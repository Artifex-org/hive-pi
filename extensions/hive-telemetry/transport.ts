/**
 * hive-telemetry — HTTP transport.
 *
 * Timeouts, error redaction and the retry classification moved to
 * ../hive-common/http.ts so hive-remote shares one policy. What stays here is
 * the one call that is telemetry's own: the cumulative usage snapshot.
 */

import { classify, redact, withTimeout } from "../hive-common/http.ts";
import type { AgentUsagePayload, ResolvedAuth } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

export { validateToken } from "../hive-common/http.ts";
export type { ValidateResult, WhoAmI } from "../hive-common/http.ts";

export interface FlushResult {
	ok: boolean;
	status: number | null;
	/** Auth failed: stop flushing for this process rather than retrying on a timer. */
	authFailed: boolean;
	/** Permanently malformed for this server: drop rather than retry forever. */
	permanent: boolean;
	error?: string;
}

/**
 * postUsage sends one cumulative snapshot.
 *
 * Kept as its own function rather than a call to the generic request() helper
 * because its result type is part of the spool's contract: the caller branches
 * on authFailed/permanent to decide whether to drop the offline backup.
 */
export interface HeartbeatResult {
	ok: boolean;
	status: number | null;
	/** The CREDENTIAL was refused, as opposed to this one call failing. */
	authFailed: boolean;
}

/**
 * Say "still alive" without reporting usage.
 *
 * The interval flush only fires when there is something to report
 * (`run.dirty > 0`), so an idle session goes silent and the server cannot tell
 * it from a dead one — the gap HIV-1160 measured, with sessions stuck `active`
 * for hours after their process died.
 *
 * Deliberately NOT a usage POST with unchanged counters: this carries no
 * numbers, so a heartbeat racing a real flush can never overwrite fresh usage
 * with a stale snapshot, and it cannot create a session.
 *
 * Best-effort by construction, and it still never throws — a heartbeat that
 * threw into the timer would take the whole telemetry loop down. What changed
 * (HIV-1639) is that it no longer swallows the OUTCOME: an idle session never
 * flushes, so the flush path — where the auth latch lives — never runs, and a
 * token revoked mid-session was re-presented once per interval for the life of
 * the process with nothing in a position to notice. The caller reads
 * `authFailed` and latches; everything else stays best-effort and unread.
 */
export async function postHeartbeat(
	clientRunID: string,
	auth: ResolvedAuth,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HeartbeatResult> {
	try {
		const res = await withTimeout(timeoutMs, (signal) =>
			fetch(`${auth.url}/api/v1/agent-sessions/heartbeat`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ client_run_id: clientRunID }),
				signal,
			}),
		);
		if (res.ok) return { ok: true, status: res.status, authFailed: false };
		// Only the auth verdict is surfaced. A heartbeat 404 is ORDINARY — the
		// session row is created by the first usage flush, so a heartbeat that
		// races it legitimately finds nothing — and treating it as permanent the
		// way postUsage does would drop a spool this call has no business
		// touching.
		return { ok: false, status: res.status, authFailed: classify(res.status).authFailed };
	} catch {
		// Network error or timeout: unknowable, therefore not an auth verdict.
		return { ok: false, status: null, authFailed: false };
	}
}

export async function postUsage(
	payload: AgentUsagePayload,
	auth: ResolvedAuth,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FlushResult> {
	try {
		const res = await withTimeout(timeoutMs, (signal) =>
			fetch(`${auth.url}/api/v1/agent-sessions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal,
			}),
		);
		if (res.ok) return { ok: true, status: res.status, authFailed: false, permanent: false };
		const { authFailed, permanent } = classify(res.status);
		return { ok: false, status: res.status, authFailed, permanent };
	} catch (err) {
		return { ok: false, status: null, authFailed: false, permanent: false, error: redact(err) };
	}
}
