/** A mode switch is consent, not an instruction the agent may give itself.
 * Reuses Hive's durable, human-only tool approvals; only this tool consumes them.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OP_MODE_CONTROL_CHANNEL, OP_MODE_STATE_CHANNEL, type OpModeStateEvent } from "../hive-common/channels.ts";
import { request, type HiveAuth } from "../hive-common/http.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { isOpMode, OP_MODE_ENFORCES, type OpMode } from "../opmode/modes.ts";

interface ModeRequestDeps {
	enabled: boolean;
	getAuth(): HiveAuth | null;
	getSessionID(): string | null;
	/** Injectable timing for tests; production uses the approval's fixed TTL. */
	pollMs?: number;
	waitMs?: number;
}

interface Approval {
	session_id: string;
	client_call_id: string;
	tool_name: string;
	tool_args: string;
	verdict: string;
	expires_at: string;
	decided_by?: string;
}

const TOOL = "request_mode";
const WAIT_MS = 5 * 60_000;

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

async function offered(auth: HiveAuth, mode: OpMode, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const response = await request<{ modes: { key: string }[] }>(auth, "GET", "/agent-op-modes", undefined, timeoutMs, signal);
	return response.ok && Array.isArray(response.body?.modes) && response.body.modes.some(m => m && m.key === mode);
}

function matches(a: Approval | undefined, session: string, call: string, from: OpMode, mode: OpMode): a is Approval {
	if (!a || a.session_id !== session || a.client_call_id !== call || a.tool_name !== TOOL) return false;
	try {
		const args = JSON.parse(a.tool_args);
		return args.from_mode === from && args.mode === mode && Date.parse(a.expires_at) > Date.now();
	} catch { return false; }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

export function registerModeRequestTool(pi: ExtensionAPI, deps: ModeRequestDeps): void {
	let mode: OpMode | undefined;
	let modes: readonly string[] = [];
	let revision = 0;
	let pending = false;
	const instance = randomUUID();
	pi.events.on(OP_MODE_STATE_CHANNEL, data => {
		const event = data as OpModeStateEvent | undefined;
		if (!isOpMode(event?.mode)) return;
		mode = event.mode;
		modes = event.modes ?? [];
		revision++;
	});
	// Session replacement invalidates in-flight consent even if it starts in the
	// same posture. A remote mode round trip also increments revision.
	pi.on("session_start", () => { revision++; });
	pi.events.on(OP_MODE_CONTROL_CHANNEL, () => { revision++; });

	registerGuardedTool(pi, {
		name: TOOL, label: "Request operating mode",
		capability: { writesExemptBecause: "changes only this session's posture after explicit human approval bound to the exact switch" },
		description: "Request human approval to switch this session's operating mode. Use build for execution or orchestrate for team coordination. Shows the current and requested mode, enforcement and your reason in the Hive workspace; blocks until approved, denied or expired. Never switches without explicit approval. This is not a model-tier selector or plan approval.",
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("build"), Type.Literal("plan"), Type.Literal("discuss"), Type.Literal("bugfix"), Type.Literal("orchestrate")]),
			reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why the user's requested work needs this posture." }),
		}),
		async execute(id, params, signal, _onUpdate, ctx) {
			const target = params.mode;
			const reason = params.reason.trim();
			const auth = deps.getAuth(), session = deps.getSessionID();
			if (!deps.enabled || !auth || !session || !mode) return result("Mode unchanged: remote mode consent is unavailable. Attach to Hive and enable operator mode control, or ask the operator to use /mode.");
			if (!isOpMode(target) || !reason || reason.length > 2000 || !modes.includes(target)) return result("Mode unchanged: a supported operating mode and a non-empty reason (up to 2000 characters) are required.");
			if (target === mode) return result(`Already in ${mode} mode; no switch requested.`);
			if (pending) return result("Mode unchanged: a mode request is already waiting for a decision.");
			if (signal?.aborted || ctx.hasPendingMessages()) return result("Mode unchanged: the turn was interrupted or a user message is queued.");
			const from = mode, startRevision = revision;
			const call = `mode:${instance}:${id}`;
			const path = `/agent-sessions/${encodeURIComponent(session)}/approvals`;
			const decisionPath = `${path}/${encodeURIComponent(call)}`;
			const waitMs = deps.waitMs ?? WAIT_MS;
			const deadline = Date.now() + waitMs;
			const remaining = () => Math.max(1, Math.min(5000, deadline - Date.now()));
			let requested = false;
			const current = () => {
				if (signal?.aborted || revision !== startRevision || deps.getSessionID() !== session || deps.getAuth() !== auth) return false;
				try { return !ctx.hasPendingMessages(); } catch { return false; }
			};
			pending = true;
			try {
				if (!await offered(auth, target, remaining(), signal) || !current()) return result("Mode unchanged: this switch is unavailable or the session changed.");
				const args = JSON.stringify({ from_mode: from, mode: target, enforces: OP_MODE_ENFORCES[target], reason });
				requested = true;
				const created = await request<Approval>(auth, "POST", path, { client_call_id: call, tool_name: TOOL, tool_args: args, ttl_seconds: Math.ceil(waitMs / 1000) }, remaining(), signal);
				// Never replay a previously approved call. Only a decision observed
				// while THIS invocation waits can release its gate.
				if (!created.ok || !matches(created.body, session, call, from, target) || created.body.verdict !== "pending") return result("Mode unchanged: a pending approval could not be established.");
				while (current() && Date.now() < deadline) {
					await pause(Math.min(deps.pollMs ?? 2000, deadline - Date.now()), signal);
					if (!current()) break;
					const polled = await request<Approval>(auth, "GET", decisionPath, undefined, remaining(), signal);
					if (!polled.ok || !matches(polled.body, session, call, from, target)) return result("Mode unchanged: the approval expired or could not be verified.");
					const approval = polled.body;
					if (approval.verdict === "pending") continue;
					if (approval.verdict !== "approve" || typeof approval.decided_by !== "string" || !approval.decided_by.trim()) return result(`Mode unchanged: the request was ${approval.verdict}.`);
					// A mode change during either network call supersedes consent.
					if (!await offered(auth, target, remaining(), signal) || !current() || Date.now() >= deadline || !matches(approval, session, call, from, target)) break;
					pi.events.emit(OP_MODE_CONTROL_CHANNEL, { mode: target });
					return result(mode === target ? `Approved: switched from ${from} to ${target} mode. ${OP_MODE_ENFORCES[target]}` : "Approval received, but the enforcer did not confirm the switch; do not assume the mode changed.");
				}
				return result("Mode unchanged: the request timed out, was interrupted, or was superseded by a user message or mode change.");
			} finally {
				pending = false;
				// Retire an unanswered card. 409 means a human already decided it;
				// expiry still bounds a card if this best-effort cleanup cannot land.
				if (requested) await request(auth, "POST", `${decisionPath}/decide`, { verdict: "answered_locally" }, 1000);
			}
		},
	});
}
