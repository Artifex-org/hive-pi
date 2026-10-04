/**
 * mcp-lazy, end to end: the real CLI, driving a fake stdio MCP server.
 *
 * The fake appends one line to a spawn log every time it starts, which is the
 * thing this proxy exists to change: a session that only discovers tools must
 * not start the server at all once the cache is warm.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../mcp-lazy/cli.ts";

const CLI = path.join(import.meta.dirname, "..", "mcp-lazy", "cli.ts");

const FAKE_SERVER = `
const fs = require("node:fs");
fs.appendFileSync(process.env.SPAWN_LOG, "start\\n");
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" } } });
		else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object" } }] } });
		else if (m.method === "tools/call") {
			if (m.params.name === "change") { send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); send({ jsonrpc: "2.0", id: m.id, result: { content: [] } }); }
			else send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + JSON.stringify(m.params.arguments) }] } });
		}
		else if (m.method === "fail") send({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "no" } });
	}
});
`;

const dirs: string[] = [];
const procs: ChildProcessWithoutNullStreams[] = [];

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lazy-"));
	dirs.push(dir);
	const server = path.join(dir, "server.cjs");
	fs.writeFileSync(server, FAKE_SERVER);
	return { dir, server, spawnLog: path.join(dir, "spawns.log"), cache: path.join(dir, "cache") };
}

function spawns(log: string): number {
	return fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

/** Start the proxy and return a request helper over its stdio. */
function proxy(env: { server: string; spawnLog: string; cache: string; dir: string }, idle = "600") {
	const child = spawn(process.execPath, [CLI, "--idle", idle, "--cache", env.cache, "--", process.execPath, env.server], {
		cwd: env.dir,
		env: { ...process.env, SPAWN_LOG: env.spawnLog },
	});
	procs.push(child);
	let buf = "";
	const waiters = new Map<unknown, (m: Record<string, unknown>) => void>();
	const notes: Record<string, unknown>[] = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (d: string) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
			buf = buf.slice(i + 1);
			if (m.id !== undefined && waiters.has(m.id)) {
				waiters.get(m.id)?.(m);
				waiters.delete(m.id);
			} else notes.push(m);
		}
	});
	let id = 0;
	const request = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const myId = ++id;
			waiters.set(myId, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
			setTimeout(() => reject(new Error(`${method} timed out`)), 10_000).unref();
		});
	const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
	const handshake = async () => {
		const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		notify("notifications/initialized");
		return init;
	};
	const stop = () =>
		new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
			child.stdin.end();
		});
	return { request, handshake, stop, notes, child };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mcp-lazy", () => {
	it("proxies transparently on a cold cache, and fills it", async () => {
		const env = setup();
		const p = proxy(env);
		const init = await p.handshake();
		expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("fake");
		const list = await p.request("tools/list");
		expect((list.result as { tools: { name: string }[] }).tools[0].name).toBe("echo");
		expect(spawns(env.spawnLog)).toBe(1);
		await p.stop();
		expect(fs.readdirSync(env.cache)).toHaveLength(1);
	}, 20_000);

	it("with a warm cache, discovery starts NOTHING; the first call starts the server", async () => {
		const env = setup();
		const warm = proxy(env);
		await warm.handshake();
		await warm.request("tools/list");
		await warm.stop();
		expect(spawns(env.spawnLog)).toBe(1);

		const p = proxy(env);
		await p.handshake();
		const list = await p.request("tools/list");
		expect((list.result as { tools: { name: string }[] }).tools[0].name).toBe("echo");
		expect((await p.request("ping")).result).toEqual({});
		expect(spawns(env.spawnLog)).toBe(1); // discovery alone: still asleep

		const call = await p.request("tools/call", { name: "echo", arguments: { a: 1 } });
		expect(JSON.stringify(call.result)).toContain('echo:{\\"a\\":1}');
		expect(spawns(env.spawnLog)).toBe(2); // woken by the call, initialize replayed
		await p.stop();
	}, 20_000);

	it("reaps an idle server and wakes it again on the next call", async () => {
		const env = setup();
		const p = proxy(env, "0.3");
		await p.handshake();
		await p.request("tools/list");
		await sleep(900);
		await p.request("tools/call", { name: "echo", arguments: {} });
		expect(spawns(env.spawnLog)).toBe(2);
		await p.stop();
	}, 20_000);

	it("never caches an error, and forgets the tool list on list_changed", async () => {
		const env = setup();
		const p = proxy(env);
		await p.handshake();
		await p.request("tools/list");
		expect((await p.request("fail")).error).toBeTruthy();
		await p.request("tools/call", { name: "change", arguments: {} });
		await sleep(100);
		expect(p.notes.some((n) => n.method === "notifications/tools/list_changed")).toBe(true);
		await p.stop();
		const [file] = fs.readdirSync(env.cache);
		const cached = JSON.parse(fs.readFileSync(path.join(env.cache, file), "utf8"));
		expect(Object.keys(cached)).toEqual(["initialize"]);
	}, 20_000);

	it("kills the server when the client closes stdin", async () => {
		const env = setup();
		const p = proxy(env);
		await p.handshake();
		await p.request("tools/call", { name: "echo", arguments: {} });
		await p.stop();
		await sleep(300);
		const out = fs.readFileSync(env.spawnLog, "utf8");
		expect(out).toContain("start");
		// The proxy exited; a live fake would keep its stdin pipe open forever.
		expect(p.child.exitCode !== null || p.child.signalCode !== null).toBe(true);
	}, 20_000);
});

describe("parseArgs", () => {
	it("splits proxy options from the server command", () => {
		expect(parseArgs(["--idle", "30", "--", "bash", "-c", "x"], {}, "/h")).toEqual({
			idleMs: 30_000,
			cacheDir: "/h/.pi/mcp-lazy",
			command: "bash",
			args: ["-c", "x"],
		});
	});

	it("refuses a missing command and a bad idle", () => {
		expect(() => parseArgs(["--idle", "5"], {}, "/h")).toThrow(/usage/);
		expect(() => parseArgs(["--idle", "-1", "--", "x"], {}, "/h")).toThrow(/idle/);
	});
});
