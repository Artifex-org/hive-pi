/**
 * The drift probe's Jev path. Jev is asked first; the `pi -p` probe runs only
 * when Jev did not answer. `runOneShot` is mocked (spreading the real module, so
 * the mock is not an allowlist) and Jev is a fake fetch — nothing here spawns
 * `pi` or reaches the network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runOneShot = vi.hoisted(() => vi.fn());
vi.mock("../extensions/agenda/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/agenda/spawn.ts")>()),
	runOneShot,
}));

import {
	createDriftPolicy,
	DRIFT_CHECK_EVERY,
	DRIFT_JEV_BAR,
	DRIFT_JEV_METRIC,
	driftLedgerId,
	jevDriftReason,
} from "../extensions/agenda/drift.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { count, emptyLedger } from "../extensions/agenda/ledger.ts";
import { TypesafeClient } from "../extensions/typesafe-common/client.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";

const goal: GoalItem = {
	schemaVersion: 1,
	kind: "goal",
	id: "g1",
	state: "active",
	condition: "the PR's checks are green",
	createdAt: 0,
	updatedAt: 0,
	ledger: {
		iterations: 0,
		maxIterations: 8,
		turnsEvaluated: 0,
		judgeErrors: 0,
		noProgressStreak: 0,
		pendingStreak: 0,
		tokens: 0,
	},
};

const context = { cwd: "/tmp", ledger: emptyLedger, lastAssistantText: undefined, transcript: "[assistant] fixing the failing test" };

/** A Jev whose noul is `p`, or whose call fails with `status`. Records bodies. */
function fakeJev(p: number | null, status = 200) {
	const bodies: unknown[] = [];
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		if (status !== 200 || p === null) return new Response("nope", { status: status === 200 ? 500 : status });
		return new Response(
			JSON.stringify({ model: "jev-test", answers: { serves: { type: "noul", noul: p } }, usage: { input_tokens: 10, output_tokens: 1 } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	});
	const client = new TypesafeClient({ config: configFrom({ enabled: true }), apiKey: "k", fetchImpl });
	return { client, fetchImpl, bodies };
}

async function probeOnce(jev: TypesafeClient | null) {
	const policy = createDriftPolicy({ goal: () => goal, evaluatorModel: () => undefined, jev: () => jev });
	let work = null;
	for (let i = 0; i < DRIFT_CHECK_EVERY; i++) work = policy.decide(context);
	expect(work).not.toBeNull();
	return work!.run();
}

beforeEach(() => {
	runOneShot.mockReset();
	runOneShot.mockResolvedValue({ text: '{"ok": true, "reason": "fine"}', tokens: 1, exitCode: 0, timedOut: false, stderr: "" });
});

describe("drift probe with Jev", () => {
	it("an aligned Jev answer passes without spawning pi", async () => {
		const { client, fetchImpl, bodies } = fakeJev(0.9);
		const out = await probeOnce(client);
		expect(out.metric.outcome).toBe("pass");
		expect(out.metric.name).toBe(DRIFT_JEV_METRIC);
		expect(out.inject).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(runOneShot).not.toHaveBeenCalled();
		// The state carries the goal and the excerpt, and nothing else.
		expect((bodies[0] as { state: Record<string, unknown> }).state).toEqual({
			goal: goal.condition,
			recent_activity: context.transcript,
		});
	});

	it("a drift answer below the bar nags once, quoting the condition, and spends the cap", async () => {
		const { client } = fakeJev(DRIFT_JEV_BAR - 0.2);
		const out = await probeOnce(client);
		expect(out.metric.outcome).toBe("fail");
		expect(out.metric.name).toBe(DRIFT_JEV_METRIC);
		expect(out.inject).toContain(`The goal is still: ${goal.condition}`);
		expect(out.inject).toContain(jevDriftReason(DRIFT_JEV_BAR - 0.2));
		expect(count(out.ledger!(emptyLedger), driftLedgerId(goal.id))).toBe(1);
		expect(runOneShot).not.toHaveBeenCalled();
	});

	it("exactly at the bar is aligned — uncertainty never nags", async () => {
		const { client } = fakeJev(DRIFT_JEV_BAR);
		const out = await probeOnce(client);
		expect(out.metric.outcome).toBe("pass");
	});

	it("a failed Jev call falls through to the pi probe, never to a verdict", async () => {
		const { client, fetchImpl } = fakeJev(null, 503);
		runOneShot.mockResolvedValue({ text: '{"ok": false, "reason": "refactoring CSS"}', tokens: 1, exitCode: 0, timedOut: false, stderr: "" });
		const out = await probeOnce(client);
		expect(fetchImpl).toHaveBeenCalled();
		expect(runOneShot).toHaveBeenCalledTimes(1);
		expect(out.metric.outcome).toBe("fail");
		// Counted as the incumbent's answer, not Jev's: this is the liveness split.
		expect(out.metric.name).toBeUndefined();
		expect(out.inject).toContain("refactoring CSS");
	});

	it("a Jev that is not live is never called", async () => {
		const fetchImpl = vi.fn();
		const off = new TypesafeClient({ config: configFrom({}), apiKey: "k", fetchImpl });
		const out = await probeOnce(off);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(runOneShot).toHaveBeenCalledTimes(1);
		expect(out.metric.outcome).toBe("pass");
	});

	it("no Jev at all behaves exactly as before", async () => {
		await probeOnce(null);
		expect(runOneShot).toHaveBeenCalledTimes(1);
	});
});
