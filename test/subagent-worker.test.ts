import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSubagentWorkerArgs, workerExtensionPaths } from "../extensions/subagent/worker.ts";

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
			withoutExtensionLoads(buildSubagentWorkerArgs("openrouter/deepseek/deepseek-v4-flash", ["read", "grep"], null)),
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
		const args = withoutExtensionLoads(buildSubagentWorkerArgs(undefined, [], null, "bugfix"));
		expect(args).toContain("--op-mode");
		expect(args[args.indexOf("--op-mode") + 1]).toBe("bugfix");
	});

	it("omits optional flags without re-enabling extensions", () => {
		// The mcp-config argument is passed EXPLICITLY here (and as null) because
		// its default reads the machine's real `~/.pi/agent/mcp.json`: once that
		// file declares an eager server, an implicit call would inject
		// `--mcp-config` and this exact-list assertion would fail on a developer
		// machine and pass in CI, or the reverse. A test whose result depends on
		// the host's config is worse than no test.
		expect(withoutExtensionLoads(buildSubagentWorkerArgs(undefined, [], null))).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
		]);
	});

	it("passes a derived MCP config when one exists — a worker must not inherit an eager lifecycle", () => {
		// HIV-1969: `hive` and `linear` are eager for the interactive session, which
		// removes a stall the human waits through. A worker is one bounded task,
		// often one of eight, and `linear` spawns an npx subprocess per connection.
		const args = buildSubagentWorkerArgs(undefined, [], "/tmp/pi-worker-mcp-1.json");
		expect(args).toContain("--mcp-config");
		expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/pi-worker-mcp-1.json");
	});

	it("passes no flag when nothing prewarms, so the worker reads what the adapter would", () => {
		expect(buildSubagentWorkerArgs(undefined, [], null)).not.toContain("--mcp-config");
	});

	it("loads exactly the allowlisted extensions, each behind its own -e", () => {
		// `--no-extensions` strips EVERY extension, including the ones a worker
		// needs. Fixing a role's `tools:` grant is a no-op if the extension that
		// registers the tool never loads — measured: a worker granted
		// `knowledge_search` reported its tools as `read, grep` before this.
		// Same pattern the Code Factory uses (HIV-887).
		const args = buildSubagentWorkerArgs(undefined, []);
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
		expect(workerExtensionPaths().length).toBeLessThanOrEqual(5);
	});

	it("only reviewed protocol extensions register worker event hooks", () => {
		// `workflow/index.ts` was the second entry until HIV-2904 merged that
		// document into the plan. It is deliberately NOT replaced by
		// `plan/index.ts`: that extension carries plan-mode enforcement, and a
		// worker inheriting a read-only posture nobody reviewed it for is a
		// worse trade than losing the projection. See worker.ts.
		const allowedHooks = new Set(["opmode/index.ts"]);
		const ours = workerExtensionPaths().filter((path) => path.includes("/extensions/"));
		expect(ours.length, "expected at least one in-repo worker extension").toBeGreaterThan(0);
		for (const path of ours) {
			if (allowedHooks.has(path.split("/extensions/")[1])) continue;
			expect(readFileSync(path, "utf8"), `${path} registers a hook`).not.toMatch(/\bpi\.on\(/);
		}
	});
});
