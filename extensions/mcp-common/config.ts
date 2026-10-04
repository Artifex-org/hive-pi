/**
 * The MCP config, read the way pi's built-in MCP support reads it — in one place.
 *
 * pi 0.99 ships MCP natively (`builtin:mcp`): it reads `<agent dir>/mcp.json`
 * (plus a trusted project's `.pi/mcp.json`) and connects every ENABLED server in
 * the background when a session starts. There is no per-server lifecycle and no
 * `--mcp-config` flag; the agent dir (`PI_CODING_AGENT_DIR`) is the only lever
 * on which file a process reads.
 *
 * ## Why a worker gets its own agent dir (HIV-1969, HIV-3745)
 *
 * A delegated worker lives for one bounded task and is often one of eight
 * spawned at once. Under the adapter we kept workers cheap by stripping
 * prewarming lifecycles, so nothing connected until called. Native MCP has no
 * lazy mode, so the same goal is reached by changing WHAT a worker reads: a
 * mirror of the parent's agent dir — every entry symlinked, so auth, models and
 * settings are the parent's own — whose `mcp.json` keeps only HTTP servers.
 * An HTTP connect is a request; a stdio server is a process tree (asfam's node
 * bundle, freecad's `uv run`), and eight of each per fan-out is the cost
 * HIV-1969 removed. This is the same mirror shape hive-agent uses for every
 * launch (`cmd/hive-agent/workstation_pi_auth.go`, `mcp_launch.go`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpServerDef {
	url?: string;
	command?: string;
	[key: string]: unknown;
}

export interface McpConfigDoc {
	mcpServers?: Record<string, McpServerDef>;
	[key: string]: unknown;
}

/**
 * Keys pi-mcp-adapter understood and pi's native validator ignores. Stripped
 * from a worker's copy so the file a worker reads says only what is true of it.
 */
const ADAPTER_ONLY_KEYS = ["lifecycle", "directTools"] as const;

/** The agent dir pi uses, with its `~` expansion rules. */
export function agentDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return path.join(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/")) return path.resolve(home, configured.slice(2));
	return path.resolve(configured);
}

/**
 * The user-level `mcp.json` pi reads. `PI_MCP_CONFIG` is OURS — a test and
 * escape seam, not something pi understands.
 */
export function mcpConfigPath(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
	if (env.PI_MCP_CONFIG) return env.PI_MCP_CONFIG;
	return path.join(agentDir(env, home), "mcp.json");
}

export function readMcpConfig(file: string): McpConfigDoc | null {
	try {
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf8")) as McpConfigDoc;
	} catch {
		// A malformed config is pi's to report (it skips invalid entries), not
		// ours to crash a delegation over.
		return null;
	}
}

/** True for an entry pi connects over streamable HTTP. */
export function isHttpServer(def: McpServerDef | undefined): boolean {
	return !!def && typeof def === "object" && typeof def.url === "string" && def.url !== "";
}

/**
 * A worker's view of the config: HTTP servers only, adapter-only keys removed.
 * Pure; copies rather than mutates.
 */
export function workerMcpConfig(config: McpConfigDoc): McpConfigDoc {
	const servers: Record<string, McpServerDef> = {};
	for (const [name, def] of Object.entries(config.mcpServers ?? {})) {
		if (!isHttpServer(def)) continue;
		const copy: McpServerDef = { ...def };
		for (const key of ADAPTER_ONLY_KEYS) delete copy[key];
		servers[name] = copy;
	}
	return { mcpServers: servers };
}

/**
 * Which servers a mirror keeps. `http` is a delegated worker's view; `none` is
 * for one-shot helpers (recap, judge, drift probe) that run with `--no-tools`
 * and can reach no tool at all — connecting anything there is pure waste, and
 * those helpers outnumber real sessions roughly 20:1.
 */
export type MirrorKind = "http" | "none";

function workerAgentDirPath(tmp: string, pid: number, kind: MirrorKind = "http"): string {
	return path.join(tmp, kind === "http" ? `pi-worker-agent-${pid}` : `pi-oneshot-agent-${pid}`);
}

/**
 * Materialise the worker agent dir, once per process, and return its path.
 *
 * Every entry of the parent's agent dir is symlinked EXCEPT `mcp.json`, which
 * is written filtered. Symlinks rather than copies: a token a worker refreshes
 * (`auth.json`, `mcp-auth.json`) must land where the parent reads it.
 *
 * Returns null when the parent has no agent dir — the worker then reads the
 * same nothing the parent does. Never throws: a worker that falls back to the
 * parent's full config pays some connects; a failed delegation pays the task.
 */
export function ensureWorkerAgentDir(
	sourceDir: string = agentDir(),
	tmp: string = os.tmpdir(),
	pid: number = process.pid,
	kind: MirrorKind = "http",
): string | null {
	try {
		if (!fs.existsSync(sourceDir)) return null;
		const target = workerAgentDirPath(tmp, pid, kind);
		fs.mkdirSync(target, { recursive: true });
		for (const entry of fs.readdirSync(sourceDir)) {
			if (entry === "mcp.json") continue;
			const link = path.join(target, entry);
			if (fs.existsSync(link) || isSymlink(link)) continue;
			fs.symlinkSync(path.join(sourceDir, entry), link);
		}
		const source = readMcpConfig(path.join(sourceDir, "mcp.json")) ?? {};
		const config = kind === "http" ? workerMcpConfig(source) : { mcpServers: {} };
		fs.writeFileSync(path.join(target, "mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
		return target;
	} catch {
		return null;
	}
}

function isSymlink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Remove this process's worker agent dir. Links only — never their targets. */
export function cleanupWorkerAgentDir(tmp: string = os.tmpdir(), pid: number = process.pid): void {
	for (const kind of ["http", "none"] as const) {
		try {
			fs.rmSync(workerAgentDirPath(tmp, pid, kind), { recursive: true, force: true });
		} catch {
			/* best effort; it is a directory of links in tmp */
		}
	}
}

/** The agent-dir env for a one-shot helper: same auth and models, no MCP servers. */
export function oneShotMcpEnv(mirror: () => string | null = () => ensureWorkerAgentDir(agentDir(), os.tmpdir(), process.pid, "none")): Record<string, string> {
	const dir = mirror();
	return dir ? { PI_CODING_AGENT_DIR: dir } : {};
}
