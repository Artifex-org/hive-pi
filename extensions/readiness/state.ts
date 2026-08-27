/**
 * The readiness document — what this session's environment can already do.
 *
 * WHY IT EXISTS. A capability the harness owns but never announces is a
 * capability the agent discovers by *failing*: it calls `dev_db_start` and
 * learns Postgres binaries are missing, calls an MCP tool and pays the connect,
 * delegates and learns the provider is out of credit (HIV-1966 and two more
 * papercuts on 2026-08-16 alone). Every one of those costs a turn to learn
 * something the machine knew before the session began.
 *
 * WHAT THIS FILE IS. Pure state: a map of probe id → last result, a revision,
 * and the renderers. No process spawning, no fs, no pi — all of that is
 * `probes.ts` and `index.ts`, so this half is testable without a harness.
 *
 * THE STATUS VOCABULARY is deliberately five words, and `unknown` is not a
 * synonym for `absent`:
 *
 *   ready     usable right now, no first-call cost worth mentioning
 *   warming   started, not usable yet — the only transient state
 *   degraded  usable but impaired (low credit, stale auth), and the detail says how
 *   absent    a prerequisite is genuinely missing; `hint` says how to install it
 *   unknown   the probe could not tell. NOT a failure verdict.
 *
 * Collapsing `unknown` into `absent` would make a probe that timed out read as
 * "you cannot do this", which is the flattering-direction lie in reverse: the
 * agent stops using a capability it has. A probe that cannot tell must say so.
 *
 * Persistence is `pi.appendEntry("readiness", snapshot)` — the idiom
 * `workflow/state.ts`, `plan/state.ts` and `tasks/state.ts` all use, for their
 * reasons: custom entries are structurally invisible to the LLM, survive
 * compaction, and are copied into a fork.
 */

export const READINESS_ENTRY_TYPE = "readiness";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

export type ProbeStatus = "ready" | "warming" | "degraded" | "absent" | "unknown";

const VALID_STATUSES: readonly ProbeStatus[] = ["ready", "warming", "degraded", "absent", "unknown"];

/** Sort weight: what is wrong sorts above what is fine. */
const STATUS_RANK: Record<ProbeStatus, number> = {
	absent: 0,
	degraded: 1,
	warming: 2,
	unknown: 3,
	ready: 4,
};

export interface ProbeResult {
	/** Stable id, e.g. `mcp.hive` or `devservices.postgres`. */
	id: string;
	/** Short human label for the deck row. */
	label: string;
	status: ProbeStatus;
	/** One line of evidence: "37 tools", "$0.28 left", "not installed". */
	detail?: string;
	/**
	 * What to DO when this is not ready — the actionable half, and the reason
	 * this document is worth injecting at all. Guidance at the decision point
	 * (technique #4): the remedy travels with the finding, not in a README.
	 */
	hint?: string;
	/** The tool or command that uses this capability, so the agent need not guess. */
	tool?: string;
	/** When the result was produced (ms since epoch). */
	at: number;
}

export interface ReadinessState {
	revision: number;
	startedAtMs: number;
	results: Record<string, ProbeResult>;
}

export function emptyReadiness(now: number): ReadinessState {
	return { revision: 0, startedAtMs: now, results: {} };
}

export function isEmpty(state: ReadinessState): boolean {
	return Object.keys(state.results).length === 0;
}

/**
 * Fold results in, reporting whether anything actually moved.
 *
 * `changed` is load-bearing rather than an optimisation: every revision is an
 * `appendEntry` plus a bus emit, and probes re-run on demand — a re-probe that
 * found the world unchanged must not grow the session file.
 *
 * Equality deliberately ignores `at`: a probe that reports the same status and
 * the same detail one minute later has not changed anything a reader cares
 * about, and treating a fresh timestamp as news would make every re-probe write.
 */
export function applyResults(
	state: ReadinessState,
	results: readonly ProbeResult[],
): { state: ReadinessState; changed: boolean } {
	let changed = false;
	const next: Record<string, ProbeResult> = { ...state.results };
	for (const result of results) {
		if (!result || typeof result.id !== "string" || !result.id) continue;
		if (!VALID_STATUSES.includes(result.status)) continue;
		const previous = next[result.id];
		if (previous && sameVerdict(previous, result)) continue;
		next[result.id] = result;
		changed = true;
	}
	if (!changed) return { state, changed: false };
	return { state: { ...state, revision: state.revision + 1, results: next }, changed: true };
}

function sameVerdict(a: ProbeResult, b: ProbeResult): boolean {
	return a.status === b.status && (a.detail ?? "") === (b.detail ?? "") && (a.hint ?? "") === (b.hint ?? "");
}

/** Every result, worst first, then alphabetically so the order is stable. */
export function orderedResults(state: ReadinessState): ProbeResult[] {
	return Object.values(state.results).sort((a, b) => {
		const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
		return rank !== 0 ? rank : a.id.localeCompare(b.id);
	});
}

export function countByStatus(state: ReadinessState): Record<ProbeStatus, number> {
	const counts: Record<ProbeStatus, number> = { ready: 0, warming: 0, degraded: 0, absent: 0, unknown: 0 };
	for (const result of Object.values(state.results)) counts[result.status] += 1;
	return counts;
}

/**
 * The collapsed one-liner, e.g. `env 6/8 ready · 1 warming · 1 absent`.
 *
 * Ready is a fraction rather than a count because "6 ready" alone answers the
 * wrong question: what an operator glances for is whether anything is missing.
 */
export function summaryLine(state: ReadinessState): string {
	if (isEmpty(state)) return "env probing";
	const counts = countByStatus(state);
	const total = Object.keys(state.results).length;
	const parts = [`env ${counts.ready}/${total} ready`];
	if (counts.warming) parts.push(`${counts.warming} warming`);
	if (counts.degraded) parts.push(`${counts.degraded} degraded`);
	if (counts.absent) parts.push(`${counts.absent} absent`);
	if (counts.unknown) parts.push(`${counts.unknown} unknown`);
	return parts.join(" · ");
}

const GLYPH: Record<ProbeStatus, string> = {
	ready: "✓",
	warming: "◐",
	degraded: "!",
	absent: "✗",
	unknown: "?",
};

/**
 * Deck lines. Only rows worth acting on are rendered by default: a list where
 * six of eight rows say "fine" buries the two that do not, and the band is
 * shared with every other publisher.
 */
export function renderLines(state: ReadinessState, options: { all?: boolean } = {}): string[] {
	const rows = orderedResults(state).filter((r) => (options.all ? true : r.status !== "ready"));
	return rows.map((r) => {
		const detail = r.detail ? ` — ${r.detail}` : "";
		const hint = r.status === "ready" || !r.hint ? "" : ` (${r.hint})`;
		return `${GLYPH[r.status]} ${r.label}${detail}${hint}`;
	});
}

/**
 * The `[Environment Snapshot]` block (HIV-1633), rendered for ONE injection at
 * the first agent start.
 *
 * Two rules the ticket is explicit about, both encoded here rather than in the
 * caller: it names the **tool** for each capability instead of telling the model
 * to go find one, and it is a snapshot — no promise that it stays true, because
 * a stale claim is worse than no claim.
 */
export function snapshotBlock(state: ReadinessState, now: number): string {
	if (isEmpty(state)) return "";
	const lines = orderedResults(state).map((r) => {
		const bits = [`${GLYPH[r.status]} ${r.label}: ${r.status}`];
		if (r.detail) bits.push(r.detail);
		if (r.tool) bits.push(`tool: ${r.tool}`);
		if (r.hint && r.status !== "ready") bits.push(r.hint);
		return `- ${bits.join(" · ")}`;
	});
	return [
		"[Environment Snapshot]",
		`Probed at session start (${new Date(now).toISOString()}); a snapshot, not a live view — re-run \`readiness\` if a capability matters now.`,
		...lines,
	].join("\n");
}

export function toEntry(state: ReadinessState): Record<string, unknown> {
	return {
		v: SCHEMA_VERSION,
		revision: state.revision,
		startedAtMs: state.startedAtMs,
		results: orderedResults(state),
	};
}

/**
 * Restore from session entries: the newest `readiness` snapshot wins.
 *
 * Scans backwards and stops at the first well-formed one — the same shape
 * `rehydrateWorkflow` uses, and for the same reason: earlier snapshots are
 * superseded, not merged.
 */
export function rehydrateReadiness(entries: readonly unknown[]): ReadinessState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (entry?.customType !== READINESS_ENTRY_TYPE) continue;
		const data = entry.data as { revision?: unknown; startedAtMs?: unknown; results?: unknown } | undefined;
		if (!data || !Array.isArray(data.results)) continue;
		const results: Record<string, ProbeResult> = {};
		for (const raw of data.results) {
			const parsed = parseResult(raw);
			if (parsed) results[parsed.id] = parsed;
		}
		return {
			revision: typeof data.revision === "number" ? data.revision : 0,
			startedAtMs: typeof data.startedAtMs === "number" ? data.startedAtMs : 0,
			results,
		};
	}
	return null;
}

function parseResult(raw: unknown): ProbeResult | null {
	if (typeof raw !== "object" || raw === null) return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.id !== "string" || !row.id) return null;
	if (typeof row.status !== "string" || !VALID_STATUSES.includes(row.status as ProbeStatus)) return null;
	return {
		id: row.id,
		label: typeof row.label === "string" && row.label ? row.label : row.id,
		status: row.status as ProbeStatus,
		...(typeof row.detail === "string" ? { detail: row.detail } : {}),
		...(typeof row.hint === "string" ? { hint: row.hint } : {}),
		...(typeof row.tool === "string" ? { tool: row.tool } : {}),
		at: typeof row.at === "number" ? row.at : 0,
	};
}
