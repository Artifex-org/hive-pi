/**
 * Every role's `tools:` line, checked against what a worker ACTUALLY gets.
 *
 * The gap this closes, measured (HIV-1581): five roles granted `mcp` and
 * `mcpScript` and named `mcp__<server>__<tool>` calls in their bodies. Those
 * tools come from `pi-mcp-adapter`, which is an extension, and a worker runs
 * `--no-extensions`. pi drops an unknown `--tools` name in silence, so those
 * roles ran without the capability their own instructions depend on — for as
 * long as the grants existed. A delegated `incident-responder` could not reach
 * sentry; it just proceeded without the data.
 *
 * The dispatch-time check in `subagent/index.ts` could never catch it, because
 * it asks the PARENT registry, where `mcp` resolves perfectly well.
 *
 * So the universe is DERIVED here rather than listed: pi's own tool factories
 * plus whatever the loaded `WORKER_EXTENSIONS` register. A pi release that moves
 * a built-in into an extension, or an extension dropped from the allowlist,
 * fails this test — which is the point. A hardcoded list would have gone stale
 * exactly the way the role grants did.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { join, sep } from "node:path";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import {
	NATIVE_MCP_TOOLS,
	WORKER_BUILTIN_MCP_EXTENSIONS,
	nativeToolGrants,
	workerExtensionPaths,
} from "../extensions/subagent/worker.ts";

const REPO = join(import.meta.dirname, "..");

/**
 * Granted by pi without appearing in any factory — it is part of the agent loop
 * rather than the tool set, and shows up in a worker's own tool listing.
 * Measured, not assumed.
 */
const IMPLICIT = ["parallel"];

let universe: Set<string>;

/**
 * The source of pi's MCP built-ins, as installed for this repo. Read rather than
 * loaded: they need a live session runtime to register anything.
 */
function builtinSource(): string {
	// The package exports no `./package.json`; resolve its entry and walk to dist/.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const root = join(entry.slice(0, entry.lastIndexOf(`${sep}dist${sep}`)), "dist", "extensions");
	let source = "";
	for (const builtin of WORKER_BUILTIN_MCP_EXTENSIONS) {
		const dir = join(root, builtin.replace(/^builtin:/, ""));
		for (const file of readdirSync(dir)) if (file.endsWith(".js")) source += readFileSync(join(dir, file), "utf8");
	}
	return source;
}

beforeAll(async () => {
	// `knowledge-tools` registers nothing without hive auth, so on a CI container
	// the universe would silently lose five tools and blame FOURTEEN roles for
	// granting them. That is the environment-dependence trap this repo has now
	// hit three times (HIV-1583's `list_workspace_catalog` was the last one) —
	// stage the environment, do not let the derivation shrink.
	process.env.HIVE_TELEMETRY_TOKEN ||= "worker-universe-test-token";
	process.env.HIVE_TELEMETRY_URL ||= "http://127.0.0.1:1";

	const names = new Set<string>(IMPLICIT);
	for (const tool of createCodingTools(REPO)) names.add(tool.name);
	for (const tool of createReadOnlyTools(REPO)) names.add(tool.name);

	// Exactly the extensions `buildSubagentWorkerArgs` passes as `-e`.
	//
	// In-repo ones are LOADED, the same way the conformance suite loads
	// extensions — the strongest evidence available, since it is the code path.
	//
	// Installed packages are READ instead. `pi-mcp-adapter` imports
	// `@earendil-works/pi-ai`, which resolves inside pi's own npm tree and not in
	// this repo's, so importing it here fails with "Could not resolve". Static
	// extraction is weaker than execution, and the weakness is bounded: it can
	// miss a tool the adapter registers dynamically, but it cannot invent one,
	// and a rename still moves the extracted set. It beats the alternative of
	// writing "mcp, mcpScript" into a constant — a hardcoded list is exactly what
	// went stale to produce this bug.
	for (const path of workerExtensionPaths()) {
		if (path.includes(`${sep}node_modules${sep}`)) continue; // handled below
		const module = (await import(path)) as { default?: (pi: unknown) => unknown };
		if (typeof module.default !== "function") continue;
		const pi = createFakePi();
		await module.default(pi.api);
		for (const tool of pi.tools) names.add(tool.name);
	}

	// pi's MCP built-ins, which buildSubagentWorkerArgs loads for an MCP-capable
	// worker (HIV-3745). Their tools are part of the universe; a test below
	// checks the names against pi's own source.
	for (const name of NATIVE_MCP_TOOLS) names.add(name);
	universe = names;
}, 60_000);

/**
 * Literal tool names a source file registers.
 *
 * Only literals: the adapter also registers per-server tools under a computed
 * `spec.prefixedName`, which no static read can enumerate. Those are the
 * `mcp__<server>__<tool>` names, and they exist only when a server declares
 * `directTools` — none do here, which is why `audit-verifier` granting two of
 * them was dead on arrival even in the parent session.
 */
export function registeredToolNames(source: string): string[] {
	// Not one regex. The adapter's call site is
	// `(pi.registerTool as (tool: unknown) => unknown)({ name: "mcp", … })`,
	// and matching arbitrary cast syntax in a single pattern is how a silent
	// zero-match happens — which it did on the first attempt, producing an empty
	// set that every assertion here would have accepted.
	const names: string[] = [];
	for (const match of source.matchAll(/registerTool\b/g)) {
		const window = source.slice(match.index, match.index + 300);
		const name = /\bname:\s*"([^"]+)"/.exec(window);
		if (name) names.push(name[1]);
	}
	return names;
}

function roles(): { name: string; tools: string[] }[] {
	const files = execSync("git ls-files 'agents/*.md'", { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
	return files.map((file) => {
		const source = readFileSync(join(REPO, file), "utf8");
		const line = /^tools:\s*(.+)$/m.exec(source);
		return {
			name: file.replace(/^agents\//, "").replace(/\.md$/, ""),
			tools: line ? line[1].split(",").map((tool) => tool.trim()).filter(Boolean) : [],
		};
	});
}

describe("the worker tool universe", () => {
	it("is derived, and contains what a real worker reported", () => {
		// Guards the derivation itself: if the factories or the extension load
		// break, every assertion below passes vacuously against an empty set.
		for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "knowledge_search"]) {
			expect(universe.has(tool), `${tool} missing from the derived universe`).toBe(true);
		}
		expect(universe.size).toBeGreaterThan(8);
	});

	it("contains the native MCP tools — codemode and tool_search reach every server", () => {
		for (const tool of ["codemode", "tool_search"]) expect(universe.has(tool), `${tool} missing`).toBe(true);
	});

	it("names only tools pi's MCP built-ins actually register", () => {
		// NATIVE_MCP_TOOLS is a declaration; pi's own source is ground truth. A
		// pi release that renames one of these fails here instead of silently
		// stripping MCP from every worker role that grants it.
		const source = builtinSource();
		for (const tool of NATIVE_MCP_TOOLS) expect(source, `pi's MCP built-ins do not mention ${tool}`).toContain(`"${tool}"`);
	});
});

describe("role grants are satisfiable in a worker", () => {
	it("no role grants a tool a worker will not have", () => {
		const offenders: string[] = [];
		for (const role of roles()) {
			// Judged AFTER the translation buildSubagentWorkerArgs applies, so a role
			// still granting the adapter's `mcp` is satisfied by `codemode`.
			const missing = nativeToolGrants(role.tools).filter((tool) => !universe.has(tool));
			if (missing.length > 0) offenders.push(`${role.name}: ${missing.join(", ")}`);
		}
		expect(
			offenders.sort(),
			"these roles grant tools that do not exist in a subagent worker. pi drops an unknown --tools name " +
				"SILENTLY, so the role runs with fewer tools than it asks for and nothing says so. Either remove the " +
				"grant (and the body instructions that depend on it), or add the extension that provides it to " +
				"WORKER_EXTENSIONS in subagent/worker.ts.",
		).toEqual([]);
	});

	it("every role grants something — an empty tools line is a role that can only talk", () => {
		const toolless = roles().filter((role) => role.tools.length === 0);
		expect(toolless.map((role) => role.name)).toEqual([]);
	});
});

describe("the extension allowlist a worker is actually spawned with", () => {
	it("passes every allowlisted extension as a real, existing path", () => {
		// pi treats an unresolvable `-e` as a hard error, so a bad entry here does
		// not degrade one role — it breaks every delegation.
		const paths = workerExtensionPaths();
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(existsSync(path), `${path} does not exist — every subagent spawn would fail`).toBe(true);
		}
	});
});
