/**
 * brief — which model compiles the brief.
 *
 * The fleet decides, not this file. Hive's agent-mode catalog is the same
 * document the Build workspace's selector shows and the same one the advisor
 * climbs; taking the cheap end of it means the brief follows a fleet retune on
 * the next catalog refresh with no client deploy. Today that resolves to
 * `openai-codex/gpt-5.6-luna`, but nothing here knows that.
 *
 * THE CHAIN, AND WHY IT ENDS WHERE IT DOES:
 *
 *   PI_BRIEF_MODEL  →  the catalog's delegation mode  →  the role's own pin  →  NOTHING
 *
 * The tail is the important part. When no cheap model is resolvable, the brief
 * does NOT run. Falling through to the session's own model would put a frontier
 * model on a search-and-summarise job in order to save that same model some
 * searching — spending more than the feature can ever return, silently, on
 * exactly the machines whose configuration is broken. A missing brief costs a
 * few turns; an expensive one costs money and hides the misconfiguration.
 */

import { resolveAuth } from "../hive-common/identity.ts";
import { fetchAgentModeCatalog, type AgentMode } from "../advisor/modes.ts";

export interface BriefModelPick {
	spec: string;
	/** Where it came from, for the log: `override` | `mode:<key>` | `role`. */
	source: string;
}

/**
 * The delegation model in an ordered catalog.
 *
 * `subagent_key` is authoritative when the server publishes it — it is Hive's
 * own statement of "the mode delegations run on" (`AgentModeConfig`). It does
 * not arrive yet (HIV-1799), so the fallback is the LAST entry: the catalog is
 * a ladder ordered highest class first, which is the contract `pickAdvisorModel`
 * already relies on to mean "one step up".
 */
export function pickBriefModel(modes: AgentMode[], subagentKey: string | undefined): BriefModelPick | null {
	const usable = modes.filter((m) => m && typeof m.model === "string" && m.model.includes("/"));
	if (usable.length === 0) return null;

	if (subagentKey) {
		const named = usable.find((m) => m.key === subagentKey);
		if (named) return { spec: named.model, source: `mode:${named.key}` };
	}
	const cheapest = usable[usable.length - 1]!;
	return { spec: cheapest.model, source: `mode:${cheapest.key}` };
}

/**
 * Resolve the briefer's model, or null to stand down.
 *
 * Never throws: this runs on the path that blocks the first turn, and a
 * resolution failure must degrade to "no brief", never to a failed prompt.
 */
export async function resolveBriefModel(override: string | undefined, rolePin: string | undefined): Promise<BriefModelPick | null> {
	if (override) return { spec: override, source: "override" };

	try {
		const auth = resolveAuth();
		if (auth) {
			const catalog = await fetchAgentModeCatalog(auth);
			const pick = catalog ? pickBriefModel(catalog.modes, catalog.subagentKey) : null;
			if (pick) return pick;
		}
	} catch {
		// Unreachable server, expired token, malformed catalog — all the same
		// answer here: fall through to the role's pin.
	}

	return rolePin ? { spec: rolePin, source: "role" } : null;
}
