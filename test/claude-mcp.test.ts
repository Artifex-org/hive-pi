/**
 * `mcp` — the adapter's stdio MCP server, driven over its real transport:
 * JSON-RPC lines in, JSON-RPC lines out, with a fake pinned pi (whose public
 * entry is the real pi, so roles are parsed by pi's own frontmatter parser)
 * and a fake Hive catalog.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opModeRefusal } from "../claude/mcp/subagent-tool.ts";
import { negotiateVersion } from "../claude/mcp/protocol.ts";
import { CLI, makeLaunch, REPO, startFakeHive, writeTranscript, type FakeHive, type LaunchEnv } from "./claude-harness.ts";

interface Rpc {
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

class McpClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, (message: Rpc) => void>();
	private nextId = 1;
	stderr = "";
	readonly exited: Promise<number | null>;

	constructor(env: Record<string, string>, cwd = REPO) {
		this.child = spawn(process.execPath, [CLI, "mcp"], { cwd, env });
		this.child.stderr.on("data", (d: Buffer) => {
			this.stderr += d.toString();
		});
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			const message = JSON.parse(line) as Rpc;
			if (message.id !== undefined) this.pending.get(message.id)?.(message);
		});
		this.exited = new Promise((done) => this.child.on("close", (code) => done(code)));
	}

	request(method: string, params: unknown = {}): Promise<Rpc> {
		const id = this.nextId++;
		const answer = new Promise<Rpc>((done) => this.pending.set(id, done));
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return answer;
	}

	notify(method: string, params: unknown = {}): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
		const message = await this.request("tools/call", { name, arguments: args });
		if (message.error) throw new Error(message.error.message);
		const content = message.result?.content as { type: string; text: string }[];
		return { text: content[0].text, isError: message.result?.isError === true };
	}

	close(): Promise<number | null> {
		this.child.stdin.end();
		return this.exited;
	}
}

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
		expect(tools.map((t) => t.name).sort()).toEqual(["advisor", "goal_clear", "goal_set", "goal_status", "quality_gate", "subagent"]);
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
		expect(set.text).toContain("goal_clear");
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

describe("shutdown", () => {
	it("aborts and reaps background workers when its input closes, and wakes nobody", async () => {
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
		expect(launch.spoolRecords().some((r) => r.kind === "wake")).toBe(false);
	});
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
