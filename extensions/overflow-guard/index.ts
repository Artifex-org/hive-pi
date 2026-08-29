/**
 * overflow-guard — break the loop when a session wedges against its own context
 * window (HIV-3060).
 *
 * THE FAILURE, MEASURED over 875 local transcripts on 2026-08-29. Once a
 * session's context reaches the provider's hard prompt limit, every further
 * request is refused before it runs, and **each refusal leaves the context
 * larger than the last** — the next attempt is strictly worse than the one
 * before it. Nothing in the harness noticed. Seven of 112 grok-4.6 sessions
 * died that way, 15.5 hours were spent on requests that could never be sent,
 * and the worst single session spent 12 h 27 m issuing eleven identical 400s.
 *
 * pi has recovery for exactly this — compact, then retry — but on this fleet it
 * stopped firing for grok after 2026-08-25 (0 compactions across the 6 sessions
 * that crossed the trip point, against 27 across the 18 before it, while terra
 * and sol compacted normally on the same builds). Whether that is a pi
 * regression is not settled here, and this extension deliberately does not
 * depend on the answer: it asks for the same recovery pi would have run, and
 * behaves correctly whether or not the request succeeds.
 *
 * TWO ACTIONS, AND NO MORE.
 *
 *  1. **Ask once for a compaction.** `ctx.compact()` is the same entry point
 *     hive-remote's remote `compact` command uses. One attempt per unbroken run
 *     of refusals: a compaction that did not help will not help on the second
 *     ask either, and a retry loop here would be the same burn loop one level up.
 *  2. **Say so, once.** A wedged session is indistinguishable from a busy one
 *     from outside — the heartbeat beats, commands are claimed, the spinner
 *     turns — so the status line is the only cheap place a human learns the
 *     session is finished rather than slow.
 *
 * WHAT IT DOES NOT DO. It does not end the session: that is an operator's call,
 * and a wedged session still holds a worktree someone may want to inspect. It
 * does not inject a turn, so the one-injector invariant in `agenda/driver.ts`
 * is untouched. It does not write to the model's context — everything it adds
 * would make the overflow it is trying to clear marginally worse.
 *
 * The other half of the fix is in `hive-common/overflow.ts`'s two callers: the
 * machine-generated wakes that were re-arming these sessions every few minutes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { overflowRunLength } from "../hive-common/overflow.ts";

export default function overflowGuard(pi: ExtensionAPI): void {
	// Factory closure, not module scope: pi builds a fresh jiti per extension
	// with `moduleCache: false`, so module-level state is not per-session.
	let compactionAsked = false;
	let announced = false;

	const clear = (ctx: ExtensionContext): void => {
		if (!compactionAsked && !announced) return;
		compactionAsked = false;
		announced = false;
		try {
			ctx.ui.setStatus("overflow-guard", undefined);
		} catch {
			// A replaced session has no UI to clear. Losing a status line is not
			// worth throwing into a settle handler.
		}
	};

	pi.on("agent_settled", (_event, ctx) => {
		let run: number;
		try {
			run = overflowRunLength(ctx.sessionManager.getBranch() as readonly unknown[]);
		} catch {
			// `ctx` throws once the session is replaced. A settle we cannot read
			// is a settle we have nothing to say about.
			return;
		}

		// The newest turn reached the provider, so whatever happened before is
		// history and the session is healthy again. Re-arm for the next run.
		if (run === 0) {
			clear(ctx);
			return;
		}

		if (!compactionAsked) {
			compactionAsked = true;
			try {
				ctx.ui.setStatus("overflow-guard", "context overflow — compacting");
			} catch {
				/* status is best-effort */
			}
			try {
				// Not awaited, for the reason every handler in this package states:
				// pi awaits extension handlers serially, so waiting on a
				// summarization round trip here WOULD BE the agent loop.
				ctx.compact();
			} catch {
				// A replaced context cannot compact. The announcement below still
				// runs on the next settle, which is the outcome that matters.
			}
			return;
		}

		if (!announced) {
			announced = true;
			try {
				ctx.ui.setStatus(
					"overflow-guard",
					"context overflow — compaction did not clear it; this session cannot send another request",
				);
			} catch {
				/* status is best-effort */
			}
		}
	});

	// A fresh session inherits none of this. Without the reset a forked or
	// resumed session would start believing it had already spent its attempt.
	pi.on("session_start", (_event, ctx) => clear(ctx));
}
