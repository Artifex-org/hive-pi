/**
 * `mcp` — the adapter's stdio MCP server, driven over its real transport:
 * JSON-RPC lines in, JSON-RPC lines out, with a fake pinned pi (whose public
 * entry is the real pi, so roles are parsed by pi's own frontmatter parser)
 * and a fake Hive catalog.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { abortedText, CANCELLED_BY_CALLER, opModeRefusal } from "../claude/mcp/subagent-tool.ts";
import { negotiateVersion } from "../claude/mcp/protocol.ts";
import { makeLaunch, McpClient, REPO, startFakeHive, writeTranscript, type FakeHive, type LaunchEnv } from "./claude-harness.ts";

let launch: LaunchEnv;
let hive: FakeHive;
let client: McpClient;

beforeEach(async () => {
	launch = makeLaunch();
	hive = await startFakeHive();
	launch.env.HIVE_URL = hive.url;
	launch.env.HIVE_TOKEN = "session-token";
	launch.env.HIVE_CLAUDE_TRANSCRIPT = writeTranscript(join(launch.root, "t.jsonl"), [
		{ user: "refactor the parser" },
		{ assistant: "I split parse() into tokenize() and build(); TRANSCRIPT-MARKER-42." },
	]);
});
afterEach(async () => {
	await client?.close();
	await hive.close();
});

async function connect(env = launch.env, cwd = REPO): Promise<McpClient> {
	client = new McpClient(env, cwd);
	const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	expect(init.result?.protocolVersion).toBe("2025-06-18");
	client.notify("notifications/initialized");
	return client;
}

describe("mcp protocol", () => {
	it("negotiates the protocol version", () => {
		expect(negotiateVersion("2025-03-26")).toBe("2025-03-26");
		expect(negotiateVersion("1999-01-01")).toBe("2025-06-18");
		expect(negotiateVersion(undefined)).toBe("2025-06-18");
	});

	it("initializes, answers ping, lists its tools with the pinned pi's roles, and refuses an unknown tool", async () => {
		const c = await connect();
		const init = await c.request("initialize", { protocolVersion: "2024-11-05" });
		expect(init.result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "hive-pi" }, capabilities: { tools: {} } });
		expect((await c.request("ping")).result).toEqual({});
		const list = await c.request("tools/list");
		const tools = list.result?.tools as { name: string; description: string; inputSchema: { type: string } }[];
		expect(tools.map((t) => t.name).sort()).toEqual([
			"advisor",
			"author_maestro_flow",
			"background_cancel",
			"browser_click",
			"browser_console",
			"browser_evaluate",
			"browser_navigate",
			"browser_screenshot",
			"browser_snapshot",
			"browser_type",
			"browser_wait_for",
			"bugfix_evidence",
			"bugfix_root_cause",
			"goal_clear",
			"goal_set",
			"goal_status",
			"hive_watch_run",
			"quality_gate",
			"record_playwright_flow",
			"report_dev_server",
			"run_playwright_flow_source",
			"run_saved_agent_flow",
			"subagent",
		]);
		for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
		expect(tools.find((t) => t.name === "subagent")?.description).toContain("research (aka explorer)");
		const unknown = await c.request("tools/call", { name: "nope", arguments: {} });
		expect(unknown.error?.code).toBe(-32602);
		expect((await c.request("no/such/method")).error?.code).toBe(-32601);
		expect(c.stderr).toBe("");
	});

	it("exits when its input closes", async () => {
		const c = await connect();
		expect(await c.close()).toBe(0);
	});
});

describe("goal tools", () => {
	it("sets, refuses to silently replace, revises, reports and clears a goal", async () => {
		const c = await connect();
		const set = await c.call("goal_set", { condition: "`npm test` exits 0", budget: { tokens: 1000 } });
		expect(set.isError).toBe(false);
		expect(set.text).toContain("Goal set: `npm test` exits 0");
		expect(set.text).toContain("/hive:goal clear");
		expect(set.text).not.toContain("goal_clear");
		const goal = JSON.parse(readFileSync(join(launch.stateDir, "goal.json"), "utf8"));
		expect(goal).toMatchObject({ state: "active", ledger: { budget: { tokens: 1000 } } });

		const again = await c.call("goal_set", { condition: "`npm run lint` exits 0" });
		expect(again.isError).toBe(true);
		expect(again.text).toContain("A goal is already active");
		const revised = await c.call("goal_set", { condition: "`npm run lint` exits 0", replace: true });
		expect(revised.text).toContain("Goal revised");

		const vague = await c.call("goal_clear");
		expect(vague.text).toContain("Goal cleared");
		const status = await c.call("goal_status");
		expect(status.text).toContain("Goal (cleared)");

		// Clear-then-set is not a budget reset: the ledger carries over.
		const spent = JSON.parse(readFileSync(join(launch.stateDir, "goal.json"), "utf8"));
		writeFileSync(join(launch.stateDir, "goal.json"), JSON.stringify({ ...spent, ledger: { ...spent.ledger, iterations: 5, tokens: 777 } }));
		const again2 = await c.call("goal_set", { condition: "`npm run build` exits 0" });
		expect(again2.text).toContain("this session's goal budget carries over (5/8 continuations, 777 evaluator tokens spent)");
		const revived = JSON.parse(readFileSync(join(launch.stateDir, "goal.json"), "utf8"));
		expect(revived).toMatchObject({ state: "active", condition: "`npm run build` exits 0", ledger: { iterations: 5, tokens: 777 } });
		await c.call("goal_clear");
		expect((await c.call("goal_set", { condition: "make it nice" })).text).toContain("names nothing machine-checkable");
	});

	it("refuses to set a goal no judge could grade", async () => {
		const env = { ...launch.env };
		delete env.HIVE_PI_AGENT_DIR;
		const c = await connect(env);
		const set = await c.call("goal_set", { condition: "`npm test` exits 0" });
		expect(set.isError).toBe(true);
		expect(set.text).toContain("no outside-model credential");
		const advisor = await c.call("advisor");
		expect(advisor.isError).toBe(true);
		expect(advisor.text).toContain("HIVE_PI_AGENT_DIR is unset");
	});
});

describe("advisor", () => {
	it("forwards the session through pi's serializer in an @file to the strongest leased mode, cross-family", async () => {
		launch.setReplies([{ match: "senior advisor", text: "Split looks right; add a test for empty input." }]);
		const c = await connect();
		const advice = await c.call("advisor");
		expect(advice.isError).toBe(false);
		expect(advice.text).toContain("add a test for empty input");
		const [call] = launch.calls();
		// openai-codex (top) is not leased; zai/glm-mid is the strongest that is.
		expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("zai/glm-mid");
		expect(call.argv[call.argv.indexOf("--thinking") + 1]).toBe("medium");
		expect(call.argv.some((a) => a.startsWith("@"))).toBe(true);
		expect(call.argv.join(" ")).not.toContain("TRANSCRIPT-MARKER-42"); // never on argv
		expect(call.input).toContain("[Assistant]: I split parse()");
		expect(call.input).toContain("TRANSCRIPT-MARKER-42");
		expect(launch.spoolRecords()).toContainEqual(expect.objectContaining({ kind: "usage", role: "advisor", model: "zai/glm-mid" }));
	});
});

describe("subagent", () => {
	it("runs a read-only role on the cheap leased lane and spools the worker's usage", async () => {
		launch.setReplies([{ match: "Task: find the parser", text: "src/parse.ts:12 — parse() lives here." }]);
		const c = await connect();
		const result = await c.call("subagent", { agent: "research", task: "find the parser" });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("src/parse.ts:12");
		const [call] = launch.calls();
		expect(call.argv).toEqual(expect.arrayContaining(["--no-extensions"]));
		expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("zai/glm-low"); // no pin, no default: cheapest leased mode
		expect(call.agentDir).toBe(launch.agentDir);
		expect(launch.spoolRecords()).toContainEqual(
			expect.objectContaining({ kind: "usage", role: "subagent:research", model: "zai/glm-low", input: 100, output: 20, turns: 1 }),
		);
	});

	it("backgrounds a delegation, announces its job id, and wakes the driver with the same id", async () => {
		launch.setReplies([{ match: "Task: survey the tests", text: "There are 12 parser tests.", delayMs: 300 }]);
		const c = await connect();
		const started = await c.call("subagent", { agent: "research", task: "survey the tests", background: true, what: "surveying parser tests" });
		expect(started.isError).toBe(false);
		const id = /^hive-pi-job: ([A-Za-z0-9_-]{1,64})$/m.exec(started.text)?.[1];
		expect(id).toBeDefined();
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(0); // returned before the worker finished
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && !launch.spoolRecords().some((r) => r.kind === "wake")) await new Promise((r) => setTimeout(r, 50));
		const wake = launch.spoolRecords().find((r) => r.kind === "wake");
		expect(wake).toMatchObject({ v: 1, kind: "wake", source: "subagent", job: id });
		expect(String(wake?.text)).toContain("There are 12 parser tests.");
		expect(String(wake?.text)).not.toContain("<background-job-result"); // the driver wraps it
	});

	it("refuses writer roles while the session is in a read-only op mode", async () => {
		launch.writeControl({ opMode: "discuss" });
		const c = await connect();
		const result = await c.call("subagent", { agent: "lint-fixer", task: "fix lint" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Discuss mode is read-only");
		expect(launch.calls()).toHaveLength(0);
	});

	it("refuses project-local roles (no trust confirmation exists here)", async () => {
		const project = join(launch.root, "project");
		mkdirSync(join(project, ".pi", "agents"), { recursive: true });
		writeFileSync(join(project, ".pi", "agents", "repo-role.md"), "---\nname: repo-role\ndescription: shipped by the repo\ntools: read\n---\nDo repo things.\n");
		const c = await connect(launch.env, project);
		const result = await c.call("subagent", { agent: "repo-role", task: "x", agentScope: "both" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain('Refusing project-local agents: "repo-role"');
		expect(launch.calls()).toHaveLength(0);
	});
});

describe("quality_gate", () => {
	it("does not create an unannounceable watch when MCP cancels a dispatched gate", async () => {
		const run = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";
		const repo = join(launch.root, "gate-repo"); mkdirSync(join(repo, ".hive"), { recursive: true });
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(repo, ".hive", "main.star"), "pipeline fixture\n");
		const bin = join(launch.root, "gate-bin"); mkdirSync(bin);
		const marker = join(launch.root, "unexpected-watch");
		writeFileSync(join(bin, "hive"), `#!/bin/sh\nif [ "$1" = check ]; then echo 'https://hive.example/runs/${run}'; else echo watch > '${marker}'; fi\n`);
		chmodSync(join(bin, "hive"), 0o755);
		hive.gateResponse = { run: { state: "running" }, tasks: [{ key: "test", state: "running" }] };
		const c = await connect({ ...launch.env, PATH: `${bin}:${launch.env.PATH}` }, repo);
		const request = c.send("tools/call", { name: "quality_gate", arguments: { only: "test" } });
		let answered = false; void request.answer.then(() => { answered = true; });
		const deadline = Date.now() + 10_000;
		while (!hive.requests.some((r) => r.path === `/api/v1/runs/${run}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		expect(hive.requests.some((r) => r.path === `/api/v1/runs/${run}`)).toBe(true);
		const runB = "2d363f69-ed6d-40c3-80b1-55bf40cc8640";
		writeFileSync(join(bin, "hive"), `#!/bin/sh\nif [ "$1" = check ]; then echo 'https://hive.example/runs/${runB}'; else echo watch > '${marker}'; fi\n`);
		const second = c.send("tools/call", { name: "quality_gate", arguments: { only: "test" } });
		const secondDeadline = Date.now() + 10_000;
		while (!hive.requests.some((r) => r.path === `/api/v1/runs/${runB}`) && Date.now() < secondDeadline) await new Promise((r) => setTimeout(r, 25));
		expect(hive.requests.some((r) => r.path === `/api/v1/runs/${runB}`)).toBe(true);
		c.notify("notifications/cancelled", { requestId: request.id });
		c.notify("notifications/cancelled", { requestId: second.id });
		await new Promise((r) => setTimeout(r, 700));
		expect(answered).toBe(false); expect(existsSync(marker)).toBe(false);
		const reportDir = join(launch.stateDir, "quality-gate-reports");
		const retained = readdirSync(reportDir).map((file) => JSON.parse(readFileSync(join(reportDir, file), "utf8")));
		expect(retained).toHaveLength(2);
		for (const ref of [run, runB]) expect(retained.some((r) => r.cwd === repo && r.report.includes(ref) && r.report.includes("NOT cancelled"))).toBe(true);
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(0);
		expect(hive.requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
		expect((await c.request("ping")).result).toEqual({});
	}, 15_000);

	it("runs hive-pi's gate discovery and says plainly when a checkout has no gate", async () => {
		const c = await connect();
		const empty = mkdtempSync(join(tmpdir(), "no-gate-"));
		const result = await c.call("quality_gate", { cwd: empty });
		expect(result.isError).toBe(false);
		expect(result.text).toContain("No quality gate found");
		expect((await c.call("quality_gate", { cwd: join(empty, "missing") })).text).toContain("is not a directory");
		await expect(c.call("quality_gate", { mode: "fast" })).resolves.toMatchObject({ isError: true });
	});
});

describe("hive_watch_run", () => {
	const RUN = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";
	/** Real processes on a shared workstation: wakes are polled for up to 15 s. */
	const PROCESS_TEST_TIMEOUT_MS = 30_000;

	/** A fake `hive` on PATH: `hive watch <uuid>` records its pid and its sleep's, prints, sleeps, exits with the given code. */
	function fakeHiveCli(sleepSeconds: number, exitCode: number): { env: Record<string, string>; pids: () => number[] } {
		const bin = join(launch.root, "bin");
		mkdirSync(bin, { recursive: true });
		const log = join(launch.root, "hive-watch.log");
		writeFileSync(
			join(bin, "hive"),
			// The sleep is a GRANDCHILD of the watch's shell, so a kill that reaches
			// only the direct child would leave it running — and fail the test.
			`#!/bin/bash\necho "$$" >> ${JSON.stringify(log)}\necho "watching $2"\nsleep ${sleepSeconds} &\necho "$!" >> ${JSON.stringify(log)}\nwait $!\necho "run $2 finished"\nexit ${exitCode}\n`,
		);
		chmodSync(join(bin, "hive"), 0o755);
		const pids = () => {
			try {
				return readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number);
			} catch {
				return [];
			}
		};
		return { env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` }, pids };
	}

	async function wakes(count: number, timeoutMs = 15_000): Promise<Record<string, unknown>[]> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && launch.spoolRecords().filter((r) => r.kind === "wake").length < count) await new Promise((r) => setTimeout(r, 50));
		return launch.spoolRecords().filter((r) => r.kind === "wake");
	}

	function alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	it("returns at once, announces the job, and wakes the driver exactly once with the run's verdict", async () => {
		const cli = fakeHiveCli(0.5, 0);
		const c = await connect(cli.env);
		const started = await c.call("hive_watch_run", { run: RUN, what: "waiting for the PR gate" });
		expect(started.isError).toBe(false);
		const id = /^hive-pi-job: ([A-Za-z0-9_-]{1,64})$/m.exec(started.text)?.[1];
		expect(id).toMatch(/^watch-/);
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(0);
		const [wake] = await wakes(1);
		expect(wake).toMatchObject({ v: 1, kind: "wake", job: id });
		expect(String(wake?.text)).toContain("the run PASSED");
		expect(String(wake?.text)).toContain(`run ${RUN} finished`);
		// Exactly one, also after the exit-settle grace has passed.
		await new Promise((r) => setTimeout(r, 2_500));
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(1);
	}, PROCESS_TEST_TIMEOUT_MS);

	it("reports a red run as FAILED and points at explain_failure", async () => {
		const cli = fakeHiveCli(0.1, 1);
		const c = await connect(cli.env);
		await c.call("hive_watch_run", { run: RUN, what: "waiting for the PR gate" });
		const [wake] = await wakes(1);
		expect(String(wake?.text)).toContain("the run FAILED");
		expect(String(wake?.text)).toContain("explain_failure");
	}, PROCESS_TEST_TIMEOUT_MS);

	it("cancels a watch: the hive watch process group is killed and the one wake says so", async () => {
		const cli = fakeHiveCli(60, 0);
		const c = await connect(cli.env);
		const started = await c.call("hive_watch_run", { run: RUN, what: "waiting for the PR gate" });
		const id = /^hive-pi-job: (\S+)$/m.exec(started.text)?.[1] as string;
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && cli.pids().length < 2) await new Promise((r) => setTimeout(r, 50));
		const pids = cli.pids();
		expect(pids.every(alive)).toBe(true);
		const cancelled = await c.call("background_cancel", { id });
		expect(cancelled.isError).toBe(false);
		const [wake] = await wakes(1);
		expect(wake).toMatchObject({ job: id });
		expect(String(wake?.text)).toContain("cancelled at your request");
		expect(pids.some(alive)).toBe(false);
		expect((await c.call("background_cancel", { id })).isError).toBe(true);
		await new Promise((r) => setTimeout(r, 500));
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(1);
	}, PROCESS_TEST_TIMEOUT_MS);

	it("stops a watch when the server shuts down, and tells the model to watch again", async () => {
		const cli = fakeHiveCli(60, 0);
		const c = await connect(cli.env);
		const started = await c.call("hive_watch_run", { run: RUN, what: "waiting for the PR gate" });
		const id = /^hive-pi-job: (\S+)$/m.exec(started.text)?.[1];
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && cli.pids().length < 2) await new Promise((r) => setTimeout(r, 50));
		expect(await c.close()).toBe(0);
		expect(cli.pids().some(alive)).toBe(false);
		const all = launch.spoolRecords().filter((r) => r.kind === "wake");
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ job: id });
		expect(String(all[0]?.text)).toContain("was cancelled because the helper server restarted");
	}, PROCESS_TEST_TIMEOUT_MS);

	it("ends a watch at its wall clock, kills it, and says the verdict is still open", async () => {
		const cli = fakeHiveCli(60, 0);
		const c = await connect(cli.env);
		const started = await c.call("hive_watch_run", { run: RUN, what: "waiting for the PR gate", timeout_seconds: 1 });
		expect(started.text).toContain("Limit 1s");
		const [wake] = await wakes(1);
		expect(String(wake?.text)).toContain("hit its 1s limit without the run's verdict");
		expect(cli.pids().some(alive)).toBe(false);
		await new Promise((r) => setTimeout(r, 500));
		expect(launch.spoolRecords().filter((r) => r.kind === "wake")).toHaveLength(1);
	}, PROCESS_TEST_TIMEOUT_MS);

	it("refuses without a spool to wake through, and refuses a malformed run reference", async () => {
		const cli = fakeHiveCli(0.1, 0);
		const { HIVE_AUX_SPOOL: _unused, ...noSpool } = cli.env;
		const c = await connect(noSpool);
		const refused = await c.call("hive_watch_run", { run: RUN, what: "x" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("HIVE_AUX_SPOOL");
		await c.close();
		const c2 = await connect(cli.env);
		expect((await c2.call("hive_watch_run", { run: "not a run", what: "x" })).isError).toBe(true);
		expect(cli.pids()).toHaveLength(0);
	}, PROCESS_TEST_TIMEOUT_MS);
});

describe("shutdown", () => {
	it("aborts and reaps background workers when its input closes, and tells the model the job is gone", async () => {
		launch.setReplies([{ match: "Task: long survey", text: "never", delayMs: 30_000 }]);
		const c = await connect();
		const started = await c.call("subagent", { agent: "research", task: "long survey", background: true, what: "a long survey" });
		expect(started.text).toContain("hive-pi-job: ");
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && launch.calls().length === 0) await new Promise((r) => setTimeout(r, 50));
		const [worker] = launch.calls();
		const closedAt = Date.now();
		expect(await c.close()).toBe(0);
		expect(Date.now() - closedAt).toBeLessThan(10_000);
		expect(() => process.kill(worker.pid, 0)).toThrow();
		const id = /^hive-pi-job: (\S+)$/m.exec(started.text)?.[1];
		const wake = launch.spoolRecords().find((r) => r.kind === "wake");
		expect(wake).toMatchObject({ job: id });
		expect(String(wake?.text)).toContain(`Background job ${id}`);
		expect(String(wake?.text)).toContain("was cancelled because the helper server restarted; delegate it again");
	});
});

describe("robustness", () => {
	it("keeps the model-free tools working on a malformed lease; only model tools degrade", async () => {
		writeFileSync(join(launch.agentDir, "auth.json"), "{not json");
		const c = await connect();
		expect((await c.call("goal_status")).text).toBe("No goal set.");
		const advisor = await c.call("advisor");
		expect(advisor.isError).toBe(true);
		expect(advisor.text).toContain("auth.json");
	});

	it("does not answer a request the client cancelled", async () => {
		launch.setReplies([{ match: "Task: slow", text: "late", delayMs: 3_000 }]);
		const c = await connect();
		let answered = false;
		void c.request("tools/call", { name: "subagent", arguments: { agent: "research", task: "slow" } }).then(() => {
			answered = true;
		});
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && launch.calls().length === 0) await new Promise((r) => setTimeout(r, 50));
		c.notify("notifications/cancelled", { requestId: 1 + 1 }); // id 1 was initialize
		const worker = launch.calls()[0];
		await new Promise((r) => setTimeout(r, 4_000));
		expect(answered).toBe(false);
		expect(() => process.kill(worker.pid, 0)).toThrow(); // its worker was aborted
		expect((await c.request("ping")).result).toEqual({}); // and the server is fine
	}, 30_000); // waits ~4 s on purpose, after spawning a worker

	it("on SIGTERM aborts and awaits an in-flight foreground delegation before exiting", async () => {
		launch.setReplies([{ match: "Task: long foreground", text: "never", delayMs: 30_000 }]);
		const c = await connect();
		void c.request("tools/call", { name: "subagent", arguments: { agent: "research", task: "long foreground" } });
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && launch.calls().length === 0) await new Promise((r) => setTimeout(r, 50));
		const worker = launch.calls()[0];
		const signalledAt = Date.now();
		c.child.kill("SIGTERM");
		await c.exited;
		expect(Date.now() - signalledAt).toBeLessThan(10_000);
		expect(() => process.kill(worker.pid, 0)).toThrow();
	}, 30_000);
});

describe("opModeRefusal", () => {
	const role = (name: string, tools: string[], opMode?: string) => ({ name, description: "", tools, opMode, systemPrompt: "", source: "package" as const, filePath: "" });
	it("lets everything through in build", () => {
		expect(opModeRefusal("build", [role("lint-fixer", ["read", "edit"])])).toBeNull();
	});
	it("refuses writers in discuss and plan, never readers", () => {
		expect(opModeRefusal("plan", [role("research", ["read", "grep"])])).toBeNull();
		expect(opModeRefusal("plan", [role("doc-writer", ["read", "write"])])).toContain('"doc-writer"');
	});
	it("in bugfix, admits only writers that enforce the bugfix posture themselves", () => {
		expect(opModeRefusal("bugfix", [role("bugfix", ["read", "edit"], "bugfix")])).toBeNull();
		expect(opModeRefusal("bugfix", [role("test-fixer", ["read", "edit"])])).toContain("no fix before a root cause");
	});
});

describe("abortedText", () => {
	it("tells a cancelled delegation from one the server restart took", () => {
		const cancelled = new AbortController();
		cancelled.abort(CANCELLED_BY_CALLER);
		expect(abortedText(cancelled.signal, "sub-1-ab", "research", "survey")).toContain("cancelled at your request");
		const shutdown = new AbortController();
		shutdown.abort();
		expect(abortedText(shutdown.signal, "sub-1-ab", "research", "survey")).toContain("helper server restarted; delegate it again");
	});
});
