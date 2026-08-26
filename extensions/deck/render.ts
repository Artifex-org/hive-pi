/**
 * deck rendering — pure over (sections, mode, now), so every behavior is
 * testable without a TUI. Style is injected: the extension passes theme
 * colors, tests pass identity functions and assert on plain strings.
 *
 * Design sources (HIV-1219 research):
 *  - Claude Code: dual task text — imperative `subject` at rest,
 *    present-continuous `activeForm` on the active row; and the lesson from
 *    its 5-row cap ("+N more" beats silent truncation).
 *  - t3code: all in-flight agent states render as one steady "working";
 *    completed agents linger below running ones and fold into a count.
 *  - agenda/run-view: the quiet marker — silence and progress look identical
 *    without one, and telling them apart is the point of a live view.
 */

import type {
	DeckAgentRow,
	DeckSectionId,
	DeckSectionState,
	DeckSubagentsSection,
	DeckTasksSection,
	DeckTaskRow,
} from "./protocol.ts";
import { SECTION_ORDER } from "./protocol.ts";

export interface DeckStyle {
	accent(text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
	error(text: string): string;
}

/** Identity style — what tests use, and the fallback for unthemed contexts. */
export const PLAIN_STYLE: DeckStyle = {
	accent: (text) => text,
	bold: (text) => text,
	dim: (text) => text,
	muted: (text) => text,
	success: (text) => text,
	warning: (text) => text,
	error: (text) => text,
};

/**
 * auto      — live sections expanded, idle sections folded into one summary
 *             line (the default: today's behavior for running subagents, one
 *             quiet line for everything else).
 * collapsed — everything folded into the single summary line.
 * expanded  — everything expanded.
 */
export type DeckMode = "auto" | "collapsed" | "expanded";

export const TASK_ROW_CAP = 12;
export const AGENT_ROW_CAP = 8;
export const DONE_FOLD = 3;
export const LINES_CAP = 16;
export const TOTAL_CAP = 30;
export const QUIET_AFTER_MS = 90_000;

const TASK_GLYPHS: Record<DeckTaskRow["status"], string> = {
	pending: "☐",
	in_progress: "⧗",
	completed: "☑",
};

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** A live section keeps the deck's 1 s repaint timer running. */
export function isLive(state: DeckSectionState): boolean {
	if (state.kind === "subagents") return state.rows.some((row) => row.state === "running");
	if (state.kind === "lines") return state.live === true;
	return false;
}

export function waitingOnInput(sections: ReadonlyMap<DeckSectionId, DeckSectionState>): number {
	let total = 0;
	for (const state of sections.values()) {
		if (state.kind !== "tasks" && state.waitingOnInput) total += state.waitingOnInput;
	}
	return total;
}

function taskCounts(state: DeckTasksSection): { pending: number; inProgress: number; completed: number } {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const row of state.rows) {
		if (row.status === "pending") pending++;
		else if (row.status === "in_progress") inProgress++;
		else completed++;
	}
	return { pending, inProgress, completed };
}

/** One short segment per section for the collapsed line. */
export function sectionSummary(state: DeckSectionState): string {
	switch (state.kind) {
		case "tasks": {
			const { pending, inProgress, completed } = taskCounts(state);
			const active = state.rows.find((row) => row.status === "in_progress");
			const label = active ? ` · ${active.activeForm ?? active.subject}` : "";
			return `tasks ☐${pending} ⧗${inProgress} ☑${completed}${label}`;
		}
		case "subagents": {
			const done = state.rows.filter((row) => row.state !== "running").length;
			const running = state.rows.length - done;
			return `agents ${done}/${state.rows.length}${running > 0 ? " working" : " done"}`;
		}
		case "lines":
			return state.summary;
	}
}

function renderTasksSection(state: DeckTasksSection, style: DeckStyle): string[] {
	const { pending, inProgress, completed } = taskCounts(state);
	const lines = [
		style.accent(style.bold("☰ TASKS")) +
			style.dim(`  ${pending} to do · ${inProgress} in progress · ${completed} done`),
	];

	const rows = state.rows;
	const shown = rows.slice(0, TASK_ROW_CAP);
	for (const row of shown) lines.push(renderTaskRow(row, style));
	if (rows.length > shown.length) {
		lines.push(style.dim(`  … +${rows.length - shown.length} more`));
		// The active row is the one line the user actually tracks; never let the
		// cap hide it.
		const hiddenActive = rows.slice(TASK_ROW_CAP).find((row) => row.status === "in_progress");
		if (hiddenActive) lines.push(renderTaskRow(hiddenActive, style));
	}
	return lines;
}

function renderTaskRow(row: DeckTaskRow, style: DeckStyle): string {
	const glyph =
		row.status === "in_progress"
			? style.warning(TASK_GLYPHS.in_progress)
			: row.status === "completed"
				? style.success(TASK_GLYPHS.completed)
				: TASK_GLYPHS.pending;
	const label = row.status === "in_progress" ? (row.activeForm ?? row.subject) : row.subject;
	const text = row.status === "completed" ? style.dim(label) : label;
	const blocked = row.blocked ? style.muted(" (blocked)") : "";
	return `  ${glyph} ${text}${blocked}`;
}

function renderSubagentsSection(state: DeckSubagentsSection, now: number, style: DeckStyle): string[] {
	const done = state.rows.filter((row) => row.state !== "running").length;
	const lines = [
		style.accent(style.bold("◈ SUBAGENTS")) + style.dim(`  ${done}/${state.rows.length} complete · ${state.mode}`),
	];

	// Running first, then failed, then done — live work is what the region is
	// for; finished rows linger below it rather than vanishing.
	const running = state.rows.filter((row) => row.state === "running");
	const failed = state.rows.filter((row) => row.state === "failed");
	const finished = state.rows.filter((row) => row.state === "done");
	const foldedDone = finished.length > DONE_FOLD ? finished.length - DONE_FOLD : 0;
	const ordered = [...running, ...failed, ...finished.slice(0, DONE_FOLD)];

	const shown = ordered.slice(0, AGENT_ROW_CAP);
	for (const row of shown) {
		lines.push(renderAgentRow(row, now, style));
		if (row.usage) lines.push(style.dim(`    ${row.usage}`));
	}
	if (ordered.length > shown.length) lines.push(style.dim(`  … +${ordered.length - shown.length} more`));
	if (foldedDone > 0) lines.push(style.dim(`  ${style.success("✓")} ${foldedDone} more finished`));
	return lines;
}

function renderAgentRow(row: DeckAgentRow, now: number, style: DeckStyle): string {
	const icon =
		row.state === "failed" ? style.error("✗") : row.state === "done" ? style.success("✓") : style.warning("◌");
	const elapsed = formatElapsed(now - row.startedAtMs);
	// All in-flight states present as one steady "working" — a stalled worker
	// is still the fleet doing its job. The quiet marker is the one exception:
	// prolonged silence is information.
	let status: string;
	if (row.state === "running") {
		const quietMs = now - (row.lastActivityAtMs ?? row.startedAtMs);
		status = quietMs > QUIET_AFTER_MS ? `working — no event ${formatElapsed(quietMs)}` : "working";
	} else {
		status = "finished";
	}
	const activity = row.activity ? `${style.dim(row.activity)} ` : "";
	return `  ${icon} ${row.agent} ${activity}${style.muted(`· ${elapsed} · ${status}`)}`;
}

function renderLinesSection(lines: readonly string[], style: DeckStyle): string[] {
	const shown = lines.slice(0, LINES_CAP);
	return shown.map((line, index) => (index === 0 ? style.accent(line) : line));
}

function renderSection(state: DeckSectionState, now: number, style: DeckStyle): string[] {
	switch (state.kind) {
		case "tasks":
			return renderTasksSection(state, style);
		case "subagents":
			return renderSubagentsSection(state, now, style);
		case "lines":
			return renderLinesSection(state.lines, style);
	}
}

function summaryLineFor(
	entries: ReadonlyArray<readonly [DeckSectionId, DeckSectionState]>,
	attention: number,
	style: DeckStyle,
): string {
	const segments = entries.map(([, state]) => sectionSummary(state));
	const attn = attention > 0 ? [style.warning(style.bold(`⚠ ${attention} waiting on input`))] : [];
	return `${style.accent("◈")} ${[...attn, ...segments].join(style.dim(" · "))}`;
}

/**
 * The whole widget, as lines. Null when there is nothing to say — the deck
 * removes the widget entirely rather than pinning an empty row.
 */
export function renderDeck(
	sections: ReadonlyMap<DeckSectionId, DeckSectionState>,
	mode: DeckMode,
	now: number,
	style: DeckStyle,
): string[] | null {
	const ordered = SECTION_ORDER.filter((id) => sections.has(id)).map(
		(id) => [id, sections.get(id) as DeckSectionState] as const,
	);
	if (ordered.length === 0) return null;

	const attention = waitingOnInput(sections);

	if (mode === "collapsed") return [summaryLineFor(ordered, attention, style)];

	const expandedEntries =
		mode === "expanded" ? ordered : ordered.filter(([, state]) => isLive(state));
	const foldedEntries = ordered.filter((entry) => !expandedEntries.includes(entry));

	const lines: string[] = [];
	if (attention > 0 && (mode === "expanded" || foldedEntries.length === 0)) {
		lines.push(style.warning(style.bold(`⚠ ${attention} waiting on input`)));
	}
	for (const [, state] of expandedEntries) lines.push(...renderSection(state, now, style));
	if (mode === "auto" && foldedEntries.length > 0) {
		// The folded summary sits LAST — adjacent to the editor, where the
		// collapsed line also lives, so toggling modes never makes it jump.
		lines.push(summaryLineFor(foldedEntries, attention, style));
	}

	if (lines.length > TOTAL_CAP) {
		return [...lines.slice(0, TOTAL_CAP), style.dim("… (deck truncated)")];
	}
	return lines;
}
