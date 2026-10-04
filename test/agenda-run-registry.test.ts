import { describe, expect, it, vi } from "vitest";

import type { RunSummary } from "../extensions/agenda/executor.ts";
import type { Plan } from "../extensions/agenda/plan-schema.ts";
import { DurableRunRegistry } from "../extensions/agenda/run-registry.ts";

const PLAN: Plan = { name: "p", description: "d", nodes: [{ id: "a", kind: "agent", role: "research", prompt: "go" }] };

const summary = (halted?: RunSummary["halted"]): RunSummary => ({
	state: { results: {}, status: {}, running: new Set(), agentsSpawned: 1, spentTokens: 10, spentCost: 0 },
	results: {},
	...(halted ? { halted } : {}),
	failures: [],
	agentsSpawned: 1,
	retrySpawns: 0,
	spentTokens: 10,
	spentCost: 0,
});

describe("DurableRunRegistry", () => {
	it("retains a completed result after the background notification", () => {
		let now = 100;
		const runs = new DurableRunRegistry(() => now);
		runs.start("run-1", "wide review", vi.fn());
		now = 200;
		runs.complete("run-1", { text: "all findings", details: { full: true }, summary: summary(), plan: PLAN });
		runs.markNotified("run-1");

		expect(runs.get("run-1")).toMatchObject({
			status: "done",
			startedAt: 100,
			endedAt: 200,
			notified: true,
			result: { text: "all findings" },
		});
	});

	it("cancels every active run on session shutdown without relabeling completed work", () => {
		const first = vi.fn();
		const second = vi.fn();
		const runs = new DurableRunRegistry(() => 100);
		runs.start("running", "running", first);
		runs.start("done", "done", second);
		runs.complete("done", { text: "done", details: null, summary: summary(), plan: PLAN });

		runs.cancelAll();
		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
		expect(runs.get("running")?.status).toBe("canceled");
		expect(runs.get("done")?.status).toBe("done");
	});

	it("classifies an aborted summary as canceled, not failed", () => {
		const runs = new DurableRunRegistry(() => 100);
		runs.start("run", "run", vi.fn());
		runs.complete("run", { text: "aborted", details: null, summary: summary("aborted"), plan: PLAN });
		expect(runs.get("run")?.status).toBe("canceled");
	});
});
