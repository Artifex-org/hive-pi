/**
 * hive-remote — the pure fold from pi events to Hive transcript events.
 *
 * Everything in this file is synchronous and side-effect free by design. It is
 * called from pi event handlers, and pi awaits every handler serially: a slow
 * handler IS the agent loop. So the handlers do nothing but call into here and
 * push onto a queue; the network happens later, off the loop.
 *
 * Keeping the fold pure is also what makes it testable without a running agent,
 * which is the gap HIV-1070 named (~4,700 lines of extension code, zero tests).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { ARGS_BUDGET, RESULT_BUDGET, budgeted } from "./budget.ts";

/** Cardinality caps. Overflow drops rather than growing without bound. */
export const MAX_PENDING_TOOLS = 64;
export const MAX_QUEUE = 500;

/** Wire shape of one transcript event. Mirrors the server's agentEventIn. */
export interface WireEvent {
	seq: number;
	role: "user" | "assistant" | "tool" | "system";
	kind: "text" | "tool_call" | "notice" | "approval" | "thinking";
	text?: string;
	tool_name?: string;
	tool_args?: string;
	tool_result?: string;
	/** Assistant-message batch identity. Omitted for orphan/legacy calls. */
	tool_batch_id?: string;
	tool_batch_index?: number;
	tool_batch_size?: number;
	is_error?: boolean;
	/**
	 * Who caused an injected message (HIV-1215): a claimed command's `source`
	 * echoed back ("operator" | "agent" | "hive"), or a client-native tag
	 * ("team", "conductor"). Omitted for ordinary turns; the server sanitizes,
	 * the web renders it as a provenance label.
	 */
	origin?: string;
	/**
	 * WHICH PERSON injected this message (HIV-1420): the claimed command's
	 * `issued_by`, echoed back exactly as `source` is echoed as `origin`.
	 *
	 * `origin` says which ROLE spoke ("operator" vs "driver"); once a session can
	 * be driven by a colleague through a read-write share, two people share one
	 * transcript and the role alone renders them as one anonymous voice. The
	 * server verifies the id against that session's real issuers before storing
	 * it and resolves the display name on read — this side only relays it.
	 */
	issued_by?: string;
	client_ts?: string;
}

export interface Transcript {
	/** Client-minted, monotonic. It is BOTH the ordering and the idempotency key
	 *  server-side, which is what lets the flush loop be "retry until 2xx". */
	seq: number;
	queue: WireEvent[];
	/** toolCallId -> {name, args} for pairing a start with its end. */
	pending: Map<string, { name: string; args?: string; batch?: ToolBatch }>;
	/** Call identity -> its assistant-message batch, populated at message_end. */
	batches: Map<string, ToolBatch>;
	nextBatch: number;
	/** Events dropped because the queue was full; reported once, never silently. */
	dropped: number;
}

export function createTranscript(): Transcript {
	return { seq: 0, queue: [], pending: new Map(), batches: new Map(), nextBatch: 0, dropped: 0 };
}

/**
 * rebase lifts this transcript's numbering above a watermark the server already
 * holds, and returns by how much.
 *
 * `seq` is BOTH the ordering and the idempotency key, and it is minted here —
 * so a client that starts counting at 0 against a session the server already has
 * 147 events for does not corrupt anything, it DISAPPEARS: the insert is
 * `ON CONFLICT (session_id, seq) DO NOTHING`, so every event below the watermark
 * is silently discarded and the session reads as one that went quiet. That is
 * exactly what a `/reload` did, because it builds a fresh Transcript.
 *
 * Two properties this must have, both learned from the failure it fixes:
 *
 *  - It moves the QUEUE too, not just the counter. Events folded before attach
 *    completes are already numbered from 1; seeding only `t.seq` would leave
 *    them below the watermark and lose precisely the turns that happened while
 *    attaching.
 *  - It lands them STRICTLY ABOVE `lastSeq`. Renumbering so the first queued
 *    event lands ON the watermark re-creates the same silent drop for one event.
 *
 * The `lastSeq > t.seq` guard is what keeps this safe on a re-attach rather than
 * a reload. `ensureAttached` runs again in the same process after a `stop()` and
 * re-login, and if a batch was accepted but its response was lost, those events
 * sit re-queued while the server's watermark already covers them. Rebasing THOSE
 * would renumber accepted events and duplicate them. The guard can only pass
 * when the server is ahead of everything this process ever minted — which is the
 * one situation rebase is for. In the lost-ack case it no-ops and the ordinary
 * resend dedupes server-side, which is what the idempotency key is for.
 *
 * A non-integer or absent `lastSeq` (a server that predates the field) is a
 * no-op rather than a `NaN` that would poison every seq in the queue.
 */
export function rebase(t: Transcript, lastSeq: number | undefined): number {
	if (!Number.isInteger(lastSeq) || (lastSeq as number) <= 0) return 0;
	const watermark = lastSeq as number;
	if (watermark <= t.seq) return 0;
	// Shift by the distance from the lowest UNSENT number, so the queue lands at
	// watermark+1 … watermark+n. `t.seq` alone is the wrong basis when events are
	// already queued: it is the highest minted, not the lowest unsent.
	const lowestUnsent = t.queue.length > 0 ? (t.queue[0]?.seq ?? t.seq + 1) : t.seq + 1;
	const shift = watermark + 1 - lowestUnsent;
	if (shift <= 0) return 0;
	t.seq += shift;
	for (const e of t.queue) e.seq += shift;
	return shift;
}

type ToolBatch = { id: string; index: number; size: number };

/**
 * foldToolBatch records the tool-call order declared by one completed assistant
 * message. Execution may finish concurrently and out of order; this declared
 * order is the only reliable grouping boundary.
 */
export function foldToolBatch(t: Transcript, toolCallIDs: string[]): void {
	if (toolCallIDs.length < 2) return;
	const id = `turn-${++t.nextBatch}`;
	for (let index = 0; index < toolCallIDs.length; index++) {
		const toolCallID = toolCallIDs[index];
		if (toolCallID) t.batches.set(toolCallID, { id, index, size: toolCallIDs.length });
	}
}

/**
 * push appends an event, bounded.
 *
 * A full queue drops the NEWEST rather than the oldest. Dropping the oldest
 * would renumber nothing but would silently create a gap in the middle of a
 * conversation the operator is reading; dropping the newest keeps the transcript
 * a correct prefix, and the counter says how much is missing from the end.
 */
function push(t: Transcript, e: Omit<WireEvent, "seq">): void {
	if (t.queue.length >= MAX_QUEUE) {
		t.dropped += 1;
		return;
	}
	t.seq += 1;
	t.queue.push({ ...e, seq: t.seq });
}

/**
 * A user turn — always one injected by a remote command, since locally-typed
 * input never reaches this fold. `origin` is the command's server-stamped
 * source; omitting it renders as the plain operator bubble, so callers must
 * pass through whatever the claim carried.
 */
export function foldUserText(
	t: Transcript,
	text: string,
	atMs?: number,
	origin?: string,
	issuedBy?: string,
): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	push(t, {
		role: "user",
		kind: "text",
		text: trimmed,
		origin: origin || undefined,
		issued_by: issuedBy || undefined,
		client_ts: iso(atMs),
	});
}

/** A finalized assistant message. Deltas are streamed separately and never stored. */
export function foldAssistantText(t: Transcript, text: string, atMs?: number): void {
	if (!text) return;
	push(t, { role: "assistant", kind: "text", text, client_ts: iso(atMs) });
}

/**
 * Hive's cap on one event's text, mirrored here because THIS side owns the data.
 *
 * Reasoning is the field that reaches it: an xhigh turn can produce more prose
 * deliberating than answering. The server truncates on insert, so sending more
 * only wastes the wire — but truncating HERE lets it end with a marker rather
 * than mid-word, so a reader can tell a cut trace from a short one.
 */
export const MAX_EVENT_TEXT = 262_144;
const TRUNCATION_MARK = "\n\n… (reasoning truncated)";

/**
 * The model's reasoning, as a durable transcript row.
 *
 * A KIND of its own rather than a flag on `text`: every consumer renders from
 * `kind`, and the default rendering — full width, as the assistant's reply — is
 * exactly wrong for reasoning. The role stays `assistant`; it IS the assistant
 * speaking, and `kind` says in what register.
 *
 * Folded BEFORE the assistant text of the same message, because that is the
 * order it happened in.
 */
export function foldThinking(t: Transcript, text: string, atMs?: number): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	push(t, { role: "assistant", kind: "thinking", text: clampText(trimmed), client_ts: iso(atMs) });
}

/** Truncate to at most MAX_EVENT_TEXT bytes, on a whole character, with a
 *  marker — a cut trace should say it was cut. */
function clampText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_EVENT_TEXT) return value;
	const budget = MAX_EVENT_TEXT - Buffer.byteLength(TRUNCATION_MARK, "utf8");
	let bytes = 0;
	let out = "";
	for (const ch of value) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > budget) break;
		bytes += size;
		out += ch;
	}
	return out + TRUNCATION_MARK;
}

/**
 * A system notice: model switch, budget cutoff, provider fallback. `origin`
 * tags the machinery that injected it ("team", "conductor", "hive") so the
 * Hive transcript can label it; untagged notices render as before.
 */
export function foldNotice(t: Transcript, text: string, atMs?: number, origin?: string): void {
	if (!text) return;
	push(t, { role: "system", kind: "notice", text, origin: origin || undefined, client_ts: iso(atMs) });
}

/** How much of a provider error rides in the notice. Enough to name the cause,
 *  bounded because this is a transcript row and the payload is arbitrary. */
const MAX_TURN_ERROR = 300;

/**
 * The error a finished turn failed with, or "" if it did not fail.
 *
 * pi's contract (pi-ai `AssistantMessage`): a failed turn settles with
 * `stopReason: "error"` and an `errorMessage`. Read defensively — this crosses
 * an extension boundary into a package that updates independently of Hive, and
 * the failure mode of guessing wrong here is silently reporting every turn as
 * fine, which is the bug being fixed.
 *
 * `"aborted"` is deliberately NOT a failure. It is overwhelmingly an operator
 * interrupting on purpose, and drawing an alert every time someone steers a
 * running agent would make the alert worthless — which is how a warning stops
 * being read.
 */
export function turnFailure(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const m = message as { stopReason?: unknown; errorMessage?: unknown };
	if (m.stopReason !== "error") return "";
	// stopReason is authoritative: a turn can fail without the provider handing
	// back a message, and reporting it as fine because the text was missing is
	// exactly the silence this exists to break.
	return typeof m.errorMessage === "string" && m.errorMessage.trim() !== ""
		? m.errorMessage
		: "the model call failed without an error message";
}

/**
 * The end-of-turn notice the Hive transcript renders as a turn divider.
 *
 * The "Turn finished" PREFIX is a contract with hive's web UI
 * (web/src/routes/Agents.transcript.tsx isTurnEnd) — it is how the row is
 * recognised, so a rename there and here must travel together. On a UI that
 * predates the styling it degrades to a plain notice, which still reads fine.
 *
 * Duration is omitted rather than guessed when the turn's start was never seen
 * (attached mid-turn); tool calls are omitted when there were none.
 *
 * A FAILED turn takes the "Turn failed" prefix instead, and carries the error
 * (HIV-1914). This function used to have no error parameter at all, which made
 * a turn that died before it ever reached the model byte-identical on the wire
 * to one that succeeded. The cost of that was measured: on 2026-08-15 a sandbox
 * allowlist gap blocked auth.openai.com, every openai-codex agent failed its
 * OAuth refresh, and eight of eight sessions posted nothing but
 * `Turn finished · 0s`. Hive's own diagnose_agent_session called them healthy —
 * correctly, since attach, steer and report all worked — and the operator spent
 * two hours in the wrong subsystem. The error existed the whole time, in the
 * pane, one variable away from being reportable.
 *
 * The old UI contract is preserved by not touching the success path: a client
 * on this build talking to a server that predates "Turn failed" degrades to a
 * plain notice carrying the error text, which is still strictly more than the
 * nothing it said before.
 */
export function turnEndNotice(
	startedAtMs: number | undefined,
	toolCalls: number,
	nowMs: number,
	error?: string,
): string {
	const failure = (error ?? "").trim();
	const parts = [failure ? "Turn failed" : "Turn finished"];
	if (startedAtMs !== undefined && nowMs >= startedAtMs) parts.push(fmtDuration(nowMs - startedAtMs));
	if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
	// Last, so the machine-readable head of the line stays fixed regardless of
	// how long or how strangely shaped the provider's message is.
	if (failure) parts.push(truncateError(failure));
	return parts.join(" · ");
}

/** One line, bounded. A provider error can be a whole stack; the transcript row
 *  wants the sentence that names the cause. */
function truncateError(s: string): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length <= MAX_TURN_ERROR ? oneLine : oneLine.slice(0, MAX_TURN_ERROR - 1) + "…";
}

/** 42s under 90s, then 3m 12s, then 1h 4m — the units an operator thinks in. */
function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * foldToolStart records an in-flight call so its end can be paired with its
 * arguments. Bounded and oldest-first evicting: an aborted tool may never emit
 * its end event, and this map must not grow for the life of the session.
 */
export function foldToolStart(t: Transcript, toolCallId: string, name: string, args?: unknown): void {
	if (!toolCallId || !name) return;
	if (t.pending.size >= MAX_PENDING_TOOLS) {
		const oldest = t.pending.keys().next();
		if (!oldest.done) t.pending.delete(oldest.value);
	}
	// Arguments get a QUARTER of the result's budget — the server's own split
	// (64 KB vs 256 KB). A large `write` is the payload that hits it, and a
	// truncated one costs the transcript its diff.
	t.pending.set(toolCallId, { name, args: stringify(args, ARGS_BUDGET), batch: t.batches.get(toolCallId) });
}

/**
 * foldToolEnd emits ONE paired event carrying the call and its result, so the
 * UI renders a single card rather than two rows it has to correlate.
 *
 * An end without a matching start still emits, using whatever name it carries:
 * a tool call that ran is worth showing even if its start was evicted.
 */
export function foldToolEnd(
	t: Transcript,
	toolCallId: string,
	name: string,
	result: unknown,
	isError: boolean,
	atMs?: number,
): void {
	const started = t.pending.get(toolCallId);
	t.pending.delete(toolCallId);
	const batch = started?.batch ?? t.batches.get(toolCallId);
	t.batches.delete(toolCallId);
	const toolName = name || started?.name || "";
	if (!toolName) return;
	push(t, {
		role: "tool",
		kind: "tool_call",
		tool_name: toolName,
		tool_args: started?.args,
		tool_result: stringify(result),
		tool_batch_id: batch?.id,
		tool_batch_index: batch?.index,
		tool_batch_size: batch?.size,
		is_error: isError || undefined,
		client_ts: iso(atMs),
	});
}

/**
 * drain removes and returns up to `limit` queued events.
 *
 * The caller re-queues on failure, which is why this returns them rather than
 * marking them sent: an event that left the queue but never reached the server
 * would be lost, and the server's idempotency makes re-sending free.
 */
export function drain(t: Transcript, limit: number): WireEvent[] {
	if (limit <= 0) return [];
	return t.queue.splice(0, limit);
}

/** requeue puts a failed batch back at the FRONT, preserving seq order. */
export function requeue(t: Transcript, events: WireEvent[]): void {
	if (events.length === 0) return;
	t.queue.unshift(...events);
	// Re-queuing can exceed the cap; trim from the END so the oldest unsent
	// events (the ones the server is still missing) survive.
	if (t.queue.length > MAX_QUEUE) {
		t.dropped += t.queue.length - MAX_QUEUE;
		t.queue.length = MAX_QUEUE;
	}
}

/**
 * stringify renders a tool payload for display, WITHIN the server's byte cap.
 *
 * The cap is not advisory: Hive truncates an over-long field on insert, and
 * truncating JSON cuts it mid-token, so what lands in the database no longer
 * parses. Every consumer that wanted the structured payload — the transcript
 * widgets above all — then gets nothing, with nothing saying why.
 *
 * So the budget is applied HERE, where the payload can still be pruned
 * intelligently: drop the largest sub-trees and mark them, rather than let the
 * server cut the tail. See ./budget.
 *
 * Anything unserializable (a cycle, a BigInt) still degrades to a marker rather
 * than throwing INSIDE an event handler, where a throw becomes an agent-loop
 * error.
 */
function stringify(v: unknown, budget = RESULT_BUDGET): string | undefined {
	return budgeted(v, budget);
}

function iso(atMs?: number): string | undefined {
	if (atMs === undefined) return undefined;
	try {
		return new Date(atMs).toISOString();
	} catch {
		return undefined;
	}
}
/**
 * The incremental output of a message_update, and WHICH stream it belongs to.
 *
 * pi emits `thinking_delta` alongside `text_delta`; this used to match only the
 * latter, so every token of reasoning was dropped at the client — on a
 * high-thinking model, most of the wall-clock of a turn, during which the Hive
 * pane showed nothing at all.
 */
export function deltaOf(event: unknown): { text: string; thinking: boolean } {
	const e = event as { assistantMessageEvent?: { type?: string; delta?: string } };
	const inner = e?.assistantMessageEvent;
	if (typeof inner?.delta !== "string" || !inner.delta) return { text: "", thinking: false };
	if (inner.type === "text_delta") return { text: inner.delta, thinking: false };
	if (inner.type === "thinking_delta") return { text: inner.delta, thinking: true };
	return { text: "", thinking: false };
}

/**
 * The finalized reasoning of one assistant message.
 *
 * REDACTED BLOCKS ARE NAMED, not skipped. A provider that filters its own
 * reasoning returns an opaque signature and no prose; dropping it silently would
 * make a turn that reasoned look like one that did not, which is the same
 * ambiguity — nothing on screen, two possible causes — this whole feature exists
 * to remove. Saying so costs one line and answers the question.
 */
export function thinkingOf(msg: AssistantMessage): string {
	const content = (msg as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let redacted = false;
	for (const block of content) {
		if (!block || typeof block !== "object" || (block as { type?: string }).type !== "thinking") continue;
		const b = block as { thinking?: unknown; redacted?: unknown };
		if (b.redacted === true) {
			redacted = true;
			continue;
		}
		if (typeof b.thinking === "string" && b.thinking.trim()) parts.push(b.thinking);
	}
	if (parts.length > 0) return parts.join("\n\n");
	return redacted ? "(the provider redacted this reasoning)" : "";
}

/**
 * The notice text for a plan sent back for questions (HIV-2080).
 *
 * A FUNCTION rather than an inline template because this string is a contract,
 * not prose: the browser recognises the row by its prefix and reads the round
 * out of it (web/src/lib/planGrill.ts), exactly as it already does for "Turn
 * finished" and "Turn failed". A contract that exists only as an interpolation
 * at one call site is one nobody can test, and the failure mode of getting it
 * wrong is silent — the row renders as an unstyled grey line and the operator
 * simply never sees that their decline landed.
 */
export const PLAN_GRILL_NOTICE_PREFIX = "Plan sent back for questions";

export function grillNoticeText(round: number, stepCount: number): string {
	const steps = Number.isFinite(stepCount) && stepCount > 0 ? stepCount : 0;
	return `${PLAN_GRILL_NOTICE_PREFIX} · round ${round} · ${steps} step${steps === 1 ? "" : "s"}`;
}
