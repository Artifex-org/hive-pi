/**
 * plan auto-continue — the guard matrix (autocontinue.ts).
 *
 * A low-tier model ends a turn with a text-only "Wave done." and stops while an
 * APPROVED plan still holds pending steps (session 98f712a4: 15 of 74 turns, a
 * `/goal keep going` set and ignored). `decideAutoContinue` is the pure heart of
 * the fix, so every branch that decides CONTINUE / NO-OP / STOP is asserted here
 * without a session: the point of the design is that the decision is deterministic
 * and cheap, and a test that needed a live agent could not pin either property.
 *
 * Docs are fabricated through the real `applyOps` + `itemCounts` path, so the
 * counts fed to the decision are the ones production would derive, not hand-typed
 * numbers a refactor of the counter could silently drift from.
 */

import { describe, expect, it } from "vitest";
import {
	AUTOCONTINUE_ENV,
	autoContinueEnabled,
	buildNudge,
	createAutoContinueState,
	decideAutoContinue,
	DEFAULT_AUTOCONTINUE_CONFIG,
	type AutoContinueConfig,
	type AutoContinueState,
} from "../extensions/plan/autocontinue.ts";
import { itemCounts } from "../extensions/plan/lanes.ts";
import { applyOps, emptyPlan, type PlanDoc, type WorkItemStatus } from "../extensions/plan/state.ts";

const NOW = 1_700_000_000_000;

/**
 * A one-lane plan holding items of the given statuses, approved unless told
 * otherwise. Built through `applyOps` so `itemCounts` sees a real document.
 */
function planWith(statuses: WorkItemStatus[], opts: { approved?: boolean } = {}): PlanDoc {
	const approved = opts.approved ?? true;
	const result = applyOps(
		emptyPlan(NOW),
		[
			{
				op: "lane",
				kind: "execute",
				title: "Execute",
				items: statuses.map((status, i) => ({ id: `s${i}`, title: `step ${i}`, status })),
			},
			...(approved ? ([{ op: "header", phase: "approved" }] as const) : []),
		],
		NOW,
	);
	return result.doc;
}

/** Shorthand: run the decision against a fabricated doc. */
function decide(
	doc: PlanDoc,
	over: {
		state?: Partial<AutoContinueState>;
		config?: AutoContinueConfig;
		enabled?: boolean;
		lastTurnMadeToolCall?: boolean;
		uiPromptOpen?: boolean;
	} = {},
) {
	const counts = itemCounts(doc);
	return decideAutoContinue({
		enabled: over.enabled ?? true,
		phase: doc.phase,
		pending: counts.pending,
		inProgress: counts.in_progress,
		done: counts.done,
		lastTurnMadeToolCall: over.lastTurnMadeToolCall ?? false,
		uiPromptOpen: over.uiPromptOpen ?? false,
		state: { ...createAutoContinueState(), ...over.state },
		config: over.config ?? DEFAULT_AUTOCONTINUE_CONFIG,
	});
}

describe("decideAutoContinue", () => {
	it("CONTINUES an approved plan with pending work that stopped short and is progressing", () => {
		const doc = planWith(["done", "pending", "pending"]);
		const decision = decide(doc, { state: { used: 2, noProgressStreak: 0, doneAtStreakStart: 0 } });

		expect(decision.action).toBe("continue");
		if (decision.action !== "continue") throw new Error("unreachable");
		expect(decision.nudge).toContain("2 steps remain");
		// One `done` (1) beats the streak baseline (0): the streak resets and the
		// counter advances by one.
		expect(decision.nextState.used).toBe(3);
		expect(decision.nextState.noProgressStreak).toBe(0);
		expect(decision.nextState.doneAtStreakStart).toBe(1);
	});

	it("NO-OPs when the plan is not approved", () => {
		const doc = planWith(["pending", "pending"], { approved: false });
		expect(doc.phase).not.toBe("approved");
		expect(decide(doc).action).toBe("noop");
	});

	it("NO-OPs when nothing is pending or in progress", () => {
		const doc = planWith(["done", "done", "skipped"]);
		const decision = decide(doc);
		expect(decision.action).toBe("noop");
		expect(decision.reason).toContain("no pending");
	});

	it("counts in_progress as remaining work", () => {
		const doc = planWith(["in_progress"]);
		expect(decide(doc).action).toBe("continue");
	});

	it("NO-OPs while a UI/approval prompt is open (an approval-wait)", () => {
		const doc = planWith(["pending", "pending"]);
		const decision = decide(doc, { uiPromptOpen: true });
		expect(decision.action).toBe("noop");
		expect(decision.reason).toContain("prompt");
	});

	it("NO-OPs when the last turn made a tool call (still mid-work)", () => {
		const doc = planWith(["pending", "pending"]);
		const decision = decide(doc, { lastTurnMadeToolCall: true });
		expect(decision.action).toBe("noop");
		expect(decision.reason).toContain("tool call");
	});

	it("STOPs once the hard cap is reached", () => {
		const doc = planWith(["pending", "pending"]);
		const cap = DEFAULT_AUTOCONTINUE_CONFIG.cap;
		const decision = decide(doc, { state: { used: cap } });
		expect(decision.action).toBe("stop");
		expect(decision.reason).toContain("cap");
	});

	it("STOPs when no new step closed across the no-progress limit of continues", () => {
		const limit = DEFAULT_AUTOCONTINUE_CONFIG.noProgressLimit; // 3
		// One step done, and the streak baseline already at that same `done`
		// count: no progress since the streak began. After `limit` such
		// continues, the loop is spinning and stands down.
		const doc = planWith(["done", "pending", "pending"]);
		const decision = decide(doc, {
			state: { used: 5, noProgressStreak: limit, doneAtStreakStart: 1 },
		});
		expect(decision.action).toBe("stop");
		expect(decision.reason).toContain("no new step");
	});

	it("keeps continuing while still under the no-progress limit, incrementing the streak", () => {
		const limit = DEFAULT_AUTOCONTINUE_CONFIG.noProgressLimit;
		const doc = planWith(["done", "pending"]);
		const decision = decide(doc, {
			state: { used: 4, noProgressStreak: limit - 1, doneAtStreakStart: 1 },
		});
		expect(decision.action).toBe("continue");
		if (decision.action !== "continue") throw new Error("unreachable");
		// No progress (done 1 == baseline 1), so the streak advances to the limit;
		// the NEXT settle with still no progress will stop.
		expect(decision.nextState.noProgressStreak).toBe(limit);
	});

	it("NO-OPs when disabled by the flag", () => {
		const doc = planWith(["pending", "pending"]);
		expect(decide(doc, { enabled: false }).action).toBe("noop");
	});
});

describe("buildNudge", () => {
	it("is deterministic, tells the model not to stop, and pluralizes the count", () => {
		expect(buildNudge(1)).toContain("1 step remains");
		const many = buildNudge(4);
		expect(many).toContain("4 steps remain");
		expect(many).toContain("do not stop to summarize");
		expect(many).toContain("`blocked`");
	});
});

describe("autoContinueEnabled", () => {
	it("defaults ON and is disabled only by an explicit '0'", () => {
		expect(autoContinueEnabled({})).toBe(true);
		expect(autoContinueEnabled({ [AUTOCONTINUE_ENV]: "1" })).toBe(true);
		expect(autoContinueEnabled({ [AUTOCONTINUE_ENV]: "" })).toBe(true);
		expect(autoContinueEnabled({ [AUTOCONTINUE_ENV]: "0" })).toBe(false);
	});
});
