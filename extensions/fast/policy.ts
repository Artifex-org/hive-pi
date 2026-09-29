/**
 * fast — the decisions, kept pure so they are testable without a provider.
 *
 * "Fast mode" is OpenAI's name (since 2026-07-30) for the priority service
 * tier: `service_tier: "priority"` on a Responses request. It is roughly 1.5×
 * faster on the Codex models and costs 2–2.5× the credits or dollars, so it is
 * OFF unless asked for, and only ever applies to a model on the allowlist.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** The two APIs that accept a service tier. */
export const FAST_APIS = ["openai-responses", "openai-codex-responses"] as const;

/**
 * Models fast mode applies to, as `provider/id`. The catalogs ship more ids
 * than OpenAI offers priority for, and sending the tier to one that does not
 * support it is a failed request rather than a slow one — so this is an
 * allowlist, extendable through the config file's `models`.
 */
export const DEFAULT_FAST_MODELS: readonly string[] = [
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-6-astra",
	"openai-codex/gpt-6-sol",
	"openai-codex/gpt-6-luna",
	"openai/gpt-5.4",
	"openai/gpt-5.5",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai/gpt-6-astra",
	"openai/gpt-6-sol",
	"openai/gpt-6-luna",
];

export interface FastConfig {
	enabled: boolean;
	models: readonly string[];
}

export interface FastModel {
	provider: string;
	id: string;
	api: string;
}

/**
 * Whether this process is a delegated WORKER: a subagent, a briefer, or a
 * one-shot helper (recap, drift check, judge, advisor-watch). Every spawner in
 * this package marks its child with one of these two variables.
 */
export function isWorkerEnv(env: NodeJS.ProcessEnv): boolean {
	return env.PI_AGENDA_WORKER === "1" || env.PI_BRIEF_WORKER === "1";
}

/**
 * Reads the stored config. Opt-in: an absent or non-boolean `enabled` is OFF,
 * because this setting spends money. `HIVE_PI_FAST=1` turns it on for one
 * process without writing anything, which is how a Hive launch asks for it.
 *
 * A WORKER decides by `PI_SUBAGENT_FAST=1` alone. Workers are spawned with the
 * parent's whole environment, so `HIVE_PI_FAST` — the parent's own switch —
 * reaches every child, and the stored `enabled` is the operator's choice for
 * their interactive sessions. Honouring either in a child would make "main
 * session fast, helpers at the default tier" impossible to express, and the
 * reverse ("helpers fast, the main session not") likewise. The allowlist
 * (`models`) still comes from the stored config: it is a fact about models,
 * not a choice about this process.
 */
export function resolveFastConfig(raw: Partial<Record<string, unknown>> | null, env: NodeJS.ProcessEnv): FastConfig {
	const models = Array.isArray(raw?.models)
		? raw.models.filter((m): m is string => typeof m === "string" && m.includes("/"))
		: [];
	// The literal reader form test/settings.test.ts's registry drift guard reads.
	const stored = { enabled: raw?.enabled === true };
	const enabled = isWorkerEnv(env) ? env.PI_SUBAGENT_FAST === "1" : stored.enabled || env.HIVE_PI_FAST === "1";
	return { enabled, models: models.length > 0 ? models : DEFAULT_FAST_MODELS };
}

/**
 * Whether a request is pi's cache warmer rather than a real turn. The warmer
 * re-sends the session's request with `maxTokens: 1` to keep the prompt cache
 * hot; the priority tier would buy nothing for it and still cost 2–2.5×.
 */
export function isCacheWarm(options: { maxTokens?: number } | undefined): boolean {
	return options?.maxTokens === 1;
}

export function modelKey(model: Pick<FastModel, "provider" | "id"> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

/** Whether this request gets the priority tier. */
export function fastApplies(model: FastModel | undefined, config: FastConfig): boolean {
	if (!config.enabled || !model) return false;
	if (!(FAST_APIS as readonly string[]).includes(model.api)) return false;
	return config.models.includes(modelKey(model));
}

export type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;

/**
 * Returns an `onPayload` that adds `service_tier: "priority"` to the request
 * body, after whatever hook was already there.
 *
 * WHY THE PAYLOAD AND NOT THE `serviceTier` OPTION. pi-ai's `streamSimple`
 * (the path pi calls) builds its options through `buildBaseOptions`, which does
 * not carry `serviceTier` — only the lower-level `stream` does, and reaching it
 * means reimplementing pi's option building (context-window clamping included)
 * against a module pi does not alias for extensions. `onPayload` IS carried.
 *
 * This is not the `before_provider_request` event this package bans
 * (test/no-forbidden-events.test.ts): registering that switches on pi's
 * transform path for every request. This touches one top-level field of the
 * allowlisted requests, never the prompt, so the prompt cache is unaffected.
 *
 * Cost accounting: on the API (`openai/*`) the response reports its tier and
 * pi prices it. On Codex (`openai-codex/*`) the response may report `default`
 * even when priority was served (openai/codex#30413), and a subscription is
 * billed in credits, not in the dollars pi estimates.
 */
export function withPriorityTier(previous: PayloadHook | undefined): PayloadHook {
	return async (payload, model) => {
		const replaced = previous ? await previous(payload, model) : undefined;
		const body = replaced === undefined ? payload : replaced;
		if (typeof body !== "object" || body === null || Array.isArray(body)) return replaced;
		return { ...(body as Record<string, unknown>), service_tier: "priority" };
	};
}

export type FastCommand = "on" | "off" | "toggle" | "status";

export function parseFastCommand(args: string): FastCommand | undefined {
	const arg = args.trim().toLowerCase();
	if (arg === "") return "toggle";
	if (arg === "on" || arg === "off" || arg === "status") return arg;
	return undefined;
}
