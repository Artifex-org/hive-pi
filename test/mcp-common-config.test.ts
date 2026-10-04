/**
 * The worker's view of MCP under pi's built-in support (HIV-1969, HIV-3745).
 *
 * Native MCP has no lazy lifecycle and no `--mcp-config`: every enabled server
 * in `<agent dir>/mcp.json` connects when a session starts. A worker therefore
 * reads a MIRROR of the parent's agent dir whose `mcp.json` keeps only HTTP
 * servers — one request each — and never spawns a stdio process tree per
 * delegation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	agentDir,
	cleanupWorkerAgentDir,
	ensureWorkerAgentDir,
	mcpConfigPath,
	oneShotMcpEnv,
	workerMcpConfig,
} from "../extensions/mcp-common/config.ts";

const temps: string[] = [];
function tmpdir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CONFIG = {
	_note: "comment keys are not servers",
	mcpServers: {
		hive: { url: "https://hive.example/mcp", lifecycle: "eager", directTools: ["get_run"], timeout: 960 },
		linear: { url: "https://mcp.linear.app/mcp", lifecycle: "eager" },
		asfam: { command: "bash", args: ["-c", "exec asfam-mcp"], lifecycle: "lazy-keep-alive" },
	},
};

describe("agentDir / mcpConfigPath", () => {
	it("follows PI_CODING_AGENT_DIR with pi's ~ expansion", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "~/x" }, "/home/u")).toBe("/home/u/x");
		expect(agentDir({}, "/home/u")).toBe("/home/u/.pi/agent");
		expect(mcpConfigPath({ PI_CODING_AGENT_DIR: "/a" }, "/home/u")).toBe("/a/mcp.json");
	});

	it("honours our PI_MCP_CONFIG seam first", () => {
		expect(mcpConfigPath({ PI_MCP_CONFIG: "/seam.json", PI_CODING_AGENT_DIR: "/a" }, "/home/u")).toBe("/seam.json");
	});
});

describe("workerMcpConfig", () => {
	it("keeps HTTP servers only and drops adapter-only keys", () => {
		const out = workerMcpConfig(CONFIG);
		expect(Object.keys(out.mcpServers ?? {})).toEqual(["hive", "linear"]);
		expect(out.mcpServers?.hive).toEqual({ url: "https://hive.example/mcp", timeout: 960 });
	});

	it("does not mutate its input", () => {
		const input = structuredClone(CONFIG);
		workerMcpConfig(input);
		expect(input).toEqual(CONFIG);
	});
});

describe("ensureWorkerAgentDir", () => {
	function parentDir(): string {
		const dir = tmpdir("parent-agent-");
		fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(CONFIG));
		fs.writeFileSync(path.join(dir, "auth.json"), "{}");
		fs.mkdirSync(path.join(dir, "sessions"));
		return dir;
	}

	it("links every entry but mcp.json, which it writes filtered", () => {
		const parent = parentDir();
		const tmp = tmpdir("worker-tmp-");
		const dir = ensureWorkerAgentDir(parent, tmp, 4242);
		expect(dir).toBe(path.join(tmp, "pi-worker-agent-4242"));
		expect(fs.readlinkSync(path.join(dir as string, "auth.json"))).toBe(path.join(parent, "auth.json"));
		expect(fs.readlinkSync(path.join(dir as string, "sessions"))).toBe(path.join(parent, "sessions"));
		const written = JSON.parse(fs.readFileSync(path.join(dir as string, "mcp.json"), "utf8"));
		expect(Object.keys(written.mcpServers)).toEqual(["hive", "linear"]);
	});

	it("is idempotent across delegations of one session", () => {
		const parent = parentDir();
		const tmp = tmpdir("worker-tmp-");
		expect(ensureWorkerAgentDir(parent, tmp, 1)).toBe(ensureWorkerAgentDir(parent, tmp, 1));
	});

	it("builds an empty-server mirror for one-shot helpers", () => {
		const parent = parentDir();
		const tmp = tmpdir("worker-tmp-");
		const dir = ensureWorkerAgentDir(parent, tmp, 7, "none");
		expect(JSON.parse(fs.readFileSync(path.join(dir as string, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
		expect(oneShotMcpEnv(() => dir)).toEqual({ PI_CODING_AGENT_DIR: dir });
	});

	it("returns null without a parent dir, and cleanup removes only the links", () => {
		const tmp = tmpdir("worker-tmp-");
		expect(ensureWorkerAgentDir(path.join(tmp, "missing"), tmp, 1)).toBeNull();
		const parent = parentDir();
		ensureWorkerAgentDir(parent, tmp, 2);
		cleanupWorkerAgentDir(tmp, 2);
		expect(fs.existsSync(path.join(tmp, "pi-worker-agent-2"))).toBe(false);
		expect(fs.existsSync(path.join(parent, "auth.json"))).toBe(true);
	});
});
