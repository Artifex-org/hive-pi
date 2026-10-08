/**
 * Which outside model each helper runs on — by catalog key, from Hive's
 * `GET /api/v1/agent-modes`, never a hardcoded provider route.
 *
 * "Configured" means one thing here: the provider has an entry in the LEASED
 * store's `auth.json`. Not an environment API key and not the machine's own
 * `~/.pi/agent` — the launch was assigned exactly the providers it leased, and
 * a helper on anything else would spend an account nobody gave it.
 *
 * The `PI_*_MODEL` overrides keep their pi meaning (an explicit spec wins),
 * though a Hive claude-code launch strips every `PI_` variable, so in
 * production the catalog answers.
 */

import { join } from "node:path";
import { fetchAgentModeOutcome, type AgentMode, type CatalogOutcome } from "../extensions/advisor/modes.ts";
import { cheapLaneMode, providerOf } from "../extensions/subagent/model.ts";
import { type AdapterEnv, hiveAuth } from "./env.ts";
import { readJson } from "./state.ts";

/** Providers the leased store holds a credential for. A missing auth.json is an empty store. */
export function leasedProviders(piAgentDir: string): Set<string> {
	const doc = readJson(join(piAgentDir, "auth.json"));
	if (doc === undefined) return new Set();
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${piAgentDir}/auth.json is not an object`);
	return new Set(Object.keys(doc));
}

export function isConfiguredWith(providers: ReadonlySet<string>): (spec: string) => boolean {
	return (spec) => spec.includes("/") && providers.has(providerOf(spec));
}

export interface ModelPick {
	spec: string;
	/** The catalog mode's thinking level, when the pick came from the catalog. */
	thinking?: string;
	/** `override` or `mode:<key>`. */
	source: string;
}

export type ModelResolution = { ok: true; pick: ModelPick } | { ok: false; reason: string };

/** The catalog, or why there is none (unreachable vs empty vs no auth are different fixes). */
export async function readCatalog(env: AdapterEnv): Promise<CatalogOutcome | { kind: "no-auth" }> {
	const auth = hiveAuth(env);
	if (!auth) return { kind: "no-auth" };
	return fetchAgentModeOutcome(auth);
}

function catalogFailure(outcome: CatalogOutcome | { kind: "no-auth" }): string {
	switch (outcome.kind) {
		case "no-auth":
			return "no Hive auth in this launch (HIVE_URL/HIVE_TOKEN unset), so the mode catalog cannot be read";
		case "unreachable":
			return `could not read the Hive mode catalog (${outcome.detail})`;
		case "empty":
			return "the Hive server has no agent modes configured";
		default:
			return "unexpected catalog state";
	}
}

/**
 * The cheap lane for a helper: `override` when set, else the catalog's `low`
 * mode when its provider is leased, else the cheapest leased mode. A failure
 * is RETURNED with its reason — the caller reports it; nothing here falls back
 * to a default route.
 */
export async function resolveCheapLane(env: AdapterEnv, override: string | undefined, providers: ReadonlySet<string>): Promise<ModelResolution> {
	const explicit = override?.trim();
	if (explicit) return { ok: true, pick: { spec: explicit, source: "override" } };
	const outcome = await readCatalog(env);
	if (outcome.kind !== "ok") return { ok: false, reason: catalogFailure(outcome) };
	const mode = cheapLaneMode<AgentMode>(outcome.catalog.modes, isConfiguredWith(providers));
	if (!mode) {
		const leased = providers.size > 0 ? [...providers].join(", ") : "none";
		return { ok: false, reason: `no Hive catalog mode runs on a leased provider (leased: ${leased})` };
	}
	return { ok: true, pick: { spec: mode.model, ...(mode.thinking ? { thinking: mode.thinking } : {}), source: `mode:${mode.key}` } };
}

/** The goal judge's, drift probe's and recap's evaluator (`PI_AGENDA_EVALUATOR_MODEL` overrides). */
export function resolveEvaluator(env: AdapterEnv, providers: ReadonlySet<string>): Promise<ModelResolution> {
	return resolveCheapLane(env, process.env.PI_AGENDA_EVALUATOR_MODEL, providers);
}

/** You Should Know's scanner (`PI_YOU_SHOULD_KNOW_MODEL` overrides). */
export function resolveYskModel(env: AdapterEnv, providers: ReadonlySet<string>): Promise<ModelResolution> {
	return resolveCheapLane(env, process.env.PI_YOU_SHOULD_KNOW_MODEL, providers);
}
