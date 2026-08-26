/**
 * status-footer — rendering.
 *
 * Pure functions only: snapshots and a theme in, strings out. Nothing here
 * touches the network, the clock or pi, which is what makes the layout testable
 * — and layout is where footers actually break, at the widths nobody tries.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type HiveRun, type HiveSnapshot, isTerminal } from "./hive.ts";
import type { LinearIssue, LinearSnapshot, LinearStateType } from "./linear.ts";
import type { Workspace } from "./workspace.ts";

export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** A droppable piece of a row. Higher priority survives longer as width shrinks. */
export interface Segment {
	text: string;
	priority: number;
}

export const SEPARATOR = " · ";

export function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function fitRow(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const gap = 2;
	if (visibleWidth(left) + visibleWidth(right) + gap <= width) {
		return `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;
	}
	return truncateToWidth(`${left}  ${right}`, width, "");
}

/**
 * packSegments joins segments in their given order, dropping the lowest-priority
 * ones until the result fits. Ties drop right-to-left, so the leading (most
 * contextual) segment of an equal-priority group is the one that survives.
 */
export function packSegments(segments: Segment[], width: number, separator = SEPARATOR): string {
	const kept = segments.map((segment, index) => ({ ...segment, index }));
	const fits = (list: typeof kept): boolean =>
		visibleWidth(list.map((s) => s.text).join(separator)) <= width;

	while (kept.length > 0 && !fits(kept)) {
		let victim = 0;
		for (let i = 1; i < kept.length; i++) {
			if (kept[i].priority <= kept[victim].priority) victim = i;
		}
		kept.splice(victim, 1);
	}
	return kept.map((s) => s.text).join(separator);
}

export interface Glyph {
	glyph: string;
	color: string;
}

export function runGlyph(state: string): Glyph {
	switch (state) {
		case "succeeded":
			return { glyph: "✓", color: "success" };
		case "failed":
			return { glyph: "✗", color: "error" };
		case "error":
			return { glyph: "!", color: "error" };
		case "canceled":
			return { glyph: "⊘", color: "dim" };
		case "running":
			return { glyph: "⟳", color: "warning" };
		default:
			return { glyph: "◌", color: "muted" };
	}
}

export function issueGlyph(stateType: LinearStateType): Glyph {
	switch (stateType) {
		case "started":
			return { glyph: "▶", color: "warning" };
		case "completed":
			return { glyph: "✓", color: "success" };
		case "canceled":
			return { glyph: "⊘", color: "dim" };
		case "triage":
			return { glyph: "△", color: "warning" };
		case "unstarted":
			return { glyph: "◔", color: "muted" };
		default:
			return { glyph: "○", color: "muted" };
	}
}

/**
 * describeRun is the one-glance state of a single run: progress while it is
 * moving, the verdict once it has stopped.
 */
export function describeRun(run: HiveRun, theme: ThemeLike): string {
	const { glyph, color } = runGlyph(run.state);
	const head = `${theme.fg("muted", run.pipeline)} ${theme.fg(color, glyph)}`;
	if (run.state === "running" && run.tasks && run.tasks.total > 0) {
		const done = run.tasks.succeeded;
		const failed = run.tasks.failed > 0 ? theme.fg("error", ` ✗${run.tasks.failed}`) : "";
		return `${head} ${theme.fg("dim", `${done}/${run.tasks.total}`)}${failed}`;
	}
	if (!isTerminal(run.state)) return `${head} ${theme.fg("dim", "queued")}`;
	if (run.state === "failed" && run.tasks && run.tasks.failed > 0) {
		return `${head} ${theme.fg("dim", `${run.tasks.failed} failed`)}`;
	}
	return head;
}

/**
 * hiveSegments renders the Hive half of the integration row.
 *
 * Priorities encode what matters when the terminal is narrow: my own run first,
 * then a RED trunk (which changes what I should do next), then how busy the
 * project is, and only then the historical pass rate. A green trunk drops early
 * — it is the expected state and says nothing new.
 */
export function hiveSegments(snapshot: HiveSnapshot, theme: ThemeLike): Segment[] {
	if (snapshot.status === "off" || snapshot.status === "foreign" || snapshot.status === "unresolved") return [];
	if (snapshot.status === "error") {
		return [{ text: theme.fg("dim", `unreachable (${snapshot.error ?? "error"})`), priority: 5 }];
	}

	const segments: Segment[] = [];
	if (snapshot.mine) segments.push({ text: describeRun(snapshot.mine, theme), priority: 6 });

	if (snapshot.trunk) {
		const { glyph, color } = runGlyph(snapshot.trunk.state);
		const red = snapshot.trunk.state !== "succeeded";
		const branch = snapshot.defaultBranch ?? "trunk";
		// A red trunk with a run already in flight is a different situation from a
		// red trunk nobody is working on: one may fix itself, the other will not.
		const inFlight = snapshot.trunkActive ? theme.fg("warning", "⟳") : "";
		segments.push({
			text: `${theme.fg("muted", branch)} ${theme.fg(color, glyph)}${inFlight}`,
			priority: red ? 5 : 2,
		});
	}

	// Runs of mine already have their own segment; this is "what else is going on".
	const others = snapshot.active.filter((run) => run.id !== snapshot.mine?.id).length;
	if (others > 0) segments.push({ text: theme.fg("dim", `${others} running`), priority: 3 });

	if (snapshot.health && snapshot.health.total > 0) {
		const { passed, total } = snapshot.health;
		const ratio = passed / total;
		const color = ratio >= 0.9 ? "success" : ratio >= 0.6 ? "warning" : "error";
		segments.push({ text: `${theme.fg("dim", "health ")}${theme.fg(color, `${passed}/${total}`)}`, priority: 1 });
	}
	return segments;
}

/**
 * linearSegments renders up to `max` tickets. `withState` is the degradation
 * knob: dropping the state name roughly halves the width while keeping the
 * identifier and the glyph, which is most of the signal.
 */
export function linearSegments(snapshot: LinearSnapshot, theme: ThemeLike, max = 2, withState = true): Segment[] {
	if (snapshot.status === "off" || snapshot.status === "unresolved" || snapshot.issues.length === 0) return [];
	if (snapshot.status === "error") {
		return [{ text: theme.fg("dim", `linear ${snapshot.error ?? "error"}`), priority: 1 }];
	}

	const shown = snapshot.issues.slice(0, max);
	const segments: Segment[] = shown.map((issue, index) => {
		const { glyph, color } = issueGlyph(issue.stateType);
		const head = `${theme.fg("accent", issue.identifier)} ${theme.fg(color, glyph)}`;
		return {
			text: withState ? `${head} ${theme.fg("dim", issue.stateName)}` : head,
			priority: 5 - index,
		};
	});
	const hidden = snapshot.issues.length - shown.length;
	if (hidden > 0) segments.push({ text: theme.fg("dim", `+${hidden}`), priority: 1 });
	return segments;
}

/**
 * integrationRow lays out Hive on the left and Linear on the right, degrading in
 * a fixed order rather than truncating: shed Linear's state names, then its
 * second ticket, and let packSegments shed Hive's low-priority segments. A
 * truncated status line is worse than a shorter one — the tail is where the
 * verdict lives.
 *
 * Returns null when there is nothing to say, so the footer costs no row at all
 * outside a Hive project.
 */
export function integrationRow(hive: HiveSnapshot, linear: LinearSnapshot, theme: ThemeLike, width: number): string | null {
	const left = hiveSegments(hive, theme);
	if (left.length === 0 && linear.issues.length === 0 && linear.status !== "error") return null;

	// Each side gets its own budget rather than competing for one pool. Half the
	// row for the tickets when there is Hive state to show, all of it when there
	// is not — so neither side can starve the other into invisibility, and what
	// gets dropped at a given width is predictable instead of emergent.
	const rightBudget = left.length === 0 ? width : Math.max(0, Math.floor(width / 2) - 1);
	const degradations: Array<{ max: number; withState: boolean }> = [
		{ max: 2, withState: true },
		{ max: 2, withState: false },
		{ max: 1, withState: true },
		{ max: 1, withState: false },
	];

	let right = "";
	for (const degradation of degradations) {
		const candidate = packSegments(linearSegments(linear, theme, degradation.max, degradation.withState), rightBudget);
		if (candidate) {
			right = candidate;
			break;
		}
	}

	const label = theme.fg("muted", "hive ");
	const leftBudget = Math.max(0, width - visibleWidth(right) - (right ? 2 : 0) - visibleWidth(label));
	const packed = packSegments(left, leftBudget);
	// No surviving segment means no label: "hive" alone says nothing.
	return fitRow(packed ? label + packed : "", right, width);
}

/** displayPath abbreviates $HOME to `~` so the workspace line spends its width on the path that matters. */
export function displayPath(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * workspaceRow is the "where am I" line. The PR number carries its run's glyph
 * so the most-asked question — did my PR pass — is answered without reading any
 * further.
 */
export function workspaceRow(
	workspace: Workspace,
	project: string,
	branch: string | null,
	mine: HiveRun | null,
	theme: ThemeLike,
): string {
	let pr = theme.fg("dim", "—");
	if (workspace.pr !== null) {
		const number = theme.fg("dim", `#${workspace.pr}`);
		if (mine && mine.pr === workspace.pr) {
			const { glyph, color } = runGlyph(mine.state);
			pr = `${number} ${theme.fg(color, glyph)}`;
		} else {
			pr = number;
		}
	}
	return [
		theme.fg("muted", "project "),
		theme.fg("accent", project),
		theme.fg("dim", ` · cwd ${displayPath(workspace.cwd)} · PR `),
		pr,
		theme.fg("dim", ` · branch ${branch ?? workspace.branch ?? "—"}`),
	].join("");
}
