/**
 * Every one-shot model call the adapter makes goes through here: hive-pi's
 * own `runOneShot` (a `pi --mode json -p --no-session --no-tools` child),
 * with three things added that a Claude launch needs.
 *
 *  1. ACCOUNTING — one `usage` spool record per call, under the caller's role.
 *  2. NO INHERITANCE — the model and the thinking level must be named. A child
 *     without `--model` runs pi's default model (a provider nobody chose); one
 *     without `--thinking` inherits the store's default level, which is how
 *     judges came to time out (agenda/goal.ts). Both are refused loudly here
 *     rather than guessed.
 *  3. A DEADLINE — a hook with a wall clock clamps each call's timeout to what
 *     is left, so a slow model cannot carry the hook past it. A clamped call
 *     that runs out reports `timedOut`, which every caller already treats as
 *     "no answer" (the goal judge: a judge error; drift: a skip).
 */

import { runOneShot, type OneShotOptions, type OneShotResult } from "../extensions/agenda/spawn.ts";
import type { Spool } from "./spool.ts";

export type OneShot = (options: OneShotOptions) => Promise<OneShotResult>;

export function accountedOneShot(spool: Spool, role: string, deadline?: () => number, spawn: OneShot = runOneShot): OneShot {
	return async (options) => {
		if (!options.model) throw new Error(`${role}: an adapter model call must name its model`);
		if (!options.thinking) throw new Error(`${role}: an adapter model call must name its thinking level`);
		const left = deadline ? deadline() - Date.now() : Number.POSITIVE_INFINITY;
		const timeoutMs = Math.max(1, Math.min(options.timeoutMs, left));
		const startedAt = Date.now();
		const result = await spawn({ ...options, timeoutMs });
		spool.usage(role, options.model, result.usage, Date.now() - startedAt, 1);
		return result;
	};
}
