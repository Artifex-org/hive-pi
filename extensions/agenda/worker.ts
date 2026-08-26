/**
 * The real worker spawner — the adapter `executor.ts` takes as a parameter.
 *
 * Lifted out of `index.ts` so it can be exercised end-to-end by an opt-in
 * integration test. It is deliberately thin: everything interesting about a run
 * (concurrency, retries, budget, failure propagation) lives in the executor and
 * is tested with a fake spawner and zero child processes. What remains here is
 * exactly the part that cannot be tested that way — the process boundary.
 *
 * Nothing mutable at module scope, per the rule `spawn.ts` carries: two
 * extensions importing this get separate instances under pi's per-entry jiti.
 */

import type { Spawn } from "./executor.ts";
import { acquireWriterLock, isWriterCapable, noWriterLock } from "../harness/writer.ts";
import { guardWorkerCwd, workerCwdRefusal } from "../guards-common/capability.ts";
import { diffStamp, NO_CHANGE_ERROR, writerMadeNoChange } from "../harness/verify.ts";
import { runRoleAgent } from "./spawn.ts";
import { resolveNodeOutput } from "./structured-node.ts";
import { discoverAgents } from "../harness/roles.ts";

/** A worker gets this long before it is killed. */
export const NODE_TIMEOUT_MS = 15 * 60_000;

export interface MakeSpawnOptions {
	/** Injectable working-tree stamp, so the fold tests without a git repo. */
	stamp?: (cwd: string) => Promise<string | null>;
}

export function makeSpawn(cwd: string, runId: string, options: MakeSpawnOptions = {}): Spawn {
	const roles = discoverAgents(cwd, "both").agents;
	const stamp = options.stamp ?? diffStamp;

	return async (dispatch, signal) => {
		const role = roles.find((candidate) => candidate.name === dispatch.role);
		if (!role) {
			return { ok: false, value: null, tokens: 0, error: `unknown role "${dispatch.role}"` };
		}

		// One writer per worktree, enforced on disk rather than in module state,
		// and shared with the subagent tool — see harness/writer.ts for why
		// neither a Set nor a per-caller scope can do this job.
		const writerCapable = isWriterCapable(role.tools);

		// Same reasoning as the subagent tool: a worker runs `--no-extensions`,
		// so it carries no worktree guard and the parent is the last place that
		// can refuse a writer aimed at a protected checkout.
		if (writerCapable) {
			const block = guardWorkerCwd(cwd, "orchestrate");
			if (block) {
				return { ok: false, value: null, tokens: 0, error: workerCwdRefusal(role.name, cwd, block) };
			}
		}

		const lock = writerCapable
			? acquireWriterLock(cwd, { pid: process.pid, runId, nodeId: dispatch.nodeId })
			: noWriterLock();

		if (!lock.acquired) {
			const holder = lock.heldBy ? ` (held by run ${lock.heldBy.runId}, node ${lock.heldBy.nodeId})` : "";
			return { ok: false, value: null, tokens: 0, error: `worktree is held by another writer${holder}: ${cwd}` };
		}

		// Taken only for writers: a reader cannot mutate the tree, and the two
		// extra spawns per node would be pure cost on a read fan-out.
		const before = writerCapable ? await stamp(cwd) : null;

		// Accumulated across a schema retry: the first attempt's spend is real
		// and must not vanish because the second one was the answer.
		let tokens = 0;
		let cost = 0;

		try {
			const outcome = await resolveNodeOutput(dispatch.outputSchema, dispatch.prompt, writerCapable, async (prompt) => {
				const result = await runRoleAgent({
					role,
					prompt,
					cwd,
					model: dispatch.model,
					timeoutMs: NODE_TIMEOUT_MS,
					signal,
					// Depth 1: a worker cannot start its own orchestration, and it
					// inherits no session context pack. It DOES inherit the writer
					// token, so a subagent it delegates to re-enters this lock rather
					// than deadlocking against the parent that is awaiting it.
					env: { PI_AGENDA_WORKER: "1", ...lock.childEnv },
				});
				tokens += result.tokens;
				cost += result.usage.cost;

				if (result.timedOut) return { ok: false, error: "worker timed out" };
				if (result.exitCode !== 0) {
					return { ok: false, error: `worker exited ${result.exitCode}: ${result.stderr.slice(-200)}` };
				}
				// An exit-0 worker that said NOTHING is a failure, not an empty
				// success — "n/m succeeded with m=0" reported as success is the
				// failure mode this whole design is trying to avoid.
				if (!result.text.trim()) return { ok: false, error: "worker produced no output" };
				return { ok: true, text: result.text };
			});

			if (!outcome.ok) return { ok: false, value: null, tokens, cost, error: outcome.error };

			// Same class, writer edition: exit 0, confident summary, untouched
			// tree. See harness/verify.ts. Checked AFTER the schema loop so a
			// reader's retry cannot be mistaken for a writer's no-op.
			if (writerCapable && writerMadeNoChange(before, await stamp(cwd))) {
				return { ok: false, value: null, tokens, cost, error: NO_CHANGE_ERROR };
			}
			return { ok: true, value: outcome.value, tokens, cost };
		} finally {
			lock.release();
		}
	};
}
