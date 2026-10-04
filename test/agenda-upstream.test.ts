/**
 * `needs` FORWARDS results, it does not merely order execution.
 *
 * Measured, five times in a week (papercuts 2026-10-01..03): a reconciler with
 * `needs: ["contract", "evidence"]` was dispatched with only its own prompt,
 * said "No independent worker findings were supplied to reconcile", and went
 * on to review unrelated work it found in the repo. The orchestration-
 * reconciler role prompt itself says "The prompt contains the prior workers'
 * findings as data" — the executor never put them there.
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runPlan, type Spawn, type WorkerResult } from "../extensions/agenda/executor.ts";
import type { Plan, PlanNode } from "../extensions/agenda/plan-schema.ts";
import { INLINE_INPUT_BYTES } from "../extensions/agenda/upstream.ts";

const ok = (value: unknown): WorkerResult => ({ ok: true, value, tokens: 1 });

function plan(nodes: PlanNode[]): Plan {
	return { name: "p", description: "d", nodes };
}

const agent = (id: string, needs?: string[]): PlanNode =>
	({ id, kind: "agent", role: "research", prompt: `do ${id}`, ...(needs ? { needs } : {}) }) as PlanNode;

/** Run the plan with fixed per-node outputs; return the prompt each node was dispatched with. */
async function promptsFor(nodes: PlanNode[], outputs: Record<string, unknown>, inputsDir?: string) {
	const prompts: Record<string, string> = {};
	const spawn: Spawn = async (dispatch) => {
		prompts[dispatch.nodeId] = dispatch.prompt;
		return ok(outputs[dispatch.nodeId] ?? `out-${dispatch.nodeId}`);
	};
	const summary = await runPlan({ plan: plan(nodes), spawn, inputsDir });
	return { prompts, summary };
}

describe("a dependent agent node receives its dependencies' final outputs", () => {
	it("carries a direct dependency's result in the prompt, labelled and marked as data", async () => {
		const { prompts } = await promptsFor([agent("contract"), agent("reconcile", ["contract"])], {
			contract: "FINDING: network grants are not revoked on node removal (grants.go:88)",
		});
		expect(prompts.reconcile.startsWith("do reconcile")).toBe(true);
		expect(prompts.reconcile).toContain("### contract");
		expect(prompts.reconcile).toContain("FINDING: network grants are not revoked on node removal (grants.go:88)");
		expect(prompts.reconcile).toContain("DATA");
	});

	it("leaves a node with no needs exactly as authored", async () => {
		const { prompts } = await promptsFor([agent("a")], {});
		expect(prompts.a).toBe("do a");
	});

	it("expands a barrier into the results it joined, each under its own name", async () => {
		const { prompts } = await promptsFor(
			[
				agent("contract"),
				agent("evidence"),
				{ id: "join", kind: "barrier", needs: ["contract", "evidence"] } as PlanNode,
				agent("reconcile", ["join"]),
			],
			{ contract: "CONTRACT-REPORT", evidence: { verdict: "pass", cases: 3 } },
		);
		expect(prompts.reconcile).toContain("### contract\nCONTRACT-REPORT");
		expect(prompts.reconcile).toContain("### evidence");
		expect(prompts.reconcile).toContain('"verdict": "pass"');
	});

	it("forwards a field ref as just that field", async () => {
		const { prompts } = await promptsFor([agent("a"), agent("b", ["a.verdict"])], { a: { verdict: "fail", noise: "x".repeat(50) } });
		expect(prompts.b).toContain("### a.verdict\nfail");
		expect(prompts.b).not.toContain("xxxxx");
	});

	it("does not change the node's work id, so resume still matches", async () => {
		const started: string[] = [];
		const spawn: Spawn = async (dispatch) => {
			started.push(dispatch.workId);
			return ok("v");
		};
		const nodes = [agent("a"), agent("b", ["a"])];
		const first = await runPlan({ plan: plan(nodes), spawn });
		const resumed: string[] = [];
		await runPlan({
			plan: plan(nodes),
			spawn: async (dispatch) => {
				resumed.push(dispatch.nodeId);
				return ok("v");
			},
			completed: { a: first.results.a, b: first.results.b },
		});
		expect(resumed).toEqual([]);
		expect(new Set(started).size).toBe(2);
	});
});

describe("a large upstream result is bounded: spilled to a file the worker can read", () => {
	it("writes the whole result to a file, passes its path, and says how much was not inlined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hive-pi-upstream-"));
		const big = `THE-START\n${"finding line\n".repeat(Math.ceil((INLINE_INPUT_BYTES * 3) / 13))}THE-END`;
		const { prompts } = await promptsFor([agent("review"), agent("reconcile", ["review"])], { review: big }, dir);

		expect(prompts.reconcile).not.toContain(big);
		expect(Buffer.byteLength(prompts.reconcile)).toBeLessThan(INLINE_INPUT_BYTES);
		const file = /written in full to (\S+?) —/.exec(prompts.reconcile)?.[1];
		expect(file, prompts.reconcile).toBeDefined();
		expect(file!.startsWith(dir)).toBe(true);
		expect(readFileSync(file!, "utf8")).toBe(big);
		expect(prompts.reconcile).toContain(`${Buffer.byteLength(big)} bytes`);
		expect(prompts.reconcile).toContain("THE-END");
	});

	it("fails the dependent node, loudly, when a result must spill and there is nowhere to write it", async () => {
		const big = "y".repeat(INLINE_INPUT_BYTES * 2);
		const { prompts, summary } = await promptsFor([agent("review"), agent("reconcile", ["review"])], { review: big });
		expect(prompts.reconcile).toBeUndefined();
		expect(summary.failures.map((failure) => failure.nodeId)).toEqual(["reconcile"]);
		expect(summary.failures[0].error).toContain("no inputs directory");
	});
});

describe("a fanout's items share one rendering of its inputs", () => {
	it("spills a large needed result ONCE, not once per item", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hive-pi-upstream-fan-"));
		const prompts: string[] = [];
		const spawn: Spawn = async (dispatch) => {
			if (dispatch.nodeId === "reviews") prompts.push(dispatch.prompt);
			if (dispatch.nodeId === "items") return ok(["x", "y", "z"]);
			if (dispatch.nodeId === "context") return ok("c".repeat(INLINE_INPUT_BYTES * 2));
			return ok("r");
		};
		await runPlan({
			plan: plan([
				agent("items"),
				agent("context"),
				{ id: "reviews", kind: "fanout", over: "items", role: "research", prompt: "review {item}", needs: ["context"] } as PlanNode,
			]),
			spawn,
			inputsDir: dir,
		});
		expect(prompts).toHaveLength(3);
		expect(readdirSync(dir)).toHaveLength(1);
		expect(new Set(prompts.map((prompt) => /written in full to (\S+?) —/.exec(prompt)?.[1])).size).toBe(1);
	});
});
