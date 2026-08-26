import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseStreamableBody, textFromToolResult } from "../extensions/hive-common/mcp.ts";
import { unknownTools } from "../extensions/harness/roles.ts";
import { discoverAgents } from "../extensions/harness/roles.ts";

describe("parseStreamableBody", () => {
	it("reads an SSE-framed JSON-RPC result", () => {
		const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n';
		const parsed = parseStreamableBody(body) as { result?: unknown };
		expect(textFromToolResult(parsed?.result)).toBe("hi");
	});

	it("reads a plain JSON body when the server does not stream", () => {
		const parsed = parseStreamableBody('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"x"}]}}');
		expect(textFromToolResult((parsed as { result?: unknown })?.result)).toBe("x");
	});

	it("takes the frame carrying the result, not a leading notification", () => {
		// A stream may emit progress before the answer; picking the first frame
		// would return a notification as though it were the result.
		const body = [
			'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
			'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"answer"}]}}',
			"",
		].join("\n");
		const parsed = parseStreamableBody(body) as { result?: unknown };
		expect(textFromToolResult(parsed?.result)).toBe("answer");
	});

	it("surfaces a JSON-RPC error frame", () => {
		const parsed = parseStreamableBody('data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"nope"}}');
		expect((parsed as { error?: { message: string } })?.error?.message).toBe("nope");
	});

	it("returns null for an empty or unparseable body rather than guessing", () => {
		expect(parseStreamableBody("")).toBeNull();
		expect(parseStreamableBody("   ")).toBeNull();
		expect(parseStreamableBody("<html>502</html>")).toBeNull();
	});
});

describe("textFromToolResult", () => {
	it("joins text blocks and ignores non-text content", () => {
		expect(
			textFromToolResult({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
		).toBe("a\nb");
	});

	it("is empty for a malformed result rather than throwing mid-call", () => {
		expect(textFromToolResult(undefined)).toBe("");
		expect(textFromToolResult({})).toBe("");
		expect(textFromToolResult({ content: "not-an-array" })).toBe("");
	});
});

describe("unknownTools", () => {
	const role = { tools: ["read", "grep", "knowledge_search"] };

	it("finds names the registry does not provide", () => {
		expect(unknownTools(role, ["read", "grep"])).toEqual(["knowledge_search"]);
	});

	it("is empty when every name resolves", () => {
		expect(unknownTools(role, ["read", "grep", "knowledge_search", "ls"])).toEqual([]);
	});

	it("is empty for a role that declares no tools (inherits everything)", () => {
		expect(unknownTools({ tools: undefined }, ["read"])).toEqual([]);
	});

	it("treats an EMPTY registry as 'cannot tell', not 'nothing available'", () => {
		// Failing closed here would block every delegation on a harness that
		// simply did not expose its tool list.
		expect(unknownTools(role, [])).toEqual([]);
	});
});

describe("shipped roles", () => {
	const agents = discoverAgents(join(import.meta.dirname, ".."), "user").agents;

	it("discovers the package roles", () => {
		expect(agents.length).toBeGreaterThan(10);
	});

	// The regression this wave exists to close: a role granted only a local
	// fallback's tool names has NO knowledge access once that fallback stands down against a reachable
	// Hive brain, and nothing said so.
	// The local knowledge fallback these roles used to name has been removed
	// entirely; `knowledge_*` and `mcp` are the only knowledge paths. A role
	// naming a tool that no longer exists would run with FEWER tools and say
	// nothing, which is precisely the defect this wave closed.
	it("grants no role a knowledge tool that does not exist", () => {
		const known = new Set(["knowledge_search", "knowledge_grep", "knowledge_get", "knowledge_multi_get", "knowledge_collections", "mcp"]);
		const offenders = agents.filter((a) =>
			(a.tools ?? []).some((t) => (t.startsWith("knowledge_") || t.startsWith("mcp__")) && !known.has(t)),
		);
		expect(offenders.map((a) => a.name)).toEqual([]);
	});

	it("gives the retrieval roles a real knowledge path", () => {
		for (const name of ["research", "retriever", "briefer"]) {
			const role = agents.find((a) => a.name === name);
			expect(role, `${name} should exist`).toBeDefined();
			const tools = role?.tools ?? [];
			const hasKnowledge = tools.includes("knowledge_search") || tools.includes("mcp");
			expect(hasKnowledge, `${name} must be able to reach the knowledge base`).toBe(true);
		}
	});

	// REMOVED with the local knowledge fallback it guarded. It asserted that a
	// role never names `mcp__qmd__*` in its body without granting it — a real
	// defect when those tool names existed. Generalising it to every `mcp__*`
	// name does NOT work and must not be reintroduced: role bodies deliberately
	// cite legacy MCP tool names as documentation of INTENT, to be discovered
	// through the adapter's `mcp` tool rather than called directly. Every role
	// would fail such a check, correctly. What still has teeth is the grant-side
	// guard above and `worker-tool-universe.test.ts`.
});

describe("subagent worker argv", () => {
	it("loads knowledge-tools explicitly, because --no-extensions strips it", async () => {
		// The regression that made the first cut of this change a no-op: fixing
		// the role GRANTS is useless if the worker cannot load the extension that
		// registers the tools. Measured before the fix — a worker spawned with
		// `--tools read,grep,knowledge_search` reported its tools as `read, grep`.
		const { buildSubagentWorkerArgs, workerExtensionPaths } = await import("../extensions/subagent/worker.ts");
		const args = buildSubagentWorkerArgs("m", ["read", "knowledge_search"]);

		expect(args).toContain("--no-extensions");
		for (const path of workerExtensionPaths()) {
			expect(args).toContain(path);
			expect(args[args.indexOf(path) - 1]).toBe("-e");
		}
	});

	it("resolves worker extension paths from the module, not the cwd", async () => {
		// A worker is spawned with the TARGET repo as cwd, which is not where
		// hive-pi lives — a cwd-relative path would resolve to nothing there.
		const { workerExtensionPaths } = await import("../extensions/subagent/worker.ts");
		const { existsSync } = await import("node:fs");
		const paths = workerExtensionPaths();
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(path.startsWith("/")).toBe(true);
			expect(existsSync(path), `${path} must exist`).toBe(true);
		}
	});
});
