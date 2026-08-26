/**
 * Turns that outlive one provider call (HIV-2095).
 *
 * # Why a turn has to survive being "finished"
 *
 * Cursor's `Run` is a single open stream carrying one agent turn. When the model
 * calls a tool, its own client answers on that same stream and the turn
 * continues — the model never re-plans, because the tool result arrives exactly
 * where it expects one.
 *
 * pi cannot answer inline: a provider gets tool DECLARATIONS, never bodies, so
 * the call must go back to pi, which executes it and invokes the provider again.
 * That boundary is what this module bridges. Rather than tearing the Cursor
 * stream down and rebuilding the conversation from prose next time, the turn is
 * SUSPENDED with its socket, heartbeat and blob store intact, parked here under
 * the tool-call id, and resumed when pi returns with the result.
 *
 * MEASURED, and the reason this module exists: with the stream torn down and the
 * call replayed as text, composer-2.5 re-issued the same tool call 25-33 times
 * until the run timed out. Answering inline on the held-open stream, the same
 * prompt calls the tool ONCE and finishes with a clean turnEnded — a 2s pause
 * standing in for pi's execution changed nothing.
 *
 * # What can go wrong, and what happens then
 *
 * A suspended turn holds a real socket, so the failure mode of getting this
 * wrong is a leak, not a wrong answer. Two guards: every suspension expires
 * (pi may abort, crash, or simply never call the tool's result back), and
 * process exit aborts whatever is still parked.
 */

import type { RunEvents } from "./transport.ts";

/** What pi's execution of a tool produced, as Cursor needs to hear it. */
export interface PiToolResult {
	text: string;
	isError: boolean;
}

export interface SuspendedTurn {
	/** Cursor's own tool-call id — also the id pi echoes back on the result. */
	callId: string;
	/** Guards against resuming a turn under a different model than it began. */
	modelId: string;
	/**
	 * Feed the tool result in and keep going. The events sink is re-pointed at
	 * the NEW pi stream, so text produced after the tool lands in the assistant
	 * message pi is currently building rather than the finished one.
	 *
	 * `signal` is the RESUMING call's, and must be passed: the parked turn is
	 * still holding the first call's signal, which pi has already finished with.
	 * Without this an abort during a resumed segment tears down nothing and the
	 * stream lives until its suspension expires.
	 */
	resume(events: RunEvents, result: PiToolResult, signal?: AbortSignal): Promise<void>;
	/** Tear the underlying stream down. Safe to call twice. */
	abort(reason: string): void;
}

/**
 * How long a turn may sit suspended before its socket is reclaimed.
 *
 * Generous on purpose: the tool pi is executing may itself be slow (a hive run,
 * a build), and the cost of expiring too early is a wasted turn, while the cost
 * of expiring too late is one idle socket. Heartbeats continue throughout, so
 * the server side stays willing.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function suspensionTtlMs(): number {
	const raw = Number(process.env.CURSOR_SUSPEND_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

interface Parked {
	turn: SuspendedTurn;
	timer: NodeJS.Timeout;
}

const parked = new Map<string, Parked>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// A parked turn owns an http2 session with a live interval on it, which is
	// enough to keep Node from exiting on its own.
	process.on("exit", () => {
		for (const { turn, timer } of parked.values()) {
			clearTimeout(timer);
			turn.abort("process exiting");
		}
		parked.clear();
	});
}

/** Park a turn until pi comes back with the result for `callId`. */
export function suspendTurn(turn: SuspendedTurn): void {
	installExitHook();
	// A second suspension under the same id should not strand the first.
	dropParked(turn.callId, "superseded by a newer call with the same id");
	const timer = setTimeout(() => {
		parked.delete(turn.callId);
		turn.abort(`no tool result within ${Math.round(suspensionTtlMs() / 1000)}s`);
	}, suspensionTtlMs());
	// Do not hold the event loop open on this timer's account: a parked turn is
	// a background obligation, not a reason for the process to stay alive.
	timer.unref?.();
	parked.set(turn.callId, { turn, timer });
}

/**
 * Claim the turn waiting on `callId`, if there is one.
 *
 * Consumed on read: a turn resumes exactly once, and leaving it parked after
 * handing it out is how the same socket ends up with two writers.
 */
export function claimSuspendedTurn(callId: string, modelId: string): SuspendedTurn | null {
	const entry = parked.get(callId);
	if (!entry) return null;
	if (entry.turn.modelId !== modelId) {
		// Not an error worth failing the request over -- pi is free to switch
		// models mid-conversation -- but the parked turn belongs to the old one
		// and cannot carry the new one's context.
		dropParked(callId, `model changed from ${entry.turn.modelId} to ${modelId}`);
		return null;
	}
	clearTimeout(entry.timer);
	parked.delete(callId);
	return entry.turn;
}

function dropParked(callId: string, reason: string): void {
	const entry = parked.get(callId);
	if (!entry) return;
	clearTimeout(entry.timer);
	parked.delete(callId);
	entry.turn.abort(reason);
}

/**
 * Forget a parked turn whose stream has already died.
 *
 * Distinct from letting it expire: the next provider call should fall through
 * to a FRESH turn rather than resume a dead socket, and it can only do that if
 * the id is gone from the registry by then.
 */
export function discardSuspendedTurn(callId: string, reason: string): void {
	dropParked(callId, reason);
}

/** Abort every parked turn. Used when a conversation is abandoned, and by tests. */
export function abortAllSuspendedTurns(reason = "aborted"): void {
	for (const callId of [...parked.keys()]) dropParked(callId, reason);
}

/** How many turns are parked. Diagnostics and tests only. */
export function suspendedTurnCount(): number {
	return parked.size;
}
