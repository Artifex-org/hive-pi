import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantText } from "../btw/thread.ts";
import { excerpt, fingerprint, outputText, parseNotes, SCAN_SYSTEM, type Note } from "./scan.ts";

const KEY = "you-should-know";
export interface ScanConfig {
	enabled: boolean;
	intervalMs: number;
	timeoutMs: number;
	maxScans: number;
}
export const DEFAULT_CONFIG: ScanConfig = {
	enabled: false, intervalMs: 30_000, timeoutMs: 60_000, maxScans: 20,
};
interface State {
	/** Consent is not inherited by a fork/clone/import with a new session id. */
	sessionId: string;
	enabled: boolean;
	scans: number;
	notes: Note[];
	seen: string[];
	tokens: number;
	cost: number;
}
export interface ScanRequest { source: string; seen: string[]; }
export type Scanner = (ctx: ExtensionContext, request: ScanRequest, signal: AbortSignal) => Promise<AssistantMessage>;

/** Same provider/model/auth as the main session. No child process or tools. */
export const scanOutput: Scanner = async (ctx, request, signal) => {
	const registry = ctx.modelRegistry;
	const model = ctx.model;
	if (!model) throw new Error("pick a model with /model before enabling the scanner");
	return await registry.streamSimple(model, {
		systemPrompt: SCAN_SYSTEM,
		messages: [{ role: "user", content: JSON.stringify({ assistant_output: request.source, previously_surfaced_quotes: request.seen }), timestamp: Date.now() }],
	}, {
		reasoning: "minimal", maxTokens: 2_048, cacheRetention: "none",
		sessionId: randomUUID(), signal,
	}).result();
};

function fresh(enabled: boolean): State {
	return { sessionId: "", enabled, scans: 0, notes: [], seen: [], tokens: 0, cost: 0 };
}

function restore(data: unknown): State | null {
	if (!data || typeof data !== "object") return null;
	const s = data as State;
	if (typeof s.sessionId !== "string" || typeof s.enabled !== "boolean" || !Number.isSafeInteger(s.scans) || s.scans < 0 ||
		!Array.isArray(s.notes) || s.notes.length > 10 || !Array.isArray(s.seen) || s.seen.length > 100 ||
		!s.seen.every(q => typeof q === "string" && q.length <= 240) ||
		!Number.isFinite(s.tokens) || s.tokens < 0 || !Number.isFinite(s.cost) || s.cost < 0) return null;
	try {
		// Revalidate every stored note before it can reach the terminal.
		const notes = s.notes.flatMap(n => parseNotes(JSON.stringify({ notes: [n] }), n.quote));
		return { ...s, notes, seen: [...s.seen] };
	} catch { return null; }
}

export default function (pi: ExtensionAPI): void {
	wireYouShouldKnow(pi, { ...DEFAULT_CONFIG, enabled: process.env.PI_YOU_SHOULD_KNOW === "1" }, scanOutput);
}

/** Lifecycle handlers only buffer/schedule. All slow work lives on a detached timer. */
export function wireYouShouldKnow(pi: ExtensionAPI, cfg: ScanConfig, scanner: Scanner): void {
	if (process.env.PI_AGENDA_WORKER === "1") return;
	let state = fresh(cfg.enabled);
	let pending = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let transportBusy = false;
	let latestCtx: ExtensionContext | undefined;
	let generation = 0;
	let lastStart = -Infinity;
	let failure = "";

	const save = () => pi.appendEntry(KEY, { ...state, notes: [...state.notes], seen: [...state.seen] });
	const paint = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(KEY, state.enabled && state.notes.length ? [
			`You should know · earlier output (model notes) · /you-should-know show · dismiss`,
			...state.notes.slice(-3).map(n => `[${n.kind}] ${n.text}`),
		] : undefined);
		ctx.ui.setStatus(KEY, !state.enabled ? undefined :
			active ? "YSK: scanning…" : failure ? `YSK: scan failed · /you-should-know status` :
			state.scans >= cfg.maxScans ? "YSK: scan budget reached" : `YSK: on · ${state.scans}/${cfg.maxScans}`);
	};
	const cancel = () => {
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
		pending = "";
		latestCtx = undefined;
	};
	const eligible = (ctx: ExtensionContext) => state.enabled && ctx.mode === "tui" && state.scans < cfg.maxScans;

	const schedule = (ctx: ExtensionContext, settle = false) => {
		latestCtx = ctx;
		if (!pending || !eligible(ctx) || active || transportBusy) return;
		if (timer) {
			if (!settle) return;
			clearTimeout(timer);
		}
		const delay = Math.max(settle ? 0 : 1_000, cfg.intervalMs - (Date.now() - lastStart));
		const gen = generation;
		timer = setTimeout(() => {
			if (gen !== generation) return;
			timer = undefined; void run(ctx);
		}, delay);
		timer.unref?.();
	};

	const run = async (ctx: ExtensionContext) => {
		const gen = generation;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!pending || !eligible(ctx) || active || transportBusy) return;
			const source = pending;
			pending = "";
			const controller = new AbortController();
			active = controller;
			lastStart = Date.now();
			state.scans++;
			failure = "";
			save();
			paint(ctx);
			// A hard wall even if a provider ignores cancellation. Cancellation also
			// releases the detached waiter on off/switch/dismiss, without a retry.
			const canceled = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener("abort", () => reject(new Error("scan canceled or timed out")), { once: true });
				deadline = setTimeout(() => controller.abort(), cfg.timeoutMs);
			});
			const request = scanner(ctx, { source, seen: state.seen.slice(-25) }, controller.signal);
			transportBusy = true;
			const release = () => {
				transportBusy = false;
				try { if (latestCtx) schedule(latestCtx); } catch { /* replaced runtime */ }
			};
			// Cancellation is provider-dependent. An abandoned request must settle
			// before another starts, even across off/on or session replacement.
			void request.then(release, release);
			const response = await Promise.race([request, canceled]);
			if (gen !== generation) return;
			state.tokens += response.usage.totalTokens;
			state.cost += response.usage.cost.total;
			if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
				throw new Error("scanner could not finish its response");
			}
			const notes = parseNotes(assistantText(response), source).filter(n => !state.seen.includes(fingerprint(n.quote)));
			state.notes = [...state.notes, ...notes].slice(-10);
			state.seen = [...state.seen, ...notes.map(n => fingerprint(n.quote))].slice(-100);
			save();
		} catch (error) {
			if (gen !== generation) return;
			// Fixed UI text only; provider errors may contain credentials or controls.
			const known = ["scanner returned invalid JSON", "scanner returned no notes array", "scanner returned too many notes",
				"scanner returned an invalid note", "scanner returned an invalid or ungrounded note",
				"scanner could not finish its response", "scan canceled or timed out"];
			const reason = error instanceof Error && known.includes(error.message) ? error.message : "provider request failed";
			failure = `Scan failed: ${reason}; this excerpt was not checked. Future output can still be scanned.`;
			save();
		} finally {
			if (deadline) clearTimeout(deadline);
			if (gen === generation) {
				active = undefined;
				try { paint(ctx); schedule(ctx); } catch { /* replaced runtime */ }
			}
		}
	};

	const load = (ctx: ExtensionContext) => {
		cancel();
		state = fresh(cfg.enabled);
		state.sessionId = ctx.sessionManager.getSessionId();
		failure = "";
		lastStart = -Infinity;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === KEY) {
				const restored = restore(entry.data);
				if (restored) state = { ...restored, sessionId: state.sessionId,
					enabled: restored.sessionId === state.sessionId ? restored.enabled : cfg.enabled };
			}
		}
		paint(ctx);
	};
	pi.on("session_start", (_e, ctx) => load(ctx));
	pi.on("session_tree", (_e, ctx) => load(ctx));
	pi.on("session_shutdown", (_e, ctx) => {
		cancel();
		if (ctx.hasUI) { ctx.ui.setWidget(KEY, undefined); ctx.ui.setStatus(KEY, undefined); }
	});
	pi.on("message_end", (event, ctx) => {
		if (!eligible(ctx)) return;
		const text = outputText(event.message);
		if (!text) return;
		pending = excerpt(pending ? `${pending}\n\n${text}` : text);
		schedule(ctx);
	});
	pi.on("agent_settled", (_e, ctx) => schedule(ctx, true));

	pi.registerCommand(KEY, {
		description: "Flag buried caveats, blockers, actions and decisions: on | off | status | show | dismiss (opt-in side model calls)",
		getArgumentCompletions: prefix => ["on", "off", "status", "show", "dismiss"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("You should know is terminal-only; no scans run in RPC, print or JSON mode.");
				return;
			}
			switch (args.trim().toLowerCase()) {
				case "on":
					state.sessionId = ctx.sessionManager.getSessionId();
					state.enabled = true;
					save(); paint(ctx);
					ctx.ui.notify(`You should know enabled. Future assistant prose goes to ${ctx.model?.provider}/${ctx.model?.id} in tool-less side calls (max ${cfg.maxScans} per session). No Claude files are read.`);
					return;
				case "off":
					cancel(); state.enabled = false;
					save(); paint(ctx);
					ctx.ui.notify("You should know disabled.");
					return;
				case "dismiss":
					cancel(); state.notes = [];
					save(); paint(ctx);
					ctx.ui.notify("Notes dismissed. Repeated source quotes stay suppressed.");
					return;
				case "show":
					ctx.ui.notify(state.notes.length ? "Earlier output — model interpretations, not current verified blockers:\n\n" + state.notes.map(n => `[${n.kind}] ${n.text}\nSource: ${n.quote}`).join("\n\n") : "No notes. Silence does not mean the work was verified.");
					return;
				case "": case "status":
					ctx.ui.notify(`You should know: ${state.enabled ? "on" : "off"} · ${state.scans}/${cfg.maxScans} scans · ${state.tokens} side-call tokens · $${state.cost.toFixed(4)} reported cost.\n${failure || "Only future assistant prose is scanned; no independent verification."}\n/you-should-know on | off | show | dismiss`);
					return;
				default: ctx.ui.notify("Usage: /you-should-know on | off | status | show | dismiss", "warning");
			}
		},
	});
}
