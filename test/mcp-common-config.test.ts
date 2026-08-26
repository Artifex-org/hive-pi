/**
 * The shared MCP-config seam (HIV-1969).
 *
 * The property under test is a COUPLING: `readiness/` reports a server's
 * lifecycle and `subagent/worker.ts` strips it, and if those two ever resolve
 * different files the report describes one config while workers run another.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	cleanupWorkerMcpConfig,
	ensureWorkerMcpConfig,
	lazyVariant,
	mcpCachePath,
	mcpConfigPath,
	readMcpConfig,
	type McpConfigDoc,
} from "../extensions/mcp-common/config.ts";

const dirs: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-common-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("mcpConfigPath", () => {
	it("prefers --mcp-config, exactly as the adapter does", () => {
		expect(mcpConfigPath({}, ["pi", "--mcp-config", "/etc/mcp.json"], "/home/x")).toBe("/etc/mcp.json");
	});

	it("falls back to the agent dir", () => {
		expect(mcpConfigPath({}, ["pi"], "/home/x")).toBe("/home/x/.pi/agent/mcp.json");
	});

	it("checks our own env escape LAST, so it can never mask the adapter's choice", () => {
		const argv = ["pi", "--mcp-config", "/from/argv.json"];
		expect(mcpConfigPath({ PI_MCP_CONFIG: "/from/env.json" }, argv, "/home/x")).toBe("/from/argv.json");
		expect(mcpConfigPath({ PI_MCP_CONFIG: "/from/env.json" }, ["pi"], "/home/x")).toBe("/from/env.json");
	});

	it("locates the adapter's tool cache", () => {
		expect(mcpCachePath("/home/x")).toBe("/home/x/.pi/agent/mcp-cache.json");
	});
});

describe("lazyVariant", () => {
	const config: McpConfigDoc = {
		_comment: "preserved",
		mcpServers: {
			hive: { lifecycle: "eager", url: "https://hive" },
			linear: { lifecycle: "eager", command: "bash" },
			sentry: { lifecycle: "lazy-keep-alive", command: "bash" },
			borealis: { command: "bash" },
		},
	};

	it("strips only the lifecycles that make the adapter connect unasked", () => {
		const { config: next, changed } = lazyVariant(config);
		expect(changed).toEqual(["hive", "linear"]);
		expect(next.mcpServers?.hive).toEqual({ url: "https://hive" });
		// `lazy-keep-alive` connects on FIRST USE, not at startup — a worker that
		// never calls `mcp` still pays nothing, so it is left alone.
		expect(next.mcpServers?.sentry).toEqual({ lifecycle: "lazy-keep-alive", command: "bash" });
		expect(next.mcpServers?.borealis).toEqual({ command: "bash" });
	});

	it("removes the key rather than writing \"lazy\" — absence is the adapter's default", () => {
		const { config: next } = lazyVariant(config);
		expect("lifecycle" in (next.mcpServers?.hive ?? {})).toBe(false);
	});

	it("preserves everything else in the document", () => {
		expect(lazyVariant(config).config._comment).toBe("preserved");
	});

	it("does not copy when nothing prewarms — an unchanged config is returned as-is", () => {
		const plain: McpConfigDoc = { mcpServers: { a: { command: "x" } } };
		const result = lazyVariant(plain);
		expect(result.changed).toEqual([]);
		expect(result.config).toBe(plain);
	});

	it("tolerates a config with no servers at all", () => {
		expect(lazyVariant({}).changed).toEqual([]);
	});
});

describe("ensureWorkerMcpConfig", () => {
	it("writes a derived config and returns its path", () => {
		const dir = tmpDir();
		const source = path.join(dir, "mcp.json");
		fs.writeFileSync(source, JSON.stringify({ mcpServers: { hive: { lifecycle: "eager", url: "u" } } }));

		const target = ensureWorkerMcpConfig(source, dir, 4242);
		expect(target).toBe(path.join(dir, "pi-worker-mcp-4242.json"));
		const written = readMcpConfig(target!);
		expect(written?.mcpServers?.hive).toEqual({ url: "u" });
	});

	it("returns null when nothing prewarms — no flag beats a redundant copy", () => {
		// The worker then reads exactly what the adapter would have read, which is
		// one fewer thing that can drift.
		const dir = tmpDir();
		const source = path.join(dir, "mcp.json");
		fs.writeFileSync(source, JSON.stringify({ mcpServers: { hive: { url: "u" } } }));
		expect(ensureWorkerMcpConfig(source, dir, 1)).toBeNull();
	});

	it("returns null when there is no config to derive from", () => {
		expect(ensureWorkerMcpConfig(path.join(tmpDir(), "absent.json"), tmpDir(), 1)).toBeNull();
	});

	it("returns null on a malformed config rather than failing the delegation", () => {
		const dir = tmpDir();
		const source = path.join(dir, "mcp.json");
		fs.writeFileSync(source, "{ not json");
		expect(ensureWorkerMcpConfig(source, dir, 1)).toBeNull();
	});

	it("writes once and reuses it for every worker of the session", () => {
		const dir = tmpDir();
		const source = path.join(dir, "mcp.json");
		fs.writeFileSync(source, JSON.stringify({ mcpServers: { hive: { lifecycle: "eager" } } }));

		const first = ensureWorkerMcpConfig(source, dir, 7)!;
		fs.writeFileSync(first, JSON.stringify({ marker: "untouched" }));
		const second = ensureWorkerMcpConfig(source, dir, 7)!;
		expect(second).toBe(first);
		// A file per delegation would be litter proportional to fan-out.
		expect(readMcpConfig(second)).toEqual({ marker: "untouched" });
	});

	it("cleans up after itself", () => {
		const dir = tmpDir();
		const source = path.join(dir, "mcp.json");
		fs.writeFileSync(source, JSON.stringify({ mcpServers: { hive: { lifecycle: "keep-alive" } } }));
		const target = ensureWorkerMcpConfig(source, dir, 9)!;
		expect(fs.existsSync(target)).toBe(true);
		cleanupWorkerMcpConfig(dir, 9);
		expect(fs.existsSync(target)).toBe(false);
		// Idempotent: shutdown may run twice.
		expect(() => cleanupWorkerMcpConfig(dir, 9)).not.toThrow();
	});
});
