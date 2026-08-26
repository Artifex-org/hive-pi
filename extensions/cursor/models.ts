/**
 * Cursor's model catalogue (HIV-2086).
 *
 * `GetUsableModels` is a UNARY Connect call and answers plain `application/json`
 * — no framing, no protobuf. It returned **204** entries when this was written,
 * including the 1M-context frontier models the subscription is worth having for:
 * claude-opus-5, claude-sonnet-5, gpt-5.6-sol/luna, composer-2.5, grok-4.6.
 *
 * Two shape facts drive the mapping below:
 *
 *  1. **Effort is baked into the model id**, not passed as a parameter:
 *     `claude-opus-5-low|medium|high|xhigh|max`. So pi's thinking levels map to
 *     SIBLING IDS rather than to a request field — which is why this module
 *     groups the flat list into families before pi ever sees it.
 *  2. **`-fast` variants exist** for most models and are priority-routed by
 *     Cursor. They are exposed as distinct ids rather than a flag, so a caller
 *     can ask for one deliberately.
 */

import { cursorHeaders } from "./transport.ts";

const API = "https://api2.cursor.sh";
const CATALOGUE_PATH = "/agent.v1.AgentService/GetUsableModels";

/** One entry exactly as Cursor reports it. */
export interface CursorModel {
	modelId: string;
	displayModelId?: string;
	displayName?: string;
	displayNameShort?: string;
	aliases?: string[];
	maxMode?: boolean;
}

/**
 * Only Cursor's OWN models are exposed — the Composer and Cursor-Grok families.
 *
 * The catalogue also carries ~190 third-party passthroughs (claude-*, gpt-*,
 * gemini-*), and they are excluded on purpose rather than for tidiness. Cursor
 * bills against TWO separate pools: its own models draw on a large included
 * allowance, while third-party models come out of a much smaller pool "charged
 * at the model's API price". Routing fleet traffic to `cursor/claude-opus-5`
 * would therefore spend metered credit at list price while looking, from
 * hive's side, exactly like the free subscription work it is not — the models
 * are registered at zero cost precisely because the FIRST pool is flat-rate.
 *
 * So the filter is a billing boundary, not a preference. Widening it means
 * revisiting the zero-cost claim in `toPiModels` at the same time.
 */
export function isCursorOwnModel(modelId: string): boolean {
	return /^(composer|cursor-grok)/.test(modelId);
}

/** Effort suffixes Cursor uses, ordered weakest to strongest. */
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "extra-high", "max"] as const;

/**
 * Split a model id into its family and effort.
 *
 * `claude-opus-5-thinking-xhigh` → family `claude-opus-5-thinking`, effort `xhigh`.
 * A model with no recognised suffix is its own family with no effort, which is
 * correct for ids like `composer-2.5` and `default`.
 */
export function splitEffort(modelId: string): { family: string; effort: string | null } {
	// Longest suffix first: `extra-high` must win over `high`, or every
	// `-extra-high` id is mis-parsed as family `…-extra` at effort `high`.
	const ordered = [...EFFORTS].sort((a, b) => b.length - a.length);
	for (const effort of ordered) {
		const suffix = `-${effort}`;
		if (modelId.endsWith(suffix)) {
			return { family: modelId.slice(0, -suffix.length), effort };
		}
	}
	return { family: modelId, effort: null };
}

/** Fetch the live catalogue. Throws with the server's own text on failure. */
export async function fetchModels(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CursorModel[]> {
	const res = await fetchImpl(`${API}${CATALOGUE_PATH}`, {
		method: "POST",
		headers: {
			...cursorHeaders(accessToken),
			"content-type": "application/json",
			"connect-protocol-version": "1",
		},
		body: JSON.stringify({ customModelIds: [] }),
	});
	if (!res.ok) {
		throw new Error(`Cursor model catalogue failed: HTTP ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { models?: CursorModel[] };
	return body.models ?? [];
}

/**
 * Context windows, by family prefix.
 *
 * Cursor does NOT report a context window in the catalogue — the only place a
 * real number appeared was a live turn's `tokenDetails.maxTokens` (200000 for
 * composer-2.5). So these are declared from the models' published windows and
 * the "1M" in Cursor's own display names, and are deliberately CONSERVATIVE:
 * pi uses this to decide when to compact, and over-declaring means a request
 * rejected by the server instead of a compaction that would have saved it.
 */
// Only Cursor's own families appear here, matching isCursorOwnModel: entries
// for the third-party passthroughs would be unreachable, and an unreachable
// table entry is how a filter silently widens later without anyone noticing.
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
	// Measured, not assumed: a live composer-2.5 turn reported
	// tokenDetails.maxTokens = 200000.
	[/^composer/, 200_000],
	[/^cursor-grok/, 256_000],
];

export function contextWindowFor(modelId: string): number {
	for (const [pattern, size] of CONTEXT_WINDOWS) {
		if (pattern.test(modelId)) return size;
	}
	// Unknown model: assume the smallest window any current Cursor model has, so
	// pi compacts early rather than sending a request that will be refused.
	return 128_000;
}

/**
 * Map Cursor's flat list onto pi model configs.
 *
 * `maxTokens` (output cap) is not reported either; 64k is the largest value
 * shared by the current frontier models and is applied uniformly rather than
 * guessed per family, because an over-large output cap fails the request while
 * an under-large one merely truncates a rare very long answer.
 */
export interface PiModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export function toPiModels(models: CursorModel[]): PiModelConfig[] {
	return models
		// `default`/`auto` is Cursor picking for us. It is excluded deliberately:
		// an eval or A/B arm labelled `cursor/default` would record a score
		// against a model that changed under it, which is unattributable.
		.filter((m) => m.modelId && m.modelId !== "default")
		.filter((m) => isCursorOwnModel(m.modelId))
		.map((m) => ({
			id: m.modelId,
			name: m.displayName || m.modelId,
			// Every current Cursor model is a reasoning model; the ones that are
			// not simply ignore the level.
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			// COST IS ZERO AT THE MARGIN, and that is a fact rather than a
			// placeholder: these tokens are covered by a flat-rate subscription.
			// Reporting a per-token price would make hive's ranking treat a
			// subscription model as though it spent metered credit, and the
			// registry's quota reading — not a token price — is what bounds it.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: contextWindowFor(m.modelId),
			maxTokens: 64_000,
		}));
}
