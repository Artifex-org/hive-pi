/**
 * The pi RPC wire protocol — pure, so every guarantee here is testable without
 * a child process.
 *
 * A durable worker is `pi --mode rpc`: JSON lines in on stdin, JSON lines out
 * on stdout. Everything interesting is in how those lines are framed and folded,
 * so that is what lives here; `rpc-worker.ts` owns only the process boundary.
 *
 * WHY NOT `RpcClient`. pi exports one (`modes/rpc/rpc-client.ts`) and it is the
 * obvious thing to reach for. Two disqualifiers, both read off the shipped
 * source at 0.83.0 and confirmed by spike W1:
 *
 *   1. `const cliPath = this.options.cliPath ?? "dist/cli.js"` — the default is
 *      a bare RELATIVE path, resolved against the child's cwd. Its docstring
 *      says it "searches for dist/cli.js"; it does not search. A worker started
 *      in a repo worktree would spawn `node dist/cli.js` there and die.
 *   2. `spawn("node", [cliPath, ...args])` hardcodes the interpreter, ignoring
 *      `process.execPath`. The child therefore runs whatever `node` PATH
 *      resolves to rather than the runtime the parent is on — the exact drift
 *      HIV-1037 exists to catch, and unfixable from the outside.
 *
 * So we speak the protocol directly and keep `getPiInvocation()` as the single
 * source of truth for "how do we re-invoke ourselves".
 *
 * Nothing mutable at module scope, per the rule `spawn.ts` carries.
 */

import { addUsage, budgetTokens, emptyUsage, type Usage, type WireUsage } from "../harness/usage.ts";
// One framing implementation, in the harness — see harness/framing.ts for what
// a second copy costs. Re-exported so this module stays the protocol surface.
export { frame } from "../harness/framing.ts";

/** Commands we send. A deliberate subset of pi's `RpcCommand` union. */
export type OutboundCommand =
	| { id: string; type: "prompt"; message: string }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "follow_up"; message: string }
	| { id: string; type: "abort" }
	| { id: string; type: "get_state" }
	| { id: string; type: "get_session_stats" }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type DeliveryMode = "steer" | "follow_up";

/** The tool a worker calls to say something structured mid-run. */
export const REPORT_TOOL = "report";

/** Statuses a worker may claim. A closed set, validated on THIS side. */
export const REPORT_STATUSES = ["progress", "blocked", "done"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Kept short on purpose — this is a status line, not a transcript. */
export const MAX_REPORT_NOTE = 200;
/** Newest wins; an unbounded array outlives the worker inside the parent's heap. */
export const MAX_REPORTS = 20;

export interface WorkerReport {
	status: ReportStatus;
	note: string;
	/** 0-100 when the worker offered one. */
	pct?: number;
}

/**
 * Validate and clamp a report the CHILD produced.
 *
 * The parent does this, not the child, and that is the whole security posture
 * of this channel: anything loaded into the worker can call `report`, so its
 * arguments are untrusted input crossing a process boundary. An unknown status
 * is dropped rather than passed through, the note is truncated rather than
 * rejected (a long note is still a useful note), and `pct` is clamped to a
 * range instead of trusted.
 *
 * Structured only — enums, a bounded string, a number. Never prose blobs and
 * never file contents: a channel that accepts arbitrary text is an exfiltration
 * path around every payload allowlist the harness has.
 */
export function parseReport(args: unknown): WorkerReport | null {
	if (typeof args !== "object" || args === null) return null;
	const record = args as Record<string, unknown>;
	const status = record.status;
	if (typeof status !== "string" || !REPORT_STATUSES.includes(status as ReportStatus)) return null;

	const rawNote = typeof record.note === "string" ? record.note.trim().replace(/\s+/g, " ") : "";
	const note = rawNote.length > MAX_REPORT_NOTE ? `${rawNote.slice(0, MAX_REPORT_NOTE - 1)}…` : rawNote;

	const report: WorkerReport = { status: status as ReportStatus, note };
	const pct = record.pct;
	if (typeof pct === "number" && Number.isFinite(pct)) {
		report.pct = Math.max(0, Math.min(100, Math.round(pct)));
	}
	return report;
}

export interface WorkerState {
	/** Assistant text, oldest first. */
	texts: string[];
	tokens: number;
	/** Full usage including DOLLARS — see harness/usage.ts for why cost cannot
	 *  be derived from `tokens` after the fact when nodes pick their own model. */
	usage: Usage;
	/** Turns that have completed. */
	turns: number;
	/** True between agent_start and agent_settled. */
	busy: boolean;
	/** Set once the child reports a settled turn at least once. */
	everSettled: boolean;
	/** Last tool the child called, for the live widget. */
	lastTool?: string;
	/** Structured reports the worker pushed mid-run, oldest first, bounded. */
	reports: WorkerReport[];
	/** Replies we owe the child. Draining these is not optional — see below. */
	pendingReplies: OutboundCommand[];
	/** Lines that were not JSON. Kept bounded; a raw dump is not a diagnostic. */
	junk: number;
}

export const emptyWorkerState: WorkerState = {
	texts: [],
	tokens: 0,
	usage: emptyUsage(),
	turns: 0,
	busy: false,
	everSettled: false,
	lastTool: undefined,
	reports: [],
	pendingReplies: [],
	junk: 0,
};

/** Assistant text can arrive as a string or as a content-part array. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const p = part as { type?: string; text?: unknown };
			return p?.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("");
}

/**
 * Fold one line of the child's stdout into worker state.
 *
 * Returns a NEW state; the caller owns storage. Unknown event types are ignored
 * rather than rejected: pi adds events between versions, and a worker that dies
 * on an unrecognised line is a worker that dies on the next pi bump.
 */
export function foldLine(state: WorkerState, line: string): WorkerState {
	if (!line.trim()) return state;

	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return { ...state, junk: state.junk + 1 };
	}

	switch (event.type) {
		case "agent_start":
			return { ...state, busy: true };

		case "agent_settled":
			return { ...state, busy: false, everSettled: true };

		case "turn_end":
			return { ...state, turns: state.turns + 1 };

		case "message_end": {
			// `message_end` fires for the USER message too — folding that one in
			// double-counts nothing but DOES append the caller's own goal as if the
			// worker had said it, which then reads as a successful empty run.
			const message = event.message as { role?: string; content?: unknown; usage?: WireUsage } | undefined;
			if (message?.role !== "assistant") return state;
			// NOT `Record<string, number>`: `usage.cost` is an object, and typing it
			// as a number makes the compiler agree while the field is dropped.
			const usage = addUsage(state.usage, message.usage);
			const text = textOf(message.content).trim();
			return {
				...state,
				usage,
				tokens: budgetTokens(usage),
				texts: text ? [...state.texts, text] : state.texts,
			};
		}

		/**
		 * The upward channel, and it needs no new transport.
		 *
		 * Spike W2 confirmed `tool_execution_start` carries `toolName` AND the
		 * full `args` on the RPC stream, so a child-side `report` tool is visible
		 * to the parent the moment it is CALLED — not when the worker finishes.
		 * That is the whole point: a worker that hits a blocker at minute two can
		 * say so at minute two rather than at minute twenty.
		 */
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : state.lastTool;
			if (event.toolName !== REPORT_TOOL) return { ...state, lastTool: toolName };
			const report = parseReport(event.args);
			if (!report) return { ...state, lastTool: toolName };
			// Newest wins: the parent must not grow a worker's heap for the life
			// of the session because the worker is chatty.
			const reports = [...state.reports, report].slice(-MAX_REPORTS);
			return { ...state, lastTool: toolName, reports };
		}

		/**
		 * THE ONE THAT MUST NOT BE IGNORED.
		 *
		 * In RPC mode an extension's `ctx.ui.confirm` / `select` / `input` is
		 * emitted as `extension_ui_request` and the child BLOCKS until a matching
		 * `extension_ui_response` arrives. A worker is unattended by definition,
		 * so nobody will ever answer — and the subagent extension really does
		 * call `ctx.ui.confirm` (its project-agent trust prompt). Left alone,
		 * that worker hangs until its timeout, having done nothing.
		 *
		 * We answer every request immediately with `cancelled`. Declining is the
		 * only safe default: silently confirming would let a repo-supplied prompt
		 * grant itself the trust a human was supposed to grant.
		 *
		 * `notify` / `setStatus` / `setWidget` arrive on the same channel and
		 * expect no reply, but replying to them is harmless — the child keys
		 * responses by id and drops unmatched ones — whereas working out which
		 * subtypes block would be a version-coupled guess.
		 */
		case "extension_ui_request": {
			const id = event.id;
			if (typeof id !== "string") return state;
			return { ...state, pendingReplies: [...state.pendingReplies, { type: "extension_ui_response", id, cancelled: true }] };
		}

		default:
			return state;
	}
}

/**
 * Split a stdout chunk into complete lines, returning the trailing partial.
 *
 * Separated from the fold because the bug it prevents is invisible in a fold
 * test: a JSON object split across two `data` events parses as junk twice and
 * the event is lost silently.
 */


/** Drain replies the child is waiting on, returning them and the cleared state. */
export function takeReplies(state: WorkerState): { replies: OutboundCommand[]; state: WorkerState } {
	if (state.pendingReplies.length === 0) return { replies: [], state };
	return { replies: state.pendingReplies, state: { ...state, pendingReplies: [] } };
}

export function finalText(state: WorkerState): string {
	return state.texts.join("\n").trim();
}

/** The newest report, which is what a status line shows. */
export function latestReport(state: WorkerState): WorkerReport | undefined {
	return state.reports[state.reports.length - 1];
}

/** True when the worker has said it is stuck and has not since said otherwise. */
export function isBlocked(state: WorkerState): boolean {
	return latestReport(state)?.status === "blocked";
}

/**
 * `steer` interrupts the current turn; `follow_up` queues until it ends.
 *
 * Exposed rather than abstracted, because getting it backwards is the expensive
 * mistake in both directions: a `steer` for merely-additional scope throws away
 * the worker's in-flight reasoning, and a `follow_up` for a stop-now correction
 * lets it finish work that is already wrong.
 */
export function deliveryCommand(id: string, mode: DeliveryMode, message: string): OutboundCommand {
	return mode === "steer" ? { id, type: "steer", message } : { id, type: "follow_up", message };
}
