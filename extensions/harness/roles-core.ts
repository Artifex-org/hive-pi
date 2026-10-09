/**
 * Agent discovery and configuration — the harness-neutral core.
 *
 * pi's three runtime facts (its frontmatter parser, its agent dir, its config
 * dir name) arrive as a `RolesRuntime` rather than as imports: `roles.ts`
 * binds pi's own, and the Claude adapter binds the PINNED pi install's (it
 * runs under plain node, where `@earendil-works/*` does not resolve from this
 * checkout). One parser either way — never a second reading of the YAML.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** What discovery needs from the pi it serves. */
export interface RolesRuntime {
	parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };
	/** The user agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
	agentDir(): string;
	/** The per-project config dir name, `.pi`. */
	configDirName: string;
}

/**
 * The user-facing `agentScope` parameter. Deliberately unchanged: "package" is
 * a *source*, not a scope a caller selects. Roles shipped with hive-pi are the
 * baseline that `user` and `project` layer over.
 */
export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	/** Canonical role name shown in discovery and telemetry. */
	name: string;
	/** Accepted invocation aliases; never rendered as duplicate roles. */
	aliases?: string[];
	description: string;
	tools?: string[];
	model?: string;
	/**
	 * A catalog CLASS (`high`, `medium`, `low`, `fast` — the keys of Hive's
	 * agent-mode catalog) for a role whose work needs a stronger model than the
	 * cheap delegation lane, without pinning a `provider/id` that drifts with the
	 * fleet. Only the `subagent` tool resolves it (subagent/model.ts); `model`
	 * wins over it, and a caller's per-call `model` wins over both.
	 */
	tier?: string;
	opMode?: string;
	systemPrompt: string;
	/**
	 * Where the definition came from, lowest precedence first. `project` is the
	 * only one that is repo-supplied and therefore the only one gated behind a
	 * trust confirmation — see the `source === "project"` check in index.ts.
	 */
	source: "package" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"], runtime: RolesRuntime): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const parsed = runtime.parseFrontmatter(content);
		const frontmatter = parsed.frontmatter as Record<string, string | undefined>;
		const body = parsed.body;

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		const aliases = frontmatter.aliases
			?.split(",")
			.map((alias: string) => alias.trim())
			.filter((alias: string) => alias && alias !== frontmatter.name);

		agents.push({
			name: frontmatter.name,
			aliases: aliases && aliases.length > 0 ? aliases : undefined,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			tier: typeof frontmatter.tier === "string" && /^[a-z0-9_-]{1,32}$/.test(frontmatter.tier) ? frontmatter.tier : undefined,
			opMode: frontmatter.op_mode,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string, configDirName: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Roles shipped inside this package, resolved relative to THIS file rather than
 * to the agent dir. Without it a package install would deliver the subagent
 * tool and none of the roles it exists to run, because pi's package manifest
 * has no `agents` resource type — only extensions, skills, prompts and themes.
 *
 * `extensions/harness/roles-core.ts` → `<package root>/agents`.
 */
function packageAgentsDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

export function discoverAgentsWith(cwd: string, scope: AgentScope, runtime: RolesRuntime): AgentDiscoveryResult {
	const userDir = path.join(runtime.agentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, runtime.configDirName);

	// Precedence, lowest first: package → user → project. A developer shadows a
	// shipped role by dropping a same-named file in ~/.pi/agent/agents, never by
	// editing the pinned package.
	const packageAgents = scope === "project" ? [] : loadAgentsFromDir(packageAgentsDir(), "package", runtime);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", runtime);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", runtime);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of packageAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of packageAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** Resolve an invocation name, preferring a canonical role over an alias. */
export function resolveAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name) ?? agents.find((agent) => agent.aliases?.includes(name));
}

/**
 * The roles a caller may actually run.
 *
 * An untrusted project loses its roles, and only its roles — package and user
 * roles are unaffected, because neither is repo-supplied.
 *
 * Filtering the POOL rather than checking the requested name is the part that
 * carries the security. discoverAgents merges project LAST, so a repo can
 * shadow a shipped role by dropping `.pi/agents/research.md` in place; a caller
 * asking for `research` by name would otherwise run repo-controlled prompt text
 * without ever naming anything project-local.
 */
export function selectableAgents(agents: AgentConfig[], projectTrusted: boolean): AgentConfig[] {
	return projectTrusted ? agents : agents.filter((agent) => agent.source !== "project");
}

/**
 * The project-supplied roles a call actually asks for.
 *
 * Both repo-controlled gates run through this: the trust refusal and the
 * interactive confirmation. Sharing it is what keeps them from disagreeing
 * about what a call is asking to run — and resolving through `resolveAgent`
 * rather than matching `name` is what stops a project role invoked by one of
 * its aliases from slipping past either.
 */
export function projectAgentsAmong(agents: AgentConfig[], requested: string[]): AgentConfig[] {
	return requested
		.map((name) => resolveAgent(agents, name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

/**
 * Tool names a role asks for that the running process cannot provide.
 *
 * Role `tools:` frontmatter is a free-text string that nothing has ever checked.
 * pi silently drops an unknown name from `--tools`, so a role naming a tool that
 * does not exist runs with FEWER tools and says nothing — which is how nine
 * roles came to be granted only a retired knowledge surface's names and, once it
 * correctly stood down against a reachable Hive brain, ended up with no
 * knowledge access at all (wave 5). `research` and `retriever` were among them:
 * the two roles the global AGENTS.md routes every context-gathering task to.
 *
 * Pure so it can be tested without a registry, and so the caller decides what a
 * mismatch means — the subagent tool refuses to spawn, which is the moment the
 * information is actionable.
 *
 * `available` is the live tool registry. An EMPTY registry means "cannot tell"
 * (the caller has no list), not "nothing is available", and yields no findings —
 * a validator that fails closed on missing input would block every delegation on
 * a harness that simply did not expose its tools.
 */
export function unknownTools(agent: Pick<AgentConfig, "tools">, available: readonly string[]): string[] {
	if (!agent.tools || agent.tools.length === 0) return [];
	if (available.length === 0) return [];
	const have = new Set(available);
	return agent.tools.filter((tool) => !have.has(tool));
}
