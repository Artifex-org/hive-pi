/**
 * usage — pure formatting and parsing (HIV-1221).
 *
 * The fetch/timer side lives in index.ts; everything here is testable without
 * a TUI or a network. Codex window parsing is NOT duplicated — it imports the
 * shared parsers from hive-remote/status.ts, which documented the endpoint's
 * contract the hard way (headers are not surfaced by pi; the backend is asked
 * directly).
 */

import type { QuotaWindow } from "../hive-remote/status.ts";

/** Both Codex windows, not just the gating one — the footer has room for two
 *  numbers and "5h 12% · 7d 34%" answers a different question than either
 *  alone: can I keep working NOW, and can I keep working THIS WEEK. */
export interface CodexReading {
	primary?: QuotaWindow;
	secondary?: QuotaWindow;
	planType?: string;
	fetchedAtMs: number;
}

export interface OpenRouterReading {
	/** Lifetime spend on the key, USD. */
	usageUsd: number;
	/** Credit limit, null = uncapped. */
	limitUsd: number | null;
	remainingUsd: number | null;
	fetchedAtMs: number;
}

/**
 * The OpenRouter key endpoint's answer (`GET /api/v1/key`), defensively.
 * Numbers only; a payload that does not carry a finite `usage` is no reading
 * at all — an absent answer must never render as $0.00 spent, which is the
 * same wrong-in-the-flattering-direction failure the telemetry client had.
 */
export function parseOpenRouterKey(payload: unknown, nowMs: number): OpenRouterReading | null {
	if (!payload || typeof payload !== "object") return null;
	const data = (payload as { data?: unknown }).data;
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	if (typeof raw.usage !== "number" || !Number.isFinite(raw.usage)) return null;
	const limit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? raw.limit : null;
	const remaining =
		typeof raw.limit_remaining === "number" && Number.isFinite(raw.limit_remaining) ? raw.limit_remaining : null;
	return { usageUsd: raw.usage, limitUsd: limit, remainingUsd: remaining, fetchedAtMs: nowMs };
}

/** "300 minutes" → "5h", "10080" → "7d" — the label a human already uses for
 *  that window. Fallback is exact minutes rather than a rounded lie. */
export function windowLabel(minutes: number): string {
	if (minutes <= 0) return "now";
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

export function formatReset(seconds: number | undefined): string | undefined {
	if (seconds === undefined || seconds <= 0) return undefined;
	if (seconds < 3600) return `resets in ${Math.ceil(seconds / 60)}m`;
	if (seconds < 172_800) return `resets in ${Math.round(seconds / 3600)}h`;
	return `resets in ${Math.round(seconds / 86_400)}d`;
}

function windowSegment(window: QuotaWindow | undefined): string | undefined {
	if (!window) return undefined;
	return `${windowLabel(window.window_minutes)} ${window.used_percent}%`;
}

/** The Codex half of the footer cell: "codex 5h 12% · 7d 34%". */
export function codexSegment(reading: CodexReading | null): string | undefined {
	if (!reading) return undefined;
	const parts = [windowSegment(reading.primary), windowSegment(reading.secondary)].filter(
		(part): part is string => part !== undefined,
	);
	if (parts.length === 0) return undefined;
	return `codex ${parts.join(" · ")}`;
}

/**
 * The OpenRouter half. `usage` is LIFETIME key spend while `limit` /
 * `limit_remaining` describe the CURRENT credit block — mixing them reads as
 * "$160.89 spent of $30.00" (measured in the first dogfood session). The
 * footer shows the number that gates work now: remaining credit when the key
 * is capped, lifetime spend only when it is not.
 */
export function openRouterSegment(reading: OpenRouterReading | null): string | undefined {
	if (!reading) return undefined;
	if (reading.remainingUsd !== null) return `or $${reading.remainingUsd.toFixed(2)} left`;
	return `or $${reading.usageUsd.toFixed(2)} spent`;
}

/**
 * The one line the footer shows (`setStatus("usage", …)` — the key
 * status-footer already reads). The ACTIVE provider leads; the other appears
 * only when there is nothing to say about the active one. Both at once would
 * crowd a cell that shares its row with the model name.
 */
export function statusLine(
	activeProvider: string | undefined,
	codex: CodexReading | null,
	openRouter: OpenRouterReading | null,
): string | undefined {
	const codexPart = codexSegment(codex);
	const orPart = openRouterSegment(openRouter);
	if (activeProvider === "openrouter") return orPart ?? codexPart;
	return codexPart ?? orPart;
}

/** The `/usage` overlay body — everything known, one reading per line. */
export function overlayLines(codex: CodexReading | null, openRouter: OpenRouterReading | null, nowMs: number): string[] {
	const lines: string[] = [];
	if (codex) {
		lines.push(`Codex${codex.planType ? ` (${codex.planType})` : ""}:`);
		for (const window of [codex.primary, codex.secondary]) {
			if (!window) continue;
			const reset = formatReset(window.reset_after_seconds);
			lines.push(`  ${windowLabel(window.window_minutes)} window: ${window.used_percent}% used${reset ? ` · ${reset}` : ""}`);
		}
		lines.push(`  read ${Math.max(0, Math.round((nowMs - codex.fetchedAtMs) / 1000))}s ago`);
	}
	if (openRouter) {
		lines.push("OpenRouter:");
		// Lifetime and the current credit block are different scales — label
		// both, never compare them ("$160.89 spent of $30.00" is how the first
		// version read).
		lines.push(`  $${openRouter.usageUsd.toFixed(2)} lifetime spend${openRouter.limitUsd === null ? " (uncapped key)" : ""}`);
		if (openRouter.limitUsd !== null && openRouter.remainingUsd !== null) {
			lines.push(`  $${openRouter.remainingUsd.toFixed(2)} of $${openRouter.limitUsd.toFixed(2)} credit remaining`);
		}
		lines.push(`  read ${Math.max(0, Math.round((nowMs - openRouter.fetchedAtMs) / 1000))}s ago`);
	}
	if (lines.length === 0) {
		lines.push("No quota readings yet.");
		lines.push("Codex quota needs an openai-codex session model; OpenRouter spend needs OPENROUTER_API_KEY.");
	}
	return lines;
}
