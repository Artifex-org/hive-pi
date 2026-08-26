/**
 * pi's package manifest has no `agents` resource type — only extensions,
 * skills, prompts and themes. Without the package-local source below, installing
 * hive-pi would deliver the `subagent` tool and NONE of the roles it exists to
 * run, and the failure would look like "no agents configured" rather than like a
 * packaging bug.
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverAgents, resolveAgent } from "../extensions/harness/roles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => {
	// Point the USER agent dir at an empty directory. On a developer's machine
	// ~/.pi/agent/agents is a symlink to these very files, so the user tier
	// legitimately shadows the package tier and every role comes back labelled
	// `user` — correct behaviour, but it would make this suite pass in CI and
	// fail locally. Isolating the tier is the only way to assert on it.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hive-pi-agentdir-"));
});

describe("discoverAgents — package-local roles", () => {
	it("finds every role shipped in agents/", () => {
		const shipped = readdirSync(join(repoRoot, "agents"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();

		// A role file whose frontmatter is missing name or description is silently
		// skipped by the loader, so comparing against the directory listing is what
		// catches a malformed one.
		const found = discoverAgents(repoRoot, "user")
			.agents.filter((a) => a.source === "package")
			.map((a) => a.name)
			.sort();

		expect(found).toEqual(shipped);
	});

	it("resolves explorer to the canonical read-only research role without listing a duplicate", () => {
		const agents = discoverAgents(repoRoot, "user").agents;
		const research = agents.find((agent) => agent.name === "research");
		const explorer = resolveAgent(agents, "explorer");

		expect(explorer).toBe(research);
		// Pinned exactly, so an accidental grant (a `bash` or a `write` on a
		// read-only role) fails here rather than shipping. Updated in wave 5:
		// this used to pin the `mcp__qmd__*` tools, which are a CONDITIONAL
		// fallback — they do not exist when the Hive knowledge brain is
		// reachable, so `research` was pinned to a tool set it did not have.
		expect(explorer?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"knowledge_search",
			"knowledge_grep",
			"knowledge_get",
			"knowledge_multi_get",
			"knowledge_collections",
		]);
		expect(agents.filter((agent) => agent.name === "explorer")).toHaveLength(0);
	});

	it("prefers a canonical role over another role's alias", () => {
		const explorer = { name: "explorer", description: "canonical", systemPrompt: "prompt", source: "user" as const, filePath: "/tmp/explorer.md" };
		const research = {
			name: "research",
			aliases: ["explorer"],
			description: "alias",
			systemPrompt: "prompt",
			source: "package" as const,
			filePath: "/tmp/research.md",
		};
		expect(resolveAgent([research, explorer], "explorer")).toBe(explorer);
	});

	it("gives every shipped role a description and a system prompt", () => {
		for (const agent of discoverAgents(repoRoot, "user").agents.filter((a) => a.source === "package")) {
			expect(agent.description, `${agent.name} description`).toBeTruthy();
			expect(agent.systemPrompt.trim(), `${agent.name} system prompt`).not.toBe("");
		}
	});

	it("labels them `package`, which keeps them out of the project trust gate", () => {
		// index.ts confirms only `source === "project"` roles with the user, because
		// only those are repo-supplied. A shipped role mislabelled `project` would
		// put a confirmation dialog in front of every delegation.
		const sources = new Set(discoverAgents(repoRoot, "user").agents.map((a) => a.source));
		expect(sources.has("project")).toBe(false);
	});

	it("excludes package roles when the caller asked for project scope only", () => {
		const agents = discoverAgents(repoRoot, "project").agents;
		expect(agents.filter((a) => a.source === "package")).toEqual([]);
	});

	it("lets a user role of the same name shadow the shipped one", () => {
		// The escape hatch: tune a shipped role by dropping a same-named file in
		// ~/.pi/agent/agents, never by editing a pinned package. Observed for real
		// on 2026-08-05 — the workstation symlinks that dir at these same files, so
		// every role came back `user` until this suite isolated the tiers.
		// getAgentDir() is the dir that CONTAINS agents/, not the agents dir itself.
		const agentDir = mkdtempSync(join(tmpdir(), "hive-pi-usershadow-"));
		mkdirSync(join(agentDir, "agents"));
		writeFileSync(
			join(agentDir, "agents", "research.md"),
			"---\nname: research\ndescription: locally tuned\n---\nlocal body\n",
		);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		try {
			const research = discoverAgents(repoRoot, "user").agents.find((a) => a.name === "research");
			expect(research?.source).toBe("user");
			expect(research?.description).toBe("locally tuned");
		} finally {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});
