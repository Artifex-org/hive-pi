/**
 * advisor — which model to consult.
 *
 * The class ladder is the Hive server's agent-mode catalog (GET /agent-modes,
 * the same list the Build workspace's mode selector shows). Its ORDER is the
 * ranking: first entry is the highest class. That keeps "one class above me" a
 * server-side fact — when the fleet's models change, the advisor follows on
 * the next catalog refresh with no client deploy.
 */

import { request, type HiveAuth } from "../hive-common/http.ts";

export interface AgentMode {
	key: string;
	label?: string;
	/** `provider/id`, the same spec shape set_mode delivers. */
	model: string;
	thinking?: string;
}

export interface AdvisorPick {
	spec: string;
	modeKey: string;
	thinking?: string;
}

/**
 * pickAdvisorModel resolves "the class above the session's current model".
 *
 * - current found at index i → modes[max(0, i-1)] — one step up the ladder.
 * - current already the top → the top itself. A fresh, independent context on
 *   the same class is most of an advisor's value, so this is a feature, not a
 *   degenerate case.
 * - current not in the catalog at all (custom model, override, drift) → the
 *   top. When we cannot rank the caller, the strongest reviewer is the only
 *   answer that is never worse than intended.
 * - empty catalog → null; the caller decides how to fail.
 */
export function pickAdvisorModel(modes: AgentMode[], currentSpec: string): AdvisorPick | null {
	const usable = modes.filter((m) => m && typeof m.model === "string" && m.model.includes("/"));
	if (usable.length === 0) return null;
	let idx = usable.findIndex((m) => m.model === currentSpec);
	// Fall back to matching on the model ID alone. The same model is reachable
	// through more than one provider — `openrouter/openai/gpt-5.6-luna` and
	// `openai-codex/gpt-5.6-luna` are one model, and the catalog carries only
	// one of the two specs. An exact provider-qualified compare therefore reads
	// "not in the catalog" for a model that is very much in it, and the caller
	// silently gets the unranked-model answer (the top) instead of its actual
	// class. Measured: a session on openrouter's copy of the LOW tier was
	// treated as unrankable.
	if (idx < 0) idx = usable.findIndex((m) => modelID(m.model) === modelID(currentSpec));
	const target = usable[idx <= 0 ? 0 : idx - 1];
	return { spec: target.model, modeKey: target.key, thinking: target.thinking };
}

/**
 * The bare model id, with any provider prefix stripped.
 *
 * Specs are `provider/id`, but a provider may itself be path-shaped
 * (`openrouter/openai/gpt-5.6-luna`), so the id is everything after the FIRST
 * segment — and for a routed spec that still leaves a vendor segment, after the
 * last one. Taking the final segment is what makes the two spellings of one
 * model compare equal.
 */
function modelID(spec: string): string {
	const parts = spec.split("/");
	return parts[parts.length - 1] ?? spec;
}

interface ModeCatalog {
	version?: string;
	modes?: AgentMode[];
	/**
	 * The mode the fleet runs DELEGATIONS on, when the server publishes it.
	 *
	 * Hive's `AgentModeConfig` carries `subagent_key` (and `launch_key`,
	 * `chat_key`) as the one place a delegation's model is spelled, but its GET
	 * handler currently reconstructs the document from `Version` and `Modes`
	 * only, so the field arrives undefined — see HIV-1799. Parsed anyway: the
	 * moment the server stops dropping it, every consumer here follows with no
	 * client deploy, which is the same property that makes the ladder work.
	 */
	subagent_key?: string;
}

export interface ModeCatalogResult {
	modes: AgentMode[];
	/** `subagent_key` when the server published one; undefined until it does. */
	subagentKey: string | undefined;
}

/** The catalog is boot-time env config on the server — it changes on deploys,
 *  not per call. Five minutes keeps a long session honest without a request
 *  per consultation. */
const CATALOG_TTL_MS = 5 * 60_000;

let cached: { catalog: ModeCatalogResult; at: number } | null = null;

/** Test hook: the module cache would otherwise leak state between tests. */
export function resetModeCatalogCache(): void {
	cached = null;
}

/**
 * CATALOG_TIMEOUT_MS is what this one call gets, overriding the 5s every other
 * Hive call uses.
 *
 * /agent-modes is not the config read its name suggests: the server enriches it
 * with fallback chains derived from a 30-day aggregate over the factory corpus.
 * Measured against production on 2026-08-18: 89.9s cold, 0.10s warm. Five seconds meant the advisor failed on the first call after
 * any hive-server restart or cache expiry. The server side of that is being
 * fixed too — the enrichment moves off the request path — but a client that
 * fails at 5s is fragile against any slow moment on the tailnet, and this call
 * happens once, at the moment a human is already waiting for a review.
 */
const CATALOG_TIMEOUT_MS = 20_000;

/**
 * CatalogOutcome distinguishes the three ways there can be no ladder, because
 * they need three different actions from whoever reads the error.
 *
 * This existed as `null` for all three, and the cost was concrete: a five-second
 * TIMEOUT surfaced to an agent as "the Hive server has no agent modes
 * configured", which is a claim about server configuration that was false. The
 * session recorded a papercut against the wrong component, and diagnosing it
 * took a walk through the server env, the token, the sandbox network and the
 * installed build — none of which were at fault.
 */
export type CatalogOutcome =
	| { kind: "ok"; catalog: ModeCatalogResult }
	/** The server answered, and genuinely has no modes configured. */
	| { kind: "empty" }
	/** The request did not complete: timeout, refusal, transport. */
	| { kind: "unreachable"; detail: string };

/**
 * fetchAgentModes returns the server's mode catalog, or null when the server
 * is unreachable, refuses, or has no modes configured. Null is a real answer —
 * the caller falls through to its explicit-config path and, absent that, a
 * clear error. Never a silent guess.
 *
 * Callers that report a failure to a human should prefer fetchAgentModeOutcome,
 * which says WHICH of those three happened.
 */
export async function fetchAgentModes(auth: HiveAuth, nowMs: number = Date.now()): Promise<AgentMode[] | null> {
	return (await fetchAgentModeCatalog(auth, nowMs))?.modes ?? null;
}

/** The whole catalog, for callers that need more than the ladder. */
export async function fetchAgentModeCatalog(auth: HiveAuth, nowMs: number = Date.now()): Promise<ModeCatalogResult | null> {
	const outcome = await fetchAgentModeOutcome(auth, nowMs);
	return outcome.kind === "ok" ? outcome.catalog : null;
}

/** The catalog, or the reason there isn't one. */
export async function fetchAgentModeOutcome(auth: HiveAuth, nowMs: number = Date.now()): Promise<CatalogOutcome> {
	if (cached && nowMs - cached.at < CATALOG_TTL_MS) return { kind: "ok", catalog: cached.catalog };
	const res = await request<ModeCatalog>(auth, "GET", "/agent-modes", undefined, CATALOG_TIMEOUT_MS);
	if (!res.ok) {
		// `error` is already redacted by the http layer — a name and a short
		// generic message, never a URL that could carry a token.
		const status = res.status === null ? "no response" : `HTTP ${res.status}`;
		return { kind: "unreachable", detail: res.error ? `${status}: ${res.error}` : status };
	}
	if (!Array.isArray(res.body?.modes) || res.body.modes.length === 0) return { kind: "empty" };
	cached = { catalog: { modes: res.body.modes, subagentKey: nonEmpty(res.body.subagent_key) }, at: nowMs };
	return { kind: "ok", catalog: cached.catalog };
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** The prefix every advisor-unavailable message shares. */
export const NO_ADVISOR = "no advisor model resolvable";

/**
 * advisorFailureMessage turns a failed resolution into the sentence a human
 * reads — kept here, and pure, because that sentence is the artifact that was
 * actually wrong. It named a cause ("the Hive server has no agent modes
 * configured") that the code had not established and that was false in the case
 * that produced it. Every branch below states only what its input proves, and
 * ends with the action that branch calls for.
 */
export function advisorFailureMessage(outcome: CatalogOutcome | "no-auth" | "no-usable-model"): string {
	if (outcome === "no-auth") {
		return `${NO_ADVISOR}: no Hive auth on this machine (run /hive-login) — or set PI_ADVISOR_MODEL`;
	}
	if (outcome === "no-usable-model") {
		return `${NO_ADVISOR}: the Hive mode catalog has no usable model — set PI_ADVISOR_MODEL`;
	}
	switch (outcome.kind) {
		case "unreachable":
			// A REACHABILITY failure, named as one. Retry is the right first
			// action here and is wrong for every other branch.
			return `${NO_ADVISOR}: could not read the Hive mode catalog (${outcome.detail}) — retry, or set PI_ADVISOR_MODEL`;
		case "empty":
			// The only branch that is genuinely about server configuration.
			return `${NO_ADVISOR}: the Hive server has no agent modes configured — set PI_ADVISOR_MODEL`;
		default:
			return `${NO_ADVISOR}: unexpected catalog state — set PI_ADVISOR_MODEL`;
	}
}
