/**
 * hive-remote — live session status: context usage, provider quota, model.
 *
 * These are the numbers the pi footer shows and the browser could not: how full
 * the context is, how much of the subscription window is left, and what the
 * session is currently thinking with. Only the client can see any of them.
 *
 * WHY THIS RIDES THE CONTROL CHANNEL AND NOT hive-telemetry.
 *
 * hive-telemetry's `payload.ts` is the audited privacy boundary — "review that
 * one file and you have reviewed what leaves the machine" — and its contents are
 * cumulative counters flushed at a 15 s settle floor. Both facts are wrong for
 * this. A context gauge is a live reading, not a total, and widening the
 * telemetry allowlist would mean every counters-only session started reporting
 * account-level quota. Here, consent is the existence of a conversation: this
 * extension is separately opt-in, and a session that opted in is already sending
 * prose.
 *
 * Everything in this file is PURE. The timer and the HTTP call live in index.ts,
 * for the reason stated at the top of it: an extension handler is awaited
 * serially by pi's runner, so a slow handler IS the agent loop.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * One rate-limit window as the Codex backend reports it.
 *
 * Field names mirror hive's `internal/codexlimits` deliberately: the server
 * already parses exactly these headers for the factory's shared account, and two
 * spellings of "used percent" across one system is how a dashboard ends up
 * showing a stale number from the wrong parser.
 */
export interface QuotaWindow {
	used_percent: number;
	window_minutes: number;
	reset_after_seconds?: number;
	limit_name?: string;
}

/** What a session reports about itself, between turns. Every field optional:
 *  absent means "this client cannot see it", which is not the same as zero. */
export interface StatusPayload {
	context_tokens?: number;
	context_window?: number;
	/** `provider/id`, the same spelling the model selector and telemetry use. */
	model?: string;
	thinking?: string;
	/** The window that actually gates this session — the longest one reported. */
	quota?: QuotaWindow;
	plan_type?: string;
	/**
	 * The operating posture in force — what the harness is allowing. Reported by
	 * the `opmode` extension over the bus; absent when that extension is not
	 * loaded, which the workspace must render as unknown and never as "build".
	 */
	op_mode?: string;
}

/**
 * The Codex usage endpoint, and why it is not the response headers.
 *
 * The first version of this file parsed `x-codex-primary-*` off
 * `after_provider_response`. It shipped, deployed, and reported nothing: those
 * headers are not on the responses pi surfaces. `internal/codexlimits` says so
 * in passing — "pi, the harness that actually makes those calls, does not
 * surface response headers" — which is why Hive PROBES a completion endpoint and
 * spends tokens to read them.
 *
 * `@narumitw/pi-usage`, the package that renders this same number in the pi
 * footer, never touches headers. It asks the backend directly. That endpoint is
 * a plain usage read — no completion, no tokens, no cost — so we can poll it on
 * a slow timer and stop paying for a measurement.
 */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const CODEX_PROVIDER = "openai-codex";

/**
 * Only the official origin.
 *
 * A custom `baseUrl` means the credential belongs to a proxy, and posting it to
 * chatgpt.com would hand a third party's token to OpenAI. pi-usage refuses for
 * the same reason; this is not defensive coding, it is the one way this feature
 * could leak a credential.
 */
export function isOfficialCodexOrigin(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

/**
 * One window out of the backend's payload.
 *
 * The refusals are the ones the header parser had, because they were the right
 * refusals: a window without a used-percent is absent rather than empty, and a
 * percentage outside 0-100 is contract drift rather than a measurement. A quota
 * we cannot read must render as unknown and never as fine.
 */
export function parseUsageWindow(raw: unknown, nowMs: number): QuotaWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;

	const used = value.used_percent;
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return undefined;

	const window: QuotaWindow = { used_percent: Math.round(used), window_minutes: 0 };
	const seconds = value.limit_window_seconds;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
		window.window_minutes = Math.ceil(seconds / 60);
	}
	// `reset_at` is an ABSOLUTE epoch; the wire carries an offset. Converted here
	// because the server stamps its own absolute time on receipt, so sending the
	// backend's epoch would compound any clock skew between three machines
	// instead of one.
	const resetAt = value.reset_at;
	if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
		const after = Math.round(resetAt - nowMs / 1000);
		if (after > 0) window.reset_after_seconds = after;
	}
	return window;
}

/**
 * The whole reading, from the usage payload.
 *
 * Reads ONLY the top-level `rate_limit`. `additional_rate_limits` are
 * per-feature buckets (a metered tool, a preview model), and folding them in
 * would make one percentage on the bar mean different things on different days.
 */
export function parseCodexUsage(payload: unknown, nowMs: number): { quota?: QuotaWindow; plan_type?: string } {
	if (!payload || typeof payload !== "object") return {};
	const body = payload as Record<string, unknown>;

	const out: { quota?: QuotaWindow; plan_type?: string } = {};
	const limits = body.rate_limit;
	if (limits && typeof limits === "object") {
		const group = limits as Record<string, unknown>;
		const quota = chooseQuotaWindow(
			parseUsageWindow(group.primary_window, nowMs),
			parseUsageWindow(group.secondary_window, nowMs),
		);
		if (quota) out.quota = quota;
	}
	if (typeof body.plan_type === "string" && body.plan_type) out.plan_type = body.plan_type;
	return out;
}

/**
 * The window worth showing, out of the two a plan may expose.
 *
 * The LONGER one, not the fuller one. A 5-hour window at 90% refills this
 * afternoon; a weekly window at 90% is the one that decides whether there is
 * work left this week, and it is the number an operator is actually asking for
 * when they glance at the bar. Ties go to primary, which is the one Codex
 * treats as authoritative.
 */
export function chooseQuotaWindow(
	primary: QuotaWindow | undefined,
	secondary: QuotaWindow | undefined,
): QuotaWindow | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	return secondary.window_minutes > primary.window_minutes ? secondary : primary;
}

/**
 * Ask the backend what is left.
 *
 * Returns null for every "we cannot know" — no codex model, a proxy credential,
 * an unreachable endpoint, a body that is not JSON. The caller keeps its last
 * reading rather than blanking the segment, because an absent answer is not a
 * reset quota.
 *
 * NEVER awaited from an event handler. Like everything else in this feature it
 * runs on a detached timer; pi awaits handlers serially, so a slow one IS the
 * agent loop.
 */
/** Keep only string-valued headers, dropping pi 0.84's null deletion markers. */
function pickStringHeaders(h: Record<string, string | null> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h ?? {})) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

export async function fetchCodexQuota(
	ctx: ExtensionContext,
	nowMs: number,
	timeoutMs = 8_000,
): Promise<{ quota?: QuotaWindow; plan_type?: string } | null> {
	const model = ctx.model;
	if (!model || model.provider !== CODEX_PROVIDER) return null;
	if (!isOfficialCodexOrigin((model as { baseUrl?: string }).baseUrl)) return null;

	let headers: Record<string, string>;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return null;
		// Since pi 0.84 a header value may be null — pi-ai's marker for "delete
		// this header" when composing a request. We are building a plain fetch,
		// not composing over an existing header set, so a deletion marker has
		// nothing to delete: drop it rather than forward a literal "null".
		headers = pickStringHeaders(auth.headers);
		// Some providers hand back the key rather than a ready Authorization
		// header. Only fill it in — never overwrite one the registry composed,
		// which may carry an account id or a session binding this does not know
		// about.
		if (auth.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
	} catch {
		return null;
	}
	if (Object.keys(headers).length === 0) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(CODEX_USAGE_URL, { headers, signal: controller.signal });
		if (!res.ok) return null;
		const reading = parseCodexUsage(await res.json(), nowMs);
		// An empty reading is a parse we did not understand, which is a different
		// thing from a quota of zero. Report it as no answer.
		return reading.quota || reading.plan_type ? reading : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * buildStatus snapshots what the session can currently say about itself.
 *
 * `quota` is passed in rather than read here because it arrives on a different
 * event entirely (a provider response) and persists between turns — the last
 * reading is still the truth until the next call replaces it.
 */
export function buildStatus(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	quota: { quota?: QuotaWindow; plan_type?: string },
	opMode?: string,
): StatusPayload {
	const status: StatusPayload = { ...quota };
	// Passed in rather than read here for the same reason `quota` is: it arrives
	// on a bus event from another extension and persists between turns. Omitted
	// entirely when unknown — an absent posture and an unrestricted one are
	// different claims, and only the client that enforces one may make it.
	if (opMode) status.op_mode = opMode;

	const usage = ctx.getContextUsage();
	// contextWindow falls back to the model's own declaration: usage reports it
	// only once there is a turn to measure, and a session that has not run yet
	// still has a window worth drawing an empty gauge against.
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (usage?.tokens != null && usage.tokens >= 0) status.context_tokens = Math.round(usage.tokens);
	if (typeof window === "number" && window > 0) status.context_window = window;

	if (ctx.model) status.model = `${ctx.model.provider}/${ctx.model.id}`;
	const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
	if (thinking) status.thinking = thinking;

	return status;
}

/**
 * changed reports whether a new snapshot is worth a request.
 *
 * The status is polled off a timer, and an idle session produces an identical
 * reading every tick. Sending it anyway would mean a workstation that has been
 * sitting at a prompt overnight is still POSTing every few seconds, forever,
 * to say nothing — which is the kind of cost that only shows up on someone
 * else's graph.
 *
 * Context tokens move constantly during a turn, so they are compared with a
 * tolerance rather than exactly: below a few hundred tokens the gauge does not
 * visibly move, and a redraw nobody can see is not worth a round trip.
 */
export function changed(previous: StatusPayload | null, next: StatusPayload): boolean {
	if (!previous) return true;
	if (previous.model !== next.model || previous.thinking !== next.thinking) return true;
	if (previous.context_window !== next.context_window) return true;
	if (previous.quota?.used_percent !== next.quota?.used_percent) return true;
	if (previous.quota?.window_minutes !== next.quota?.window_minutes) return true;
	if (previous.plan_type !== next.plan_type) return true;
	// A posture change is always worth a request. It is the one field here that
	// changes what an operator believes the session may DO, so letting it wait
	// for the next context-token move would leave the workspace showing the old
	// restriction for as long as the session sits idle.
	if (previous.op_mode !== next.op_mode) return true;

	const before = previous.context_tokens;
	const after = next.context_tokens;
	if (before === undefined || after === undefined) return before !== after;
	return Math.abs(after - before) >= CONTEXT_TOKEN_EPSILON;
}

/** Roughly a quarter-percent of a 200k window — under this the gauge does not
 *  move a pixel. */
export const CONTEXT_TOKEN_EPSILON = 500;

/** A mode as the server resolved it. The client never maps a difficulty to a
 *  model: Hive owns that mapping and sends the answer, so the two can never
 *  disagree about what "high" means. */
export interface ModeSpec {
	mode: string;
	model: string;
	thinking?: string;
}

/** Parse `provider/model-id` — models with a slash in the id (openrouter's
 *  `z-ai/glm-5.2`) keep it, so only the FIRST segment is the provider. */
export function splitModelSpec(spec: string): { provider: string; id: string } | null {
	const at = spec.indexOf("/");
	if (at <= 0 || at === spec.length - 1) return null;
	return { provider: spec.slice(0, at), id: spec.slice(at + 1) };
}

/**
 * The thinking levels pi accepts.
 *
 * A literal set rather than something derived, because a type cannot be
 * enumerated at runtime — but the predicate is typed against pi's own
 * `ThinkingLevel`, so this list narrowing to something pi does not accept is a
 * compile error rather than a runtime surprise. The other direction is safe by
 * design: a server naming a level newer than this client simply fails the guard,
 * and the model switch still happens without it.
 */
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return value !== undefined && THINKING_LEVELS.has(value);
}
