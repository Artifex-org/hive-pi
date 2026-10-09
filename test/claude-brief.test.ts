/**
 * `brief --cwd <dir> --prompt-file <file>` — hive-pi's opening brief for a
 * Claude session: stdout is `{"brief": …}` or `{"brief": null, "reason": …}`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeLaunch, REPO, runCli, startFakeHive, type FakeHive, type LaunchEnv } from "./claude-harness.ts";

let launch: LaunchEnv;
let hive: FakeHive;

beforeEach(async () => {
	launch = makeLaunch();
	hive = await startFakeHive();
	launch.env.HIVE_URL = hive.url;
	launch.env.HIVE_TOKEN = "session-token";
});
afterEach(async () => {
	await hive.close();
});

function brief(prompt: string) {
	const file = join(launch.root, "prompt.txt");
	writeFileSync(file, prompt);
	return runCli(["brief", "--cwd", REPO, "--prompt-file", file], launch.env);
}

describe("brief", () => {
	it("compiles the lanes' drafts into a brief on the cheapest leased catalog mode, one usage record per lane", async () => {
		launch.setReplies([
			{
				match: "Compile your part of a brief",
				text: '```json\n{"goal":"Make the parser accept empty input","facts":[{"ref":"extensions/agenda/verdict.ts:70","note":"extractJsonObject handles fences"}],"start_here":[],"refs":[],"unknowns":["whether callers rely on the error"],"next_moves":[]}\n```',
			},
		]);
		const result = await brief("fix the verdict parser so an empty answer is reported as an error, see extensions/agenda/verdict.ts");
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout) as { brief: string | null };
		expect(out.brief).toContain("<!-- brief:v1 model=zai/glm-low");
		expect(out.brief).toContain("Make the parser accept empty input");
		expect(out.brief).toContain("extractJsonObject handles fences");
		for (const name of ["quality_gate", "hive_watch_run", "subagent", "goal_set"]) expect(out.brief).toContain(`mcp__hive-pi__${name}`);
		expect(out.brief).toContain("before pushing");
		expect(out.brief).toContain("instead of sleep-polling CI");
		const lanes = launch.calls();
		expect(lanes.length).toBeGreaterThan(0);
		for (const call of lanes) {
			expect(call.argv).toContain("--no-extensions");
			expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("zai/glm-low");
		}
		const usage = launch.spoolRecords().filter((r) => r.kind === "usage");
		expect(usage).toHaveLength(lanes.length);
		for (const record of usage) expect(record).toMatchObject({ role: "brief", model: "zai/glm-low", turns: 1 });
	});

	it("stands down, with the reason, on a prompt that is not task-like", async () => {
		const out = JSON.parse((await brief("hi")).stdout);
		expect(out).toEqual({ brief: null, reason: "prompt is not task-like" });
		expect(launch.calls()).toHaveLength(0);
	});

	it("stands down without a leased store", async () => {
		delete launch.env.HIVE_PI_AGENT_DIR;
		const out = JSON.parse((await brief("fix the verdict parser in extensions/agenda/verdict.ts")).stdout);
		expect(out.brief).toBeNull();
		expect(out.reason).toContain("no outside-model credential");
	});
});
