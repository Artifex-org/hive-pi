/**
 * The launch contract, read once.
 *
 * Hive's claude-code launch hands every hook and MCP process the variables
 * below (see README.md). This file is the only place they are read, so a
 * renamed variable is one edit and a missing one has one wording.
 *
 * The rule that matters most: a model-backed feature runs ONLY on the leased
 * pi store (`HIVE_PI_AGENT_DIR`) through the pinned pi (`HIVE_PI_BIN`). There
 * is no fallback to the machine's `~/.pi/agent` — a helper with no lease is a
 * helper that is off, and says so.
 */

import { join } from "node:path";
import { HELPER_MARKER } from "../extensions/hive-common/child-tree.ts";

export interface AdapterEnv {
	hiveUrl?: string;
	hiveToken?: string;
	/** The session's CLIENT RUN ID — not the server's agent-session uuid (see session.ts). */
	sessionRunId?: string;
	launchId?: string;
	piBin?: string;
	piAgentDir?: string;
	piBase?: string;
	configDir?: string;
	spool?: string;
	transcript?: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): AdapterEnv {
	return {
		hiveUrl: value(env, "HIVE_URL")?.replace(/\/+$/, ""),
		hiveToken: value(env, "HIVE_TOKEN"),
		sessionRunId: value(env, "HIVE_SESSION_ID"),
		launchId: value(env, "HIVE_LAUNCH_ID"),
		piBin: value(env, "HIVE_PI_BIN"),
		piAgentDir: value(env, "HIVE_PI_AGENT_DIR"),
		piBase: value(env, "HIVE_PI_BASE"),
		configDir: value(env, "HIVE_CLAUDE_CONFIG_DIR"),
		spool: value(env, "HIVE_AUX_SPOOL"),
		transcript: value(env, "HIVE_CLAUDE_TRANSCRIPT"),
	};
}

/** Why outside-model features cannot run, or null when they can. */
export function modelUnavailableReason(env: AdapterEnv): string | null {
	if (!env.piAgentDir) return "this launch has no outside-model credential (HIVE_PI_AGENT_DIR is unset)";
	if (!env.piBin) return "this launch has no pinned pi binary (HIVE_PI_BIN is unset)";
	return null;
}

/**
 * Point every pi child this process spawns at the leased store and the
 * pinned binary, and mark this process (and so its children) as a Claude
 * helper. Set on `process.env` once, at entry, because every spawner the
 * adapter reuses (`runOneShot`, `runRoleAgent`, the subagent worker) merges
 * `process.env` into the child.
 *
 * - `PI_CODING_AGENT_DIR` is only ever the lease itself: no tmp mirror
 *   (mcp-common/config.ts stands its mirror down for a helper), because
 *   Hive's node accepts a helper child only on that store.
 * - `HIVE_PI_HELPER_CHILD=1` is the explicit helper marker
 *   (hive-common/child-tree.ts): children spawn as process groups and
 *   one-shots skip extension discovery. It is NOT inferred from
 *   `HIVE_PI_AGENT_DIR`, which every process in the launch inherits.
 * - `PI_AGENDA_WORKER=1` is set by those spawners on each child, not here:
 *   this process is not a worker.
 */
export function applyPiChildEnv(env: AdapterEnv): void {
	process.env[HELPER_MARKER] = "1";
	if (env.piAgentDir) process.env.PI_CODING_AGENT_DIR = env.piAgentDir;
	if (env.piBin) process.env.PI_HOUSE_PI_BIN = env.piBin;
}

/** `$HIVE_CLAUDE_CONFIG_DIR/hive-pi`, or null when the launch gave no config dir. */
export function stateDir(env: AdapterEnv): string | null {
	return env.configDir ? join(env.configDir, "hive-pi") : null;
}

/** The Hive auth the catalog and session REST calls use, or null. */
export function hiveAuth(env: AdapterEnv): { url: string; token: string } | null {
	return env.hiveUrl && env.hiveToken ? { url: env.hiveUrl, token: env.hiveToken } : null;
}
