/**
 * ask — pure view (HIV-1220). Lines from state, style injected, testable
 * with identity style. Layout mirrors the surveyed consensus: header chips
 * as tabs (≤12 chars each), question, numbered option rows with digit
 * badges, one text row serving Other/notes, and a contextual hint line.
 */

import type { AskState } from "./state.ts";
import { allAnswered, isAnswered } from "./state.ts";

export interface AskStyle {
	accent(text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
	success(text: string): string;
}

export const PLAIN_ASK_STYLE: AskStyle = {
	accent: (text) => text,
	bold: (text) => text,
	dim: (text) => text,
	muted: (text) => text,
	warning: (text) => text,
	success: (text) => text,
};

const DESCRIPTION_MAX = 80;

export function renderAskLines(state: AskState, style: AskStyle): string[] {
	const question = state.questions[state.active];
	const draft = state.drafts[state.active];
	const lines: string[] = [];

	// Chips row — only when there is more than one question to tab between.
	if (state.questions.length > 1) {
		const chips = state.questions.map((entry, index) => {
			const mark = isAnswered(state, index) ? "✓" : "·";
			const chip = `${mark} ${entry.header}`;
			return index === state.active ? style.accent(style.bold(`[${chip}]`)) : style.dim(` ${chip} `);
		});
		lines.push(`${chips.join(" ")} ${style.muted(`${state.active + 1}/${state.questions.length}`)}`);
	}

	lines.push(style.bold(question.question));

	question.options.forEach((option, index) => {
		const selected = draft.selected.includes(index);
		const glyph = question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
		const pointer = state.focus === "options" && state.cursor === index ? style.accent("❯") : " ";
		const label = selected ? style.bold(option.label) : option.label;
		const description = option.description
			? style.dim(
					`  ${option.description.length > DESCRIPTION_MAX ? `${option.description.slice(0, DESCRIPTION_MAX - 1)}…` : option.description}`,
				)
			: "";
		lines.push(`${pointer} ${style.muted(`${index + 1}.`)} ${selected ? style.success(glyph) : glyph} ${label}${description}`);
	});

	// The text row: Other when nothing is selected, a note otherwise.
	const textRowActive = state.focus === "text" || (state.focus === "options" && state.cursor === question.options.length);
	const pointer = textRowActive ? style.accent("❯") : " ";
	const placeholder = draft.selected.length === 0 ? "Other — type your own answer" : "add a note to this answer";
	const textBody =
		draft.text.length > 0
			? draft.text + (state.focus === "text" ? style.accent("▏") : "")
			: state.focus === "text"
				? style.accent("▏")
				: style.dim(placeholder);
	lines.push(`${pointer} ${style.muted("✎")} ${textBody}`);

	lines.push(style.dim(hint(state)));
	return lines;
}

function hint(state: AskState): string {
	if (state.escArmed) return "esc again to dismiss — the agent will be told you declined";
	if (state.focus === "text") return "enter continue · esc back to options";
	const parts = ["1-9 pick", "↑↓ move", "enter next"];
	if (state.questions[state.active].multiSelect) parts.splice(1, 0, "space toggle");
	if (state.questions.length > 1) parts.push("tab question");
	parts.push("type to answer/note", "esc esc dismiss");
	return parts.join(" · ");
}

/** One line for the tool-call transcript row while the questionnaire is open. */
export function summaryLine(state: AskState, style: AskStyle): string {
	const answered = state.questions.filter((_question, index) => isAnswered(state, index)).length;
	const status = allAnswered(state) ? "ready" : `${answered}/${state.questions.length} answered`;
	return style.accent("? ") + style.bold(state.questions[state.active].header) + style.dim(` · ${status}`);
}
