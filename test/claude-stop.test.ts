/**
 * `hook stop` — the agenda chain for a Claude session, end to end through the
 * CLI with a fake pinned pi and a fake Hive catalog: what Claude reads on
 * stdout, what persists, and what the driver reads from the spool.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGoal, type GoalItem } from "../extensions/agenda/goal-state.ts";
import type { OneShotOptions, OneShotResult } from "../extensions/agenda/spawn.ts";
import { stopDecision } from "../claude/hooks/stop.ts";
import { createSpool } from "../claude/spool.ts";
import { makeLaunch, runCli, startFakeHive, writeTranscript, type FakeHive, type LaunchEnv } from "./claude-harness.ts";

const JUDGE = "You are grading whether a stated completion condition has been met.";
const DRIFT = "You are checking whether an agent's RECENT ACTIVITY still serves its stated goal.";

let launch: LaunchEnv;
let hive: FakeHive;
let transcript: string;

beforeEach(async () => {
	launch = makeLaunch();
	hive = await startFakeHive();
	launch.env.HIVE_URL = hive.url;
	launch.env.HIVE_TOKEN = "session-token";
	transcript = writeTranscript(join(launch.root, "t.jsonl"), [
		{ user: "make the tests pass" },
		{ assistant: "I changed src/a.ts. Running the suite next." },
	]);
});
afterEach(async () => {
	await hive.close();
});

function setGoal(overrides: Partial<GoalItem["ledger"]> = {}, state: GoalItem["state"] = "active"): void {
	const goal = createGoal("goal-1", "`npm test` exits 0", Date.now());
	writeFileSync(join(launch.stateDir, "goal.json"), JSON.stringify({ ...goal, state, ledger: { ...goal.ledger, ...overrides } }));
}

function goal(): GoalItem {
	return JSON.parse(readFileSync(join(launch.stateDir, "goal.json"), "utf8")) as GoalItem;
}

const stop = (extra: Record<string, unknown> = {}) =>
	runCli(["hook", "stop"], launch.env, JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript, cwd: launch.root, stop_hook_active: false, ...extra }));

describe("hook stop", () => {
	it("does nothing, and calls no model, without a goal or a repo gate", async () => {
		const result = await stop();
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(launch.calls()).toHaveLength(0);
	});

	it("blocks with the judge's reason when the goal is not met, and accounts for the call", async () => {
		setGoal();
		launch.setReplies([{ match: JUDGE, text: '{"ok": false, "reason": "the suite has not been run"}' }]);
		const result = await stop();
		expect(result.stderr).toBe("");
		const out = JSON.parse(result.stdout) as { decision: string; reason: string };
		expect(out.decision).toBe("block");
		expect(out.reason).toContain("Goal not yet met: the suite has not been run");

		// Persisted before the block: one continuation charged.
		expect(goal().ledger.iterations).toBe(1);
		expect(goal().ledger.turnsEvaluated).toBe(1);

		const [call] = launch.calls();
		expect(call.argv).toEqual(expect.arrayContaining(["--mode", "json", "-p", "--no-session", "--no-tools"]));
		expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("zai/glm-low"); // catalog `low`, leased
		expect(call.argv[call.argv.indexOf("--thinking") + 1]).toBe("off");
		expect(call.agentDir).toBe(launch.agentDir); // the lease itself, never a mirror
		expect(call.worker).toBe("1");

		const records = launch.spoolRecords();
		expect(records).toContainEqual(expect.objectContaining({ v: 1, kind: "usage", role: "goal-judge", model: "zai/glm-low", input: 100, output: 20, cacheRead: 3, cacheWrite: 0, cost: 0.0015, turns: 1 }));
		expect(records).toContainEqual(expect.objectContaining({ v: 1, kind: "gate", gate: "goal", outcome: "failed" }));
		for (const record of records) {
			expect(Number.isSafeInteger(record.ms)).toBe(true);
			expect(typeof record.at).toBe("string");
		}
	});

	it("confirms a fast 'met' with an explicit thinking level and then lets the stop through", async () => {
		setGoal();
		launch.setReplies([{ match: JUDGE, text: '{"ok": true, "reason": "npm test exited 0 in the transcript"}' }]);
		const result = await stop();
		expect(result.stdout).toBe("");
		expect(goal().state).toBe("achieved");
		const calls = launch.calls();
		expect(calls).toHaveLength(2);
		expect(calls[0].argv[calls[0].argv.indexOf("--thinking") + 1]).toBe("off");
		// The confirming pass never inherits: the evaluator mode's own level.
		expect(calls[1].argv[calls[1].argv.indexOf("--thinking") + 1]).toBe("minimal");
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "gate", gate: "goal", outcome: "passed" }));
		expect(launch.spoolRecords().filter((r) => r.kind === "usage")).toHaveLength(2);
	});

	it("keeps going on stop_hook_active, bounded by the goal's iteration cap", async () => {
		setGoal({ maxIterations: 2 });
		launch.setReplies([{ match: JUDGE, text: '{"ok": false, "reason": "still red"}' }]);
		const first = JSON.parse((await stop({ stop_hook_active: true })).stdout);
		expect(first.reason).toContain("1 automatic continuation(s) left");
		const second = JSON.parse((await stop({ stop_hook_active: true })).stdout);
		expect(second.reason).toContain("This was the final automatic attempt");
		expect(goal().state).toBe("capped");
		const third = await stop({ stop_hook_active: true });
		expect(third.stdout).toBe("");
		expect(launch.calls()).toHaveLength(2); // a capped goal is not judged again
	});

	it("reads the mode catalog once per TTL across settles (it is cached in the state dir, not per process)", async () => {
		setGoal();
		launch.setReplies([{ match: JUDGE, text: '{"ok": false, "reason": "still red"}' }]);
		await stop();
		await stop();
		await stop();
		expect(hive.requests.filter((r) => r.path === "/api/v1/agent-modes")).toHaveLength(1);
		expect(launch.calls()).toHaveLength(3);
	});

	it("fails closed on judge errors and pauses the goal after three", async () => {
		setGoal();
		launch.setReplies([{ match: JUDGE, text: "", exit: 1 }]);
		for (let i = 0; i < 3; i++) expect((await stop()).stdout).toBe("");
		expect(goal().state).toBe("paused");
		expect(goal().ledger.judgeErrors).toBe(3);
		expect(launch.spoolRecords().filter((r) => r.kind === "gate").map((r) => r.outcome)).toEqual(["skipped", "skipped", "skipped"]);
	});

	it("never re-drives a turn handed back to a person", async () => {
		setGoal();
		transcript = writeTranscript(join(launch.root, "q.jsonl"), [{ user: "fix it" }, { assistant: "Two options. Which one do you want me to take?" }]);
		launch.setReplies([{ match: JUDGE, text: '{"ok": false, "reason": "x"}' }]);
		expect((await stop()).stdout).toBe("");
		expect(launch.calls()).toHaveLength(0);
	});

	it("charges nothing — not even a failed evaluator lookup — on a hand-back or a failed API turn", async () => {
		setGoal();
		hive.modes = [{ key: "high", model: "openai-codex/gpt-top" }]; // nothing leased: a lookup would be a judge error
		transcript = writeTranscript(join(launch.root, "q2.jsonl"), [{ user: "fix it" }, { assistant: "Shall I delete the old table too?" }]);
		expect((await stop()).stdout).toBe("");
		expect(goal().ledger.judgeErrors).toBe(0);
		const apiError = join(launch.root, "err.jsonl");
		writeFileSync(apiError, [
			JSON.stringify({ type: "user", uuid: "u", message: { role: "user", content: "go" } }),
			JSON.stringify({ type: "assistant", uuid: "e", isApiErrorMessage: true, message: { id: "x", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit" }] } }),
		].join("\n") + "\n");
		expect((await stop({ transcript_path: apiError })).stdout).toBe("");
		expect(goal().ledger.judgeErrors).toBe(0);
		expect(hive.requests.some((r) => r.path === "/api/v1/agent-modes")).toBe(false);
	});

	it("grades the final assistant text Claude hands the hook even when the transcript lags", async () => {
		setGoal();
		launch.setReplies([{ match: "FINAL-MARKER-7", text: '{"ok": false, "reason": "saw the final turn"}' }]);
		const out = JSON.parse((await stop({ last_assistant_message: "Done: FINAL-MARKER-7" })).stdout);
		expect(out.reason).toContain("saw the final turn");
	});

	it("records a judge error — not silence — when no catalog model runs on a leased provider", async () => {
		setGoal();
		hive.modes = [{ key: "high", model: "openai-codex/gpt-top" }];
		const result = await stop();
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no evaluator model");
		expect(goal().lastJudgeError?.message).toContain("no Hive catalog mode runs on a leased provider");
		expect(goal().ledger.judgeErrors).toBe(1);
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "gate", gate: "goal", outcome: "skipped" }));
	});

	it("says once that the judge is off without a leased store, and never touches ~/.pi", async () => {
		setGoal();
		delete launch.env.HIVE_PI_AGENT_DIR;
		const result = await stop();
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no outside-model credential");
		expect(launch.calls()).toHaveLength(0);
	});

	it("runs the drift probe on the fifth settle, BEFORE the goal, and its realignment wins the settle", async () => {
		setGoal();
		writeFileSync(join(launch.stateDir, "agenda.json"), JSON.stringify({ ledger: { iterations: {} }, driftSettles: 4, gateStamps: {} }));
		launch.setReplies([
			{ match: DRIFT, text: '{"ok": false, "reason": "rewriting the README instead"}' },
			{ match: JUDGE, text: '{"ok": false, "reason": "x"}' },
		]);
		const out = JSON.parse((await stop()).stdout);
		expect(out.reason).toContain("Drift check");
		expect(out.reason).toContain("rewriting the README instead");
		const calls = launch.calls();
		expect(calls).toHaveLength(1); // one continuation per settle: the goal was not judged
		expect(calls[0].argv[calls[0].argv.indexOf("--thinking") + 1]).toBe("off");
		const agenda = JSON.parse(readFileSync(join(launch.stateDir, "agenda.json"), "utf8"));
		expect(agenda.driftSettles).toBe(0);
		expect(agenda.ledger.iterations["drift:goal-1"]).toBe(1);
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "usage", role: "drift" }));
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "gate", gate: "drift", outcome: "failed" }));
	});

	it("runs the repo gate from .pi/harness.json and injects its failure", async () => {
		const repo = join(launch.root, "repo");
		const { execFileSync } = await import("node:child_process");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(repo, ".pi"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, ".pi", "harness.json"), JSON.stringify({ check: "echo boom-from-gate; exit 3", maxInjections: 1 }));
		const result = await runCli(["hook", "stop"], launch.env, JSON.stringify({ transcript_path: transcript, cwd: repo }));
		const out = JSON.parse(result.stdout);
		expect(out.reason).toContain("FAILED");
		expect(out.reason).toContain("boom-from-gate");
		// maxInjections: 1 — the next settle reports, but does not inject.
		const again = await runCli(["hook", "stop"], launch.env, JSON.stringify({ transcript_path: transcript, cwd: repo }));
		expect(again.stdout).toBe("");
	});
});

describe("stopDecision's wall clock", () => {
	it("does not start the repo gate without time to run it — no block, no charge", async () => {
		const { execFileSync } = await import("node:child_process");
		const { mkdirSync } = await import("node:fs");
		const repo = join(launch.root, "gated");
		mkdirSync(join(repo, ".pi"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, ".pi", "harness.json"), JSON.stringify({ check: "exit 1" }));
		const out = await stopDecision(
			{ transcript_path: transcript, cwd: repo },
			{
				stateDir: launch.stateDir,
				spool: createSpool(launch.spool, () => {}),
				modelUnavailable: null,
				resolveEvaluator: async () => ({ ok: false, reason: "unused" }),
				stderr: () => {},
				budgetMs: 1_000,
			},
		);
		expect(out).toBeNull();
		const agenda = JSON.parse(readFileSync(join(launch.stateDir, "agenda.json"), "utf8"));
		expect(agenda.ledger.iterations).toEqual({});
	});

	it("clamps a slow judge to what is left of the budget — a timeout is a judge error, never a verdict", async () => {
		setGoal();
		let seenTimeout = 0;
		const slow = (options: OneShotOptions): Promise<OneShotResult> => {
			seenTimeout = options.timeoutMs;
			return Promise.resolve({ text: "", tokens: 0, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, exitCode: 1, timedOut: true, stderr: "" });
		};
		const lines: string[] = [];
		const out = await stopDecision(
			{ transcript_path: transcript, cwd: launch.root },
			{
				stateDir: launch.stateDir,
				spool: createSpool(launch.spool, (l) => lines.push(l)),
				modelUnavailable: null,
				resolveEvaluator: async () => ({ ok: true, pick: { spec: "zai/glm-low", source: "mode:low" } }),
				stderr: (l) => lines.push(l),
				budgetMs: 2_000,
				spawn: slow,
			},
		);
		expect(out).toBeNull();
		expect(seenTimeout).toBeLessThanOrEqual(2_000);
		expect(goal().ledger.judgeErrors).toBe(1);
		expect(goal().lastJudgeError?.message).toBe("evaluator timed out");
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "gate", gate: "goal", outcome: "timed_out" }));
	});
});
