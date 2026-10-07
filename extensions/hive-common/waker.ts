/**
 * The one way an automatic notice may wake the agent.
 *
 * Every extension that tells the agent something it did not ask for in this
 * turn — a background job finished, an orchestration landed, a teammate wrote —
 * used to call `pi.sendMessage(…, {deliverAs:"followUp", triggerTurn:true})`
 * directly. Two things made that the "it should have stopped and it kept going"
 * bug (measured in `handback.ts`):
 *
 * 1. **Idle:** nothing asked whether the agent had just handed the turn back.
 *    A plan put up for approval, a pending grant, a question in prose — the
 *    next completion notice woke the agent anyway, and the model read the wake
 *    as licence to carry on.
 *
 * 2. **Mid-run:** pi's `sendCustomMessage` puts a streaming `triggerTurn` message
 *    on the agent's FOLLOW-UP queue, and the agent loop drains that queue at
 *    "Agent would stop here" (`agent-loop.js`). So a notice that arrived while
 *    the agent was still writing its plan or its question was processed right
 *    after the final word, and the run simply did not end.
 *
 * The fix is one decision point:
 *
 *   - **Idle** → classify the branch. Wake only when the hand-back allows it;
 *     otherwise append the notice (visible, in context for the human's next
 *     prompt) without starting a turn.
 *   - **Streaming** → never touch the follow-up queue. Send with
 *     `triggerTurn:false`, which pi appends at the end of the current turn, and
 *     record a pending wake. If the run continues, the model reads it in its
 *     next turn and the wake is spent. If the run ends, this waker's own
 *     `agent_before_settle` handler classifies the final turn and either asks
 *     for one continuation or leaves the notice parked.
 *   - **Settling** (between this waker's `agent_before_settle` and
 *     `agent_settled`) → hold the notice in memory and deliver it with the idle
 *     rule from `agent_settled`, or as streaming if the run continued instead.
 *
 * Nothing is dropped: a held notice is in the transcript, in front of the human
 * and the model alike. A held notice that WANTED to wake is announced in the
 * footer so a parked session never looks finished for no reason.
 *
 * Each extension builds its own waker (`createWaker(pi, by)`) — extensions are
 * separate module instances, so state cannot be shared. The settle claim
 * (`settle-claim.ts`) keeps them, the agenda driver and plan auto-continue to at
 * most one continuation per settle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyHandback, isFirmHandback, NO_HANDBACK, type Handback } from "./handback.ts";
import { trackSettleClaims } from "./settle-claim.ts";

/**
 * What kind of notice this is, which decides what a hand-back holds.
 *
 *   - `completion` — the agent's own work landed (background job, orchestration).
 *     The agent asked to be told, so only a FIRM hand-back holds it: a gate a
 *     person must open, or a question / decision put to them. A bare "standing
 *     by" while a CI watcher runs must still hear the verdict.
 *   - `message` — a message addressed to this agent by another (teammate,
 *     controller, agmsg peer). The agent may be waiting on exactly that sender,
 *     so only a STRUCTURED hand-back (plan approval, pending grant, abort, an
 *     unanswered `plan_ask`) holds it; a text hand-back wakes it with a reminder
 *     of what it is still waiting for.
 */
export type NoticeKind = "completion" | "message";

export interface Notice {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

export type WakeDecision = { wake: true; reminder?: string } | { wake: false };

/** Pure: may this notice wake an agent in this hand-back state? */
export function decideWake(kind: NoticeKind, handback: Handback): WakeDecision {
	if (handback.kind !== "human") return { wake: true };
	if (kind === "completion") return isFirmHandback(handback) ? { wake: false } : { wake: true };
	if (handback.structured) return { wake: false };
	return { wake: true, reminder: reminderFor(handback.reason) };
}

/**
 * Rides with a message that wakes an agent which had handed back in prose. The
 * sender may be exactly who the agent is waiting on (a controller answering
 * "blocked on controller decision"), so it must not forbid acting on an answer;
 * it forbids treating an unrelated message as one.
 */
export function reminderFor(reason: string): string {
	const what = reason === "question" || reason === "decision-request" ? "an answer to what you asked" : "the decision you said you are waiting for";
	return (
		`(This message arrived after you handed the turn back, waiting on ${what}. ` +
		"If it IS that answer, act on it. If not, reply to it if it needs a reply and keep waiting — do not resume the held work on your own.)"
	);
}

/** Footer line for notices held behind a hand-back. Enum words only — never notice content. */
function heldStatus(reason: string, held: number): string {
	return `⏸ waiting on you (${reason}) — ${held} notice${held === 1 ? "" : "s"} held`;
}

/**
 * Every waker paints the same footer key, so they share the count over the bus:
 * each announces its own parked total and renders the sum.
 */
const PARKED_CHANNEL = "hive.handback.parked";

interface ParkedEvent {
	by: string;
	count: number;
	reason: string;
}

export interface Waker {
	/**
	 * Deliver a notice under the hand-back rule. Throws if the session cannot be
	 * read or pi refuses the send — the session went away — so a caller that
	 * tracks "notified" (background) keeps the notice for the next session
	 * instead of losing it.
	 */
	deliver(notice: Notice, kind: NoticeKind): void;
}

interface PendingWake {
	kind: NoticeKind;
	/** Set once a `turn_end`/before-settle flush has put the notice in the transcript. */
	flushed: boolean;
}

export function createWaker(pi: ExtensionAPI, by: string): Waker {
	const claims = trackSettleClaims(pi);
	let ctx: ExtensionContext | null = null;
	let closed = false;
	// An agent run is active from `agent_start` to `agent_settled`. Tracked here
	// rather than read from `ctx.isIdle()`, which is also false during an idle
	// compaction — a notice sent then was treated as mid-run and its wake waited
	// for a settle that never came.
	let inRun = false;
	let settling = false;
	let pending: PendingWake[] = [];
	let held: Array<{ notice: Notice; kind: NoticeKind }> = [];
	const parked = new Map<string, ParkedEvent>();
	let paintedTotal = 0;

	const paintParked = () => {
		let total = 0;
		let reason = "";
		for (const entry of parked.values()) {
			total += entry.count;
			reason = entry.reason;
		}
		if (total === 0 && paintedTotal === 0) return; // nothing shown, nothing to clear
		paintedTotal = total;
		try {
			ctx?.ui.setStatus("handback", total > 0 ? heldStatus(reason, total) : undefined);
		} catch {
			/* a replaced session has no footer to paint; the next session_start repaints */
		}
	};

	pi.events.on(PARKED_CHANNEL, (data: unknown) => {
		const event = data as Partial<ParkedEvent> | undefined;
		if (typeof event?.by !== "string" || typeof event.count !== "number") return;
		parked.set(event.by, { by: event.by, count: event.count, reason: typeof event.reason === "string" ? event.reason : "hand-back" });
		paintParked();
	});

	const announceParked = (count: number, reason: string) => {
		pi.events.emit(PARKED_CHANNEL, { by, count, reason } satisfies ParkedEvent);
	};

	const park = (handback: Handback) => {
		const reason = handback.kind === "human" ? handback.reason : "hand-back";
		announceParked((parked.get(by)?.count ?? 0) + 1, reason);
	};

	/**
	 * The hand-back of the session this waker last saw. `null` when that ctx can
	 * no longer be read — the session was replaced and its successor's state is
	 * not known yet — which the callers answer by delivering WITHOUT waking:
	 * guessing "no hand-back" there could wake through a plan awaiting approval.
	 */
	const handbackNow = (): Handback | null => {
		if (!ctx) return NO_HANDBACK;
		let branch: readonly unknown[];
		try {
			branch = ctx.sessionManager.getBranch() as readonly unknown[];
		} catch {
			return null;
		}
		return classifyHandback(branch);
	};

	const sendStreaming = (notice: Notice, kind: NoticeKind) => {
		// `triggerTurn:false` while streaming → pi appends at the end of the
		// current turn and NEVER puts it on the follow-up queue.
		pi.sendMessage(notice, { deliverAs: "followUp", triggerTurn: false });
		pending.push({ kind, flushed: false });
	};

	/**
	 * `fromSettle` — only a delivery made inside the `agent_settled` chain may
	 * defer to a settle claim: a claim belongs to ONE settle, and outside its
	 * chain one left behind by a continuation that never started would silence
	 * every later wake.
	 */
	const sendIdle = (notice: Notice, kind: NoticeKind, fromSettle: boolean) => {
		const handback = handbackNow();
		if (!handback) {
			pi.sendMessage(notice, { deliverAs: "followUp", triggerTurn: false });
			return;
		}
		const decision = decideWake(kind, handback);
		if (!decision.wake || (fromSettle && claims.claimedBy() !== null)) {
			pi.sendMessage(notice, { deliverAs: "followUp", triggerTurn: false });
			if (!decision.wake) park(handback);
			return;
		}
		const content = decision.reminder ? `${notice.content}\n\n${decision.reminder}` : notice.content;
		pi.sendMessage({ ...notice, content }, { deliverAs: "followUp", triggerTurn: true });
		if (fromSettle) claims.claim(by);
	};

	/** The settle continued the run: deliver what it held the streaming way. */
	const releaseHeldIntoRun = () => {
		settling = false;
		const release = held;
		held = [];
		for (const item of release) sendStreaming(item.notice, item.kind);
	};

	const remember = (next: ExtensionContext) => {
		ctx = next;
	};

	pi.on("session_start", (_event, next) => {
		remember(next);
		closed = false;
		inRun = false;
		settling = false;
		pending = [];
		parked.clear();
		paintParked(); // clears a footer the replaced session left behind
		// Held notices belong to the originating branch. Persisted completion
		// evidence lets its owner recover them there; never transport them into
		// an unrelated session or fork.
		held = [];
	});

	const forgetBranch = () => {
		closed = true;
		ctx = null;
		inRun = false;
		settling = false;
		pending = [];
		held = [];
		parked.clear();
	};
	pi.on("session_shutdown", forgetBranch);
	pi.on("session_tree", (_event, next) => { forgetBranch(); remember(next); closed = false; paintParked(); });

	pi.on("agent_start", (_event, next) => {
		remember(next);
		inRun = true;
		// Anything appended before a run starts is in the context it reads.
		for (const wake of pending) wake.flushed = true;
		// A continued settle emits agent_start BEFORE turn_start.
		if (settling) releaseHeldIntoRun();
		if ((parked.get(by)?.count ?? 0) > 0) announceParked(0, "");
	});

	pi.on("turn_start", (_event, next) => {
		remember(next);
		// The model is about to read everything flushed so far: those wakes are spent.
		pending = pending.filter((wake) => !wake.flushed);
		if (settling) releaseHeldIntoRun();
	});

	pi.on("turn_end", (_event, next) => {
		remember(next);
		// pi flushes `triggerTurn:false` messages right after the turn_end dispatch.
		for (const wake of pending) wake.flushed = true;
	});

	pi.on("agent_before_settle", (event, next) => {
		remember(next);
		settling = true;
		// Everything still pending is flushed right after these handlers return.
		const wakes = pending;
		pending = [];
		for (const wake of wakes) wake.flushed = true;
		if (wakes.length === 0 || event.outcome !== "completed") return;
		if (event.continue || claims.claimedBy()) return; // someone else is already continuing the run
		const handback = handbackNow();
		if (!handback) return;
		const decisions = wakes.map((wake) => decideWake(wake.kind, handback));
		if (!decisions.some((decision) => decision.wake)) {
			park(handback);
			return;
		}
		claims.claim(by);
		// The notice is already in the transcript, so a wake that carries a
		// reminder adds it as its own entry rather than amending the notice.
		const reminder = decisions.find((decision): decision is { wake: true; reminder: string } => decision.wake && decision.reminder !== undefined)?.reminder;
		return reminder
			? { entries: [...event.entries, { type: "custom_message" as const, customType: "handback", content: reminder, display: true }], continue: true }
			: { continue: true };
	});

	pi.on("agent_settled", (_event, next) => {
		remember(next);
		inRun = false;
		settling = false;
		const release = held;
		held = [];
		for (const item of release) sendIdle(item.notice, item.kind, true);
	});

	return {
		deliver(notice, kind) {
			if (closed) throw new Error("Cannot deliver notice after session shutdown");
			if (settling) {
				held.push({ notice, kind });
				return;
			}
			if (inRun) sendStreaming(notice, kind);
			else sendIdle(notice, kind, false);
		},
	};
}
