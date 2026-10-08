/**
 * Spawning and killing a child as a WHOLE TREE, when the host asks for it.
 *
 * A pi child spawns its own children — bash, MCP servers, a worker's tools —
 * and `child.kill()` reaches only the direct child. Inside an interactive pi
 * that is tolerable (the session's own lifetime bounds them). For the Claude
 * adapter's helpers it is not: Hive's node accounts for every process a
 * launch leaves behind, and a timed-out judge or a cancelled background
 * worker must not leave grandchildren running. So a helper of a Claude launch
 * spawns each child in its own process group (`detached`) and kills the
 * group (`kill(-pid)`).
 *
 * A Claude helper is recognised by `HIVE_PI_AGENT_DIR`, the leased store the
 * launch hands its helpers — the same variable that, there, IS the agent dir
 * (see mcp-common/config.ts). Everywhere else nothing changes.
 */

import type { ChildProcess } from "node:child_process";

/** True in a process (or a descendant of one) serving a Claude launch's hive-pi helpers. */
export function isClaudeHelper(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.HIVE_PI_AGENT_DIR?.trim());
}

/** Spawn options that put the child in its own process group when killing it must kill its tree. */
export function treeSpawnOptions(env: Record<string, string | undefined> = process.env): { detached: boolean } {
	return { detached: isClaudeHelper(env) };
}

/**
 * Signal `child` — and, when it was spawned as a group leader (`grouped`, the
 * `detached` that `treeSpawnOptions` returned), everything in its group. A
 * group that is already gone falls back to the child itself, so the caller's
 * kill is never lost.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
	if (grouped && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	child.kill(signal);
}
