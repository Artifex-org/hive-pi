/**
 * deck protocol — the bus contract between section publishers and the one
 * pinned widget (HIV-1219).
 *
 * WHY A BUS. pi builds a fresh jiti instance per extension with
 * `moduleCache: false`, so two extensions importing this module get two
 * separate copies — a shared module-level store would silently never update.
 * The only shared channel extensions have is `pi.events`. Publishers
 * (`tasks`, `plan`, `agenda`, `subagent`) emit their section state here; the
 * `deck` extension owns the single `ctx.ui.setWidget("deck", …)` slot and
 * renders whatever it last heard. This file is safe to import from every
 * side precisely because it holds types and pure functions only.
 *
 * WHAT MAY TRAVEL. Bus input is untrusted — any loaded extension can emit
 * anything — so the deck validates and clamps every payload with
 * `sanitizeSectionEvent` before touching it. Unlike the hive channels
 * (hive-common/channels.ts) this one does carry display strings, which is
 * acceptable for one reason: it is consumed for LOCAL rendering only, by an
 * extension that never forwards it anywhere, and everything on it (task
 * subjects, agent activity) is already present in the session transcript.
 * Nothing here may ever be relayed off-machine; a consumer that wants to do
 * that must go read the session entries under its own consent, the way
 * hive-remote does.
 */

export const DECK_SECTION_CHANNEL = "deck.section";

/**
 * Emitted by the deck when it (re)gains a paintable context. Publishers
 * respond by re-emitting their current section state. This exists because
 * extension load order is unknown: whichever side comes up second would
 * otherwise wait forever for an event the other side already sent.
 */
export const DECK_SYNC_CHANNEL = "deck.sync";

export type DeckSectionId =
	| "ask"
	| "conductor"
	| "gate"
	| "orchestrate"
	| "subagents"
	| "tasks"
	| "plan"
	| "opmode"
	| "env";

/** Render order, top to bottom. Attention first, live activity next, ambient
 *  state last. */
export const SECTION_ORDER: readonly DeckSectionId[] = [
	"ask",
	"conductor",
	// Above the other live sections: a running gate is the thing whose verdict
	// the session is blocked on, and it is short-lived — it clears the moment the
	// check ends, so it never competes for the band at rest (HIV-1929).
	"gate",
	"orchestrate",
	"subagents",
	"tasks",
	"plan",
	// Last, with the other ambient state: the operating mode is a standing fact
	// about the session rather than something happening in it, and it only
	// renders at all when the posture is not the default.
	"opmode",
	// Ambient too, and below opmode on purpose: environment readiness is a fact
	// about the machine, not about the session, and it renders only the rows
	// that are NOT ready — so at rest it occupies nothing (HIV-1969).
	"env",
];

export interface DeckTaskRow {
	status: "pending" | "in_progress" | "completed";
	/** Imperative title, shown at rest. */
	subject: string;
	/** Present-continuous form, shown on the in-progress row. */
	activeForm?: string;
	blocked?: boolean;
}

export interface DeckAgentRow {
	agent: string;
	state: "running" | "done" | "failed";
	/** Plain text, no ANSI — the deck applies theme colors. */
	activity?: string;
	startedAtMs: number;
	lastActivityAtMs?: number;
	/** Preformatted usage line (turns/tokens/model), plain text. */
	usage?: string;
}

/**
 * A section that ships pre-rendered lines. Used where a tested pure renderer
 * already exists next to the state it renders (conductor, orchestrate, plan)
 * — moving those folds into the deck would detach them from their tests for
 * no gain. `live` sections re-emit on their own cadence (the orchestrate
 * publisher keeps its 1 s repaint interval) and are auto-expanded.
 */
export interface DeckLinesSection {
	kind: "lines";
	/** One short segment for the collapsed line, e.g. "plan 4/9". */
	summary: string;
	lines: readonly string[];
	live?: boolean;
	waitingOnInput?: number;
}

export interface DeckTasksSection {
	kind: "tasks";
	rows: readonly DeckTaskRow[];
}

export interface DeckSubagentsSection {
	kind: "subagents";
	mode: string;
	rows: readonly DeckAgentRow[];
	waitingOnInput?: number;
}

export type DeckSectionState = DeckLinesSection | DeckTasksSection | DeckSubagentsSection;

export interface DeckSectionEvent {
	section: DeckSectionId;
	/** Replaces the slot's previous state. Null clears the slot. */
	state: DeckSectionState | null;
}

/** Clamps, applied on receive. Generous for real use, tight enough that a
 * misbehaving publisher cannot wedge the terminal. */
export const MAX_ROWS = 32;
export const MAX_LINES = 32;
export const MAX_TEXT = 200;

const SECTION_IDS = new Set<string>(SECTION_ORDER);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);
const AGENT_STATES = new Set(["running", "done", "failed"]);

function clampText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function clampCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(Math.floor(value), 99);
}

/**
 * Validate an untrusted bus payload into a `DeckSectionEvent`, or null when it
 * is not one. Unknown fields are dropped, strings clamped, arrays capped —
 * never thrown over: a malformed payload from one publisher must not take the
 * whole widget down.
 */
export function sanitizeSectionEvent(payload: unknown): DeckSectionEvent | null {
	if (typeof payload !== "object" || payload === null) return null;
	const raw = payload as Record<string, unknown>;
	if (typeof raw.section !== "string" || !SECTION_IDS.has(raw.section)) return null;
	const section = raw.section as DeckSectionId;

	if (raw.state === null || raw.state === undefined) return { section, state: null };
	if (typeof raw.state !== "object") return null;
	const state = raw.state as Record<string, unknown>;

	switch (state.kind) {
		case "lines": {
			const summary = clampText(state.summary);
			if (summary === undefined || !Array.isArray(state.lines)) return null;
			const lines = state.lines
				.map(clampText)
				.filter((line): line is string => line !== undefined)
				.slice(0, MAX_LINES);
			return {
				section,
				state: {
					kind: "lines",
					summary,
					lines,
					...(state.live === true ? { live: true } : {}),
					...(clampCount(state.waitingOnInput) ? { waitingOnInput: clampCount(state.waitingOnInput) } : {}),
				},
			};
		}
		case "tasks": {
			if (!Array.isArray(state.rows)) return null;
			const rows: DeckTaskRow[] = [];
			for (const entry of state.rows.slice(0, MAX_ROWS)) {
				if (typeof entry !== "object" || entry === null) continue;
				const row = entry as Record<string, unknown>;
				const subject = clampText(row.subject);
				if (subject === undefined || typeof row.status !== "string" || !TASK_STATUSES.has(row.status)) continue;
				rows.push({
					status: row.status as DeckTaskRow["status"],
					subject,
					...(clampText(row.activeForm) !== undefined ? { activeForm: clampText(row.activeForm) } : {}),
					...(row.blocked === true ? { blocked: true } : {}),
				});
			}
			return { section, state: { kind: "tasks", rows } };
		}
		case "subagents": {
			const mode = clampText(state.mode);
			if (mode === undefined || !Array.isArray(state.rows)) return null;
			const rows: DeckAgentRow[] = [];
			for (const entry of state.rows.slice(0, MAX_ROWS)) {
				if (typeof entry !== "object" || entry === null) continue;
				const row = entry as Record<string, unknown>;
				const agent = clampText(row.agent);
				if (agent === undefined || typeof row.state !== "string" || !AGENT_STATES.has(row.state)) continue;
				if (typeof row.startedAtMs !== "number" || !Number.isFinite(row.startedAtMs)) continue;
				rows.push({
					agent,
					state: row.state as DeckAgentRow["state"],
					startedAtMs: row.startedAtMs,
					...(clampText(row.activity) !== undefined ? { activity: clampText(row.activity) } : {}),
					...(typeof row.lastActivityAtMs === "number" && Number.isFinite(row.lastActivityAtMs)
						? { lastActivityAtMs: row.lastActivityAtMs }
						: {}),
					...(clampText(row.usage) !== undefined ? { usage: clampText(row.usage) } : {}),
				});
			}
			return {
				section,
				state: {
					kind: "subagents",
					mode,
					rows,
					...(clampCount(state.waitingOnInput) ? { waitingOnInput: clampCount(state.waitingOnInput) } : {}),
				},
			};
		}
		default:
			return null;
	}
}
