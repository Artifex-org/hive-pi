/**
 * The project trust gate on the `subagent` tool.
 *
 * Observed 2026-08-06: a delegation from a hive worktree died with "Refusing
 * project-local agents because the current project is not trusted." The
 * worktree had no `.pi/agents` directory at all — `projectAgentsDir` came back
 * null and every one of the 11 available roles was `package`. The call asked
 * for `agentScope: "both"`, which in that tree resolves to exactly the same set
 * as the default `"user"`. Nothing repo-supplied was in play, and the whole
 * delegation was refused anyway.
 *
 * The gate keyed on the requested SCOPE. It has to key on what is actually
 * about to run.
 */

import { describe, expect, it } from "vitest";
import { type AgentConfig, projectAgentsAmong, selectableAgents } from "../extensions/harness/roles.ts";
import { requestedAgentNames } from "../extensions/subagent/index.ts";

function role(name: string, source: AgentConfig["source"], aliases?: string[]): AgentConfig {
	return {
		name,
		aliases,
		description: `${name} role`,
		systemPrompt: "prompt",
		source,
		filePath: `/tmp/${name}.md`,
	};
}

const PACKAGE_ONLY = [role("research", "package", ["explorer"]), role("code-reviewer", "package")];

describe("selectableAgents — an untrusted project loses its roles, and only its roles", () => {
	it("keeps every package and user role when the project is untrusted", () => {
		// The regression. These roles are not repo-supplied, so an untrusted repo
		// is not a reason to withhold them — and in the tree that produced the bug
		// they were the ONLY roles that existed.
		const agents = [...PACKAGE_ONLY, role("local-tuned", "user")];
		expect(selectableAgents(agents, false)).toEqual(agents);
	});

	it("drops project roles when the project is untrusted", () => {
		const agents = [...PACKAGE_ONLY, role("repo-helper", "project")];
		expect(selectableAgents(agents, false).map((a) => a.name)).toEqual(["research", "code-reviewer"]);
	});

	it("keeps project roles when the project IS trusted", () => {
		const agents = [...PACKAGE_ONLY, role("repo-helper", "project")];
		expect(selectableAgents(agents, true)).toEqual(agents);
	});

	it("empties the pool when project roles were all there was", () => {
		// `agentScope: "project"` in an untrusted repo leaves nothing runnable. The
		// tool names trust as the cause rather than reporting "Unknown agent …
		// (none)", which would blame the caller's spelling for a trust decision.
		expect(selectableAgents([role("repo-helper", "project")], false)).toEqual([]);
	});

	it("drops a project role that shadows a shipped one by name", () => {
		// This is why the pool is filtered instead of the requested name being
		// checked. discoverAgents merges project LAST, so a repo can replace
		// `research` by dropping .pi/agents/research.md in place. A caller asking
		// for "research" would then run repo-controlled prompt text without ever
		// naming anything that looks project-local.
		const shadowed = [role("code-reviewer", "package"), role("research", "project")];
		const selectable = selectableAgents(shadowed, false);

		expect(selectable.find((a) => a.name === "research")).toBeUndefined();
		expect(selectable.map((a) => a.source)).not.toContain("project");
	});
});

describe("projectAgentsAmong — refuse only what the call actually asks for", () => {
	it("finds nothing to refuse when the call names only package roles", () => {
		// The exact failing call: agentScope "both", a package role, no project
		// agents anywhere. An empty result is what lets the delegation proceed.
		expect(projectAgentsAmong(PACKAGE_ONLY, ["research"])).toEqual([]);
	});

	it("finds nothing to refuse when there are no project roles at all", () => {
		expect(projectAgentsAmong(PACKAGE_ONLY, ["research", "code-reviewer"])).toEqual([]);
	});

	it("finds the project role a call names", () => {
		const agents = [...PACKAGE_ONLY, role("repo-helper", "project")];
		expect(projectAgentsAmong(agents, ["research", "repo-helper"]).map((a) => a.name)).toEqual(["repo-helper"]);
	});

	it("finds a project role invoked through an alias", () => {
		// Both gates matched on `name` before. A repo shipping a role with an alias
		// could be invoked by that alias and skip the confirmation entirely.
		const agents = [...PACKAGE_ONLY, role("repo-helper", "project", ["helper"])];
		expect(projectAgentsAmong(agents, ["helper"]).map((a) => a.name)).toEqual(["repo-helper"]);
	});

	it("ignores names that resolve to nothing", () => {
		expect(projectAgentsAmong(PACKAGE_ONLY, ["general"])).toEqual([]);
	});
});

describe("requestedAgentNames — every mode, deduped", () => {
	it("reads the single-mode agent", () => {
		expect(requestedAgentNames({ agent: "research" })).toEqual(["research"]);
	});

	it("reads every agent in a parallel batch", () => {
		expect(requestedAgentNames({ tasks: [{ agent: "research" }, { agent: "code-reviewer" }] })).toEqual([
			"research",
			"code-reviewer",
		]);
	});

	it("reads every step of a chain", () => {
		// A chain that gated on its first step only would run the rest ungated.
		expect(requestedAgentNames({ chain: [{ agent: "research" }, { agent: "repo-helper" }] })).toContain("repo-helper");
	});

	it("dedupes a name used twice", () => {
		expect(requestedAgentNames({ tasks: [{ agent: "research" }, { agent: "research" }] })).toEqual(["research"]);
	});

	it("returns nothing for a call that names no agent", () => {
		expect(requestedAgentNames({})).toEqual([]);
	});
});
