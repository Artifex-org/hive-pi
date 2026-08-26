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

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, sep } from "node:path";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import { packageExtensionPath, workerExtensionPaths, workerPackageExtensions } from "../extensions/subagent/worker.ts";

const REPO = join(import.meta.dirname, "..");

/**
 * Granted by pi without appearing in any factory — it is part of the agent loop
 * rather than the tool set, and shows up in a worker's own tool listing.
 * Measured, not assumed.
 */
const IMPLICIT = ["parallel"];

let universe: Set<string>;
const verifiedPackages: { spec: string; declared: readonly string[]; actual: string[] }[] = [];
const unresolvedPackages: string[] = [];

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

	// Package extensions live in pi's agent dir, which does not exist in a CI
	// container. Where the package IS there, read it — the source is ground
	// truth. Where it is not, use its DECLARED `provides`, and record that the
	// declaration went unverified so a test below can say so out loud.
	for (const pkg of workerPackageExtensions()) {
		const path = packageExtensionPath(pkg.spec);
		if (path) {
			verifiedPackages.push({ spec: pkg.spec, declared: pkg.provides, actual: registeredToolNames(readFileSync(path, "utf8")) });
			for (const name of registeredToolNames(readFileSync(path, "utf8"))) names.add(name);
		} else {
			unresolvedPackages.push(pkg.spec);
			for (const name of pkg.provides) names.add(name);
		}
	}
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

	it("contains the MCP adapter tools, which is what HIV-1581 restored", () => {
		// The six affected roles grant these. If the adapter is dropped from
		// WORKER_PACKAGE_EXTENSIONS entirely, they vanish from the universe and
		// the role-grant assertion below fails; this one says WHY, rather than
		// leaving a reader to infer it from six role names.
		for (const tool of ["mcp", "mcpScript"]) {
			expect(
				universe.has(tool),
				`${tool} is missing — pi-mcp-adapter is not among the worker's extensions, so six roles are silently MCP-less again`,
			).toBe(true);
		}
	});

	it("verifies each package's DECLARED tools against its source, wherever the package exists", () => {
		// The declaration exists so CI (no pi agent dir, no adapter) can still
		// evaluate role grants. It is a contract, not an article of faith: on any
		// machine that actually runs workers the package is present and this
		// compares the declaration to what it really registers.
		for (const pkg of verifiedPackages) {
			for (const tool of pkg.declared) {
				expect(
					pkg.actual,
					`${pkg.spec} is declared to provide ${tool} in WORKER_PACKAGE_EXTENSIONS, but its source does not register it`,
				).toContain(tool);
			}
		}
	});

	it("accounts for every package extension as either verified or explicitly unresolved", () => {
		// A package that is neither would mean the derivation loop skipped it, and
		// its tools would be missing from the universe with no reason recorded —
		// the shape that made this whole ticket necessary.
		//
		// Deliberately NOT a console warning about the unresolved ones: vitest's
		// default reporter does not surface console output on a passing file, so a
		// message here would be a notice nobody receives. Where the trust matters
		// it is in the code — `WORKER_PACKAGE_EXTENSIONS[].provides` carries the
		// reason — and the assertion above reads the source wherever it exists.
		expect(verifiedPackages.length + unresolvedPackages.length).toBe(workerPackageExtensions().length);
		for (const pkg of unresolvedPackages) {
			expect(
				workerPackageExtensions().map((entry) => entry.spec),
				`${pkg} was unresolved but is not a declared package extension`,
			).toContain(pkg);
		}
	});
});

describe("role grants are satisfiable in a worker", () => {
	it("no role grants a tool a worker will not have", () => {
		const offenders: string[] = [];
		for (const role of roles()) {
			const missing = role.tools.filter((tool) => !universe.has(tool));
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
