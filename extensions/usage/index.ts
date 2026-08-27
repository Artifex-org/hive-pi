/**
 * usage — provider quota/spend in the footer, in-house (HIV-1221, replacing
 * `@narumitw/pi-usage`).
 *
 * The integration surface was already ours on both ends: `status-footer`
 * reads `statuses.get("usage")`, and the Codex endpoint contract lives in
 * `hive-remote/status.ts` (HIV-1188 learned the hard way that response
 * headers are not surfaced by pi — the backend is asked directly, a plain
 * read that costs no tokens). This extension is the third consumer of that
 * contract, not a fourth implementation of it.
 *
 * Rules carried over from the package and the house:
 *  - NEVER fetch inside an event handler — pi awaits handlers serially, so a
 *    slow handler IS the agent loop. Every fetch is a detached promise.
 *  - Keep the last good reading on failure. An absent answer is not a reset
 *    quota, and blanking the cell every network hiccup teaches the user to
 *    ignore it.
 *  - Only the official Codex origin ever sees the credential
 *    (isOfficialCodexOrigin — a custom baseUrl means a proxy's token).
 *
 * Nothing mutable at module scope — pi builds a fresh jiti per extension
 * entry with `moduleCache:false`, so state lives in the factory closure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	CODEX_PROVIDER,
	CODEX_USAGE_URL,
	isOfficialCodexOrigin,
	parseUsageWindow,
} from "../hive-remote/status.ts";
import {
	type CodexReading,
	type OpenRouterReading,
	overlayLines,
	parseOpenRouterKey,
	statusLine,
} from "./format.ts";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const FETCH_TIMEOUT_MS = 8_000;
/** Codex refresh floor. The quota moves with every turn but the number is a
 *  percentage — sub-minute freshness changes nothing a human acts on. */
const CODEX_MIN_INTERVAL_MS = 60_000;
/** OpenRouter is lifetime key spend; it moves slowly and the endpoint is
 *  rate-limited. */
const OPENROUTER_MIN_INTERVAL_MS = 300_000;

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { headers, signal: controller.signal });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Both Codex windows (hive-remote's fetch keeps only the gating one — the
 * footer wants the 5h AND the weekly number). Same auth dance, same refusals:
 * null for every "we cannot know".
 */
/** Keep only string-valued headers, dropping pi 0.84's null deletion markers. */
function pickStringHeaders(h: Record<string, string | null> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h ?? {})) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

async function fetchCodexReading(ctx: ExtensionContext, nowMs: number): Promise<CodexReading | null> {
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
		if (auth.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
	} catch {
		return null;
	}
	if (Object.keys(headers).length === 0) return null;

	const payload = await fetchJson(CODEX_USAGE_URL, headers);
	if (!payload || typeof payload !== "object") return null;
	const body = payload as Record<string, unknown>;
	const limits = body.rate_limit && typeof body.rate_limit === "object" ? (body.rate_limit as Record<string, unknown>) : {};
	const reading: CodexReading = {
		...(parseUsageWindow(limits.primary_window, nowMs) ? { primary: parseUsageWindow(limits.primary_window, nowMs) } : {}),
		...(parseUsageWindow(limits.secondary_window, nowMs)
			? { secondary: parseUsageWindow(limits.secondary_window, nowMs) }
			: {}),
		...(typeof body.plan_type === "string" && body.plan_type ? { planType: body.plan_type } : {}),
		fetchedAtMs: nowMs,
	};
	return reading.primary || reading.secondary ? reading : null;
}

async function fetchOpenRouterReading(nowMs: number): Promise<OpenRouterReading | null> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return null;
	const payload = await fetchJson(OPENROUTER_KEY_URL, { Authorization: `Bearer ${key}` });
	return parseOpenRouterKey(payload, nowMs);
}

/** Injectable for tests — pi calls the factory with (pi) only, so the second
 *  parameter always defaults to the real fetchers in production. */
export interface UsageDeps {
	fetchCodex: (ctx: ExtensionContext, nowMs: number) => Promise<CodexReading | null>;
	fetchOpenRouter: (nowMs: number) => Promise<OpenRouterReading | null>;
}

export default function (
	pi: ExtensionAPI,
	deps: UsageDeps = { fetchCodex: fetchCodexReading, fetchOpenRouter: fetchOpenRouterReading },
) {
	let codex: CodexReading | null = null;
	let openRouter: OpenRouterReading | null = null;
	let codexAttemptAtMs = 0;
	let openRouterAttemptAtMs = 0;
	let heldCtx: ExtensionContext | null = null;

	const paint = () => {
		const ctx = heldCtx;
		if (!ctx) return;
		try {
			ctx.ui.setStatus("usage", statusLine(ctx.model?.provider, codex, openRouter));
		} catch {
			/* session replaced, or a mode without a footer */
		}
	};

	/**
	 * Detached by contract. `force` skips the interval floor (`/usage` is a
	 * human asking NOW); reads that fail keep the previous reading.
	 */
	const refresh = async (ctx: ExtensionContext, force = false) => {
		heldCtx = ctx;
		const nowMs = Date.now();
		const wantCodex = force || nowMs - codexAttemptAtMs >= CODEX_MIN_INTERVAL_MS;
		const wantOpenRouter = force || nowMs - openRouterAttemptAtMs >= OPENROUTER_MIN_INTERVAL_MS;

		if (wantCodex) {
			codexAttemptAtMs = nowMs;
			try {
				const reading = await deps.fetchCodex(ctx, nowMs);
				if (reading) codex = reading;
			} catch {
				/* keep the last reading */
			}
		}
		if (wantOpenRouter) {
			openRouterAttemptAtMs = nowMs;
			try {
				const reading = await deps.fetchOpenRouter(nowMs);
				if (reading) openRouter = reading;
			} catch {
				/* keep the last reading */
			}
		}
		paint();
	};

	pi.on("session_start", (_event, ctx) => {
		heldCtx = ctx;
		void refresh(ctx, true);
	});
	pi.on("model_select", (_event, ctx) => {
		// The active provider changed, so both the auth source and which segment
		// leads may have. Repaint immediately with what is known; fetch behind it.
		heldCtx = ctx;
		paint();
		void refresh(ctx, true);
	});
	pi.on("turn_end", (_event, ctx) => {
		void refresh(ctx);
	});

	pi.registerCommand("usage", {
		description: "Provider quota and spend (Codex windows, OpenRouter key)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			heldCtx = ctx;
			await refresh(ctx, true);
			const lines = overlayLines(codex, openRouter, Date.now());
			if (ctx.mode !== "tui") {
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => ({
					render(width: number): string[] {
						const clip = (line: string) => (line.length > width - 4 ? `${line.slice(0, width - 5)}…` : line);
						return [theme.fg("accent", "usage"), ...lines.map(clip), theme.fg("dim", "Esc or Enter to close")];
					},
					invalidate() {},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
						tui.requestRender();
					},
				}),
				{
					overlay: true,
					overlayOptions: { width: "60%", minWidth: 44, maxHeight: "60%", anchor: "center", margin: 2 },
				},
			);
		},
	});
}
