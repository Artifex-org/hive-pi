/**
 * `/handoff` (HIV-1231) — seed building and the consume-once contract.
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	buildHandoffSeed,
	consumeHandoff,
	handoffPath,
	writeHandoff,
} from "../extensions/agenda/handoff.ts";
import { createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { emptySignals } from "../extensions/agenda/signals.ts";

const goal: GoalItem = {
	schemaVersion: 1,
	kind: "goal",
	id: "g",
	state: "active",
	condition: "PR created and its checks green",
	createdAt: 0,
	updatedAt: 0,
	ledger: { iterations: 0, maxIterations: 8, turnsEvaluated: 0, judgeErrors: 0, noProgressStreak: 0, tokens: 0 },
};

describe("buildHandoffSeed", () => {
	it("carries objective, goal, lifecycle stage, todos and git state", () => {
		const seed = buildHandoffSeed({
			objective: "finish the verify stage",
			goal,
			conductor: withStage(createConductor("c", 0), "execute", 0),
			signals: {
				...emptySignals,
				tasks: { total: 4, pending: 1, inProgress: 1, completed: 2 },
				plan: { phase: "approved", revision: 2, stepCount: 4, goal: "ship it" },
			},
			gitStatus: " M extensions/agenda/index.ts\n?? docs/new.md",
			cwd: "/work/repo",
		});
		expect(seed).toContain("finish the verify stage");
		expect(seed).toContain("PR created and its checks green");
		expect(seed).toContain('"execute" stage');
		expect(seed).toContain("2/4 completed");
		expect(seed).toContain("phase: approved, 4 step(s), goal: ship it");
		expect(seed).toContain("M extensions/agenda/index.ts");
		expect(seed).toContain("verifying this seed against the worktree");
	});

	it("omits sections that have nothing to say", () => {
		const seed = buildHandoffSeed({
			objective: "",
			goal: null,
			conductor: null,
			signals: emptySignals,
			gitStatus: null,
			cwd: "/work/repo",
		});
		expect(seed).not.toContain("## Finish line");
		expect(seed).not.toContain("## Lifecycle");
		expect(seed).not.toContain("## Todos");
		expect(seed).toContain("carry the previous session's work forward");
	});
});

describe("write + consume", () => {
	it("round-trips, renames on consume, and never consumes twice", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-"));
		const path = writeHandoff(cwd, "# Handoff\ncontent");
		expect(path).toBe(handoffPath(cwd));
		expect(existsSync(path)).toBe(true);

		const seed = consumeHandoff(cwd, 1234);
		expect(seed).toContain("content");
		// Renamed, not deleted — lineage stays on disk.
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(join(cwd, ".pi"))).toContain("handoff-consumed-1234.md");

		expect(consumeHandoff(cwd)).toBeNull();
	});

	it("consuming when nothing is pending is a quiet null", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-none-"));
		expect(consumeHandoff(cwd)).toBeNull();
	});
});
