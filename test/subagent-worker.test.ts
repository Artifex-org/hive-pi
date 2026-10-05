import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import registerMetaProvider from "../extensions/meta-media/provider-only.ts";
import { createFakePi } from "./fake-pi.ts";
import {
	WORKER_BUILTIN_MCP_EXTENSIONS,
	buildSubagentWorkerArgs,
	nativeToolGrants,
	workerExtensionPaths,
	workerMcpEnv,
	workerNeedsMcp,
} from "../extensions/subagent/worker.ts";

/** The `-e <path>` pairs, flattened away, so the rest can be pinned exactly. */
function withoutExtensionLoads(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e") {
			i++; // skip its path
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

describe("subagent worker invocation", () => {
	it("isolates a worker from interactive extensions so it exits after agent_settled", () => {
		// Everything EXCEPT the explicit extension allowlist is still pinned
		// exactly: `--no-extensions` is the isolation contract and a stray flag
		// re-enabling discovery is what this test exists to catch.
		expect(
			withoutExtensionLoads(buildSubagentWorkerArgs("openrouter/deepseek/deepseek-v4-flash", ["read", "grep"])),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model",
			"openrouter/deepseek/deepseek-v4-flash",
			"--tools",
			"read,grep",
		]);
	});

	it("passes a role operating mode to the worker", () => {
		const args = withoutExtensionLoads(buildSubagentWorkerArgs(undefined, [], "bugfix"));
		expect(args).toContain("--op-mode");
		expect(args[args.indexOf("--op-mode") + 1]).toBe("bugfix");
	});

	it("omits optional flags without re-enabling extensions", () => {
		expect(withoutExtensionLoads(buildSubagentWorkerArgs(undefined, []))).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
		]);
	});

	describe("native MCP (HIV-3745)", () => {
		it("loads pi's MCP built-ins for a worker that can reach MCP", () => {
			// --no-extensions strips the built-ins too (pi 0.99); without them a
			// worker granted codemode has no MCP servers to call.
			const args = buildSubagentWorkerArgs(undefined, ["read", "codemode"]);
			for (const builtin of WORKER_BUILTIN_MCP_EXTENSIONS) expect(args[args.indexOf(builtin) - 1]).toBe("-e");
		});

		it("loads none for a worker that cannot reach MCP — zero connections", () => {
			const args = buildSubagentWorkerArgs(undefined, ["read", "grep"]);
			for (const builtin of WORKER_BUILTIN_MCP_EXTENSIONS) expect(args).not.toContain(builtin);
			expect(workerMcpEnv(["read", "grep"], () => "/never")).toEqual({});
		});

		it("an unrestricted worker gets every tool, MCP included", () => {
			expect(workerNeedsMcp(undefined)).toBe(true);
			expect(workerNeedsMcp([])).toBe(true);
		});

		it("translates the adapter's grants, so an old role file keeps its MCP", () => {
			expect(nativeToolGrants(["read", "mcp", "mcpScript"])).toEqual(["read", "codemode", "tool_search"]);
			const args = buildSubagentWorkerArgs(undefined, ["read", "mcp"]);
			expect(args[args.indexOf("--tools") + 1]).toBe("read,codemode,tool_search");
			expect(args).toContain("builtin:mcp");
		});

		it("points an MCP-capable worker at the HTTP-only agent-dir mirror", () => {
			expect(workerMcpEnv(["codemode"], () => "/tmp/pi-worker-agent-1")).toEqual({
				PI_CODING_AGENT_DIR: "/tmp/pi-worker-agent-1",
			});
			// A mirror that could not be built falls back to the parent's config.
			expect(workerMcpEnv(["codemode"], () => null)).toEqual({});
		});
	});

	it("loads exactly the allowlisted extensions, each behind its own -e", () => {
		// `--no-extensions` strips EVERY extension, including the ones a worker
		// needs. Fixing a role's `tools:` grant is a no-op if the extension that
		// registers the tool never loads — measured: a worker granted
		// `knowledge_search` reported its tools as `read, grep` before this.
		// Same pattern the Code Factory uses (HIV-887).
		const args = buildSubagentWorkerArgs(undefined, ["read"]);
		const loaded = args.filter((arg, i) => args[i - 1] === "-e");
		expect(loaded).toEqual(workerExtensionPaths());
		expect(args.filter((a) => a === "-e")).toHaveLength(workerExtensionPaths().length);
	});

	it("keeps the worker extension list short and hook-free by policy", () => {
		// Every entry runs in EVERY delegated worker. An extension registering a
		// hook would put that hook in the worker's loop, which --no-extensions
		// exists to prevent. Growth here is a decision, not an accident.
		//
		// Raised 3 -> 5 for the reviewed bugfix protocol pair. The two hook-bearing
		// entries are pinned below; remaining entries stay tool-only and scoped.
		// Raised 5 -> 6 for fast/worker.ts (Fast mode for delegations), whose
		// single session_start hook is pinned below.
		expect(workerExtensionPaths().length).toBeLessThanOrEqual(6);
	});

	it("loads the fast worker module, with its one hook and no tools or commands", () => {
		// A delegation's model calls happen in the worker's own process, so the
		// parent's wrapped provider cannot give them the priority tier. The worker
		// module may hook session_start — the first point the registry is
		// reachable — and nothing else.
		const fast = workerExtensionPaths().find((path) => path.endsWith("/extensions/fast/worker.ts"));
		expect(fast, "worker must load the fast worker module").toBeDefined();
		const source = readFileSync(fast as string, "utf8");
		expect([...source.matchAll(/\bpi\.on\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["session_start"]);
		expect(source).not.toMatch(/\bregisterTool\(|\bregisterCommand\(|\bregisterFlag\(/);
	});

	it("loads the meta provider, so a meta delegation model never resolves through OpenRouter", () => {
		// `meta` exists only via registerProvider. Without it a worker resolved
		// `--model meta/muse-spark-1.3-contributor` by bare id, matched the
		// OpenRouter catalogue entry of the same name, and died on OpenRouter's
		// `404 … Paid model training violation` — 22 papercuts while readiness
		// reported delegation ready (2026-09-20..22).
		const provider = workerExtensionPaths().find((path) => path.endsWith("/extensions/meta-media/provider-only.ts"));
		expect(provider, "worker must load the meta provider").toBeDefined();
		const source = readFileSync(provider as string, "utf8");
		const pi = createFakePi();
		const register = vi.spyOn(pi.api, "registerProvider");
		registerMetaProvider(pi.api);
		expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "meta" }));
		expect(source, "a worker provider module must not add tools").not.toMatch(/\bregisterTool\(/);
	});

	it("loads the loadout module, whose only hook appends the on-demand tool index", () => {
		const loadout = workerExtensionPaths().find((path) => path.endsWith("/extensions/loadout/index.ts"));
		expect(loadout, "worker must load the loadout module").toBeDefined();
		const source = readFileSync(loadout as string, "utf8");
		expect([...source.matchAll(/\bpi\.on\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["before_agent_start"]);
	});

	it("only reviewed protocol extensions register worker event hooks", () => {
		// `workflow/index.ts` was the second entry until HIV-2904 merged that
		// document into the plan. It is deliberately NOT replaced by
		// `plan/index.ts`: that extension carries plan-mode enforcement, and a
		// worker inheriting a read-only posture nobody reviewed it for is a
		// worse trade than losing the projection. See worker.ts.
		// `loadout/index.ts` appends the on-demand tool index to the system prompt
		// and nothing else (pinned below): without it a worker spawned with no
		// `--tools` list could not reach any deferred harness tool.
		const allowedHooks = new Set(["opmode/index.ts", "fast/worker.ts", "loadout/index.ts"]);
		const ours = workerExtensionPaths().filter((path) => path.includes("/extensions/"));
		expect(ours.length, "expected at least one in-repo worker extension").toBeGreaterThan(0);
		for (const path of ours) {
			if (allowedHooks.has(path.split("/extensions/")[1])) continue;
			expect(readFileSync(path, "utf8"), `${path} registers a hook`).not.toMatch(/\bpi\.on\(/);
		}
	});
});
