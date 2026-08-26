/**
 * The `/loop` policy and its tick.
 *
 * This is the first thing in the harness that re-enters the agent loop from a
 * TIMER rather than in response to a settle, so the delivery path is the part
 * worth reading carefully.
 *
 * The timer NEVER injects. It does two synchronous things — ask a pure fold
 * whether a fire is owed, and set a flag — and nothing else. Delivery happens
 * either from an idle-gated deferral or from the next `agent_settled`, both of
 * which run through the driver's single injection point. Injecting from the
 * interval body directly would be wrong twice over: `triggerTurn` silently
 * degrades to a queued follow-up while streaming (`agent-session.js:1077-1083`),
 * and the driver's caps, question guard and idle check would all be bypassed.
 *
 * Spike U2, resolved from source: `sendCustomMessage` has no gate on being
 * inside an event handler, so a timer-driven injection starts a real turn when
 * idle exactly as a settle-driven one does.
 */

import type { Policy, PolicyContext, PolicyWork } from "./policy.ts";
import {
	applyKeepaliveLapse,
	expiryCheck,
	isDue,
	type LoopItem,
	recordFire,
} from "./loop-state.ts";

export interface LoopHooks {
	current(): LoopItem | null;
	commit(loop: LoopItem): void;
	/** Called immediately before a loop injection, to re-assert the tool set. */
	beforeInject?(): void;
}

/**
 * The loop policy. Unlike the gate and the goal it does no expensive work — the
 * decision is already made by the time it is asked, so `run()` is a formality
 * that hands the driver the text to inject.
 */
export function createLoopPolicy(hooks: LoopHooks, now: () => number = Date.now): Policy {
	return {
		name: "loop",

		decide(_context: PolicyContext): PolicyWork | null {
			const loop = hooks.current();
			if (!loop || loop.state !== "active") return null;

			const at = now();

			// Lifetime bounds are checked BEFORE dueness, so an expired loop stops
			// on the next settle rather than lingering until its next fire — which
			// for a 7-day-expired hourly loop would otherwise never come.
			const terminal = expiryCheck(loop, at);
			if (terminal) {
				hooks.commit({ ...loop, state: terminal, nextAt: null, keepaliveArmed: false, updatedAt: at });
				return {
					name: "loop",
					status: "",
					run: async () => ({ metric: { outcome: "skip", value: 0 } }),
				};
			}

			if (!isDue(loop, at)) return null;

			// The keepalive came due and the model never re-armed. Silence ends a
			// self-paced loop; liveness is opt-in by design.
			if (loop.keepaliveArmed) {
				hooks.commit(applyKeepaliveLapse(loop, at));
				return {
					name: "loop",
					status: "",
					run: async () => ({ metric: { outcome: "skip", value: 0 } }),
				};
			}

			const fired = recordFire(loop, at);
			const prompt = loop.prompt;

			return {
				name: "loop",
				status: "loop: waking",
				run: async () => {
					hooks.commit(fired);
					hooks.beforeInject?.();
					return {
						metric: { outcome: "fail", value: 0 },
						inject: prompt,
					};
				},
			};
		},
	};
}

/**
 * The tick. One interval for the whole extension, `unref`'d so it can never
 * hold the process open on its own.
 *
 * It is deliberately anaemic: a pure `isDue` check and a callback. Everything
 * that could throw, block, or touch `ctx` happens elsewhere.
 */
export interface TickHandle {
	stop(): void;
}

export function startTick(
	shouldWake: () => boolean,
	onDue: () => void,
	intervalMs = 1_000,
): TickHandle {
	const timer = setInterval(() => {
		try {
			if (shouldWake()) onDue();
		} catch {
			/* a tick must never take the session down */
		}
	}, intervalMs);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
}
