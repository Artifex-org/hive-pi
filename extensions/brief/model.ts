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
import type { HiveAuth } from "../hive-common/http.ts";
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
export function pickBriefModel(
	modes: AgentMode[],
	subagentKey: string | undefined,
	isConfigured?: (spec: string) => boolean,
): BriefModelPick | null {
	// A host that knows which providers it holds credentials for (the Claude
	// adapter's leased store) narrows the ladder to them first; a pick it
	// cannot run is not a pick. Absent, every catalog mode is a candidate, as
	// before.
	const usable = modes.filter(
		(m) => m && typeof m.model === "string" && m.model.includes("/") && (!isConfigured || isConfigured(m.model)),
	);
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
export interface BriefModelHost {
	/** The Hive auth for the catalog read. Absent resolves this machine's (`resolveAuth`). */
	auth?: HiveAuth | null;
	/** Restricts the catalog to models this host can run. */
	isConfigured?(spec: string): boolean;
}

export async function resolveBriefModel(
	override: string | undefined,
	rolePin: string | undefined,
	host: BriefModelHost = {},
): Promise<BriefModelPick | null> {
	if (override) return { spec: override, source: "override" };

	try {
		const auth = host.auth === undefined ? resolveAuth() : host.auth;
		if (auth) {
			const catalog = await fetchAgentModeCatalog(auth);
			const pick = catalog ? pickBriefModel(catalog.modes, catalog.subagentKey, host.isConfigured) : null;
			if (pick) return pick;
		}
	} catch {
		// Unreachable server, expired token, malformed catalog — all the same
		// answer here: fall through to the role's pin.
	}

	// A host that knows what it can run checks the pin too: a role pinned to a
	// provider this host holds no credential for is not a fallback, it is a
	// worker that dies on its first request.
	if (!rolePin || (host.isConfigured && !host.isConfigured(rolePin))) return null;
	return { spec: rolePin, source: "role" };
}
