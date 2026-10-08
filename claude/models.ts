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
import { CATALOG_TTL_MS, fetchAgentModeOutcome, type AgentMode, type CatalogOutcome } from "../extensions/advisor/modes.ts";
import { cheapLaneMode, providerOf } from "../extensions/subagent/model.ts";
import { type AdapterEnv, hiveAuth, stateDir } from "./env.ts";
import { readJson, writeJsonAtomic } from "./state.ts";

const CATALOG_FILE = "catalog.json";

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

/**
 * The catalog, or why there is none (unreachable vs empty vs no auth are
 * different fixes).
 *
 * Cached ON DISK in the state dir for the catalog's own TTL: every hook is a
 * fresh process, so modes.ts's in-memory cache never survives a settle — and
 * a cold `/agent-modes` has been measured at 90 s, which a Stop hook with a
 * 110 s budget cannot afford on every settle. A cache from another Hive URL
 * is ignored; a failed read is never cached.
 */
export async function readCatalog(env: AdapterEnv, now: number = Date.now()): Promise<CatalogOutcome | { kind: "no-auth" }> {
	const auth = hiveAuth(env);
	if (!auth) return { kind: "no-auth" };
	const dir = stateDir(env);
	const path = dir ? join(dir, CATALOG_FILE) : null;
	if (path) {
		const cached = readJson(path) as { at?: unknown; url?: unknown; modes?: unknown; subagentKey?: unknown } | undefined;
		if (
			cached &&
			cached.url === auth.url &&
			typeof cached.at === "number" &&
			now - cached.at >= 0 &&
			now - cached.at < CATALOG_TTL_MS &&
			Array.isArray(cached.modes) &&
			cached.modes.length > 0 &&
			cached.modes.every((m) => m && typeof (m as AgentMode).key === "string" && typeof (m as AgentMode).model === "string")
		) {
			return { kind: "ok", catalog: { modes: cached.modes as AgentMode[], subagentKey: typeof cached.subagentKey === "string" ? cached.subagentKey : undefined } };
		}
	}
	const outcome = await fetchAgentModeOutcome(auth, now);
	if (outcome.kind === "ok" && path) {
		writeJsonAtomic(path, { at: now, url: auth.url, modes: outcome.catalog.modes, subagentKey: outcome.catalog.subagentKey ?? null });
	}
	return outcome;
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
/**
 * The leased providers, read when first needed. A malformed lease is an
 * answer (`ok: false`) for the model-backed caller that asked, never an
 * exception that takes the whole command — and the model-free features with
 * it — down.
 */
export type LeaseRead = () => ReadonlySet<string>;

export function lazyLease(piAgentDir: string | undefined): LeaseRead {
	let read: ReadonlySet<string> | undefined;
	return () => (read ??= piAgentDir ? leasedProviders(piAgentDir) : new Set<string>());
}

export async function resolveCheapLane(env: AdapterEnv, override: string | undefined, lease: LeaseRead): Promise<ModelResolution> {
	const explicit = override?.trim();
	if (explicit) return { ok: true, pick: { spec: explicit, source: "override" } };
	let providers: ReadonlySet<string>;
	try {
		providers = lease();
	} catch (error) {
		return { ok: false, reason: `the leased credential store is unreadable: ${(error as Error).message}` };
	}
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
export function resolveEvaluator(env: AdapterEnv, lease: LeaseRead): Promise<ModelResolution> {
	return resolveCheapLane(env, process.env.PI_AGENDA_EVALUATOR_MODEL, lease);
}

/** You Should Know's scanner (`PI_YOU_SHOULD_KNOW_MODEL` overrides). */
export function resolveYskModel(env: AdapterEnv, lease: LeaseRead): Promise<ModelResolution> {
	return resolveCheapLane(env, process.env.PI_YOU_SHOULD_KNOW_MODEL, lease);
}
