/**
 * The conductor's `consolidate` stage — memory formation into the Hive
 * knowledge brain (HIV-1194 memory lifecycle).
 *
 * This is the integration point the conductor deliberately left open at
 * `done`: after verify, and only for complex tasks (nothing simple ever
 * enters the lifecycle), the session gets ONE injection asking the model to
 * extract durable learnings and write them as memory/ documents via
 * `knowledge_write`. Extraction happens HERE, agent-side, by design: session
 * transcripts are user-key encrypted at rest (HIV-1227), so no server-side
 * job can ever read them — only the session itself holds its own context.
 *
 * The stage follows the conductor's contract: `decide()` is a synchronous
 * fold, the Hive reachability probe and the stage commit live in the
 * PolicyWork, and the injection is charged to the shared ledger (cap 1).
 * Hive unreachable → skip straight to done; the daily introspection pass is
 * the offline safety net.
 */

import { atCap, record } from "./ledger.ts";
import { hiveBaseURL } from "../hive-common/identity.ts";
import type { PolicyContext, PolicyWork } from "./policy.ts";
import { createConductor, withStage, type ConductorItem } from "./conductor-state.ts";
import type { ConductorHooks } from "./conductor.ts";

export const CONSOLIDATE_LEDGER_ID = "conductor:consolidate";

const PROBE_TIMEOUT_MS = 2_000;

export const CONSOLIDATE_INJECTION = [
	"Conductor: the task is complete — one last step: consolidate what this session learned.",
	"Identify the durable, non-derivable learnings (usually 0–2: a gotcha, a decision and its why,",
	"a fact about a system's behavior — NOT code structure, git history, or anything re-derivable",
	"from the repo). For each: first search existing memories (knowledge_search, a few terms from",
	"the fact), then knowledge_write to the `knowledge-base` collection — APPEND a dated observation",
	"to the matching memory/<domain>/<slug>.md if one exists, otherwise CREATE it (one fact per",
	"file, domain = repo or topic, e.g. memory/aurora/celery-retry-backoff.md). Always pass your",
	"session id as `session` so the observation counts toward the memory's strength.",
	"If nothing durable was learned, say so and finish — zero writes is a fine outcome.",
].join(" ");

/**
 * True only on a confirmed 2xx from the configured Hive's readyz — the same
 * probe discipline the knowledge tools use: no Hive configured (HIV-1853),
 * any error, non-2xx, or timeout is "unreachable" and the stage skips itself.
 * The AbortSignal timeout is the hard cap.
 */
async function hiveReachable(): Promise<boolean> {
	const base = hiveBaseURL();
	if (!base) return false;
	try {
		const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Fresh-or-current item, mirroring conductor.ts's local helper. */
function itemFor(hooks: ConductorHooks, now: number): ConductorItem {
	return hooks.current() ?? createConductor(`conductor-${now.toString(36)}`, now);
}

/**
 * The consolidate-stage fold. First settle in the stage: probe Hive inside
 * the work — reachable injects the consolidation ask (charged, cap 1),
 * unreachable closes out as a skip. Any later settle (nudge already spent —
 * the model had its turn to write memories) advances silently to done.
 */
export function decideConsolidate(
	hooks: ConductorHooks,
	context: PolicyContext,
	probe: () => Promise<boolean> = hiveReachable,
): PolicyWork | null {
	if (atCap(context.ledger, CONSOLIDATE_LEDGER_ID, 1)) {
		return {
			name: "conductor",
			status: "",
			run: async () => {
				const now = Date.now();
				hooks.commit(withStage(itemFor(hooks, now), "done", now));
				return { metric: { outcome: "pass" as const, value: 0 } };
			},
		};
	}
	return {
		name: "conductor",
		status: "conductor: consolidating learnings",
		run: async () => {
			const now = Date.now();
			if (!(await probe())) {
				hooks.commit(withStage(itemFor(hooks, now), "done", now));
				return { metric: { outcome: "skip" as const, value: 0 } };
			}
			hooks.commit(withStage(itemFor(hooks, now), "consolidate", now));
			return {
				metric: { outcome: "pass" as const, value: 0 },
				inject: CONSOLIDATE_INJECTION,
				ledger: (state) => record(state, CONSOLIDATE_LEDGER_ID),
			};
		},
	};
}
