/**
 * The plan validator and the scheduler.
 *
 * The scheduler is a pure fold, so every orchestration semantic — concurrency,
 * dependency order, pipelines advancing independently, hard budget stops — is
 * tested here with zero child processes. That testability is the main thing the
 * declarative design buys over a JS script runtime.
 */

import { describe, expect, it } from "vitest";
import {
	emptyRunState,
	estimateAgents,
	isComplete,
	nextBatch,
	resolveRef,
	type RunState,
	skippableAfterFailure,
	suggestCaps,
	workId,
} from "../extensions/agenda/plan-graph.ts";
import {
	MAX_NODES,
	type Plan,
	type PlanNode,
	resolveCaps,
	validatePlan,
} from "../extensions/agenda/plan-schema.ts";

const ROLES = ["research", "code-reviewer", "doc-writer", "lint-fixer"];
const CAPS = resolveCaps(undefined);

function plan(nodes: PlanNode[], caps?: Plan["caps"]): Plan {
	return { name: "p", description: "d", nodes, caps };
}

const agentNode = (id: string, over?: string[]): PlanNode =>
	({ id, kind: "agent", role: "research", prompt: `do ${id}`, ...(over ? { needs: over } : {}) }) as PlanNode;

describe("validatePlan — roles", () => {
	it("accepts a plan using real roles", () => {
		expect(validatePlan(plan([agentNode("a")]), ROLES)).toEqual([]);
	});

	it("names the real roles when one is wrong, so a near-miss is fixable", () => {
		const issues = validatePlan(
			plan([{ id: "a", kind: "agent", role: "researcher", prompt: "x" } as PlanNode]),
			ROLES,
		);
		expect(issues[0].message).toContain('unknown role "researcher"');
		expect(issues[0].message).toContain("research");
	});

	it("checks every stage of a pipeline", () => {
		const node = {
			id: "p",
			kind: "pipeline",
			over: "a",
			stages: [
				{ role: "research", prompt: "{item}" },
				{ role: "nope", prompt: "{item}" },
			],
		} as PlanNode;
		const issues = validatePlan(plan([agentNode("a"), node]), ROLES);
		expect(issues.some((i) => i.message.includes('"nope"'))).toBe(true);
	});
});

describe("validatePlan — structure", () => {
	it("rejects duplicate ids", () => {
		const issues = validatePlan(plan([agentNode("a"), agentNode("a")]), ROLES);
		expect(issues.some((i) => i.message.includes("duplicate"))).toBe(true);
	});

	it("rejects a dangling reference", () => {
		const issues = validatePlan(plan([agentNode("a", ["ghost"])]), ROLES);
		expect(issues[0].message).toContain('unknown node "ghost"');
	});

	it("rejects a self-reference", () => {
		const issues = validatePlan(plan([agentNode("a", ["a"])]), ROLES);
		expect(issues.some((i) => i.message.includes("references itself"))).toBe(true);
	});

	it("rejects a cycle and shows the path", () => {
		const issues = validatePlan(plan([agentNode("a", ["b"]), agentNode("b", ["a"])]), ROLES);
		const cycle = issues.find((i) => i.message.includes("cycle"));
		expect(cycle?.message).toMatch(/a → b → a|b → a → b/);
	});

	it("rejects a fanout whose prompt ignores the item", () => {
		// Otherwise it runs N identical agents — always a mistake, and expensive.
		const node = { id: "f", kind: "fanout", over: "a", role: "research", prompt: "look at things" } as PlanNode;
		const issues = validatePlan(plan([agentNode("a"), node]), ROLES);
		expect(issues.some((i) => i.message.includes("{item}"))).toBe(true);
	});

	it("rejects an oversized plan", () => {
		const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => agentNode(`n${i}`));
		expect(validatePlan(plan(nodes), ROLES).some((i) => i.message.includes("limit"))).toBe(true);
	});

	it("rejects additionalProperties:false in an output schema, before the node runs", () => {
		// This REVERSES the previous assertion, and the reversal is the point.
		//
		// The old test allowed a closed schema, on the grounds that "pi sends the
		// schema to the provider unmodified, and constrainedSampling strict mode
		// REQUIRES it". That was true of a mechanism which did not exist:
		// `outputSchema` reached `Dispatch` and was then read by nothing at all —
		// no flag carried it to a provider, no validator consumed it. The rule was
		// written for a constrained-sampling path that was never built.
		//
		// It is now validated the same way `subagent`'s schema is: the worker ends
		// with a fenced JSON block and we check it locally. Under LOCAL validation
		// a closed schema is the documented anti-pattern — an extra `notes` field
		// becomes a hard failure and the retry invents duplicate field names
		// instead of dropping it. One mechanism, one rule.
		//
		// Checked at plan validation rather than at the node, so the author is not
		// charged for a worker to discover a typo in their own schema.
		const node = {
			id: "a",
			kind: "agent",
			role: "research",
			prompt: "x",
			outputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
		} as PlanNode;
		const issues = validatePlan(plan([node]), ROLES);
		expect(issues).toHaveLength(1);
		expect(issues[0].nodeId).toBe("a");
		expect(issues[0].message).toContain("additionalProperties:false");
	});

	it("names the offending STAGE when a pipeline stage carries a bad schema", () => {
		const node = {
			id: "p",
			kind: "pipeline",
			over: "a",
			stages: [
				{ role: "research", prompt: "first" },
				{ role: "research", prompt: "second", outputSchema: { type: "object", additionalProperties: false } },
			],
		} as unknown as PlanNode;
		const issues = validatePlan(plan([agentNode("a"), node]), ROLES);
		expect(issues.some((issue) => issue.message.startsWith("stage 2 outputSchema is unusable"))).toBe(true);
	});

	it("leaves an open schema alone", () => {
		const node = {
			id: "a",
			kind: "agent",
			role: "research",
			prompt: "x",
			outputSchema: { type: "object", properties: { findings: { type: "array" } } },
		} as PlanNode;
		expect(validatePlan(plan([node]), ROLES)).toEqual([]);
	});
});

describe("workId — content-derived identity", () => {
	it("is stable across whitespace and formatting", () => {
		const a = { id: "x", kind: "agent", role: "research", prompt: "do   the\n thing" } as PlanNode;
		const b = { id: "x", kind: "agent", role: "research", prompt: "do the thing" } as PlanNode;
		expect(workId(a)).toBe(workId(b));
	});

	it("CHANGES when the prompt changes — which is what makes resume work", () => {
		const a = { id: "x", kind: "agent", role: "research", prompt: "one" } as PlanNode;
		const b = { id: "x", kind: "agent", role: "research", prompt: "two" } as PlanNode;
		expect(workId(a)).not.toBe(workId(b));
	});

	it("changes with the role", () => {
		const a = { id: "x", kind: "agent", role: "research", prompt: "p" } as PlanNode;
		const b = { id: "x", kind: "agent", role: "doc-writer", prompt: "p" } as PlanNode;
		expect(workId(a)).not.toBe(workId(b));
	});

	it("gives each fanout item its own identity", () => {
		const node = { id: "f", kind: "fanout", over: "a", role: "research", prompt: "{item}" } as PlanNode;
		expect(workId(node, "0:alpha")).not.toBe(workId(node, "1:beta"));
	});

	it("gives each pipeline stage its own identity", () => {
		const node = { id: "x", kind: "agent", role: "research", prompt: "p" } as PlanNode;
		expect(workId(node, "0:a", 0)).not.toBe(workId(node, "0:a", 1));
	});
});

describe("resolveRef", () => {
	const results = { a: { findings: [1, 2], meta: { count: 2 } } };

	it("resolves a whole node", () => {
		expect(resolveRef("a", results)).toEqual(results.a);
	});
	it("resolves a field", () => {
		expect(resolveRef("a.findings", results)).toEqual([1, 2]);
	});
	it("resolves a nested path", () => {
		expect(resolveRef("a.meta.count", results)).toBe(2);
	});
	it("returns undefined for an unfinished node rather than throwing", () => {
		expect(resolveRef("b.x", results)).toBeUndefined();
	});
});

describe("nextBatch — dependencies and concurrency", () => {
	it("dispatches only nodes whose dependencies are done", () => {
		const p = plan([agentNode("a"), agentNode("b", ["a"])]);
		const batch = nextBatch(p, emptyRunState(), CAPS);
		expect(batch.dispatch.map((d) => d.nodeId)).toEqual(["a"]);
	});

	it("releases a dependent once its dependency completes", () => {
		const p = plan([agentNode("a"), agentNode("b", ["a"])]);
		const state: RunState = { ...emptyRunState(), status: { a: "done" }, results: { a: 1 } };
		expect(nextBatch(p, state, CAPS).dispatch.map((d) => d.nodeId)).toEqual(["b"]);
	});

	it("never exceeds maxConcurrent", () => {
		const p = plan(Array.from({ length: 10 }, (_, i) => agentNode(`n${i}`)));
		expect(nextBatch(p, emptyRunState(), resolveCaps({ maxConcurrent: 3 })).dispatch).toHaveLength(3);
	});

	it("counts already-running work against the concurrency limit", () => {
		const p = plan(Array.from({ length: 10 }, (_, i) => agentNode(`n${i}`)));
		const state: RunState = { ...emptyRunState(), running: new Set(["x", "y"]) };
		expect(nextBatch(p, state, resolveCaps({ maxConcurrent: 3 })).dispatch).toHaveLength(1);
	});

	it("does not re-dispatch a node already running", () => {
		const p = plan([agentNode("a")]);
		const state: RunState = { ...emptyRunState(), status: { a: "running" } };
		expect(nextBatch(p, state, CAPS).dispatch).toHaveLength(0);
	});
});

describe("nextBatch — hard caps", () => {
	it("HALTS on the token budget rather than dispatching less", () => {
		// An advisory budget is a budget that gets ignored.
		const p = plan([agentNode("a")]);
		const state: RunState = { ...emptyRunState(), spentTokens: 1000 };
		expect(nextBatch(p, state, resolveCaps({ budgetTokens: 1000 })).halt).toBe("budget");
	});

	it("serializes a budgeted plan so one turn, not a whole wave, is the maximum overshoot", () => {
		const p = plan(Array.from({ length: 8 }, (_, index) => agentNode(`n${index}`)));
		const batch = nextBatch(p, emptyRunState(), resolveCaps({ budgetTokens: 50_000, maxConcurrent: 8 }));
		expect(batch.dispatch).toHaveLength(1);
	});

	it("halts on the agent cap", () => {
		const p = plan([agentNode("a")]);
		const state: RunState = { ...emptyRunState(), agentsSpawned: 40 };
		expect(nextBatch(p, state, resolveCaps({ maxAgents: 40 })).halt).toBe("agents");
	});

	it("clamps caps to their ceilings rather than trusting the plan", () => {
		const caps = resolveCaps({ maxConcurrent: 999, maxAgents: 99_999 });
		expect(caps.maxConcurrent).toBe(8);
		expect(caps.maxAgents).toBe(200);
	});

	it("suggests a real first wave instead of defaulting every small plan to two workers", () => {
		expect(suggestCaps(2)).toEqual({ maxConcurrent: 4, maxAgents: 12 });
		expect(suggestCaps(12)).toEqual({ maxConcurrent: 8, maxAgents: 40 });
		expect(suggestCaps(100)).toEqual({ maxConcurrent: 8, maxAgents: 40 });
	});
});

describe("nextBatch — fanout", () => {
	const fanoutPlan = plan([
		agentNode("scout"),
		{ id: "f", kind: "fanout", over: "scout.items", role: "research", prompt: "look at {item}" } as PlanNode,
	]);

	it("dispatches one worker per item, interpolating {item}", () => {
		const state: RunState = {
			...emptyRunState(),
			status: { scout: "done" },
			results: { scout: { items: ["alpha", "beta"] } },
		};
		const batch = nextBatch(fanoutPlan, state, CAPS);
		expect(batch.dispatch).toHaveLength(2);
		expect(batch.dispatch[0].prompt).toBe("look at alpha");
		expect(batch.dispatch[1].prompt).toBe("look at beta");
	});

	it("respects concurrency across a wide fanout", () => {
		const state: RunState = {
			...emptyRunState(),
			status: { scout: "done" },
			results: { scout: { items: Array.from({ length: 50 }, (_, i) => `i${i}`) } },
		};
		expect(nextBatch(fanoutPlan, state, resolveCaps({ maxConcurrent: 4 })).dispatch).toHaveLength(4);
	});

	it("dispatches nothing for an empty item list", () => {
		const state: RunState = { ...emptyRunState(), status: { scout: "done" }, results: { scout: { items: [] } } };
		expect(nextBatch(fanoutPlan, state, CAPS).dispatch).toHaveLength(0);
	});
});

describe("nextBatch — pipelines advance INDEPENDENTLY", () => {
	const pipelinePlan = plan([
		agentNode("scout"),
		{
			id: "p",
			kind: "pipeline",
			over: "scout.items",
			stages: [
				{ role: "research", prompt: "stage1 {item}" },
				{ role: "code-reviewer", prompt: "stage2 {item}" },
			],
		} as PlanNode,
	]);

	const base: RunState = {
		...emptyRunState(),
		status: { scout: "done" },
		results: { scout: { items: ["a", "b"] } },
	};

	it("starts every item at stage 0", () => {
		const batch = nextBatch(pipelinePlan, base, CAPS);
		expect(batch.dispatch.map((d) => d.stageIndex)).toEqual([0, 0]);
	});

	it("lets one item reach stage 1 while the other is still at stage 0", () => {
		// No barrier between stages: wall-clock is the slowest single CHAIN, not
		// the sum of slowest-per-stage.
		const state: RunState = {
			...base,
			status: { ...base.status, "p#0@0": "done" },
			results: { ...base.results, "p#0@0": "first done" },
		};
		const batch = nextBatch(pipelinePlan, state, CAPS);
		const stages = batch.dispatch.map((d) => d.stageIndex).sort();
		expect(stages).toEqual([0, 1]);
	});

	it("feeds the previous stage's output into the next", () => {
		const state: RunState = {
			...base,
			status: { ...base.status, "p#0@0": "done" },
			results: { ...base.results, "p#0@0": "OUTPUT-OF-STAGE-1" },
		};
		const stage1 = nextBatch(pipelinePlan, state, CAPS).dispatch.find((d) => d.stageIndex === 1);
		expect(stage1?.prompt).toContain("OUTPUT-OF-STAGE-1");
	});

	it("stops dispatching an item once it clears every stage", () => {
		const state: RunState = {
			...base,
			status: { ...base.status, "p#0@0": "done", "p#0@1": "done", "p#1@0": "done", "p#1@1": "done" },
		};
		expect(nextBatch(pipelinePlan, state, CAPS).dispatch).toHaveLength(0);
	});
});

describe("nextBatch — barriers and transforms cost nothing", () => {
	it("a barrier resolves immediately and consumes no concurrency slot", () => {
		const p = plan([agentNode("a"), { id: "b", kind: "barrier", needs: ["a"] } as PlanNode]);
		const state: RunState = { ...emptyRunState(), status: { a: "done" }, results: { a: [1] } };
		const batch = nextBatch(p, state, resolveCaps({ maxConcurrent: 1 }));
		expect(batch.immediate.map((i) => i.nodeId)).toEqual(["b"]);
		expect(batch.dispatch).toHaveLength(0);
	});

	it("a transform resolves immediately too", () => {
		const p = plan([
			agentNode("a"),
			{ id: "t", kind: "transform", over: "a", op: { op: "count" } } as PlanNode,
		]);
		const state: RunState = { ...emptyRunState(), status: { a: "done" }, results: { a: [1, 2, 3] } };
		expect(nextBatch(p, state, CAPS).immediate.map((i) => i.nodeId)).toEqual(["t"]);
	});
});

describe("failure propagation", () => {
	it("marks dependents of a failed node as skippable, not failed", () => {
		// A node never tried is not a node that was tried and did not work.
		const p = plan([agentNode("a"), agentNode("b", ["a"]), agentNode("c", ["b"])]);
		const state: RunState = { ...emptyRunState(), status: { a: "failed" } };
		expect(skippableAfterFailure(p, state)).toEqual(["b"]);
	});

	it("does not skip a node whose other dependency is fine", () => {
		const p = plan([agentNode("a"), agentNode("b")]);
		const state: RunState = { ...emptyRunState(), status: { a: "failed" } };
		expect(skippableAfterFailure(p, state)).toEqual([]);
	});
});

describe("isComplete", () => {
	it("is false while anything is unfinished", () => {
		const p = plan([agentNode("a"), agentNode("b")]);
		expect(isComplete(p, { ...emptyRunState(), status: { a: "done" } })).toBe(false);
	});

	it("counts failed and skipped as finished", () => {
		const p = plan([agentNode("a"), agentNode("b"), agentNode("c")]);
		const state: RunState = { ...emptyRunState(), status: { a: "done", b: "failed", c: "skipped" } };
		expect(isComplete(p, state)).toBe(true);
	});
});

describe("estimateAgents — for the pre-run confirmation", () => {
	it("counts plain agents", () => {
		expect(estimateAgents(plan([agentNode("a"), agentNode("b")]))).toBe(2);
	});

	it("multiplies pipeline stages by item count", () => {
		const p = plan([
			agentNode("scout"),
			{
				id: "p",
				kind: "pipeline",
				over: "scout",
				stages: [
					{ role: "research", prompt: "{item}" },
					{ role: "research", prompt: "{item}" },
				],
			} as PlanNode,
		]);
		expect(estimateAgents(p, { p: 10 })).toBe(1 + 20);
	});

	it("ignores barriers and transforms", () => {
		const p = plan([
			agentNode("a"),
			{ id: "b", kind: "barrier", needs: ["a"] } as PlanNode,
			{ id: "t", kind: "transform", over: "a", op: { op: "count" } } as PlanNode,
		]);
		expect(estimateAgents(p)).toBe(1);
	});
});
