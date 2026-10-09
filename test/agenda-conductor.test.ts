import { describe, expect, it } from "vitest";
import {
	assessComplexity,
	createConductor,
	looksLikeQuestion,
	rehydrateConductor,
	validateConductor,
	withStage,
	type ConductorItem,
} from "../extensions/agenda/conductor-state.ts";
import {
	ADVISE_LEDGER_ID,
	createConductorPolicy,
	createConductorAdvicePolicy,
	describeConductor,
	deriveGoalCondition,
	FRAME_INJECTION,
	FRAME_LEDGER_ID,
	PLAN_INJECTION,
	PLAN_LEDGER_ID,
	type ConductorHooks,
} from "../extensions/agenda/conductor.ts";
import {
	CONSOLIDATE_INJECTION,
	CONSOLIDATE_LEDGER_ID,
	decideConsolidate,
} from "../extensions/agenda/consolidate.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { emptyLedger, record, type LedgerState } from "../extensions/agenda/ledger.ts";
import type { PolicyContext } from "../extensions/agenda/policy.ts";
import { emptySignals, type SessionSignals } from "../extensions/agenda/signals.ts";

const COMPLEX_PROMPT =
	"Implement the new steering lifecycle: refactor the agenda extension, add a conductor policy, and wire the plan " +
	"extension to it. Build the DAG integration, fix the drivers across extensions/agenda/driver.ts and " +
	"extensions/plan/index.ts, then create a PR and get its CI checks green. This spans extensions/agenda/conductor.ts " +
	"as well, and should ship as one PR with tests pinned for every injection text and stage transition of the machine.";

function signalsWith(overrides: Partial<SessionSignals>): SessionSignals {
	return { ...emptySignals, userTurns: 1, lastUserPrompt: COMPLEX_PROMPT, ...overrides };
}

function makeHooks(initial: ConductorItem | null = null, goal: GoalItem | null = null) {
	let item = initial;
	let rang = 0;
	const hooks: ConductorHooks = {
		current: () => item,
		commit: (next) => {
			item = next;
		},
		goal: () => goal,
		requestPlanMode: () => {
			rang++;
		},
		enabled: () => true,
	};
	return { hooks, item: () => item, rang: () => rang };
}

function contextWith(ledger: LedgerState, signals: SessionSignals | undefined, cwd = "/tmp/no-such-repo"): PolicyContext {
	return { cwd, ledger, lastAssistantText: undefined, transcript: "", signals };
}

describe("looksLikeQuestion", () => {
	it("flags interrogatives and question marks", () => {
		expect(looksLikeQuestion("what does driver.ts do?")).toBe(true);
		expect(looksLikeQuestion("How is the plan persisted")).toBe(true);
		expect(looksLikeQuestion("Explain the ledger")).toBe(true);
		expect(looksLikeQuestion("Implement the ledger")).toBe(false);
	});
});

describe("assessComplexity", () => {
	it("questions are always simple", () => {
		expect(assessComplexity("How should we refactor the driver across all extensions?", 10)).toBe("simple");
	});

	it("short verb-less prompts are simple", () => {
		expect(assessComplexity("thanks, looks good", 0)).toBe("simple");
	});

	it("a Linear key plus an implementation verb is complex", () => {
		expect(assessComplexity("Implement HIV-1234 per the ticket description", 0)).toBe("complex");
	});

	it("four or more todos make active work complex", () => {
		expect(assessComplexity("Fix the remaining failures in the suite", 4)).toBe("complex");
	});

	it("a long prompt with two implementation verbs is complex", () => {
		expect(assessComplexity(COMPLEX_PROMPT, 0)).toBe("complex");
	});

	it("two weak signals compose: paths + PR mention", () => {
		expect(
			assessComplexity(
				"Update extensions/agenda/driver.ts, extensions/plan/index.ts and extensions/tasks/index.ts so the PR goes green",
				0,
			),
		).toBe("complex");
	});

	it("a modest single-file ask stays simple", () => {
		expect(assessComplexity("Fix the typo in the readme heading", 0)).toBe("simple");
	});
});

describe("conductor state", () => {
	it("round-trips through validate/rehydrate", () => {
		const item = withStage(createConductor("c1", 1000), "plan", 2000);
		expect(validateConductor(item)).toEqual(item);
		const entries = [{ customType: "agenda", data: item }];
		expect(rehydrateConductor(entries)).toEqual(item);
	});

	it("ignores goal entries when rehydrating", () => {
		const entries = [{ customType: "agenda", data: { kind: "goal", schemaVersion: 1, id: "g", condition: "x", state: "active" } }];
		expect(rehydrateConductor(entries)).toBeNull();
	});

	it("rejects an unknown stage", () => {
		expect(validateConductor({ kind: "conductor", schemaVersion: 1, id: "c", stage: "warp" })).toBeNull();
	});
});

describe("conductor policy", () => {
	it("does nothing without signals", () => {
		const { hooks } = makeHooks();
		const policy = createConductorPolicy(hooks);
		expect(policy.decide(contextWith(emptyLedger, undefined))).toBeNull();
	});

	it("does nothing before the first user turn", () => {
		const { hooks } = makeHooks();
		const policy = createConductorPolicy(hooks);
		expect(policy.decide(contextWith(emptyLedger, { ...emptySignals }))).toBeNull();
	});

	it("does nothing when disabled", () => {
		const { hooks } = makeHooks();
		const policy = createConductorPolicy({ ...hooks, enabled: () => false });
		expect(policy.decide(contextWith(emptyLedger, signalsWith({})))).toBeNull();
	});

	it("stays idle on a simple prompt — no item is even created", async () => {
		const { hooks, item } = makeHooks();
		const policy = createConductorPolicy(hooks);
		expect(policy.decide(contextWith(emptyLedger, signalsWith({ lastUserPrompt: "what is the ledger?" })))).toBeNull();
		expect(item()).toBeNull();
	});

	it("complex prompt with no todos → frame stage + exactly the frame injection", async () => {
		const { hooks, item } = makeHooks();
		const policy = createConductorPolicy(hooks);
		const work = policy.decide(contextWith(emptyLedger, signalsWith({})));
		expect(work).not.toBeNull();
		const outcome = await work!.run();
		expect(outcome.inject).toBe(FRAME_INJECTION);
		expect(item()?.stage).toBe("frame");
		expect(item()?.complexity).toBe("complex");
		const charged = outcome.ledger!(emptyLedger);
		expect(charged.iterations[FRAME_LEDGER_ID]).toBe(1);
	});

	it("complex prompt with todos already present → plan stage, doorbell rung, plan injection", async () => {
		const { hooks, item, rang } = makeHooks();
		const policy = createConductorPolicy(hooks);
		const signals = signalsWith({ tasks: { total: 5, pending: 5, inProgress: 0, completed: 0 } });
		const work = policy.decide(contextWith(emptyLedger, signals));
		const outcome = await work!.run();
		expect(outcome.inject).toBe(PLAN_INJECTION);
		expect(rang()).toBe(1);
		expect(item()?.stage).toBe("plan");
		const charged = outcome.ledger!(emptyLedger);
		expect(charged.iterations[PLAN_LEDGER_ID]).toBe(1);
	});

	it("frame stage advances to plan once todos exist", async () => {
		const { hooks, item, rang } = makeHooks(withStage(createConductor("c", 0), "frame", 0));
		const policy = createConductorPolicy(hooks);
		const signals = signalsWith({ tasks: { total: 3, pending: 2, inProgress: 1, completed: 0 } });
		const work = policy.decide(contextWith(emptyLedger, signals));
		const outcome = await work!.run();
		expect(outcome.inject).toBe(PLAN_INJECTION);
		expect(rang()).toBe(1);
		expect(item()?.stage).toBe("plan");
	});

	it("frame stage waits while the frame nudge is un-answered and un-spent", () => {
		const { hooks } = makeHooks(withStage(createConductor("c", 0), "frame", 0));
		const policy = createConductorPolicy(hooks);
		// No todos and the frame injection has NOT been charged: this settle is
		// the one where the injection is still in front of the model.
		expect(policy.decide(contextWith(emptyLedger, signalsWith({})))).toBeNull();
	});

	it("frame stage advances even without todos once the nudge was spent (advisory, cap 1)", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "frame", 0));
		const policy = createConductorPolicy(hooks);
		const ledger = record(emptyLedger, FRAME_LEDGER_ID);
		const work = policy.decide(contextWith(ledger, signalsWith({})));
		const outcome = await work!.run();
		expect(outcome.inject).toBe(PLAN_INJECTION);
		expect(item()?.stage).toBe("plan");
	});

	it("plan stage waits on the plan extension", () => {
		const { hooks } = makeHooks(withStage(createConductor("c", 0), "plan", 0));
		const policy = createConductorPolicy(hooks);
		const drafting = signalsWith({ plan: { phase: "drafting", revision: 1, stepCount: 2, goal: "" } });
		expect(policy.decide(contextWith(emptyLedger, drafting))).toBeNull();
	});

	it("plan stage advances silently once the plan is approved", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "plan", 0));
		const policy = createConductorPolicy(hooks);
		const approved = signalsWith({ plan: { phase: "approved", revision: 2, stepCount: 2, goal: "g" } });
		const work = policy.decide(contextWith(emptyLedger, approved));
		const outcome = await work!.run();
		expect(outcome.inject).toBeUndefined();
		expect(item()?.stage).toBe("execute");
	});

	it("execute waits while todos are open and no goal exists", () => {
		const { hooks } = makeHooks(withStage(createConductor("c", 0), "execute", 0));
		const policy = createConductorPolicy(hooks);
		const open = signalsWith({ tasks: { total: 3, pending: 1, inProgress: 1, completed: 1 } });
		expect(policy.decide(contextWith(emptyLedger, open))).toBeNull();
	});

	it("runs verification at the same completion boundary without late advice", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "execute", 0));
		const policy = createConductorPolicy(hooks);
		const done = signalsWith({ tasks: { total: 3, pending: 0, inProgress: 0, completed: 3 } });
		const work = policy.decide(contextWith(emptyLedger, done));
		const outcome = await work!.run();
		expect(item()?.stage).toBe("consolidate"); // no harness configured: explicitly skipped
		expect(outcome.metric.outcome).toBe("skip");
		expect(outcome.inject).toBeUndefined();
		expect(outcome.ledger).toBeUndefined();
	});

	it("runs verification silently once the advisor nudge is spent", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "execute", 0));
		const policy = createConductorPolicy(hooks);
		const done = signalsWith({ tasks: { total: 3, pending: 0, inProgress: 0, completed: 3 } });
		const spent = record(emptyLedger, ADVISE_LEDGER_ID);
		const work = policy.decide(contextWith(spent, done));
		const outcome = await work!.run();
		expect(item()?.stage).toBe("consolidate");
		expect(outcome.inject).toBeUndefined();
	});

	it("nudges at the first milestone with an active goal and open todos, once per session", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "execute", 0), { state: "active" } as GoalItem);
		const policy = createConductorAdvicePolicy(hooks);
		const open = signalsWith({ tasks: { total: 3, pending: 2, inProgress: 1, completed: 0 } });
		expect(policy.decide(contextWith(emptyLedger, open))).toBeNull();
		const milestone = { ...open, deliveryStarted: true };
		const outcome = await policy.decide(contextWith(emptyLedger, milestone))!.run();
		expect(outcome.inject).toContain("first commit or PR opening");
		expect(item()?.stage).toBe("verify");
		const ledger = outcome.ledger!(emptyLedger);
		expect(policy.decide(contextWith(ledger, milestone))).toBeNull();
		expect(createConductorPolicy(hooks).decide(contextWith(ledger, milestone))).toBeNull();
		hooks.commit(withStage(item()!, "execute", 10));
		expect(policy.decide(contextWith(ledger, milestone))).toBeNull();
	});
	it("does not create an unfinishable lifecycle when milestone advice has no goal or todos", async () => {
		const { hooks, item } = makeHooks();
		const advice = createConductorAdvicePolicy(hooks);
		const outcome = await advice.decide(contextWith(emptyLedger, signalsWith({ deliveryStarted: true })))!.run();
		expect(outcome.inject).toContain("advisor");
		expect(item()).toBeNull();
		const next = createConductorPolicy(hooks).decide(contextWith(outcome.ledger!(emptyLedger), signalsWith({})));
		await next!.run();
		expect(item()?.stage).toBe("frame");
	});
	it("offers advice for the session\'s first commit even on a simple task, not on a later complex read", async () => {
		const { hooks } = makeHooks();
		const policy = createConductorAdvicePolicy(hooks);
		const simple = signalsWith({ lastUserPrompt: "Fix a typo", deliveryStarted: true });
		const outcome = await policy.decide(contextWith(emptyLedger, simple))!.run();
		expect(outcome.inject).toContain("advisor");
		expect(policy.decide(contextWith(outcome.ledger!(emptyLedger), signalsWith({ deliveryStarted: true })))).toBeNull();
	});
	it.each(["capped", "budget_exhausted", "paused", "cleared", "blocked_user", "achieved"] as const)("does not create a verify lifecycle from an old %s goal without todos", async state => {
		const { hooks, item } = makeHooks(null, { state } as GoalItem);
		const outcome = await createConductorAdvicePolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ deliveryStarted: true })))!.run();
		expect(outcome.inject).toContain("advisor");
		expect(item()).toBeNull();
		await createConductorPolicy(hooks).decide(contextWith(outcome.ledger!(emptyLedger), signalsWith({})))!.run();
		expect(item()?.stage).toBe("frame");
	});
	it("releases an early verify lifecycle if its goal terminates without todos", async () => {
		const goal = { state: "active" } as GoalItem;
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "execute", 0), goal);
		await createConductorAdvicePolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ deliveryStarted: true })))!.run();
		goal.state = "capped";
		const outcome = await createConductorPolicy(hooks).decide(contextWith(record(emptyLedger, ADVISE_LEDGER_ID), signalsWith({})))!.run();
		expect(outcome.inject).toBeUndefined();
		expect(item()?.stage).toBe("idle");
		expect(goal.state).toBe("capped");
	});
	it.each(["capped", "budget_exhausted", "cleared", "blocked_user"] as const)("uses the current todos instead of a terminal %s goal", async state => {
		const { hooks, item } = makeHooks(null, { state } as GoalItem);
		const open = signalsWith({ deliveryStarted: true, tasks: { total: 1, pending: 1, inProgress: 0, completed: 0 } });
		const outcome = await createConductorAdvicePolicy(hooks).decide(contextWith(emptyLedger, open))!.run();
		expect(item()?.stage).toBe("verify");
		const ledger = outcome.ledger!(emptyLedger), policy = createConductorPolicy(hooks);
		expect(policy.decide(contextWith(ledger, open))).toBeNull();
		const done = { ...open, tasks: { total: 1, pending: 0, inProgress: 0, completed: 1 } };
		const verified = await policy.decide(contextWith(ledger, done))!.run();
		expect(verified.metric.outcome).toBe("skip");
		expect(item()?.stage).toBe("consolidate");
	});
	it("the plan injection carries the advisor line", () => {
		expect(PLAN_INJECTION).toContain("advisor");
	});

	it("execute → verify keys off the goal verdict when a goal exists", async () => {
		const achieved = { state: "achieved", condition: "x" } as GoalItem;
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "execute", 0), achieved);
		const policy = createConductorPolicy(hooks);
		// Todos deliberately open: the judge's verdict outranks todo state.
		const open = signalsWith({ tasks: { total: 3, pending: 3, inProgress: 0, completed: 0 } });
		const work = policy.decide(contextWith(emptyLedger, open));
		const outcome = await work!.run();
		expect(outcome.metric.outcome).toBe("skip");
		expect(item()?.stage).toBe("consolidate");
	});

	it("verify with no prCheck hands over to consolidate with a skip metric", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "verify", 0));
		const policy = createConductorPolicy(hooks);
		const work = policy.decide(contextWith(emptyLedger, signalsWith({ tasks: { total: 1, pending: 0, inProgress: 0, completed: 1 } })));
		const outcome = await work!.run();
		expect(outcome.metric.outcome).toBe("skip");
		expect(outcome.inject).toBeUndefined();
		expect(item()?.stage).toBe("consolidate");
	});

	it("done stage is inert", () => {
		const { hooks } = makeHooks(withStage(createConductor("c", 0), "done", 0));
		const policy = createConductorPolicy(hooks);
		expect(policy.decide(contextWith(emptyLedger, signalsWith({})))).toBeNull();
	});
});

describe("consolidate stage", () => {
	it("injects the consolidation ask when Hive is reachable, charged to the ledger", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "consolidate", 0));
		const work = decideConsolidate(hooks, contextWith(emptyLedger, signalsWith({})), async () => true);
		expect(work).not.toBeNull();
		expect(work!.status).toContain("consolidating");
		const outcome = await work!.run();
		expect(outcome.inject).toBe(CONSOLIDATE_INJECTION);
		expect(item()?.stage).toBe("consolidate");
		const charged = outcome.ledger!(emptyLedger);
		expect(charged.iterations[CONSOLIDATE_LEDGER_ID]).toBe(1);
	});

	it("skips straight to done when Hive is unreachable — no injection, skip metric", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "consolidate", 0));
		const work = decideConsolidate(hooks, contextWith(emptyLedger, signalsWith({})), async () => false);
		const outcome = await work!.run();
		expect(outcome.metric.outcome).toBe("skip");
		expect(outcome.inject).toBeUndefined();
		expect(item()?.stage).toBe("done");
	});

	it("advances silently to done once the nudge is spent — the model had its turn", async () => {
		const { hooks, item } = makeHooks(withStage(createConductor("c", 0), "consolidate", 0));
		const spent = record(emptyLedger, CONSOLIDATE_LEDGER_ID);
		const work = decideConsolidate(hooks, contextWith(spent, signalsWith({})), async () => {
			throw new Error("probe must not run once the nudge is spent");
		});
		const outcome = await work!.run();
		expect(outcome.inject).toBeUndefined();
		expect(item()?.stage).toBe("done");
	});

	it("the injection teaches dedup-first, one-fact-per-file, and the session id", () => {
		expect(CONSOLIDATE_INJECTION).toContain("knowledge_search");
		expect(CONSOLIDATE_INJECTION).toContain("memory/<domain>/<slug>.md");
		expect(CONSOLIDATE_INJECTION).toContain("session");
		expect(CONSOLIDATE_INJECTION).toContain("zero writes is a fine outcome");
	});

	it("a consolidate-stage item round-trips validate/rehydrate", () => {
		const item = withStage(createConductor("c1", 0), "consolidate", 1);
		expect(validateConductor(item)).toEqual(item);
		expect(rehydrateConductor([{ customType: "agenda", data: item }])).toEqual(item);
	});
});

describe("deriveGoalCondition", () => {
	it("falls back to the generic clause outside any repo", () => {
		expect(deriveGoalCondition("", "/tmp/no-such-repo")).toBe("Every step of the approved plan is done");
	});

	it("leads with the plan's own goal sentence", () => {
		expect(deriveGoalCondition("Ship the widget with tests passing", "/tmp/no-such-repo")).toBe(
			"Ship the widget with tests passing",
		);
	});
});

describe("renderConductorLines", () => {
	const activeGoal = {
		state: "active",
		condition: "PR created and `gh pr checks` green",
		ledger: { iterations: 1, maxIterations: 8 },
	} as GoalItem;

	it("returns null when idle, done, or disabled — no always-on widget", async () => {
		const { renderConductorLines } = await import("../extensions/agenda/conductor.ts");
		expect(renderConductorLines(null, null, true)).toBeNull();
		expect(renderConductorLines(createConductor("c", 0), null, true)).toBeNull(); // idle
		expect(renderConductorLines(withStage(createConductor("c", 0), "done", 0), null, true)).toBeNull();
		expect(renderConductorLines(withStage(createConductor("c", 0), "plan", 0), null, false)).toBeNull();
	});

	it("highlights the current stage in the strip", async () => {
		const { renderConductorLines } = await import("../extensions/agenda/conductor.ts");
		const lines = renderConductorLines(withStage(createConductor("c", 0), "plan", 0), null, true)!;
		expect(lines[0]).toContain("[plan]");
		expect(lines[0]).toContain("frame ▸ [plan] ▸ execute ▸ verify ▸ consolidate");
		expect(lines.some((line) => line.includes("awaiting plan approval"))).toBe(true);
	});

	it("carries the active goal line, truncated", async () => {
		const { renderConductorLines } = await import("../extensions/agenda/conductor.ts");
		const lines = renderConductorLines(withStage(createConductor("c", 0), "execute", 0), activeGoal, true)!;
		expect(lines.some((line) => line.includes("goal: PR created"))).toBe(true);
		expect(lines.some((line) => line.includes("1/8 continuations"))).toBe(true);
	});
});

describe("lifecycleEnvelope", () => {
	it("carries stage, strip, and the goal snapshot for the browser widget", async () => {
		const { lifecycleEnvelope } = await import("../extensions/agenda/conductor.ts");
		const goal = {
			condition: "`npm run check` exits 0",
			state: "active",
			ledger: { iterations: 2, maxIterations: 8 },
		} as GoalItem;
		const envelope = lifecycleEnvelope("execute", goal, "kickoff");
		expect(envelope.hive_widget.v).toBe(1);
		expect(envelope.hive_widget.type).toBe("lifecycle");
		expect(envelope.hive_widget.spec.stage).toBe("execute");
		expect(envelope.hive_widget.spec.stages).toEqual(["frame", "plan", "execute", "verify", "consolidate"]);
		expect(envelope.hive_widget.spec.goal).toEqual({
			condition: "`npm run check` exits 0",
			state: "active",
			iterations: 2,
			maxIterations: 8,
		});
		expect(envelope.hive_widget.spec.note).toBe("kickoff");
	});

	it("omits the goal block when there is no goal", async () => {
		const { lifecycleEnvelope } = await import("../extensions/agenda/conductor.ts");
		const envelope = lifecycleEnvelope("plan", null);
		expect(envelope.hive_widget.spec.goal).toBeUndefined();
		expect(envelope.hive_widget.spec.note).toBeUndefined();
	});
});

describe("describeConductor", () => {
	it("names the off state, the idle state, and the waiting stages", () => {
		expect(describeConductor(null, false)).toContain("off");
		expect(describeConductor(null, true)).toContain("idle");
		expect(describeConductor(withStage(createConductor("c", 0), "plan", 0), true)).toContain("plan approval");
		expect(describeConductor(withStage(createConductor("c", 0), "frame", 0), true)).toContain("TodoWrite");
	});
});

// The frame and plan kicks are advice for the START of a task. Measured: 99 of
// 104 fired after ≥10 tool calls, reopening finished or running work.
describe("conductor policy — kicks only before the work is under way", () => {
	it("frames a complex task at its first settle", async () => {
		const { hooks } = makeHooks();
		const work = createConductorPolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ toolCallsSinceUser: 3 })));
		expect((await work?.run())?.inject).toBe(FRAME_INJECTION);
	});

	it("stays out of a task the agent has already been executing", () => {
		const { hooks, item } = makeHooks();
		const work = createConductorPolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ toolCallsSinceUser: 40 })));
		expect(work).toBeNull();
		expect(item()).toBeNull();
	});

	it("skips planning when the agent went on executing after the frame kick", async () => {
		const { hooks, item, rang } = makeHooks(withStage(createConductor("c1", 1), "frame", 2));
		const ledger = record(emptyLedger, FRAME_LEDGER_ID);
		const work = createConductorPolicy(hooks).decide(
			contextWith(ledger, signalsWith({ tasks: { total: 2, pending: 2, inProgress: 0, completed: 0 }, toolCallsSinceInjection: 30, toolCallsSinceUser: 33 })),
		);
		const outcome = await work?.run();
		expect(outcome?.inject).toBeUndefined();
		expect(rang()).toBe(0); // no read-only plan mode over work in flight
		expect(item()?.stage).toBe("execute");
	});

	it("still plans when the frame kick was answered with a todo list", async () => {
		const { hooks, rang } = makeHooks(withStage(createConductor("c1", 1), "frame", 2));
		const ledger = record(emptyLedger, FRAME_LEDGER_ID);
		const work = createConductorPolicy(hooks).decide(
			contextWith(ledger, signalsWith({ tasks: { total: 3, pending: 3, inProgress: 0, completed: 0 }, toolCallsSinceInjection: 1, toolCallsSinceUser: 4 })),
		);
		expect((await work?.run())?.inject).toBe(PLAN_INJECTION);
		expect(rang()).toBe(1);
	});

	it("does not name a todo tool the session cannot reach — it plans instead", async () => {
		const { hooks } = makeHooks();
		hooks.toolReachable = (name) => name !== "TodoWrite";
		const work = createConductorPolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ toolCallsSinceUser: 2 })));
		expect((await work?.run())?.inject).toBe(PLAN_INJECTION);
	});

	it("skips plan mode entirely when plan_write is unreachable — back to idle without todos", async () => {
		const { hooks, item, rang } = makeHooks();
		hooks.toolReachable = () => false;
		const work = createConductorPolicy(hooks).decide(contextWith(emptyLedger, signalsWith({ toolCallsSinceUser: 2 })));
		expect((await work?.run())?.inject).toBeUndefined();
		expect(rang()).toBe(0);
		expect(item()?.stage).toBe("idle");
	});

	it("keeps the lifecycle for a late task with a todo list: execute, so verify follows completion", async () => {
		const { hooks, item, rang } = makeHooks();
		const work = createConductorPolicy(hooks).decide(
			contextWith(emptyLedger, signalsWith({ toolCallsSinceUser: 40, tasks: { total: 3, pending: 1, inProgress: 1, completed: 1 } })),
		);
		expect((await work?.run())?.inject).toBeUndefined();
		expect(rang()).toBe(0);
		expect(item()?.stage).toBe("execute");
	});
});
