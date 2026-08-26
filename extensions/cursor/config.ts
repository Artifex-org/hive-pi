/** Cursor transport configuration and request headers. */

export function apiUrl(): string {
	return process.env.CURSOR_API_URL || "https://api2.cursor.sh";
}

const DEFAULT_STREAM_IDLE_MS = 180_000;

/**
 * How long a turn may produce NOTHING before it is failed.
 *
 * FOUR MINUTES, not fifteen, because the failure it catches is INTERMITTENT and
 * RETRYABLE. A stalled turn never recovers on its own: the connection stays
 * open, heartbeats keep flowing, and the model waits forever for a result.
 *
 * The root cause turned out to be an exec request answered in the wrong oneof
 * case — see `refusalFor` in exec.ts, which now covers every kind the protocol
 * defines. This budget is the BACKSTOP for the next one, not the fix for that
 * one, and it is kept because the class recurs: the server adds a request kind,
 * nothing answers it in the shape it is watching for, and the turn hangs with no
 * error anywhere.
 *
 * (An earlier version of this comment blamed the size of the tool RESULT, on a
 * measured correlation — 8 KB stalled 0 of 3, 26 KB stalled 1 of 3, and
 * non-monotonically. That was a confounder: a big result gets truncated,
 * truncation sends the model to the shell to check what it could not read, and
 * the extra shell traffic is what reached the uncovered kind. A 26 KB result on
 * its own answers in 1-3ms, three times out of three.)
 *
 * That shape makes waiting the wrong strategy. pi retries a failed turn three
 * times, so the budget is multiplied: at fifteen minutes a stalling agent spends
 * forty-five before it gives up, which is exactly what two launched agents did —
 * ~50 minutes each on a two-line task, 0 commits, 0 edits. At four minutes the
 * same three attempts cost twelve, and with a ~1-in-3 stall rate the retry
 * usually lands.
 *
 * Four rather than one: every SUCCESSFUL turn measured completed in 10–20s, so
 * 240s is more than an order of magnitude of headroom, and the cost of cutting a
 * genuinely slow turn short is worse than the cost of waiting a little longer to
 * retry a dead one. Still overridable for an operator who has a turn that
 * legitimately thinks longer.
 */
const DEFAULT_TURN_STALL_MS = 240_000;

export function streamIdleMs(): number {
	const raw = Number(process.env.CURSOR_STREAM_IDLE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_MS;
}

export function turnStallMs(): number {
	const raw = Number(process.env.CURSOR_TURN_STALL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_STALL_MS;
}

export function isHeartbeatOnly(msg: Record<string, unknown>): boolean {
	for (const holder of [msg.execServerMessage, msg.interactionUpdate]) {
		if (!holder || typeof holder !== "object") continue;
		const keys = Object.keys(holder as Record<string, unknown>);
		if (keys.length === 1 && keys[0] === "heartbeat") return true;
	}
	return false;
}

export const DEFAULT_CLIENT_VERSION = "cli-2026.08.11-e8db854";

export function clientVersion(): string {
	return process.env.CURSOR_CLIENT_VERSION?.trim() || DEFAULT_CLIENT_VERSION;
}

export function piToolsEnabled(): boolean {
	const raw = process.env.CURSOR_PI_TOOLS?.trim().toLowerCase();
	return raw !== "0" && raw !== "false" && raw !== "off";
}

export function cursorHeaders(accessToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${accessToken}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": clientVersion(),
		"x-cursor-client-type": "cli",
	};
}
