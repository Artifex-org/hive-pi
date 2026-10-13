/**
 * Operator attendance and the lifecycle reopen (attendance.ts), replayed from
 * session f2ead622 (2026-10-13): an operator gave a finished Hive launch a new
 * instruction, the conductor stayed in consolidate/done, and the session
 * consolidated the old task, reported `completed` and closed under them.
 */

import { describe, expect, it, vi } from "vitest";
const runRecap = vi.hoisted(() => vi.fn());
vi.mock("../extensions/agenda/spawn.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../extensions/agenda/spawn.ts")>(), runOneShot: runRecap,
}));
import agenda from "../extensions/agenda/index.ts";
import { rehydrateAttended, reopenForInstruction } from "../extensions/agenda/attendance.ts";
import { type ConductorItem, createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import { createGoal, type GoalItem, withState } from "../extensions/agenda/goal-state.ts";
import { completedRecap, instructionRecap } from "../extensions/agenda/recap.ts";
import { OPERATOR_INPUT_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

function conductorAt(stage: ConductorItem["stage"]): ConductorItem {
	return withStage({ ...createConductor("conductor-1", 1), complexity: "complex" }, stage, 2);
}

function goalIn(state: GoalItem["state"], condition = "Report and register exist with retained diagnostics"): GoalItem {
	return withState(createGoal("goal-1", condition, 1), state, 2);
}

const asEntry = (data: unknown) => ({ customType: "agenda", data });

function latest<T>(fake: FakePi, kind: string): T | undefined {
	return fake.entries
		.filter((e) => e.customType === "agenda" && (e.data as { kind?: string }).kind === kind)
		.map((e) => e.data as T)
		.at(-1);
}

function statuses(fake: FakePi) {
	return fake.entries
		.filter((e) => e.customType === "agent-status")
		.map((e) => e.data as { taskState: string; recap: string });
}

async function operatorSays(fake: FakePi, text: string, source = "operator") {
	fake.api.events.emit(OPERATOR_INPUT_CHANNEL, { source });
	await fake.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
}

describe("reopenForInstruction", () => {
	it("reopens a done or consolidating lifecycle to idle and retires the achieved goal", () => {
		for (const stage of ["done", "consolidate"] as const) {
			const out = reopenForInstruction(conductorAt(stage), goalIn("achieved"), 10);
			expect(out.conductor?.stage).toBe("idle");
			expect(out.goal?.state).toBe("cleared");
		}
	});

	it("reopens verify only once the goal is achieved — a steer mid-delivery is the same task", () => {
		expect(reopenForInstruction(conductorAt("verify"), goalIn("active"), 10)).toEqual({});
		expect(reopenForInstruction(conductorAt("verify"), goalIn("achieved"), 10).conductor?.stage).toBe("idle");
	});

	it("leaves work in progress alone", () => {
		expect(reopenForInstruction(conductorAt("execute"), goalIn("active"), 10)).toEqual({});
		expect(reopenForInstruction(null, null, 10)).toEqual({});
		expect(reopenForInstruction(conductorAt("idle"), goalIn("active"), 10)).toEqual({});
	});

	it("retires an achieved goal even when no lifecycle ran (a simple task)", () => {
		const out = reopenForInstruction(null, goalIn("achieved"), 10);
		expect(out.conductor).toBeUndefined();
		expect(out.goal?.state).toBe("cleared");
	});
});

describe("rehydrateAttended", () => {
	it("finds only a well-formed attendance entry", () => {
		expect(rehydrateAttended([])).toBe(false);
		expect(rehydrateAttended([{ customType: "agenda-attended", data: { kind: "other" } }])).toBe(false);
		expect(rehydrateAttended([{ customType: "agenda-attended", data: { kind: "agenda-attended", at: 1, source: "operator" } }])).toBe(true);
	});
});

describe("status lines the session states mechanically", () => {
	it("names the new instruction, bounded and redacted", () => {
		expect(instructionRecap("i want you to do a proper multi hour deep research run")).toBe(
			"New instruction: i want you to do a proper multi hour deep research run",
		);
		expect(instructionRecap("x".repeat(500)).length).toBeLessThanOrEqual(200);
		expect(instructionRecap("  ")).toBe("Working on a new instruction");
	});

	it("states completion from the achieved goal", () => {
		expect(completedRecap("PR open and checks green")).toBe("Completed: PR open and checks green");
		expect(completedRecap(null)).toBe("Completed the task");
	});
});

describe("a person's new instruction reopens a finished lifecycle", () => {
	it("moves done → idle, clears the achieved goal, and replaces the stale status at once", async () => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, {
			branch: [asEntry(goalIn("achieved")), asEntry(conductorAt("done"))],
		});

		await operatorSays(fake, "i want you to do a proepr multi hour deep research run");

		expect(latest<ConductorItem>(fake, "conductor")?.stage).toBe("idle");
		expect(latest<GoalItem>(fake, "goal")?.state).toBe("cleared");
		expect(statuses(fake).at(-1)).toEqual(expect.objectContaining({
			taskState: "idle",
			recap: "New instruction: i want you to do a proepr multi hour deep research run",
		}));
	});

	it("reopens a consolidate stage the operator interrupts (f2ead622 at 20:21:51)", async () => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, {
			branch: [asEntry(goalIn("achieved")), asEntry(conductorAt("consolidate"))],
		});

		await operatorSays(fake, "continue", "collaborator");

		expect(latest<ConductorItem>(fake, "conductor")?.stage).toBe("idle");
	});

	// A settle in progress can still commit the old task's `done` after the
	// announcement (f2ead622: the "continue" and `done` share a second), so the
	// reopen keys on the message arriving, not on the announcement.
	it("reopens when the announced message arrives, not at the announcement", async () => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, {
			branch: [asEntry(goalIn("achieved")), asEntry(conductorAt("consolidate"))],
		});
		fake.api.events.emit(OPERATOR_INPUT_CHANNEL, { source: "operator" });
		const conductorEntries = () => fake.entries.filter((e) => (e.data as { kind?: string }).kind === "conductor");
		expect(conductorEntries()).toHaveLength(0);

		await fake.emit({ type: "message_end", message: { role: "user", content: "continue" } });

		expect(latest<ConductorItem>(fake, "conductor")?.stage).toBe("idle");
	});

	it("does not reopen for Hive's own notices or other agents — no operator announcement, no reopen", async () => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, {
			branch: [asEntry(goalIn("achieved")), asEntry(conductorAt("done"))],
		});
		const before = fake.entries.length;

		await fake.emit({ type: "message_end", message: { role: "user", content: "Hive: you reported this session complete. Tidy up." } });

		expect(fake.entries.length).toBe(before);
	});

	it("leaves an in-progress lifecycle alone when the operator steers it", async () => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_start", reason: "resume" }, {
			branch: [asEntry(goalIn("active")), asEntry(conductorAt("execute"))],
		});

		await operatorSays(fake, "also cover the edge case");

		expect(fake.entries.some((e) => (e.data as { kind?: string }).kind === "conductor")).toBe(false);
		expect(statuses(fake)).toEqual([]);
	});
});

describe("a completed settle whose summarizer produced nothing", () => {
	it("states completion instead of leaving the server on an earlier recap", async () => {
		vi.useFakeTimers(); runRecap.mockReset();
		try {
			// f2ead622: both completion recaps hit the 60s cap, and the server kept
			// showing "blocked on hive-attest" — a blocker later gates had resolved.
			runRecap.mockResolvedValue({ exitCode: 0, timedOut: true, text: "" });
			const fake = createFakePi();
			agenda(fake.api);
			const goal = goalIn("achieved", "Baseline repair milestone committed with named regressions passing");
			await fake.emit({ type: "session_start", reason: "resume" }, { branch: [asEntry(goal), asEntry(conductorAt("done"))] });
			await fake.emit({ type: "agent_settled" }, { branch: [{ message: { role: "assistant", content: "Committed the repair. ".repeat(40) } }] });
			await vi.advanceTimersByTimeAsync(1);

			expect(statuses(fake).at(-1)).toEqual(expect.objectContaining({
				taskState: "completed",
				recap: "Completed: Baseline repair milestone committed with named regressions passing",
			}));
		} finally { vi.clearAllTimers(); vi.useRealTimers(); runRecap.mockReset(); }
	});

	it("keeps preserving on empty while the work is not complete", async () => {
		vi.useFakeTimers(); runRecap.mockReset();
		try {
			runRecap.mockResolvedValue({ exitCode: 1, timedOut: false, text: "" });
			const fake = createFakePi();
			agenda(fake.api);
			await fake.emit({ type: "agent_settled" }, { branch: [{ message: { role: "assistant", content: "Still working. ".repeat(40) } }] });
			await vi.advanceTimersByTimeAsync(1);

			expect(statuses(fake).at(-1)).toEqual(expect.objectContaining({ taskState: "idle", recap: "" }));
		} finally { vi.clearAllTimers(); vi.useRealTimers(); runRecap.mockReset(); }
	});
});
