/**
 * status-footer — generation-speed timing.
 *
 * The last turn's decode throughput (tok/s) and the session's average
 * time-to-first-token (TTFT), for the session row. Pure and self-contained
 * (type-only imports, which erase) so it is testable without a pi harness and
 * without dragging in render.ts's `pi-tui` / hive / linear module graph.
 *
 * The MEASUREMENT is the one hive-pi #70 added to the hive-telemetry extension
 * (see `extensions/hive-telemetry/accumulator.ts timedTurnContribution` and the
 * message_start/update/end handlers in that extension's index.ts):
 *   - message_start (assistant) ≈ headers received → headersAt
 *   - the FIRST message_update after it → firstTokenAt (stamped once, O(1))
 *   - message_end → endAt
 *   decode tok/s = output / ((endAt − firstTokenAt) / 1000)
 *   TTFT        = firstTokenAt − headersAt
 * counted only for a streamed, output>0, normally-stopped assistant message.
 *
 * The rule is DELIBERATELY duplicated rather than imported: pi builds a fresh
 * jiti instance per extension with `moduleCache: false`, so a cross-extension
 * import would be a second copy anyway, and it would pull accumulator.ts's whole
 * module graph in for four lines of arithmetic.
 */

import type { StopReason } from "@earendil-works/pi-ai";

/** The clock readings for ONE in-flight assistant message. */
export interface TurnTiming {
	/** Date.now() at message_start — the provider pushes the stream "start" AFTER
	 * the HTTP await, so this ≈ response headers received, the TTFT baseline. */
	headersAt: number;
	/** Date.now() at the FIRST message_update (the first output token); null when
	 * the message never streamed (a non-streaming reply emits start then end with
	 * no update between). */
	firstTokenAt: number | null;
	/** Date.now() at message_end. */
	endAt: number;
}

/** Stop reasons that mark a COMPLETE decode worth timing. A truncated or failed
 * decode (aborted/error/pending/deferred) would understate throughput, so it
 * contributes nothing; `length` is a clean stop at the token cap. Kept in sync
 * with hive-telemetry/accumulator.ts TIMED_STOP_REASONS. */
const TIMED_STOP_REASONS = new Set<string>(["stop", "toolUse", "length"]);

/**
 * deriveTurnSpeed returns one assistant message's decode/ttft split, or null
 * when there is no honest measurement to make: the turn never streamed a token,
 * produced no output, stopped abnormally, a clock skew inverted an interval, or
 * the whole decode landed inside one clock tick (endAt === firstTokenAt would
 * make tok/s Infinity — telemetry never hits this because it divides summed
 * totals at read time, whereas we divide per turn).
 */
export function deriveTurnSpeed(
	timing: TurnTiming,
	output: number,
	stopReason: StopReason | string | undefined,
): { tokPerSec: number; ttftMs: number } | null {
	if (timing.firstTokenAt === null) return null;
	if (!(output > 0)) return null;
	if (!TIMED_STOP_REASONS.has(String(stopReason))) return null;
	const generationMs = timing.endAt - timing.firstTokenAt;
	const ttftMs = timing.firstTokenAt - timing.headersAt;
	if (generationMs <= 0 || ttftMs < 0) return null;
	return { tokPerSec: output / (generationMs / 1_000), ttftMs };
}

/**
 * speedCell formats the plain-text speed segment for the session row, or ""
 * when there is nothing honest to show. It returns UNTHEMED text so the caller's
 * single `theme.fg("dim", …)` wraps it alongside the rest of the row.
 *
 *   - Before the first timed turn (avgTtftMs null) → "" (no startup noise).
 *   - After a turn that did NOT stream → "— tok/s" for the last-turn throughput,
 *     never a 0 or a bogus number; the session's avg TTFT still shows.
 */
export function speedCell(lastTokPerSec: number | null, avgTtftMs: number | null): string {
	if (avgTtftMs === null) return "";
	const tps = lastTokPerSec === null ? "— tok/s" : `${Math.round(lastTokPerSec)} tok/s`;
	return `${tps} · ttft ${Math.round(avgTtftMs)} ms`;
}

/**
 * SpeedTracker holds the per-session timing across one assistant message's
 * start/update/end stream and folds each timed turn into a running average.
 *
 * `moduleCache: false` means this must be instantiated in the extension's
 * per-session closure and reset on session_start — closure state outlives /new.
 * The update() hot path is a single null-check per token; nothing allocates.
 */
export class SpeedTracker {
	private inflight: { headersAt: number; firstTokenAt: number | null } | null = null;
	private lastTps: number | null = null;
	private ttftSumMs = 0;
	private ttftCount = 0;

	/** message_start (assistant): re-arm unconditionally — a new message supersedes
	 * any prior slot whose stream was aborted before its end. */
	start(now: number): void {
		this.inflight = { headersAt: now, firstTokenAt: null };
	}

	/** message_update (per token): stamp the first one and ignore the rest. O(1). */
	update(now: number): void {
		const t = this.inflight;
		if (t !== null && t.firstTokenAt === null) t.firstTokenAt = now;
	}

	/** message_end (assistant): consume the slot. A timed turn sets last-turn
	 * tok/s and folds its TTFT into the average; an untimed turn (non-streaming,
	 * aborted, error, no output) clears last-turn tok/s to a dash and leaves the
	 * average untouched. */
	end(output: number, stopReason: StopReason | string | undefined, now: number): void {
		const inflight = this.inflight;
		this.inflight = null;
		if (inflight === null) {
			this.lastTps = null;
			return;
		}
		const speed = deriveTurnSpeed(
			{ headersAt: inflight.headersAt, firstTokenAt: inflight.firstTokenAt, endAt: now },
			output,
			stopReason,
		);
		if (speed === null) {
			this.lastTps = null;
			return;
		}
		this.lastTps = speed.tokPerSec;
		this.ttftSumMs += speed.ttftMs;
		this.ttftCount += 1;
	}

	/** Throughput of the most recent timed turn; null after an untimed one. */
	get lastTokPerSec(): number | null {
		return this.lastTps;
	}

	/** Mean TTFT over the session's timed turns; null until there is one. */
	get avgTtftMs(): number | null {
		return this.ttftCount === 0 ? null : this.ttftSumMs / this.ttftCount;
	}

	/** The session's speed segment, ready to drop into the session row (or ""). */
	cell(): string {
		return speedCell(this.lastTokPerSec, this.avgTtftMs);
	}

	/** Drop all state — call on session_start; closure state outlives /new. */
	reset(): void {
		this.inflight = null;
		this.lastTps = null;
		this.ttftSumMs = 0;
		this.ttftCount = 0;
	}
}
