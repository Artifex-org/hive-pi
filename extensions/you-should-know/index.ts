import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantText } from "../btw/thread.ts";
import { resolveAuth } from "../hive-common/identity.ts";
import { fetchAgentModeCatalog } from "../advisor/modes.ts";
import { YSK_CONTROL_CHANNEL, YSK_REMOTE_CHANNEL, YSK_STATE_CHANNEL, YSK_FINDINGS_CHANNEL, YSK_POLICY_CHANNEL, YSK_POLICY_REQUEST_CHANNEL, YSK_RECORDING_CHANNEL, YSK_RECEIPTS_CHANNEL, readYouShouldKnowAction, type YouShouldKnowAction, type YouShouldKnowState } from "../hive-common/you-should-know.ts";
import { validFinding, type CapturedFinding, type FindingReceipt } from "../hive-common/you-should-know-findings.ts";
import { loadConfig } from "../typesafe-common/config.ts";
import { readApiKey } from "../typesafe-common/key.ts";
import { createJevShadow } from "./jev.ts";
import { createJevPrefilter, type PrefilterOutcome } from "./prefilter.ts";
import { assistantEvidence, failedToolEvidence, groundNotes, redactEvidence, stableFindingID, type CaptureSource, type SourceEvidence } from "./evidence.ts";
import { DEFAULT_CONFIG, excerpt, fingerprint, outputText, parseNotes, SCAN_SYSTEM, type Note, type ScanConfig } from "./scan.ts";

const KEY = "you-should-know";
const LEDGER = "you-should-know.findings";
const RECEIPTS = "you-should-know.receipts";
// The scan limits live in scan.ts, shared with the Claude adapter's settle hook.
export { DEFAULT_CONFIG, type ScanConfig };
interface State {
	sessionId: string; enabled: boolean; scans: number; notes: Note[]; seen: string[]; tokens: number; cost: number;
	/** Scans that ended without a verdict. Without it a saved session reads N failures as N clean, empty scans. */
	failed?: number;
	recording?: boolean; desiredRecording?: boolean;
}
export interface ScanRequest { source: string; seen: string[] }
export type Scanner = (ctx: ExtensionContext, request: ScanRequest, signal: AbortSignal) => Promise<AssistantMessage>;

/** A strict cheap-lane pick; never borrow the session or delegation model. */
export async function resolveYouShouldKnowModel(ctx: ExtensionContext) {
	const registry = ctx.modelRegistry;
	let spec = process.env.PI_YOU_SHOULD_KNOW_MODEL?.trim();
	if (!spec) {
		const auth = resolveAuth();
		if (!auth) throw new Error("no Hive catalog auth");
		const catalog = await fetchAgentModeCatalog(auth);
		const low = catalog?.modes.find(mode => mode.key === "low");
		if (!low || typeof low.model !== "string") throw new Error("Hive catalog has no low model");
		spec = low.model;
	}
	const split = spec.indexOf("/");
	if (split < 1 || split === spec.length - 1) throw new Error("invalid low model spec");
	const model = registry.find(spec.slice(0, split), spec.slice(split + 1));
	if (!model) throw new Error("low model is unavailable in this registry");
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error("low model credentials unavailable");
	return model;
}
export const scanOutput: Scanner = async (ctx, request, signal) => {
	if (signal.aborted) throw new Error("scan canceled or timed out");
	const model = await resolveYouShouldKnowModel(ctx);
	if (signal.aborted) throw new Error("scan canceled or timed out");
	const credential = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!credential.ok) throw new Error("low model credentials unavailable");
	if (signal.aborted) throw new Error("scan canceled or timed out");
	const secrets = credential.apiKey ? [credential.apiKey] : [];
	return await ctx.modelRegistry.streamSimple(model, {
		systemPrompt: SCAN_SYSTEM,
		messages: [{ role: "user", content: JSON.stringify({ assistant_output: redactEvidence(request.source, secrets), previously_surfaced_quotes: request.seen.map(quote => redactEvidence(quote, secrets)) }), timestamp: Date.now() }],
	}, { reasoning: "minimal", maxTokens: 2_048, cacheRetention: "none", sessionId: randomUUID(), signal }).result();
};
const fresh = (enabled: boolean): State => ({ sessionId: "", enabled, scans: 0, notes: [], seen: [], tokens: 0, cost: 0, recording: false });
function restore(data: unknown): State | null {
	if (!data || typeof data !== "object") return null;
	const s = data as State;
	if (typeof s.sessionId !== "string" || typeof s.enabled !== "boolean" || !Number.isSafeInteger(s.scans) || s.scans < 0 ||
		!Array.isArray(s.notes) || s.notes.length > 10 || !Array.isArray(s.seen) || s.seen.length > 100 ||
		!s.seen.every(q => typeof q === "string" && q.length <= 480 && [...q].length <= 240) ||
		!Number.isFinite(s.tokens) || s.tokens < 0 || !Number.isFinite(s.cost) || s.cost < 0 ||
		(s.failed !== undefined && (!Number.isSafeInteger(s.failed) || s.failed < 0 || s.failed > s.scans)) ||
		(s.recording !== undefined && typeof s.recording !== "boolean") || (s.desiredRecording !== undefined && typeof s.desiredRecording !== "boolean")) return null;
	try { return { ...s, notes: s.notes.flatMap(n => parseNotes(JSON.stringify({ notes: [{ ...n, text: redactEvidence(n.text), quote: redactEvidence(n.quote), ...(n.expected ? { expected: redactEvidence(n.expected) } : {}), ...(n.impact ? { impact: redactEvidence(n.impact) } : {}) }] }), redactEvidence(n.quote), true)), seen: [...s.seen] }; } catch { return null; }
}
export default function (pi: ExtensionAPI): void { wireYouShouldKnow(pi, { ...DEFAULT_CONFIG, enabled: process.env.PI_YOU_SHOULD_KNOW !== "0" }, scanOutput); }

/** Handlers only buffer and schedule; providers, classification and remote I/O
 * run detached. Durable custom entries never enter the agent's LLM context. */
export function wireYouShouldKnow(pi: ExtensionAPI, cfg: ScanConfig, scanner: Scanner): void {
	if (process.env.PI_AGENDA_WORKER === "1") return;
	// Read config/key once outside event handlers; create the long-lived client
	// at session_start. A credential alone is never consent to use Jev.
	const jevConfig = loadConfig(), jevKey = jevConfig.enabled ? readApiKey() : null;
	let classify = createJevShadow(jevConfig, jevKey);
	const prefilterEnabled = process.env.PI_YOU_SHOULD_KNOW_JEV_PREFILTER === "shadow";
	const prefilter = createJevPrefilter(jevConfig, jevKey, prefilterEnabled);
	const prefilterControllers = new Set<AbortController>();
	let prefilterDetail = prefilterEnabled ? "shadow; waiting" : "disabled";
	let incompleteSources = false;
	let jev = jevConfig.enabled ? (jevKey ? "shadow" : "unavailable") : "disabled";
	let jevDetail = jevConfig.enabled ? (jevKey ? "waiting" : "no usable key") : "configuration disabled";
	let model = process.env.PI_YOU_SHOULD_KNOW_MODEL || "catalog:low";
	let state = fresh(cfg.enabled);
	let sources: CaptureSource[] = [];
	let ledger: CapturedFinding[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let transportBusy = false;
	let latestCtx: ExtensionContext | undefined;
	let generation = 0, lastStart = -Infinity;
	let failure = "", recordingFailure = "";
	let remoteAvailable = false, policyReady = false;
	let serverSessionId: string | undefined;
	let recordingRevision = 0;
	let appliedCommandId: string | undefined;
	let pendingControl: { recording: boolean; expected_revision: number; control_id: string; serverSessionId: string } | undefined;
	const save = () => pi.appendEntry(KEY, { ...state, notes: [...state.notes], seen: [...state.seen] });
	const publishLedger = () => { if (remoteAvailable && policyReady) pi.events.emit(YSK_FINDINGS_CHANNEL, ledger.filter(x => x.serverSessionId === serverSessionId)); };
	const supported = (ctx: ExtensionContext) => ctx.mode === "tui" || (ctx.mode === "rpc" && remoteAvailable);
	const eligible = (ctx: ExtensionContext) => state.enabled && supported(ctx) && state.scans < cfg.maxScans;
	const paint = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		if (!supported(ctx)) { pi.events.emit(YSK_STATE_CHANNEL, undefined); return; }
		pi.events.emit(YSK_STATE_CHANNEL, {
			version: 1, command_id: appliedCommandId, enabled: state.enabled, model,
			recording: state.recording === true, ...(policyReady ? { recording_revision: recordingRevision } : {}),
			capture_tools: process.env.PI_YOU_SHOULD_KNOW_CAPTURE_TOOLS === "1", jev,
			phase: !state.enabled ? "idle" : active ? "scanning" : transportBusy ? "waiting" : failure ? "failed" : state.scans >= cfg.maxScans ? "budget" : "idle",
			scans: state.scans, max_scans: cfg.maxScans, tokens: state.tokens, cost: state.cost, failure, notes: state.notes.map(n => ({ ...n })),
		} satisfies YouShouldKnowState);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(KEY, state.enabled && state.notes.length ? ["You should know · earlier output (model notes) · /you-should-know show · dismiss", ...state.notes.slice(-3).map(n => `[${n.kind}] ${n.text}`)] : undefined);
		ctx.ui.setStatus(KEY, !state.enabled ? undefined : active ? "YSK: scanning…" : transportBusy ? "YSK: awaiting canceled provider · /you-should-know status" : failure ? "YSK: scan failed · /you-should-know status" : state.scans >= cfg.maxScans ? "YSK: scan budget reached" : `YSK: on · ${state.scans}/${cfg.maxScans}`);
	};
	const cancel = () => { generation++; if (timer) clearTimeout(timer); timer = undefined; active?.abort(); active = undefined; for (const controller of prefilterControllers) controller.abort(); prefilterControllers.clear(); sources = []; incompleteSources = false; latestCtx = undefined; };
	const record = (enabled: boolean, ctx: ExtensionContext) => {
		state.desiredRecording = enabled; state.recording = enabled;
		if (policyReady && serverSessionId) {
			pendingControl = { recording: enabled, expected_revision: recordingRevision, control_id: randomUUID(), serverSessionId };
			pi.events.emit(YSK_RECORDING_CHANNEL, pendingControl);
		}
		save(); paint(ctx);
	};
	const apply = (action: YouShouldKnowAction, ctx: ExtensionContext) => {
		if (action === "record_on" || action === "record_off") { record(action === "record_on", ctx); return; }
		if (action === "on") { state.sessionId = ctx.sessionManager.getSessionId(); state.enabled = true; }
		else { cancel(); if (action === "off") state.enabled = false; else state.notes = []; }
		save(); paint(ctx);
	};
	pi.events.on(YSK_CONTROL_CHANNEL, (data: unknown) => {
		const action = readYouShouldKnowAction(data);
		if (!action || !remoteAvailable || !latestCtx || !supported(latestCtx)) return;
		const control = data as { command_id?: unknown; recording_revision?: unknown };
		if (typeof control.command_id !== "string" || control.command_id.length > 64 || !control.command_id) return;
		if (action === "record_on" || action === "record_off") {
			if (!Number.isSafeInteger(control.recording_revision) || (control.recording_revision as number) < recordingRevision) return;
			recordingRevision = control.recording_revision as number; policyReady = true;
			state.recording = action === "record_on"; state.desiredRecording = undefined; pendingControl = undefined;
			appliedCommandId = control.command_id; save(); paint(latestCtx); return;
		}
		appliedCommandId = control.command_id; apply(action, latestCtx);
	});
	pi.events.on(YSK_REMOTE_CHANNEL, (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const remote = data as { available?: unknown; serverSessionId?: unknown };
		if (typeof remote.available !== "boolean") return;
		const changed = remote.serverSessionId !== serverSessionId;
		remoteAvailable = remote.available;
		if (changed || !remoteAvailable) { policyReady = false; pendingControl = undefined; }
		serverSessionId = remoteAvailable && typeof remote.serverSessionId === "string" ? remote.serverSessionId : undefined;
		const ctx = latestCtx;
		if (!remoteAvailable && ctx?.mode === "rpc") cancel();
		if (ctx) paint(ctx);
	});
	pi.events.on(YSK_POLICY_CHANNEL, (data: unknown) => {
		if (!data || typeof data !== "object" || !remoteAvailable || !latestCtx) return;
		const policy = data as { serverSessionId?: unknown; version?: unknown; recording?: unknown; recording_revision?: unknown };
		if (policy.serverSessionId !== serverSessionId || policy.version !== 1 || typeof policy.recording !== "boolean" || !Number.isSafeInteger(policy.recording_revision) || (policy.recording_revision as number) < recordingRevision) return;
		policyReady = true; recordingRevision = policy.recording_revision as number;
		if (pendingControl && recordingRevision > pendingControl.expected_revision) { pendingControl = undefined; state.desiredRecording = undefined; }
		if (state.desiredRecording !== undefined && state.desiredRecording !== policy.recording) {
			state.recording = state.desiredRecording;
			if (!pendingControl && serverSessionId) { pendingControl = { recording: state.desiredRecording, expected_revision: recordingRevision, control_id: randomUUID(), serverSessionId }; pi.events.emit(YSK_RECORDING_CHANNEL, pendingControl); }
		} else { state.recording = policy.recording; state.desiredRecording = undefined; }
		save(); paint(latestCtx); publishLedger();
	});
	pi.events.on(YSK_RECEIPTS_CHANNEL, (data: unknown) => {
		if (!data || typeof data !== "object" || !remoteAvailable || !latestCtx) return;
		const event = data as { serverSessionId?: unknown; receipts?: FindingReceipt[]; failure?: unknown };
		if (event.serverSessionId !== serverSessionId) return;
		if (Array.isArray(event.receipts) && event.receipts.length <= 200) { pi.appendEntry(RECEIPTS, { sessionId: state.sessionId, serverSessionId, receipts: event.receipts }); recordingFailure = ""; }
		if (typeof event.failure === "string") recordingFailure = event.failure;
	});

	const schedule = (ctx: ExtensionContext, settle = false) => {
		latestCtx = ctx;
		if (!sources.length || !eligible(ctx) || active || transportBusy) return;
		if (timer) { if (!settle) return; clearTimeout(timer); }
		const gen = generation;
		timer = setTimeout(() => { if (gen !== generation) return; timer = undefined; void run(ctx); }, Math.max(settle ? 0 : 1_000, cfg.intervalMs - (Date.now() - lastStart)));
		timer.unref?.();
	};
	const run = async (ctx: ExtensionContext) => {
		const gen = generation;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let prefilterRequest: Promise<PrefilterOutcome> | undefined;
		let prefilterController: AbortController | undefined;
		let baseline: { checked: boolean; notes?: number; tokens?: number } = { checked: false };
		try {
			if (!sources.length || !eligible(ctx) || active || transportBusy) return;
			const captured = sources; sources = [];
			const incomplete = incompleteSources; incompleteSources = false;
			const source = excerpt(captured.map(x => x.evidence.text).join("\n\n"));
			const scanRecording = state.recording === true && policyReady && !pendingControl;
			const scanRevision = recordingRevision;
			const controller = new AbortController(); active = controller; lastStart = Date.now(); state.scans++; failure = ""; save(); paint(ctx);
			const canceled = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(new Error("scan canceled or timed out")), { once: true });
				deadline = setTimeout(() => controller.abort(), cfg.timeoutMs);
			});
			// Begin the observational pre-extraction call first, but NEVER wait for
			// it to start extraction. Its transport/budget cannot gate the low lane.
			if (prefilterEnabled) {
				prefilterController = new AbortController(); prefilterControllers.add(prefilterController);
				prefilterRequest = prefilter({ source, hasTool: captured.some(x => x.evidence.type === "tool"), incomplete }, prefilterController.signal);
			}
			const request = scanner(ctx, { source, seen: state.seen.slice(-25) }, controller.signal);
			transportBusy = true;
			const release = () => { transportBusy = false; try { if (latestCtx) { paint(latestCtx); schedule(latestCtx); } } catch { /* replaced runtime */ } };
			void request.then(release, release);
			const response = await Promise.race([request, canceled]);
			if (gen !== generation) return;
			state.tokens += response.usage.totalTokens; state.cost += response.usage.cost.total;
			model = `${response.provider}/${response.model}`;
			if (["error", "aborted", "length"].includes(response.stopReason)) throw new Error("scanner could not finish its response");
			const extracted = parseNotes(assistantText(response), source);
			baseline = { checked: true, notes: extracted.length, tokens: response.usage.totalTokens };
			const { notes, findings } = groundNotes(extracted, state.seen, captured, state.sessionId,
				origin => origin.recording && scanRecording && state.recording === true && scanRevision === origin.revision && recordingRevision === scanRevision);
			state.notes = [...state.notes, ...notes].slice(-10);
			state.seen = [...state.seen, ...notes.map(n => fingerprint(n.quote))].slice(-100);
			if (findings.length && ledger.length < 200) {
				const retained = findings.slice(0, 200 - ledger.length);
				ledger.push(...retained); pi.appendEntry(LEDGER, { sessionId: state.sessionId, findings: retained }); publishLedger();
			}
			save();
			// Shadow classification is an observation, never a filter or router.
			if (notes.length) {
				const shadow = await Promise.race([classify(notes, controller.signal), canceled]);
				if (gen !== generation) return;
				jev = shadow.status === "ok" ? "shadow" : shadow.status === "disabled" ? (shadow.reason === "no_key" ? "unavailable" : "disabled") : "failed";
				jevDetail = shadow.status === "ok" ? `${redactEvidence(shadow.model).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100)} · ${shadow.inputTokens + shadow.outputTokens} reported tokens · ${shadow.findings.filter(f => f.status === "abstained").length} abstained; cost unreported` : shadow.reason;
				pi.appendEntry("you-should-know.jev", { sessionId: state.sessionId, findingIds: notes.map(n => n.id), baseline: notes.map(n => n.classification ?? "context"), shadow });
			}
		} catch (error) {
			if (gen !== generation) return;
			const known = ["scanner returned invalid JSON", "scanner returned no notes array", "scanner returned too many notes", "scanner returned an invalid note", "scanner returned an invalid or ungrounded note", "scanner could not finish its response", "scan canceled or timed out", "no Hive catalog auth", "Hive catalog has no low model", "invalid low model spec", "low model is unavailable in this registry", "low model credentials unavailable"];
			failure = `Scan failed: ${error instanceof Error && known.includes(error.message) ? error.message : "provider request failed"}; this excerpt was not checked.`;
			state.failed = (state.failed ?? 0) + 1; save();
		} finally {
			// Pair with the baseline off the extraction path. Failed extraction is
			// UNKNOWN, never a safe skip label. No evidence text/recording writes.
			if (prefilterRequest && prefilterController) {
				const controller = prefilterController, comparison = baseline, sessionId = state.sessionId;
				void prefilterRequest.then(shadow => {
					if (gen !== generation || controller.signal.aborted) return;
					pi.appendEntry("you-should-know.prefilter", { version: 1, sessionId, mode: "shadow", baseline: comparison, shadow });
					prefilterDetail = `shadow · ${shadow.decision} (${shadow.reason}) · ${shadow.latencyMs} ms · ${shadow.inputTokens === undefined ? "usage unreported" : `${shadow.inputTokens + (shadow.outputTokens ?? 0)} reported tokens`} · actual calls avoided: 0`;
				}).catch(() => { /* runtime replaced; no agent-loop failure */ }).finally(() => prefilterControllers.delete(controller));
			}
			if (deadline) clearTimeout(deadline); if (gen === generation) { active = undefined; try { paint(ctx); schedule(ctx); } catch { /* replaced runtime */ } }
		}
	};
	const load = (ctx: ExtensionContext) => {
		const sameSession = state.sessionId === ctx.sessionManager.getSessionId();
		if (!sameSession) { serverSessionId = undefined; remoteAvailable = false; }
		cancel(); state = fresh(cfg.enabled); appliedCommandId = undefined; state.sessionId = ctx.sessionManager.getSessionId(); failure = ""; recordingFailure = ""; lastStart = -Infinity;
		ledger = []; pendingControl = undefined; policyReady = false; recordingRevision = 0;
		prefilterDetail = prefilterEnabled ? "shadow; waiting" : "disabled";
		classify = createJevShadow(jevConfig, jevKey);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === KEY) {
				const restored = restore(entry.data);
				if (restored) state = { ...restored, sessionId: state.sessionId, enabled: restored.sessionId === state.sessionId ? restored.enabled : cfg.enabled,
					recording: false, desiredRecording: restored.sessionId === state.sessionId ? restored.desiredRecording : undefined };
			}
			if (entry.customType === LEDGER && entry.data && typeof entry.data === "object") {
				const saved = entry.data as { sessionId?: unknown; findings?: unknown };
				if (saved.sessionId === state.sessionId && Array.isArray(saved.findings)) for (const item of saved.findings) {
					const f = item as CapturedFinding;
					if (ledger.length < 200 && validFinding(f?.finding) && typeof f.recording === "boolean" && typeof f.serverSessionId === "string" && Number.isSafeInteger(f.revision) && f.revision >= 0 && !ledger.some(x => x.finding.id === f.finding.id)) ledger.push(f);
				}
			}
		}
		paint(ctx);
		if (sameSession && remoteAvailable) pi.events.emit(YSK_POLICY_REQUEST_CHANNEL, undefined);
	};
	pi.on("session_start", (_e, ctx) => load(ctx));
	pi.on("session_tree", (_e, ctx) => load(ctx));
	pi.on("session_shutdown", (_e, ctx) => { cancel(); if (ctx.hasUI) { ctx.ui.setWidget(KEY, undefined); ctx.ui.setStatus(KEY, undefined); } });
	const buffer = (evidence: SourceEvidence, ctx: ExtensionContext) => {
		if (!eligible(ctx) || !evidence.text.trim()) return;
		sources.push({ evidence: { ...evidence, text: excerpt(evidence.text) }, recording: state.recording === true && policyReady && !pendingControl, revision: recordingRevision, serverSessionId });
		if (sources.length > 20) incompleteSources = true;
		sources = sources.slice(-20); schedule(ctx);
	};
	pi.on("message_end", (event, ctx) => {
		if (!eligible(ctx)) return;
		const text = outputText(event.message); if (!text) return;
		const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "message" && e.message === event.message);
		const id = entry?.id ?? stableFindingID(state.sessionId, String(event.message.timestamp), text).slice(0, 64);
		buffer(assistantEvidence(id, text, jevKey ? [jevKey] : []), ctx);
	});
	pi.on("tool_result", (event, ctx) => { if (process.env.PI_YOU_SHOULD_KNOW_CAPTURE_TOOLS !== "1") return; const evidence = failedToolEvidence(event, jevKey ? [jevKey] : []); if (evidence) buffer(evidence, ctx); });
	pi.on("agent_settled", (_e, ctx) => schedule(ctx, true));
	pi.registerCommand(KEY, {
		description: "Surface grounded notes: on | off | status | show | dismiss | record-on | record-off",
		getArgumentCompletions: prefix => ["on", "off", "status", "show", "dismiss", "record-on", "record-off"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!supported(ctx)) { ctx.ui.notify("You should know needs a terminal or an attached Hive conversation; no scans run in standalone RPC, print or JSON mode."); return; }
			switch (args.trim().toLowerCase()) {
				case "on": apply("on", ctx); ctx.ui.notify(`You should know enabled. Future assistant prose goes to ${model} in tool-less side calls (max ${cfg.maxScans} per session). No Claude files are read.`); return;
				case "off": apply("off", ctx); ctx.ui.notify("You should know disabled."); return;
				case "record-on": case "record-off": record(args.trim().toLowerCase() === "record-on", ctx); ctx.ui.notify(`Recording ${state.recording ? "requested" : "stopped locally"}. Destination writes require an authenticated supported Hive attachment; queued is not delivered.`); return;
				case "dismiss": apply("dismiss", ctx); ctx.ui.notify("Notes dismissed. Durable findings and real receipts are retained; repeated quotes stay suppressed."); return;
				case "show": ctx.ui.notify(state.notes.length ? "Earlier output — model interpretations, not current verified blockers:\n\n" + state.notes.map(n => `[${n.kind}] ${n.text}\nSource: ${n.quote}`).join("\n\n") : "No notes. Silence does not mean the work was verified."); return;
				case "": case "status": ctx.ui.notify(`You should know: ${state.enabled ? "on" : "off"} · ${state.scans}/${cfg.maxScans} scans${state.failed ? ` (${state.failed} failed)` : ""} · ${state.tokens} side-call tokens · $${state.cost.toFixed(4)} reported extraction cost.\nModel: ${model} · recording: ${state.recording ? "on" : "off"}${policyReady ? ` (revision ${recordingRevision})` : " (not negotiated)"} · Jev: ${jev} (${jevDetail}).\nJev prefilter: ${prefilterDetail}.\n${failure || "Only future captured evidence is scanned; no independent verification."}${recordingFailure ? `\n${recordingFailure}` : ""}${transportBusy && !active ? "\nFurther calls wait for the canceled provider request to settle." : ""}\n/you-should-know on | off | show | dismiss | record-on | record-off`); return;
				default: ctx.ui.notify("Usage: /you-should-know on | off | status | show | dismiss | record-on | record-off", "warning");
			}
		},
	});
}
