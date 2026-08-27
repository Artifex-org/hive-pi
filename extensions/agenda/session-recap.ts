/**
 * Compaction re-arm of Hive's Detail-rail recap.
 *
 * `recap_session` is the agent-facing copy of the agents Detail pane. After a
 * compaction the model has none of those facts, and reconstructing them means
 * five other tools. This module is the OTHER half: at `session_compact` we
 * fetch that same payload (best-effort, never mid-handler) and inject it the
 * way the goal/conductor already restore — `deliverAs: "nextTurn"`, so an
 * unattended run actually sees it (injected turns skip `before_agent_start`).
 *
 * Failures are silent by design. A compaction that cannot reach Hive must
 * still leave a working session; the next explicit `recap_session` call is
 * the recovery, not a broken compact path.
 */

import { resolveAuth } from "../hive-common/identity.ts";
import { callMcpTool } from "../hive-common/mcp.ts";

const RECAP_PREFIX = "Session recap (restored after compaction)";

/** What compact_schedule always appends so the summarizer keeps the Detail-rail facts. */
export const COMPACT_PRESERVE =
	"Preserve verbatim: the current goal, the current workflow/plan step, " +
	"open PR/ticket numbers, live branch, and any unfinished work. " +
	"After this compaction the session will be re-armed with recap_session.";

/** Merge the caller's compact_schedule instructions with COMPACT_PRESERVE. */
export function compactInstructions(requested?: string): string {
	const extra = requested?.trim();
	return extra ? `${extra}\n\n${COMPACT_PRESERVE}` : COMPACT_PRESERVE;
}

/** Pull the stay_on lines (or a one-line fallback) out of a recap_session body. */
export function formatSessionRecap(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as { stay_on?: unknown; recap?: unknown; title?: unknown };
		const stay = Array.isArray(parsed.stay_on)
			? parsed.stay_on.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
			: [];
		if (stay.length > 0) {
			return `${RECAP_PREFIX}:\n- ${stay.join("\n- ")}`;
		}
		if (typeof parsed.recap === "string" && parsed.recap.trim()) {
			return `${RECAP_PREFIX}: ${parsed.recap.trim()}`;
		}
		if (typeof parsed.title === "string" && parsed.title.trim()) {
			return `${RECAP_PREFIX}: ${parsed.title.trim()}`;
		}
	} catch {
		/* not JSON — treat the whole body as the recap if it already is one */
	}
	if (trimmed.startsWith(RECAP_PREFIX)) return trimmed;
	return null;
}

/**
 * Fetch recap_session for THIS process. Never throws.
 *
 * Auth is the same ranking hive-remote uses. The connection claim is the
 * client-run id hive-telemetry already exported as $PI_HIVE_RUN_ID — that is
 * what X-Hive-Session carries, and recap_session resolves it. A launched
 * session additionally has $HIVE_LAUNCH_ID, which whoami already taught the
 * model to use; we do not invent a session_id here.
 */
export async function fetchSessionRecap(sessionID?: string | null): Promise<string | null> {
	const auth = resolveAuth();
	if (!auth) return null;
	const args: Record<string, unknown> = {};
	if (sessionID) args.session_id = sessionID;
	const result = await callMcpTool(
		{ token: auth.token, url: auth.url },
		"recap_session",
		args,
		{ sessionId: process.env.PI_HIVE_RUN_ID?.trim() || undefined, timeoutMs: 8_000 },
	);
	if (!result.ok) return null;
	return formatSessionRecap(result.text);
}
