/**
 * MCP project-scope and spawnability helpers (HIV-2639).
 *
 * Pure: no adapter, no disk. The probe tests drive the same functions through
 * `mcpServerProbes`; this file pins the classification itself so a matcher
 * change cannot silently reclassify one project's checkout as another's.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";

import {
	mcpBelongsHere,
	projectKind,
	stdioEntrypoints,
	stdioMissing,
} from "../extensions/readiness/mcp.ts";

const PROFILE = {
	projects: [
		{ token: "alpha", mcpServers: ["alpha-api"], mcpLauncher: "alpha-mcp" },
		{ token: "beta", mcpServers: ["beta-api"], mcpLauncher: "beta-mcp" },
	],
};

beforeEach(() => setHouseProfileForTest(PROFILE));
afterEach(() => setHouseProfileForTest(null));

describe("projectKind / mcpBelongsHere", () => {
	it("keeps one project's checkout out of another's product server", () => {
		expect(projectKind("/home/dev/repos/Alpha__worktrees/agents-8ae46e84")).toBe("alpha");
		expect(mcpBelongsHere("beta-api", "/home/dev/repos/Alpha__worktrees/x")).toBe(false);
		expect(mcpBelongsHere("alpha-api", "/home/dev/repos/Alpha__worktrees/x")).toBe(true);
	});

	it("keeps the other project's checkout out of the first's product server", () => {
		expect(projectKind("/home/dev/repos/Beta-Platform__worktrees/main")).toBe("beta");
		expect(mcpBelongsHere("alpha-api", "/home/dev/repos/Beta-Platform__worktrees/main")).toBe(false);
		expect(mcpBelongsHere("beta-api", "/home/dev/repos/Beta-Platform__worktrees/main")).toBe(true);
	});

	it("leaves servers no project claims available from any checkout", () => {
		for (const cwd of ["/home/dev/repos/alpha", "/home/dev/repos/beta", "/home/dev/repos/hive"]) {
			expect(mcpBelongsHere("hive", cwd)).toBe(true);
			expect(mcpBelongsHere("linear", cwd)).toBe(true);
			expect(mcpBelongsHere("sentry", cwd)).toBe(true);
		}
	});

	// The out-of-the-box state. Nothing is a product server, so nothing is
	// hidden — the conservative direction: a row too many is a nuisance, a
	// silently missing capability is the failure this repo keeps hitting.
	it("reports every server everywhere when no profile is configured", () => {
		setHouseProfileForTest({});
		expect(projectKind("/home/dev/repos/Alpha__worktrees/x")).toBeNull();
		expect(mcpBelongsHere("alpha-api", "/home/dev/repos/Beta-Platform")).toBe(true);
	});
});

describe("stdioEntrypoints / stdioMissing", () => {
	const home = "/home/test";
	const aurorasvc = {
		command: "bash",
		args: [
			"-c",
			'for p in "$HOME/repos/Alpha__worktrees/feature" "$HOME/repos/Alpha"; do [ -f "$p/frontend/cli/dist/mcp-server.js" ] && exec node "$p/frontend/cli/dist/mcp-server.js"; done; exit 1',
		],
	};

	it("expands the house's for-loop spawn into candidate paths", () => {
		expect(stdioEntrypoints(aurorasvc, home)).toEqual([
			"/home/test/repos/Alpha__worktrees/feature/frontend/cli/dist/mcp-server.js",
			"/home/test/repos/Alpha/frontend/cli/dist/mcp-server.js",
		]);
	});

	it("does not invent files for an HTTP / npx server", () => {
		expect(stdioEntrypoints({ url: "https://app.hiveci.io/mcp" }, home)).toEqual([]);
		expect(
			stdioEntrypoints(
				{ command: "bash", args: ["-c", "source ~/.secrets; exec npx -y @sentry/mcp-server@0.37.0 --host=de.sentry.io"] },
				home,
			),
		).toEqual([]);
		expect(stdioMissing({ url: "https://app.hiveci.io/mcp" }, home, () => false)).toBeNull();
	});

	it("is missing when every candidate is gone", () => {
		const missing = stdioMissing(aurorasvc, home, () => false);
		expect(missing).toEqual([
			"/home/test/repos/Alpha__worktrees/feature/frontend/cli/dist/mcp-server.js",
			"/home/test/repos/Alpha/frontend/cli/dist/mcp-server.js",
		]);
	});

	it("is runnable when any candidate exists", () => {
		expect(
			stdioMissing(aurorasvc, home, (p) => p.endsWith("Alpha/frontend/cli/dist/mcp-server.js")),
		).toBeNull();
	});

	it("does not treat a bare launcher as enough without a seed bundle", () => {
		const launcher = {
			command: "bash",
			args: ["-c", 'exec "$HOME/repos/Alpha__worktrees/feature/frontend/cli/bin/alpha-mcp"'],
		};
		const present = new Set(["/home/test/repos/Alpha__worktrees/feature/frontend/cli/bin/alpha-mcp"]);
		const missing = stdioMissing(launcher, home, (p) => present.has(p));
		expect(missing).toContain("/home/test/.local/share/alpha-mcp/current.js");
		expect(missing?.some((p) => p.endsWith("dist/mcp-server.js"))).toBe(true);
	});

	it("is runnable once the launcher has a staged current.js", () => {
		const launcher = {
			command: "bash",
			args: ["-c", 'exec "$HOME/repos/Alpha__worktrees/feature/frontend/cli/bin/alpha-mcp"'],
		};
		const present = new Set([
			"/home/test/repos/Alpha__worktrees/feature/frontend/cli/bin/alpha-mcp",
			"/home/test/.local/share/alpha-mcp/current.js",
		]);
		expect(stdioMissing(launcher, home, (p) => present.has(p))).toBeNull();
	});
});
