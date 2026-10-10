/**
 * A turn the provider CUT OFF is not retried unchanged.
 *
 * pi retries a retryable provider error inside the run (`_prepareRetry` →
 * `agent.continue()`, settings.retry: 3 attempts from a 2 s base), and
 * "terminated" — the stream closed under the model — is on its retryable list.
 * The retry re-sends the identical request: same context, same thinking level.
 *
 * Measured 2026-10-10 (session 8bbc4b22): a turn spent 15 minutes thinking and
 * was cut off; pi retried it 3 s, 4 s and 8 s later, and each retry thought for
 * 15 minutes and was cut off again — four failures, 56 minutes dark, nothing
 * emitted but thinking. An operator message queued at minute 27 got no answer
 * for half an hour.
 *
 * So, at the `turn_end` of a cut-off — which pi dispatches BEFORE it schedules
 * the retry, and whose boundary entries it commits into the context the retry
 * is built from (only the failed message itself is omitted):
 *
 *   - a notice is appended: how long the turn ran, and to act in smaller steps
 *     with an early tool call. The retry is no longer the same request.
 *   - the thinking level is capped at `low` until the next completed turn, when
 *     the operator's level is restored (unless they changed it meanwhile).
 *   - a queued operator message goes FIRST. pi's continuation drains the steer
 *     queue before its first request, so a steer lands right after the notice;
 *     a follow-up is delivered only when the agent stops, so the notice tells
 *     the model to stop at once when no message is shown.
 *   - at the second consecutive cut-off with nothing queued, the retry is
 *     stopped (`ctx.abort()` — pi checks for it before retrying) and the
 *     session is marked as needing a person; the settle observer turns that
 *     into the `needs_input` status Hive's attention reads.
 *
 * A SHORT "terminated" (a connection reset seconds in) is a transport blip that
 * pi's identical retry is right for, so only a turn that ran for a while counts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A termination this far into a turn is the model running long, not a blip. */
export const CUT_OFF_MIN_MS = 60_000;

/** Consecutive cut-offs after which automatic retries stop. */
export const MAX_CUT_OFFS = 2;

/** The thinking level a retry after a cut-off is capped at. */
export const CUT_OFF_THINKING = "low" as const;

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const STATUS_KEY = "agenda-cutoff";

/** Did the provider cut this turn off? Pure over the turn's message and duration. */
export function isCutOff(message: unknown, elapsedMs: number, minMs = CUT_OFF_MIN_MS): boolean {
	const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
	if (m?.role !== "assistant" || m.stopReason !== "error" || typeof m.errorMessage !== "string") return false;
	return /\bterminated\b/i.test(m.errorMessage) && elapsedMs >= minMs;
}

export interface CutOffDecision {
	/** Appended to the context the next request is built from. */
	notice: string;
	/** Stop pi's automatic retry and hand the session to a person. */
	stop: boolean;
}

function minutes(ms: number): number {
	return Math.max(1, Math.round(ms / 60_000));
}

/**
 * What to do about the `streak`-th consecutive cut-off. Pure, so the wording and
 * the stop rule are testable without a session.
 *
 * A queued operator message always wins over stopping: answering a person is
 * not an automatic retry, and stopping would strand the message.
 */
export function decideCutOff(input: { streak: number; durationsMs: readonly number[]; pending: boolean }): CutOffDecision {
	const last = minutes(input.durationsMs[input.durationsMs.length - 1] ?? 0);
	const cut = `Your last turn was cut off by the model provider after ${last} min ("terminated") before it finished; nothing from it was kept.`;
	if (input.pending) {
		return {
			stop: false,
			notice: [
				cut,
				"An operator message is queued for you and takes priority over resuming the interrupted work.",
				"If it is not shown right after this notice, reply with one short line and end your turn now —",
				"it is delivered as soon as you stop. Then act in smaller steps: keep reasoning short and emit a tool call early.",
			].join(" "),
		};
	}
	if (input.streak >= MAX_CUT_OFFS) {
		const runs = input.durationsMs.map((ms) => `${minutes(ms)} min`).join(", ");
		return {
			stop: true,
			notice: [
				`Your last ${input.streak} turns were each cut off by the model provider (${runs}; "terminated").`,
				"Automatic retries are stopped and the session is waiting for an operator.",
				"When work resumes, act in smaller steps: keep reasoning short and emit a tool call early.",
			].join(" "),
		};
	}
	return {
		stop: false,
		notice: [
			cut,
			"It is being retried now. Act in smaller steps: keep your reasoning short, emit a tool call early,",
			"and continue the work from there rather than planning all of it in one turn.",
		].join(" "),
	};
}

/** One-line status for Hive's attention when retries were stopped. */
export function stoppedRecap(durationsMs: readonly number[]): string {
	const runs = durationsMs.map((ms) => `${minutes(ms)}m`).join(", ");
	return `Needs operator: provider cut off ${durationsMs.length} turns in a row (${runs}); automatic retries stopped`;
}

export interface CutOffGuard {
	/** The recap to surface while retries are stopped and nobody has resumed the session, else null. */
	stopped(): string | null;
}

export interface CutOffOptions {
	/** Minimum turn length that counts as a cut-off. Tests pass 0. */
	minMs?: number;
	now?: () => number;
}

export function installCutOffGuard(pi: ExtensionAPI, options: CutOffOptions = {}): CutOffGuard {
	const now = options.now ?? Date.now;
	const minMs = options.minMs ?? CUT_OFF_MIN_MS;
	let turnStartedAt: number | null = null;
	let durations: number[] = [];
	let stopped: string | null = null;
	/** The operator's thinking level while a cap is in force. */
	let cappedFrom: ReturnType<ExtensionAPI["getThinkingLevel"]> | null = null;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* session replaced — status is cosmetic */
		}
	};

	const reset = (ctx: ExtensionContext | null) => {
		durations = [];
		if (stopped !== null && ctx) setStatus(ctx, undefined);
		stopped = null;
	};

	const restoreThinking = () => {
		if (cappedFrom === null) return;
		// Only undo our own cap: a level the operator chose since then stands.
		if (pi.getThinkingLevel() === CUT_OFF_THINKING) pi.setThinkingLevel(cappedFrom);
		cappedFrom = null;
	};

	const capThinking = () => {
		const level = pi.getThinkingLevel();
		if (THINKING_ORDER.indexOf(level) <= THINKING_ORDER.indexOf(CUT_OFF_THINKING)) return;
		cappedFrom ??= level;
		pi.setThinkingLevel(CUT_OFF_THINKING);
	};

	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
		turnStartedAt = null;
		cappedFrom = null;
	});

	// A person typing has taken over; the streak is about the automatic retries.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		reset(ctx);
	});

	pi.on("turn_start", () => {
		turnStartedAt = now();
	});

	pi.on("turn_end", (event, ctx) => {
		const elapsed = turnStartedAt === null ? 0 : now() - turnStartedAt;
		turnStartedAt = null;
		if (event.outcome === "completed") {
			reset(ctx);
			restoreThinking();
			return;
		}
		if (event.outcome !== "error" || !isCutOff(event.message, elapsed, minMs)) return;

		durations = [...durations, elapsed];
		const decision = decideCutOff({ streak: durations.length, durationsMs: durations, pending: ctx.hasPendingMessages() });
		capThinking();
		if (decision.stop) {
			stopped = stoppedRecap(durations);
			setStatus(ctx, `turns cut off ×${durations.length} — automatic retries stopped`);
			ctx.abort();
		}
		return {
			entries: [...event.entries, { type: "custom_message", customType: "agenda", content: decision.notice, display: true }],
		};
	});

	return { stopped: () => stopped };
}
