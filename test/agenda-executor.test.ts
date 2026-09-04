/**
 * The run loop, driven by a FAKE spawner.
 *
 * Injecting the spawner is what lets concurrency, retries, budget stops,
 * failure propagation and the identical-failure collapse be tested here with
 * zero child processes — the same reason the scheduler is a pure fold.
 */

import { describe, expect, it, vi } from "vitest";
import { errorSignature, runPlan, type Spawn, type WorkerResult } from "../extensions/agenda/executor.ts";
import type { Plan, PlanNode } from "../extensions/agenda/plan-schema.ts";

const ok = (value: unknown, tokens = 10): WorkerResult => ({ ok: true, value, tokens });
const fail = (error: string, tokens = 5): WorkerResult => ({ ok: false, value: null, tokens, error });

function plan(nodes: PlanNode[], caps?: Plan["caps"]): Plan {
	return { name: "p", description: "d", nodes, caps };
}

const agentNode = (id: string, needs?: string[]): PlanNode =>
	({ id, kind: "agent", role: "research", prompt: `do ${id}`, ...(needs ? { needs } : {}) }) as PlanNode;

describe("runPlan — the happy path", () => {
	it("runs a single node and returns its result", async () => {
		const spawn: Spawn = async () => ok("result-a");
		const summary = await runPlan({ plan: plan([agentNode("a")]), spawn });

		expect(summary.results.a).toBe("result-a");
		expect(summary.agentsSpawned).toBe(1);
		expect(summary.failures).toEqual([]);
	});

	it("respects dependency order", async () => {
		const order: string[] = [];
		const spawn: Spawn = async (d) => {
			order.push(d.nodeId);
			return ok(d.nodeId);
		};
		await runPlan({ plan: plan([agentNode("a"), agentNode("b", ["a"]), agentNode("c", ["b"])]), spawn });
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("accumulates token spend across every worker", async () => {
		const spawn: Spawn = async () => ok("x", 100);
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b")]), spawn });
		expect(summary.spentTokens).toBe(200);
	});

	it("runs independent nodes in the same batch", async () => {
		let concurrent = 0;
		let peak = 0;
		const spawn: Spawn = async () => {
			concurrent++;
			peak = Math.max(peak, concurrent);
			await Promise.resolve();
			concurrent--;
			return ok("x");
		};
		await runPlan({ plan: plan([agentNode("a"), agentNode("b"), agentNode("c")]), spawn });
		expect(peak).toBeGreaterThan(1);
	});
});

describe("runPlan — fanout and transforms", () => {
	it("fans out over a previous node's output", async () => {
		const scout = agentNode("scout");
		const fan = { id: "f", kind: "fanout", over: "scout.items", role: "research", prompt: "check {item}" } as PlanNode;
		const seen: string[] = [];
		const spawn: Spawn = async (d) => {
			if (d.nodeId === "scout") return ok({ items: ["x", "y", "z"] });
			seen.push(d.prompt);
			return ok(`done ${d.item}`);
		};

		const summary = await runPlan({ plan: plan([scout, fan]), spawn });
		expect(seen.sort()).toEqual(["check x", "check y", "check z"]);
		expect(summary.agentsSpawned).toBe(4);
	});

	it("gives identical fanout items distinct result slots", async () => {
		// Two items with the same value must not collapse into one.
		const scout = agentNode("scout");
		const fan = { id: "f", kind: "fanout", over: "scout", role: "research", prompt: "{item}" } as PlanNode;
		const spawn: Spawn = async (d) => (d.nodeId === "scout" ? ok(["same", "same"]) : ok(`r${d.itemIndex}`));

		const summary = await runPlan({ plan: plan([scout, fan]), spawn });
		expect(summary.results["f#0"]).toBe("r0");
		expect(summary.results["f#1"]).toBe("r1");
	});

	it("publishes an ordered fanout aggregate and unblocks a reconciliation join", async () => {
		const scout = agentNode("scout");
		const fan = { id: "f", kind: "fanout", over: "scout", role: "research", prompt: "inspect {item}" } as PlanNode;
		const evidence = { id: "evidence", kind: "barrier", needs: ["f"] } as PlanNode;
		const reconcile = {
			id: "reconcile",
			kind: "pipeline",
			over: "evidence",
			stages: [{ role: "code-reviewer", prompt: "reconcile {item}" }],
		} as PlanNode;
		const prompts: string[] = [];
		const spawn: Spawn = async (dispatch) => {
			prompts.push(dispatch.prompt);
			if (dispatch.nodeId === "scout") return ok(["a", "b", "c"]);
			if (dispatch.nodeId === "f") return ok(`finding-${dispatch.itemIndex}`);
			return ok("reconciled");
		};

		const summary = await runPlan({ plan: plan([scout, fan, evidence, reconcile]), spawn });
		expect(summary.state.status.f).toBe("done");
		expect(summary.results.f).toEqual(["finding-0", "finding-1", "finding-2"]);
		expect(summary.results.evidence).toEqual([["finding-0", "finding-1", "finding-2"]]);
		expect(prompts.filter((prompt) => prompt.startsWith("reconcile"))).toEqual([
			'reconcile [\n  "finding-0",\n  "finding-1",\n  "finding-2"\n]',
		]);
		expect(summary.results.reconcile).toEqual(["reconciled"]);
	});

	it("finalizes an empty fanout so downstream joins still run", async () => {
		const scout = agentNode("scout");
		const fan = { id: "f", kind: "fanout", over: "scout", role: "research", prompt: "{item}" } as PlanNode;
		const evidence = { id: "evidence", kind: "barrier", needs: ["f"] } as PlanNode;
		const spawn: Spawn = async () => ok([]);

		const summary = await runPlan({ plan: plan([scout, fan, evidence]), spawn });
		expect(summary.state.status.f).toBe("done");
		expect(summary.results.f).toEqual([]);
		expect(summary.results.evidence).toEqual([[]]);
	});

	it("computes a transform without spawning anything", async () => {
		const a = agentNode("a");
		const t = { id: "t", kind: "transform", over: "a", op: { op: "count" } } as PlanNode;
		const spawn = vi.fn<Spawn>(async () => ok([1, 2, 3]));

		const summary = await runPlan({ plan: plan([a, t]), spawn });
		expect(summary.results.t).toBe(3);
		expect(spawn).toHaveBeenCalledTimes(1); // only the agent node
	});

	it("resolves a barrier from its dependencies", async () => {
		const b = { id: "bar", kind: "barrier", needs: ["a", "b"] } as PlanNode;
		const spawn: Spawn = async (d) => ok(`v-${d.nodeId}`);
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b"), b]), spawn });
		expect(summary.results.bar).toEqual(["v-a", "v-b"]);
	});
});

describe("runPlan — failure handling", () => {
	it("records a failure and does not run its dependents", async () => {
		const spawn: Spawn = async (d) => (d.nodeId === "a" ? fail("boom") : ok("should not happen"));
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b", ["a"])]), spawn });

		expect(summary.failures).toEqual([{ nodeId: "a", error: "boom" }]);
		expect(summary.state.status.b).toBe("skipped");
	});

	it("fails a partial fanout parent and skips its reconciliation join instead of stalling", async () => {
		const scout = agentNode("scout");
		const fan = { id: "f", kind: "fanout", over: "scout", role: "research", prompt: "{item}", retries: 0 } as PlanNode;
		const evidence = { id: "evidence", kind: "barrier", needs: ["f"] } as PlanNode;
		const spawn: Spawn = async (dispatch) => {
			if (dispatch.nodeId === "scout") return ok(["a", "b", "c"]);
			return dispatch.itemIndex === 1 ? fail("bad item") : ok(`finding-${dispatch.itemIndex}`);
		};

		const summary = await runPlan({ plan: plan([scout, fan, evidence]), spawn });
		expect(summary.state.status.f).toBe("failed");
		expect(summary.state.status.evidence).toBe("skipped");
		expect(summary.failures).toContainEqual({ nodeId: "f", error: "bad item" });
	});

	it("fails a pipeline parent when one item stage fails and skips downstream work", async () => {
		const seed = agentNode("seed");
		const pipeline = {
			id: "pipe",
			kind: "pipeline",
			over: "seed",
			stages: [{ role: "research", prompt: "inspect {item}", retries: 0 }],
		} as PlanNode;
		const after = agentNode("after", ["pipe"]);
		const spawn: Spawn = async (dispatch) => {
			if (dispatch.nodeId === "seed") return ok(["a", "b"]);
			return dispatch.itemIndex === 0 ? fail("pipeline item failed") : ok("fine");
		};

		const summary = await runPlan({ plan: plan([seed, pipeline, after]), spawn });
		expect(summary.state.status.pipe).toBe("failed");
		expect(summary.state.status.after).toBe("skipped");
	});

	it("marks unreached nodes SKIPPED, not failed", async () => {
		// A node never tried is not a node that was tried and did not work.
		const spawn: Spawn = async (d) => (d.nodeId === "a" ? fail("boom") : ok("x"));
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b", ["a"])]), spawn });
		expect(summary.failures.map((f) => f.nodeId)).toEqual(["a"]);
	});

	it("lets independent nodes finish even when one fails", async () => {
		const spawn: Spawn = async (d) => (d.nodeId === "a" ? fail("boom") : ok("fine"));
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b")]), spawn });
		expect(summary.results.b).toBe("fine");
	});

	it("treats a THROWN spawner as a failure rather than taking the run down", async () => {
		const spawn: Spawn = async () => {
			throw new Error("process exploded");
		};
		const summary = await runPlan({ plan: plan([agentNode("a")]), spawn });
		expect(summary.failures[0].error).toContain("process exploded");
	});
});

describe("runPlan — retries", () => {
	it("retries a failing node up to its budget, then gives up", async () => {
		let calls = 0;
		const spawn: Spawn = async () => {
			calls++;
			return fail("nope");
		};
		await runPlan({ plan: plan([agentNode("a")]), spawn });
		expect(calls).toBe(3); // default 2 retries + the original
	});

	it("stops retrying the moment one succeeds", async () => {
		let calls = 0;
		const spawn: Spawn = async () => {
			calls++;
			return calls === 2 ? ok("recovered") : fail("transient");
		};
		const summary = await runPlan({ plan: plan([agentNode("a")]), spawn });
		expect(calls).toBe(2);
		expect(summary.results.a).toBe("recovered");
	});

	it("honours a node's own retry budget", async () => {
		let calls = 0;
		const node = { id: "a", kind: "agent", role: "research", prompt: "x", retries: 0 } as PlanNode;
		const spawn: Spawn = async () => {
			calls++;
			return fail("nope");
		};
		await runPlan({ plan: plan([node]), spawn });
		expect(calls).toBe(1);
	});

	it("caps retries even if a plan asks for more", async () => {
		let calls = 0;
		const node = { id: "a", kind: "agent", role: "research", prompt: "x", retries: 99 } as PlanNode;
		const spawn: Spawn = async () => {
			calls++;
			return fail("nope");
		};
		await runPlan({ plan: plan([node]), spawn });
		expect(calls).toBeLessThanOrEqual(4);
	});
});

describe("runPlan — a retry is spend, and both caps must see it", () => {
	// A retried dispatch spawns up to four REAL workers and used to report the
	// last one's tokens and a single admission. Measured: four spawns at 5000
	// tokens each surfaced as `agentsSpawned: 1, spentTokens: 5000` — so a node
	// with `retries: 3` could burn 4x its accounted spend while the hard caps in
	// `nextBatch` saw nothing.
	const retrier = (retries: number): PlanNode =>
		({ id: "a", kind: "agent", role: "research", prompt: "x", retries }) as PlanNode;

	const burn = (tokens: number, cost: number): WorkerResult => ({ ok: false, value: null, tokens, cost, error: "nope" });

	it("sums the tokens and cost of every attempt, not just the last", async () => {
		const spawn: Spawn = async () => burn(5_000, 0.5);
		const summary = await runPlan({ plan: plan([retrier(3)]), spawn });

		expect(summary.spentTokens).toBe(20_000);
		expect(summary.spentCost).toBeCloseTo(2);
	});

	it("counts the discarded attempts of a node that eventually SUCCEEDS", async () => {
		let calls = 0;
		const events: Array<{ ev: string; attempts?: number }> = [];
		const spawn: Spawn = async () => {
			calls++;
			return calls === 3 ? ok("recovered", 100) : burn(1_000, 0);
		};
		const summary = await runPlan({ plan: plan([retrier(3)]), spawn, journal: (event) => events.push(event) });

		expect(summary.results.a).toBe("recovered");
		expect(summary.spentTokens).toBe(2_100);
		expect(summary.agentsSpawned).toBe(3);
		// A node that succeeded on its third worker is not a one-worker node, and
		// the journal is the only place that difference is visible per node.
		expect(events.find((event) => event.ev === "node_finished")?.attempts).toBe(3);
	});

	it("admits each attempt against maxAgents, so the agent cap cannot be run past", async () => {
		const spawn: Spawn = async () => burn(10, 0);
		const summary = await runPlan({
			plan: plan([retrier(3), agentNode("b")], { maxAgents: 3, maxConcurrent: 1 }),
			spawn,
		});

		expect(summary.agentsSpawned).toBe(4); // one dispatch, four workers
		expect(summary.halted).toBe("agents");
	});

	it("lets the token budget see the retried spend", async () => {
		const spawn: Spawn = async () => burn(5_000, 0);
		const summary = await runPlan({
			plan: plan([retrier(3), agentNode("b")], { budgetTokens: 10_000 }),
			spawn,
		});

		expect(summary.spentTokens).toBe(20_000);
		expect(summary.halted).toBe("budget");
	});

	it("records the attempt count on the journal event, so retry spend is legible", async () => {
		const events: Array<{ ev: string; attempts?: number }> = [];
		const spawn: Spawn = async () => burn(1, 0);
		await runPlan({ plan: plan([retrier(2)]), spawn, journal: (event) => events.push(event) });

		expect(events.find((event) => event.ev === "node_failed")?.attempts).toBe(3);
	});
});

describe("runPlan — nodes the scheduler never ran", () => {
	// `repeat` is in the plan schema and has no branch in `nextBatch`. The loop
	// then breaks out with those nodes statusless and returned a CLEAN success:
	// no halt, no failure, no mention. Validation now refuses `repeat` up front,
	// but the reporting hole is the general one — any node the scheduler
	// produces no work for must be named, not dropped.
	const repeatNode = {
		id: "loop",
		kind: "repeat",
		needs: ["seed"],
		body: [{ id: "inner", kind: "agent", role: "research", prompt: "again" }],
		maxRounds: 2,
		until: { kind: "empty", of: "seed" },
	} as unknown as PlanNode;

	it("names them instead of reporting a successful run", async () => {
		const join = { id: "join", kind: "barrier", needs: ["loop"] } as PlanNode;
		const spawn: Spawn = async () => ok("seeded");
		const summary = await runPlan({ plan: plan([agentNode("seed"), repeatNode, join]), spawn });

		expect(summary.neverRan).toEqual(["loop", "join"]);
		expect(summary.state.status.loop).toBe("skipped");
		expect(summary.state.status.join).toBe("skipped");
		// Surfaced through the failure channel because that is what the tool's
		// summary text prints; a run that silently drops a third of its plan is
		// not a run that succeeded.
		expect(summary.failures.map((failure) => failure.nodeId)).toEqual(["loop", "join"]);
		expect(summary.failures[0].error).toContain("never ran");
	});

	it("stays silent on a healthy run", async () => {
		const spawn: Spawn = async () => ok("x");
		const summary = await runPlan({ plan: plan([agentNode("a"), agentNode("b", ["a"])]), spawn });

		expect(summary.neverRan).toBeUndefined();
		expect(summary.failures).toEqual([]);
	});

	it("does not re-report as failures the nodes a HALT already explains", async () => {
		// The halt line names the reason and the cap. Adding a failure per unrun
		// node there would bury the one line that explains the whole run.
		const nodes = Array.from({ length: 4 }, (_, index) => agentNode(`n${index}`));
		const spawn: Spawn = async () => ok("x", 500);
		const summary = await runPlan({ plan: plan(nodes, { budgetTokens: 600, maxConcurrent: 1 }), spawn });

		expect(summary.halted).toBe("budget");
		expect(summary.failures).toEqual([]);
		expect(summary.neverRan?.length).toBeGreaterThan(0);
	});
});

describe("runPlan — the identical-failure collapse", () => {
	it("halts once several nodes fail the same way", async () => {
		// Three nodes failing identically is one problem discovered in parallel,
		// not three. Continuing spends the rest of the fan-out rediscovering it.
		const nodes = Array.from({ length: 12 }, (_, i) => agentNode(`n${i}`));
		const touched = new Set<string>();
		const spawn: Spawn = async (dispatch) => {
			touched.add(dispatch.nodeId);
			return fail("TypeError: cannot read 'x' of undefined at line 42");
		};

		const summary = await runPlan({ plan: plan(nodes, { maxConcurrent: 8 }), spawn });
		expect(summary.halted).toBeDefined();
		// Counts DISTINCT nodes reached, not `agentsSpawned`. Those were the same
		// number only while a retried dispatch was miscounted as one admission;
		// now that every attempt is admitted, `agentsSpawned` legitimately exceeds
		// the node count (8 dispatches x 3 attempts) and the old assertion was
		// measuring the accounting bug rather than the collapse.
		expect(touched.size).toBeLessThan(nodes.length);
	});

	it("does NOT collapse distinct failures", async () => {
		const nodes = Array.from({ length: 3 }, (_, i) => agentNode(`n${i}`));
		const spawn: Spawn = async (d) => fail(`unique failure for ${d.nodeId}`);
		const summary = await runPlan({ plan: plan(nodes, { maxConcurrent: 8 }), spawn });
		expect(summary.failures).toHaveLength(3);
	});
});

describe("errorSignature", () => {
	it("collapses varying numbers and quoted strings", () => {
		expect(errorSignature("failed at line 42 in 'foo.ts'")).toBe(errorSignature("failed at line 99 in 'bar.ts'"));
	});
	it("keeps genuinely different errors distinct", () => {
		expect(errorSignature("out of memory")).not.toBe(errorSignature("permission denied"));
	});
});

describe("runPlan — hard limits", () => {
	it("halts on the token budget", async () => {
		const nodes = Array.from({ length: 10 }, (_, i) => agentNode(`n${i}`));
		const spawn: Spawn = async () => ok("x", 500);
		const summary = await runPlan({ plan: plan(nodes, { budgetTokens: 1000, maxConcurrent: 1 }), spawn });

		expect(summary.halted).toBe("budget");
		expect(summary.agentsSpawned).toBeLessThan(10);
	});

	it("halts on the agent cap", async () => {
		const nodes = Array.from({ length: 20 }, (_, i) => agentNode(`n${i}`));
		const spawn: Spawn = async () => ok("x", 1);
		const summary = await runPlan({ plan: plan(nodes, { maxAgents: 5, maxConcurrent: 1 }), spawn });

		expect(summary.halted).toBe("agents");
		expect(summary.agentsSpawned).toBeLessThanOrEqual(6);
	});

	it("stops on an abort signal", async () => {
		const controller = new AbortController();
		const nodes = Array.from({ length: 10 }, (_, i) => agentNode(`n${i}`));
		const spawn: Spawn = async () => {
			controller.abort();
			return ok("x");
		};
		const summary = await runPlan({ plan: plan(nodes, { maxConcurrent: 1 }), spawn, signal: controller.signal });
		expect(summary.halted).toBe("aborted");
	});
});

describe("runPlan — resume", () => {
	it("does not re-run work already recorded as done", async () => {
		const spawn = vi.fn<Spawn>(async (d) => ok(`fresh-${d.nodeId}`));
		const summary = await runPlan({
			plan: plan([agentNode("a"), agentNode("b", ["a"])]),
			spawn,
			completed: { a: "from-a-previous-run" },
		});

		expect(summary.results.a).toBe("from-a-previous-run");
		expect(spawn).toHaveBeenCalledTimes(1); // only b
	});
});

describe("runPlan — the journal", () => {
	it("brackets the run and records each node", async () => {
		const events: string[] = [];
		const spawn: Spawn = async () => ok("x");
		await runPlan({
			plan: plan([agentNode("a")]),
			spawn,
			journal: (e) => events.push(e.ev),
		});

		expect(events[0]).toBe("run_started");
		expect(events).toContain("node_started");
		expect(events).toContain("node_finished");
		expect(events.at(-1)).toBe("run_finished");
	});

	it("records a failure with its reason", async () => {
		const events: Array<{ ev: string; reason?: string }> = [];
		const spawn: Spawn = async () => fail("the reason");
		await runPlan({ plan: plan([agentNode("a")]), spawn, journal: (e) => events.push(e) });

		expect(events.find((e) => e.ev === "node_failed")?.reason).toBe("the reason");
	});
});
