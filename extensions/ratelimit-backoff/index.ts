/**
 * ratelimit-backoff — resume a turn that died on a provider rate limit, after
 * an escalating wait, out loud, and only so many times.
 *
 * Why an extension and not pi's retry setting alone: pi's in-turn retry is
 * bounded and fast (settings.retry), and when it gives up the turn simply
 * fails — the session is idle with nobody to continue it. This is the layer
 * ABOVE that: per failed turn, wait longer, then send the same "continue"
 * follow-up credential-recovery sends after an account swap. See policy.ts
 * for the schedule and the measured case.
 *
 * Cancellation: any human or extension input, a model switch, or a session
 * replacement drops the pending continuation — a person who typed has taken
 * over, and a stale timer must not fire into their conversation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUE_MESSAGE, gaveUpStatus, isRateLimitedText, nextBackoff, waitingStatus } from "./policy.ts";

export const RATELIMIT_CHANNEL = "hive.ratelimit-backoff";

const STATUS_KEY = "ratelimit-backoff";

export default function ratelimitBackoff(pi: ExtensionAPI): void {
	let streak = 0;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latestCtx: ExtensionContext | undefined;

	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const clear = (ctx: ExtensionContext | undefined) => {
		cancel();
		streak = 0;
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		generation++;
		latestCtx = ctx;
		clear(ctx);
	});
	pi.on("session_shutdown", () => {
		generation++;
		cancel();
		latestCtx = undefined;
	});
	pi.on("input", (event) => {
		// A person (or another extension) has taken the next turn; the pending
		// continuation would be a second, competing prompt.
		if (event.source === "extension") return;
		cancel();
	});
	pi.on("model_select", (_event, ctx) => {
		// A new model is a new rate limit; start the ladder over.
		clear(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		latestCtx = ctx;
		const newest = event.messages.findLast((message) => message.role === "assistant");
		if (!newest || newest.role !== "assistant") return;
		const error = newest.stopReason === "error" ? newest.errorMessage : undefined;
		if (!isRateLimitedText(error)) {
			// Any turn that reached the provider — or failed for another reason,
			// which is another extension's business — resets the ladder.
			if (streak > 0) clear(ctx);
			return;
		}
		const decision = nextBackoff(streak, String(error));
		streak += 1;
		if (!decision) {
			cancel();
			ctx.ui.setStatus(STATUS_KEY, gaveUpStatus(streak));
			pi.events.emit(RATELIMIT_CHANNEL, { state: "gave-up", streak });
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, waitingStatus(decision));
		pi.events.emit(RATELIMIT_CHANNEL, { state: "waiting", attempt: decision.attempt, delayMs: decision.delayMs, source: decision.source });
		if (ctx.mode === "json" || ctx.mode === "rpc") {
			process.stdout.write(JSON.stringify({ type: "ratelimit_backoff", state: "waiting", attempt: decision.attempt, delayMs: decision.delayMs }) + "\n");
		}
		cancel();
		const gen = generation;
		timer = setTimeout(() => {
			timer = undefined;
			const current = latestCtx;
			if (gen !== generation || !current) return;
			// Someone else may have continued the session while we waited.
			if (!current.isIdle() || current.hasPendingMessages() || current.signal?.aborted) return;
			current.ui.setStatus(STATUS_KEY, undefined);
			pi.events.emit(RATELIMIT_CHANNEL, { state: "continuing", attempt: decision.attempt });
			pi.sendMessage(
				{ customType: "ratelimit-backoff", content: CONTINUE_MESSAGE, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}, decision.delayMs);
		timer.unref?.();
	});
}
