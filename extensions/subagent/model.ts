/**
 * Which model a delegated worker runs on — and what to do when that model
 * cannot run here.
 *
 * Kept pure so it is tested without a worker: the tool tests that reach
 * `runSingleAgent` spawn a real pi child.
 *
 * ## The two failures this exists for, measured in the seven days to 2026-09-10
 *
 * 1. The delegation default is a model this machine has no credential for.
 *    `subagent` resolved `role.model ?? PI_SUBAGENT_MODEL ?? settings` and
 *    spawned blind; the worker died on `No API key found for xai.` while
 *    `readiness` reported OpenRouter ready with $34 — because readiness reports
 *    the SESSION's provider and the worker was on another. Eight papercuts from
 *    one developer in one day, every one saying "the tool offered no
 *    model-selection parameter". HIV-2474 names the class.
 *
 * 2. The default's account is throttled or drained. `429 {"code":"1302",
 *    "message":"Rate limit reached for requests"}` killed whole read-only
 *    fan-outs 0/4 after each worker had already spent pi's retry budget on the
 *    same account: 39 papercuts, both developers, "no way to choose a different
 *    model" five times verbatim. The guidance text already said "re-run with a
 *    role/model on another account" — this module is that sentence, executed.
 *
 * ## The rule
 *
 * The caller's explicit `model` wins, and is refused (before any spawn) when it
 * is not configured here — an override is a decision, not a hint. Otherwise the
 * role's own pin, then the fleet's stamp (`PI_SUBAGENT_MODEL`), then the
 * workstation default. When THAT is not configured, the fallback is the LOWEST
 * configured class in the server's mode catalog — the delegation lane is the
 * cheap lane, and quietly promoting a worker to the session's model would
 * defeat the tier design — and only then the session's own model. Every
 * fallback carries a `note` the tool prints with the result, because a worker
 * that silently ran on a different account is the harder-to-diagnose defect.
 */

export interface CatalogMode {
	key?: string;
	/** `provider/id`, highest class first in catalog order. */
	model: string;
}

/**
 * `true`/`false` from a registry that knows; `null` when there is no registry
 * to ask (a headless caller), which must never be read as "not configured".
 */
export type ConfiguredCheck = (spec: string) => boolean | null;

export interface WorkerModelEnv {
	isConfigured: ConfiguredCheck;
	/** The session's own `provider/id`, always configured by definition. */
	sessionModel?: string;
	/**
	 * The server's mode catalog, fetched LAZILY: the happy path — a configured
	 * default — never pays for it (measured 89.9s cold against production).
	 */
	catalog: () => Promise<readonly CatalogMode[]>;
}

export interface WorkerModelChoice {
	/** The spec to spawn with; undefined lets pi pick its own default. */
	spec?: string;
	/** Set when `spec` is not the model the caller would have expected. */
	note?: string;
	/** Set when nothing may be spawned; the reason, addressed to the caller. */
	refusal?: string;
}

/** The bare id, provider stripped — `openrouter/openai/x` and `openai-codex/x` are one model. */
export function modelID(spec: string): string {
	const parts = spec.split("/");
	return parts[parts.length - 1] ?? spec;
}

/** The first segment: pi's provider key. */
export function providerOf(spec: string): string {
	const at = spec.indexOf("/");
	return at > 0 ? spec.slice(0, at) : spec;
}

function sameModel(a: string, b: string): boolean {
	return a === b || modelID(a) === modelID(b);
}

/**
 * The configured catalog modes, CHEAPEST FIRST, that are not `exclude`'s model
 * and — when `avoidProvider` is set — not on that provider either. The catalog
 * is ranked highest class first, so cheapest-first is the reverse.
 */
function configuredFallbacks(
	catalog: readonly CatalogMode[],
	isConfigured: ConfiguredCheck,
	exclude: string | undefined,
	avoidProvider: string | undefined,
): string[] {
	const out: string[] = [];
	for (let i = catalog.length - 1; i >= 0; i--) {
		const spec = catalog[i]?.model;
		if (typeof spec !== "string" || !spec.includes("/")) continue;
		if (exclude && sameModel(spec, exclude)) continue;
		if (avoidProvider && providerOf(spec) === avoidProvider) continue;
		if (isConfigured(spec) !== true) continue;
		if (!out.includes(spec)) out.push(spec);
	}
	return out;
}

/**
 * The model a worker spawns with, decided BEFORE the spawn.
 *
 * `preferred` is what the old code would have used (`role.model ??
 * getSubagentDefaultModel()`); `requested` is the caller's explicit override.
 */
export async function chooseWorkerModel(
	opts: { requested?: string; preferred?: string; roleName: string },
	env: WorkerModelEnv | undefined,
): Promise<WorkerModelChoice> {
	const requested = opts.requested?.trim();
	if (requested) {
		if (env && env.isConfigured(requested) === false) {
			return {
				refusal:
					`model ${requested} is not configured on this machine (no credential for provider ` +
					`"${providerOf(requested)}"), so no worker was started. Drop \`model\` to use the delegation ` +
					`default, or name a model this session can run.`,
			};
		}
		return { spec: requested };
	}

	const preferred = opts.preferred?.trim() || undefined;
	if (!preferred || !env) return { spec: preferred };
	if (env.isConfigured(preferred) !== false) return { spec: preferred };

	// The default cannot run here. Same shape as pickConfiguredAdvisor: prefer
	// what the catalog ranks, then the session's own model, and say so.
	const why =
		`the delegation default ${preferred} is not configured on this machine ` +
		`(no credential for provider "${providerOf(preferred)}")`;
	const remedy =
		"Point PI_SUBAGENT_MODEL (or subagentDefaultModel in ~/.pi/agent/settings.json) at a model this " +
		"machine can run, or pass `model` per call.";
	const catalog = await safeCatalog(env);
	const [fallback] = configuredFallbacks(catalog, env.isConfigured, preferred, undefined);
	if (fallback) {
		return {
			spec: fallback,
			note: `role "${opts.roleName}" ran on ${fallback}, the cheapest configured fleet mode: ${why}. ${remedy}`,
		};
	}
	if (env.sessionModel && env.isConfigured(env.sessionModel) !== false) {
		return {
			spec: env.sessionModel,
			note:
				`role "${opts.roleName}" ran on ${env.sessionModel} — THIS SESSION'S model, not the cheap delegation ` +
				`lane: ${why}, and no fleet mode is configured here either. ${remedy}`,
		};
	}
	return {
		refusal: `${why}, and nothing else is configured to fall back to; no worker was started. ${remedy}`,
	};
}

/**
 * A rate limit, anchored the way `quota.ts` anchors its patterns: on the status
 * code or the two-word phrase, never on a bare "limit", which every quota,
 * budget and context message also contains.
 */
export const RATE_LIMITED = /\b429\b|\brate.?limit/i;

/**
 * Whether a failed worker's error is the kind another ACCOUNT would clear.
 *
 * A throttle (429) and an exhausted allowance are opposites for "should I
 * wait", and identical for "should I try a different account": both are a
 * property of the account the worker ran on, not of the task. Anything else —
 * a crash, a timeout, a bad prompt — would fail the same way anywhere.
 */
export function isAccountRefusal(errorMessage: string | undefined, isQuotaExhausted: (text: string) => boolean): boolean {
	if (!errorMessage) return false;
	return isQuotaExhausted(errorMessage) || RATE_LIMITED.test(errorMessage);
}

/**
 * A configured model on a DIFFERENT provider than the one that refused —
 * cheapest catalog mode first, then the session's model — or undefined when
 * there is nothing to switch to. Same provider is excluded on purpose: a
 * throttled provider key is throttled for every model behind it.
 */
export async function pickAlternateAccount(
	refusedModel: string | undefined,
	env: WorkerModelEnv | undefined,
): Promise<string | undefined> {
	if (!env) return undefined;
	const avoid = refusedModel ? providerOf(refusedModel) : undefined;
	const catalog = await safeCatalog(env);
	const [fallback] = configuredFallbacks(catalog, env.isConfigured, refusedModel, avoid);
	if (fallback) return fallback;
	const session = env.sessionModel;
	if (!session || env.isConfigured(session) === false) return undefined;
	if (refusedModel && (sameModel(session, refusedModel) || providerOf(session) === avoid)) return undefined;
	return session;
}

async function safeCatalog(env: WorkerModelEnv): Promise<readonly CatalogMode[]> {
	try {
		return await env.catalog();
	} catch {
		return [];
	}
}

/**
 * Whether a worker's final message is intent rather than a result.
 *
 * The measured shape: a worker exits 0 after "Now updating Agents.tsx to pass
 * the renamed params:" or "Checking the registry defaults for the two gates…"
 * — a sentence announcing work, with no work after it. The model ended its
 * turn without a tool call, so pi's `-p` mode ended the run, and the caller
 * received `done (exit 0)` with a mid-sentence handoff and no deliverable.
 * Three delegations in three days, two of them writers whose only trace was
 * unfinished scratch files.
 *
 * Conservative on purpose: SHORT and shaped like an announcement. A long
 * message that happens to end in a colon is an answer with a trailing list.
 */
export const MID_WORK_MAX_CHARS = 240;
const INTENT_LEAD = /^(now|next|let me|let's|i'll|i will|i am going to|i'm going to|checking|looking|running|updating|writing|reading|starting|first,?)\b/i;

export function stoppedMidWork(finalText: string): boolean {
	const text = finalText.trim();
	if (!text || text.length > MID_WORK_MAX_CHARS) return false;
	if (/[:…]$/.test(text) || text.endsWith("...")) return true;
	return INTENT_LEAD.test(text) && text.split(/\s+/).length <= 20;
}

/** The task a second worker gets when the first one stopped mid-work. */
export function continuationTask(task: string, lastText: string): string {
	return (
		`${task}\n\n` +
		"A previous attempt at this task ended WITHOUT delivering a result. Its last message was:\n" +
		`"${lastText.trim().slice(0, MID_WORK_MAX_CHARS)}"\n` +
		"That is an announcement of work, not the work. Do the task and end with the actual result — " +
		"findings, an answer, or an explicit statement that there is nothing to report."
	);
}
