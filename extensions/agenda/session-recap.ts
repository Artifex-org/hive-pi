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
	const text = await fetchRecapPayload(sessionID);
	if (text === null) return null;
	return formatSessionRecap(text);
}

/* ------------------------------------------------------------------------ *
 * Handoff seeding (HIV-1231 follow-up)
 *
 * The compaction re-arm above wants the SHORT fold — `stay_on`, a few lines to
 * put a compacted model back on its rails. A handoff seed wants the opposite:
 * the successor session has no history at all, so it needs the facts that are
 * expensive or impossible for it to re-derive — which PR, which CI verdict,
 * which tickets are claimed, which knowledge documents were already read.
 *
 * Sections rather than one string, because the seed has a hard character
 * budget and has to be able to drop the cheapest-to-re-derive block first.
 * ------------------------------------------------------------------------ */

/** One droppable block of a handoff seed. */
export interface RecapSection {
	/** Rendered as the `## ` heading. */
	label: string;
	lines: string[];
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn a `recap_session` body into the seed's remote sections.
 *
 * Returns `[]` for anything unparseable — a seed with local state only is a
 * working seed, and inventing a section from a shape we did not recognise is
 * how a successor ends up trusting a fact nobody asserted.
 *
 * Nothing here widens what the tool returned: `knowledge.refs` arrives capped
 * at 8 and `team.members` at 12 server-side, and the truncation flags it sets
 * are carried through verbatim so the successor knows a list is partial.
 */
export function handoffRecapSections(text: string): RecapSection[] {
	let parsed: Record<string, unknown>;
	try {
		const value = JSON.parse(text.trim()) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		parsed = value as Record<string, unknown>;
	} catch {
		return [];
	}

	const sections: RecapSection[] = [];

	// --- Delivery: branch, PR, CI. The single most expensive block to re-derive,
	// because getting it wrong means working the wrong branch.
	const working = (parsed.working ?? {}) as Record<string, unknown>;
	const delivery = (parsed.delivery ?? {}) as Record<string, unknown>;
	const deliveryLines: string[] = [];
	const branch = str(working.branch) || str(working.launch_branch);
	if (branch) deliveryLines.push(`- branch: \`${branch}\``);
	if (str(working.cut_from)) deliveryLines.push(`- cut from: \`${str(working.cut_from)}\``);
	if (str(working.worktree)) deliveryLines.push(`- worktree: \`${str(working.worktree)}\``);
	const pr = num(working.pr_number) ?? num(delivery.pr_number);
	if (pr !== null) deliveryLines.push(`- PR: #${pr}`);
	if (str(delivery.ci_state)) {
		const run = str(delivery.ci_run_id);
		deliveryLines.push(`- CI: ${str(delivery.ci_state)}${run ? ` (run ${run})` : ""}`);
	}
	if (deliveryLines.length > 0) sections.push({ label: "Delivery", lines: deliveryLines });

	// --- Tickets: claimed work. A successor that does not know these re-claims
	// them, or worse, collides with whoever else holds one.
	const tickets = Array.isArray(parsed.tickets) ? parsed.tickets : [];
	const ticketLines = tickets
		.map((raw) => {
			const t = (raw ?? {}) as Record<string, unknown>;
			const id = str(t.ticket);
			if (!id) return "";
			const source = str(t.source);
			return `- ${id}${source ? ` (via ${source})` : ""}`;
		})
		.filter((line) => line.length > 0);
	if (ticketLines.length > 0) sections.push({ label: "Claimed tickets", lines: ticketLines });

	// --- Knowledge: what was already read. Re-searching is the waste this block
	// exists to prevent, so it carries paths, not summaries.
	const knowledge = (parsed.knowledge ?? {}) as Record<string, unknown>;
	const refs = Array.isArray(knowledge.refs) ? knowledge.refs : [];
	const knowledgeLines = refs
		.map((raw) => {
			const r = (raw ?? {}) as Record<string, unknown>;
			const path = str(r.path);
			if (!path) return "";
			const collection = str(r.collection);
			return `- ${collection ? `${collection}/` : ""}${path}`;
		})
		.filter((line) => line.length > 0);
	if (knowledgeLines.length > 0) {
		const total = num(knowledge.total);
		const returned = num(knowledge.returned) ?? knowledgeLines.length;
		if (knowledge.truncated === true && total !== null && total > returned) {
			knowledgeLines.push(`- (${total - returned} more not listed — re-search if you need them)`);
		}
		sections.push({ label: "Knowledge already read", lines: knowledgeLines });
	}

	// --- Team: who else is live. Lowest priority because it is the block that
	// goes stale fastest — a successor should re-read it, not trust it.
	const team = (parsed.team ?? {}) as Record<string, unknown>;
	const members = Array.isArray(team.members) ? team.members : [];
	const teamLines = members
		.map((raw) => {
			const m = (raw ?? {}) as Record<string, unknown>;
			if (m.self === true) return "";
			const title = str(m.title) || str(m.session_id);
			if (!title) return "";
			const live = str(m.live_state);
			return `- ${title}${live ? ` — ${live}` : ""}`;
		})
		.filter((line) => line.length > 0);
	if (teamLines.length > 0) {
		teamLines.push("- (re-read with `list_teammates` — team state goes stale fastest)");
		sections.push({ label: "Teammates at handoff", lines: teamLines });
	}

	return sections;
}

/**
 * Fetch the raw `recap_session` body. Never throws; null on any failure.
 *
 * Split out of `fetchSessionRecap` so the handoff seed and the compaction
 * re-arm share ONE call path and one auth ranking — two copies would be two
 * places to review when asking what leaves this machine.
 */
export async function fetchRecapPayload(sessionID?: string | null): Promise<string | null> {
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
	return result.text;
}
