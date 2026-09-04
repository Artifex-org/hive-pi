/**
 * Loop scheduling — pure folds, so every timing rule is testable without
 * waiting for wall-clock time.
 *
 * The rules that matter most:
 *  - overdue fires COALESCE (no catch-up storm after a long turn);
 *  - fixed loops re-arm themselves, self-paced loops do not;
 *  - silence terminates a self-paced loop after exactly one grace wake.
 */

import { describe, expect, it } from "vitest";
import {
	applyKeepaliveLapse,
	applyWake,
	clampDelay,
	createLoop,
	DEFAULT_MAX_FIRES,
	expiryCheck,
	isDue,
	isTerminal,
	KEEPALIVE_MS,
	MAX_DELAY_MS,
	MAX_LIFETIME_MS,
	MAX_NOOP_STREAK,
	MIN_DELAY_MS,
	noopDelayFloor,
	recordFire,
	rehydrateLoop,
	stopLoop,
	validateLoop,
} from "../extensions/agenda/loop-state.ts";

const T0 = 1_700_000_000_000;
const fixed = () => createLoop("l1", "fixed", "check the deploy", T0, { intervalMs: 300_000 });
const paced = () => createLoop("l2", "self-paced", "keep going", T0);

describe("createLoop", () => {
	it("arms a fixed loop immediately", () => {
		expect(fixed().nextAt).toBe(T0 + 300_000);
	});

	it("leaves a self-paced loop unscheduled — its first turn is the command's own injection", () => {
		expect(paced().nextAt).toBeNull();
	});

	it("sets a 7-day expiry", () => {
		expect(fixed().expiresAt).toBe(T0 + MAX_LIFETIME_MS);
	});
});

describe("clampDelay", () => {
	it("floors sub-minute delays, which would be a busy-wait", () => {
		expect(clampDelay(5_000)).toEqual({ ms: MIN_DELAY_MS, clamped: true });
	});
	it("caps very long ones", () => {
		expect(clampDelay(99 * 3_600_000)).toEqual({ ms: MAX_DELAY_MS, clamped: true });
	});
	it("passes a reasonable delay through untouched", () => {
		expect(clampDelay(300_000)).toEqual({ ms: 300_000, clamped: false });
	});
});

describe("isDue", () => {
	it("is false before the scheduled time", () => {
		expect(isDue(fixed(), T0 + 100)).toBe(false);
	});
	it("is true at and after it", () => {
		expect(isDue(fixed(), T0 + 300_000)).toBe(true);
		expect(isDue(fixed(), T0 + 999_999)).toBe(true);
	});
	it("is false for an unscheduled loop", () => {
		expect(isDue(paced(), T0 + 999_999)).toBe(false);
	});
	it("is false once the loop is not active", () => {
		expect(isDue(stopLoop(fixed(), T0), T0 + 999_999)).toBe(false);
	});
});

describe("recordFire", () => {
	it("COALESCES overdue fires — one fire, then scheduled from now", () => {
		// A loop owed six fires during one long turn produces one, not six.
		const veryLate = T0 + 300_000 * 6;
		const next = recordFire(fixed(), veryLate);
		expect(next.fires).toBe(1);
		expect(next.nextAt).toBe(veryLate + 300_000);
	});

	it("re-arms a fixed loop without the model's help", () => {
		const next = recordFire(fixed(), T0 + 300_000);
		expect(next.nextAt).not.toBeNull();
		expect(next.keepaliveArmed).toBe(false);
	});

	it("arms exactly one keepalive for a self-paced loop", () => {
		const armed = { ...paced(), nextAt: T0 };
		const next = recordFire(armed, T0);
		expect(next.keepaliveArmed).toBe(true);
		expect(next.nextAt).toBe(T0 + KEEPALIVE_MS);
	});

	it("stops at the fire budget", () => {
		let current = { ...fixed(), fires: DEFAULT_MAX_FIRES - 1 };
		current = recordFire(current, T0);
		expect(current.state).toBe("exhausted");
		expect(current.nextAt).toBeNull();
	});

	it("stops once expired", () => {
		const next = recordFire(fixed(), T0 + MAX_LIFETIME_MS + 1);
		expect(next.state).toBe("expired");
		expect(next.nextAt).toBeNull();
	});
});

describe("applyWake", () => {
	it("schedules the requested delay", () => {
		const { loop } = applyWake(paced(), { delaySeconds: 300 }, T0);
		expect(loop.nextAt).toBe(T0 + 300_000);
	});

	it("clamps and says so", () => {
		const { loop, clamped } = applyWake(paced(), { delaySeconds: 5 }, T0);
		expect(clamped).toBe(true);
		expect(loop.nextAt).toBe(T0 + MIN_DELAY_MS);
	});

	it("stop:true ends the loop", () => {
		const { loop } = applyWake(paced(), { stop: true }, T0);
		expect(loop.state).toBe("stopped");
		expect(loop.nextAt).toBeNull();
	});

	it("clears the keepalive, granting a fresh grace period to a loop that is alive", () => {
		const armed = { ...paced(), keepaliveArmed: true, nextAt: T0 + KEEPALIVE_MS };
		const { loop } = applyWake(armed, { delaySeconds: 120 }, T0);
		expect(loop.keepaliveArmed).toBe(false);
	});

	it("records the reason for the user to see", () => {
		const { loop } = applyWake(paced(), { delaySeconds: 120, reason: "build is 2 min out" }, T0);
		expect(loop.lastReason).toBe("build is 2 min out");
	});

	it("counts consecutive noops and eventually advises stopping", () => {
		let current = paced();
		let advised = false;
		for (let i = 0; i < MAX_NOOP_STREAK; i++) {
			const result = applyWake(current, { noop: true, delaySeconds: 60 }, T0);
			current = result.loop;
			advised = result.advisedStop;
		}
		expect(current.noopStreak).toBe(MAX_NOOP_STREAK);
		expect(advised).toBe(true);
		// Advisory only — the loop is still running.
		expect(current.state).toBe("active");
	});

	it("resets the noop streak as soon as something happens", () => {
		let current = applyWake(paced(), { noop: true, delaySeconds: 60 }, T0).loop;
		current = applyWake(current, { delaySeconds: 60 }, T0).loop;
		expect(current.noopStreak).toBe(0);
	});

	it("defaults to the minimum delay when the model omits one", () => {
		const { loop } = applyWake(paced(), {}, T0);
		expect(loop.nextAt).toBe(T0 + MIN_DELAY_MS);
	});

	it("lengthens the delay when the model keeps asking for the floor on quiet ticks", () => {
		// The failure this prevents: a self-paced loop reporting `noop:true` while
		// asking for 60s every time polls at the minimum forever, and each wake is
		// a billed turn over a full context.
		let current = paced();
		const delays: number[] = [];
		for (let i = 0; i < 4; i++) {
			const result = applyWake(current, { noop: true, delaySeconds: 60 }, T0);
			current = result.loop;
			delays.push((current.nextAt ?? T0) - T0);
		}
		expect(delays).toEqual([MIN_DELAY_MS, MIN_DELAY_MS * 2, MIN_DELAY_MS * 4, MIN_DELAY_MS * 8]);
	});

	it("reports the hold as `backedOff`, distinct from an out-of-range `clamped`", () => {
		let current = applyWake(paced(), { noop: true, delaySeconds: 60 }, T0).loop;
		const result = applyWake(current, { noop: true, delaySeconds: 60 }, T0);
		expect(result.backedOff).toBe(true);
		expect(result.clamped).toBe(false);
	});

	it("honours a longer delay than the floor, and does not call that a backoff", () => {
		// The floor raises a minimum; it never overrides a model asking for more.
		let current = applyWake(paced(), { noop: true, delaySeconds: 60 }, T0).loop;
		const result = applyWake(current, { noop: true, delaySeconds: 600 }, T0);
		expect((result.loop.nextAt ?? T0) - T0).toBe(600_000);
		expect(result.backedOff).toBe(false);
	});

	it("restores full responsiveness the moment something actually happens", () => {
		// Cost of guessing wrong is one slow iteration, not a slow loop.
		let current = paced();
		for (let i = 0; i < 5; i++) {
			current = applyWake(current, { noop: true, delaySeconds: 60 }, T0).loop;
		}
		const result = applyWake(current, { delaySeconds: 60 }, T0);
		expect((result.loop.nextAt ?? T0) - T0).toBe(MIN_DELAY_MS);
		expect(result.backedOff).toBe(false);
	});
});

describe("noopDelayFloor", () => {
	it("leaves the first quiet tick at the minimum", () => {
		expect(noopDelayFloor(0)).toBe(MIN_DELAY_MS);
		expect(noopDelayFloor(1)).toBe(MIN_DELAY_MS);
	});

	it("doubles per consecutive quiet tick", () => {
		expect(noopDelayFloor(2)).toBe(MIN_DELAY_MS * 2);
		expect(noopDelayFloor(3)).toBe(MIN_DELAY_MS * 4);
	});

	it("never exceeds the range the model is allowed to ask for", () => {
		// Otherwise the floor could demand a delay clampDelay would then reject,
		// and the two bounds would disagree about the same number.
		expect(noopDelayFloor(50)).toBe(MAX_DELAY_MS);
		expect(noopDelayFloor(Number.MAX_SAFE_INTEGER)).toBe(MAX_DELAY_MS);
	});
});

describe("the keepalive lapse", () => {
	it("ends the loop as `dry`, distinct from the user stopping it", () => {
		// A loop that quietly ran out of things to say and one the user cancelled
		// are different events, and `/loop` reports the difference.
		const lapsed = applyKeepaliveLapse(paced(), T0);
		expect(lapsed.state).toBe("dry");
		expect(isTerminal(lapsed.state)).toBe(true);
		expect(stopLoop(paced(), T0).state).toBe("stopped");
	});
});

describe("expiryCheck", () => {
	it("passes a healthy loop", () => {
		expect(expiryCheck(fixed(), T0)).toBeNull();
	});
	it("catches the token budget", () => {
		const budgeted = { ...fixed(), tokenBudget: 100, tokens: 100 };
		expect(expiryCheck(budgeted, T0)).toBe("exhausted");
	});
});

describe("rehydration", () => {
	it("restores the newest loop", () => {
		const restored = rehydrateLoop([
			{ customType: "agenda", data: fixed() },
			{ customType: "agenda", data: { ...paced(), prompt: "newest" } },
		]);
		expect(restored?.prompt).toBe("newest");
	});

	it("ignores goal entries sharing the same customType", () => {
		expect(rehydrateLoop([{ customType: "agenda", data: { kind: "goal", schemaVersion: 1 } }])).toBeNull();
	});

	it("treats a corrupt expiry as ALREADY EXPIRED, never as never-expires", () => {
		// This bound is the last thing between an abandoned loop and an unbounded
		// one, so it must fail closed.
		const restored = validateLoop({ ...fixed(), expiresAt: "soon" });
		expect(restored?.expiresAt).toBe(0);
		expect(expiryCheck(restored!, T0)).toBe("expired");
	});

	it("rejects an unknown mode", () => {
		expect(validateLoop({ ...fixed(), mode: "cron" })).toBeNull();
	});

	it("rejects a newer schemaVersion", () => {
		expect(validateLoop({ ...fixed(), schemaVersion: 2 })).toBeNull();
	});

	it("floors maxFires at 1 so a corrupt 0 cannot mean unbounded", () => {
		expect(validateLoop({ ...fixed(), maxFires: 0 })?.maxFires).toBe(1);
	});
});
