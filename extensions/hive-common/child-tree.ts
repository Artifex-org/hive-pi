/**
 * Spawning and killing a child as a WHOLE TREE, when the host asks for it.
 *
 * A pi child spawns its own children — bash, MCP servers, a worker's tools —
 * and `child.kill()` reaches only the direct child. Inside an interactive pi
 * that is tolerable (the session's own lifetime bounds them). For the Claude
 * adapter's helpers it is not: Hive's node accounts for every process a
 * launch leaves behind, and a timed-out judge or a cancelled background
 * worker must not leave grandchildren running. So a helper spawns each child
 * in its own process group (`detached`), kills the group (`kill(-pid)`), and
 * can kill every group it still has when it is itself told to stop.
 *
 * A helper is recognised by an EXPLICIT marker the adapter sets on itself and
 * so on its own children (`HIVE_PI_HELPER_CHILD=1`, claude/env.ts) — not by
 * `HIVE_PI_AGENT_DIR`, which every process in the launch inherits, including
 * a pi the agent starts from its own shell.
 */

import type { ChildProcess } from "node:child_process";

export const HELPER_MARKER = "HIVE_PI_HELPER_CHILD";

/** True in the Claude adapter and the pi children it spawned. */
export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return env[HELPER_MARKER] === "1";
}

/** Spawn options that put the child in its own process group when killing it must kill its tree. */
export function treeSpawnOptions(env: Record<string, string | undefined> = process.env): { detached: boolean } {
	return { detached: isClaudeHelper(env) };
}

/**
 * Signal `child` — and, when it was spawned as a group leader (`grouped`, the
 * `detached` that `treeSpawnOptions` returned), everything in its group. A
 * group that is gone, or one this process may not signal, falls back to the
 * child itself, so the caller's kill is never lost and never throws.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
	if (grouped && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH" && code !== "EPERM") throw error;
		}
	}
	child.kill(signal);
}

/**
 * The trees this module instance spawned and that are still running. Per
 * instance on purpose (pi gives each extension its own copy): each copy kills
 * only what it started. Only the Claude adapter's entry ever calls
 * `killAllTrees` — on its own termination, so a hook killed for its timeout
 * does not leave a gate check or a judge running behind it.
 */
const live = new Set<{ child: ChildProcess; grouped: boolean }>();

export function trackTree(child: ChildProcess, grouped: boolean): void {
	const entry = { child, grouped };
	live.add(entry);
	child.once("close", () => live.delete(entry));
	child.once("error", () => live.delete(entry));
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const entry of live) killTree(entry.child, signal, entry.grouped);
}
