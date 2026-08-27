/**
 * settings — pure view. Lines from state, style injected, testable with the
 * identity style. Same shape as `ask/view.ts`, for the same reason: the render
 * is where the off-by-one bugs live, and they are only cheap to find if the
 * render is a function of data rather than of a mounted TUI.
 */

import { GROUP_LABELS, groupRows, navigationOrder, type SettingRow } from "./registry.ts";

export interface SettingsStyle {
	accent(text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
	success(text: string): string;
}

export const PLAIN_SETTINGS_STYLE: SettingsStyle = {
	accent: (text) => text,
	bold: (text) => text,
	dim: (text) => text,
	muted: (text) => text,
	warning: (text) => text,
	success: (text) => text,
};

/** Width below which the two-column row would collide with itself. */
const MIN_WIDTH = 44;
const LABEL_BUDGET = 30;

function truncate(text: string, max: number): string {
	if (max <= 1) return text.slice(0, Math.max(0, max));
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `[ ON  ]` / `[ OFF ]` — padded to one width so the column does not jitter as
 * rows toggle. A moving column reads as the page redrawing rather than one
 * value changing, which is the opposite of the feedback a toggle owes you.
 */
export function switchLabel(value: boolean): string {
	return value ? "[ ON  ]" : "[ OFF ]";
}

export interface SettingsViewState {
	rows: readonly SettingRow[];
	/** Index into `navigationOrder(rows)`, not into `rows`. */
	cursor: number;
	/** Set after a write fails, so the page never silently lies about state. */
	error?: string;
}

export function renderSettingsLines(state: SettingsViewState, style: SettingsStyle, width: number): string[] {
	const inner = Math.max(MIN_WIDTH, width);
	const order = navigationOrder(state.rows);
	const lines: string[] = [];

	lines.push(style.accent(style.bold("hive-pi settings")));
	lines.push("");

	if (order.length === 0) {
		lines.push(style.muted("No settings registered."));
		return lines;
	}

	let flat = 0;
	for (const { group, rows } of groupRows(state.rows)) {
		lines.push(style.muted(GROUP_LABELS[group]));
		for (const row of rows) {
			const selected = flat === state.cursor;
			const caret = selected ? style.accent("›") : " ";
			const label = truncate(row.spec.label, LABEL_BUDGET).padEnd(LABEL_BUDGET);
			const sw = row.value ? style.success(switchLabel(true)) : style.dim(switchLabel(false));
			const text = `${caret} ${selected ? style.bold(label) : label} ${sw}`;
			lines.push(text);

			// Warnings show always — a consequence you only see after enabling is
			// one you were not given the chance to weigh. Hints show only when on,
			// because a caveat about behaviour is noise while the thing is off.
			if (row.spec.warning) {
				lines.push(style.warning(truncate(`    ⚠ ${row.spec.warning}`, inner)));
			}
			if (row.value && row.spec.hint) {
				lines.push(style.dim(truncate(`    ${row.spec.hint}`, inner)));
			}
			flat++;
		}
		lines.push("");
	}

	if (state.error) {
		lines.push(style.warning(truncate(`could not save: ${state.error}`, inner)));
		lines.push("");
	}

	lines.push(style.dim("↑↓ move · space toggle · esc close"));
	return lines;
}

/** Clamp a cursor move to the navigable range. Wrapping is deliberate. */
export function moveCursor(cursor: number, delta: number, count: number): number {
	if (count <= 0) return 0;
	return (((cursor + delta) % count) + count) % count;
}
