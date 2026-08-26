/**
 * compaction — pure logic for Codex-style server-side compaction.
 *
 * The technique, reimplemented from `algal/pi-openai-server-compaction` (which
 * pins pi `>=0.80.9 <0.81.0` and cannot be installed on 0.84.1): at a
 * compaction boundary, send the conversation plus a trailing
 * `compaction_trigger` through `POST /v1/responses` and keep the opaque
 * `compaction` item the endpoint returns, ALONGSIDE pi's own portable text
 * summary. Two artifacts, not one — the opaque blob is higher-fidelity for a
 * compatible next turn, and the text summary is what keeps forks, exports, tree
 * navigation and non-OpenAI models working. Dropping either is the mistake.
 *
 * WHAT THE PUBLISHED NUMBERS ACTUALLY SAY, since "78% vs 48% recall" invites a
 * wrong conclusion: that win came with **4.58x the compaction output tokens**
 * and a **29% larger billed downstream context**, and the author states plainly
 * it is not evidence of being better at the same budget — the gains
 * concentrated in large artifacts while three small ones scored about as poorly
 * as pi's default. Treat it as "sometimes allocates far more context, usefully",
 * which is a cost/quality trade, not an upgrade.
 *
 * This module is pure on purpose: everything except the socket is testable, and
 * the socket is the one part that cannot be exercised without sending real
 * conversation data to OpenAI.
 */

/**
 * WHY THIS BUILD CANNOT DELIVER THE FEATURE — stated once, so the status
 * command and the compaction path cannot drift apart, and so nobody has to
 * discover it by enabling the setting and waiting.
 *
 * Found by the adversarial review of PR #167 (HIV-1884). TWO structural gaps,
 * neither of them fixable inside this extension:
 *
 * 1. NOTHING IS EVER SENT. `index.ts` reads the conversation out of
 *    `event.compactionEntry.messages`. pi 0.84.1's `CompactionEntry`
 *    (`core/session-manager.d.ts`) carries `summary`, `firstKeptEntryId`,
 *    `tokensBefore`, `details`, `usage` and `fromHook` — and no `messages` at
 *    all. The array is therefore always empty and the request is never built.
 *
 * 2. NOTHING WOULD BE REPLAYED. Even with the messages in hand, the artifact
 *    this extension stores has no consumer: feeding it to a later turn needs
 *    `before_provider_request`, which `test/no-forbidden-events.test.ts` bans
 *    package-wide as a prompt-cache hazard.
 *
 * Closing (1) on its own would be a REGRESSION dressed as a fix: it would
 * upload the conversation to OpenAI with `store: true` and then discard what
 * came back. Enabling this setting consents to a cost/quality TRADE; the cost
 * without the benefit is not that trade. So the gap is reported loudly and left
 * open, pending a decision that belongs to the operator: complete the feature
 * (which means revisiting the provider-hook ban) or drop it.
 */
export const INERT_REASON =
	"inert in this build: pi's compaction entry carries no messages to send, and the artifact has no replay path (that needs before_provider_request, banned package-wide) — pi's own summary is used";

/**
 * Pull a usable API key out of ONE `auth.json` credential.
 *
 * The shape is pi's, not ours (`@earendil-works/pi-ai` → `Credential`):
 *
 *     { "openai": { "type": "api_key", "key": "sk-…", "env": { … } } }
 *     { "openai-codex": { "type": "oauth", "access": …, "refresh": …  } }
 *
 * The first version of this extension read `credential.apiKey`. No version of
 * pi has ever written that field, so the auth-store fallback could not fire and
 * `/compaction` reported `api key: MISSING — feature inert` for every user
 * whose key lives in auth.json rather than in `$OPENAI_API_KEY`.
 *
 * A stored `key` may be a REFERENCE rather than a literal: a leading `!` means
 * "run the rest as a shell command", `$VAR`/`${VAR}` means "read that env var".
 * pi resolves those with `resolveConfigValue`, which it does not export.
 * Handing an unresolved reference to `fetch` would put someone's 1Password
 * command line into an `Authorization:` header sent to OpenAI, so anything that
 * is not a plain literal is refused rather than guessed at.
 */
export function apiKeyFromCredential(credential: unknown): string | null {
	if (!credential || typeof credential !== "object") return null;
	const { type, key } = credential as { type?: unknown; key?: unknown };
	if (type !== "api_key") return null;
	if (typeof key !== "string" || key.length === 0) return null;
	if (key.startsWith("!") || key.includes("$")) return null;
	return key;
}

/** What this extension can actually do for a given provider. */
export type SupportLevel =
	/** Direct `/v1/responses` call with an API key. The only path we implement. */
	| "direct"
	/**
	 * Subscription OAuth via the built-in Codex transport. The upstream
	 * extension does NOT make its own call here either — it preserves pi's
	 * transport and only injects reconstructed history after a boundary, which
	 * needs provider-request hooks this package bans (`test/no-forbidden-events`
	 * forbids `before_provider_request`). Reported honestly rather than silently
	 * doing nothing.
	 */
	| "codex-unsupported"
	| "unsupported";

export interface ModelRef {
	provider: string;
	id: string;
}

export function supportFor(model: ModelRef | null | undefined, includeAzure: boolean): SupportLevel {
	if (!model) return "unsupported";
	const provider = model.provider.toLowerCase();
	if (provider === "openai") return "direct";
	if (provider === "openai-codex") return "codex-unsupported";
	if (includeAzure && provider.startsWith("azure")) return "direct";
	return "unsupported";
}

/**
 * The one-line explanation the UI shows. Written for someone who enabled the
 * setting and is wondering why nothing happened — which, on this workstation's
 * default `openai-codex` model, is the expected first experience.
 */
export function supportReason(level: SupportLevel): string {
	switch (level) {
		case "direct":
			return "server-side compaction active";
		case "codex-unsupported":
			return "openai-codex uses subscription OAuth and pi's built-in transport; server-side compaction needs a direct openai/* model with an API key";
		case "unsupported":
			return "not an OpenAI model — pi's own summary is used";
	}
}

/** A message as we hand it to the endpoint. Deliberately structural. */
export interface WireMessage {
	role: string;
	content: unknown;
}

export interface CompactionRequestInput {
	model: string;
	messages: readonly WireMessage[];
	systemPrompt?: string;
	tools?: readonly unknown[];
	reasoning?: unknown;
	text?: unknown;
}

export interface CompactionRequestBody {
	model: string;
	input: unknown[];
	store: true;
	instructions?: string;
	tools?: readonly unknown[];
	reasoning?: unknown;
	text?: unknown;
}

/**
 * Build the request body.
 *
 * `store: true` IS THE PRIVACY DECISION and it is not optional — the endpoint
 * needs server-side state to return an artifact that is meaningful later. It is
 * why the whole feature is opt-in and why the settings row carries a warning.
 * Nothing here should ever be reached without an explicit enable.
 *
 * The request deliberately mirrors the shape of the surrounding normal requests
 * (same tools, same reasoning effort, same text config) rather than using
 * endpoint defaults. A compaction produced under a different configuration than
 * the conversation it summarizes is a silent fidelity loss.
 */
export function buildCompactionRequest(input: CompactionRequestInput): CompactionRequestBody {
	const body: CompactionRequestBody = {
		model: input.model,
		input: [...input.messages, { type: "compaction_trigger" }],
		store: true,
	};
	if (input.systemPrompt) body.instructions = input.systemPrompt;
	if (input.tools && input.tools.length > 0) body.tools = input.tools;
	if (input.reasoning !== undefined) body.reasoning = input.reasoning;
	if (input.text !== undefined) body.text = input.text;
	return body;
}

/** The opaque artifact, as we persist it. Never parsed — only carried. */
export interface RemoteCompaction {
	/** Provider-native, opaque, not human-readable. */
	item: unknown;
	/** Model it was produced under, so a later turn can refuse to replay it. */
	model: string;
	provider: string;
	createdAtMs: number;
	/** Response id, for `previous_response_id` continuation while it stays safe. */
	responseId?: string;
}

/**
 * Pull the compaction item out of a `/v1/responses` payload.
 *
 * Returns null rather than throwing on any shape it does not recognise: an
 * endpoint that changed its response format must degrade to "pi's own summary
 * only", never take down the session it was trying to help.
 */
export function extractCompaction(payload: unknown, model: ModelRef, nowMs: number): RemoteCompaction | null {
	if (!payload || typeof payload !== "object") return null;
	const root = payload as { output?: unknown; id?: unknown };
	if (!Array.isArray(root.output)) return null;
	const item = root.output.find(
		(candidate) => !!candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "compaction",
	);
	if (!item) return null;
	return {
		item,
		model: model.id,
		provider: model.provider,
		createdAtMs: nowMs,
		responseId: typeof root.id === "string" ? root.id : undefined,
	};
}

/**
 * Events after which any live-continuation state MUST be dropped.
 *
 * Copied wholesale from the upstream safety model, which is the most valuable
 * part of it. Every entry is a point where the conversation the server thinks
 * it holds stops matching the one we hold; replaying a stale artifact past any
 * of them contaminates context in a way that is very hard to see afterwards.
 */
export const CLEAR_ON_EVENTS = [
	"session_start",
	"session_shutdown",
	"session_before_fork",
	"session_before_switch",
	"session_before_tree",
	"session_tree",
	"model_select",
	"session_compact",
] as const;

export type ClearEvent = (typeof CLEAR_ON_EVENTS)[number];

export function shouldClearContinuation(eventType: string): boolean {
	return (CLEAR_ON_EVENTS as readonly string[]).includes(eventType);
}

/**
 * Whether a stored artifact may be replayed for the model now in use.
 *
 * Cross-model replay is the contamination case the upstream extension calls out
 * explicitly, and it is reachable by ordinary use: resume a session, switch
 * model, keep going. Compare BOTH provider and id — `openai/gpt-x` and
 * `openai-codex/gpt-x` are the same weights behind different transports and
 * still must not share an artifact.
 */
export function canReplay(artifact: RemoteCompaction | null, model: ModelRef | null | undefined): boolean {
	if (!artifact || !model) return false;
	return artifact.provider === model.provider && artifact.model === model.id;
}
