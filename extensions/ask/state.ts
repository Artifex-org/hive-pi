/**
 * ask — pure questionnaire state (HIV-1220).
 *
 * A reducer over (state, action), no UI types anywhere, so every interaction
 * rule below is a unit test rather than a manual TUI session. The rules are
 * the synthesis the epic's research landed on, each with a measured source:
 *
 *  - digits jump + commit + advance in one press (Codex `request_user_input`;
 *    no multi-digit buffer — the schema caps options at 4, so one digit is
 *    always unambiguous).
 *  - typing any printable character on the options list drops into the text
 *    field, no mode switch (Codex).
 *  - ONE text field per question serves as both "Other" (when nothing is
 *    selected, the text IS the answer) and a note (when something is
 *    selected, the text is appended) — Codex's notes and Claude Code's Other
 *    unified, because "option B, but only for the API layer" is the most
 *    common real answer.
 *  - single-select commits advance to the next question; committing the last
 *    question auto-submits when everything is answered (Claude Code — no
 *    redundant review screen).
 *  - Esc is contextual and NEVER kills the turn from inside text entry
 *    (Codex; CC shipped that as a bug and fixed it): in text → back to
 *    options; on options → arm, and only a second Esc dismisses.
 */

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	id: string;
	header: string;
	question: string;
	multiSelect: boolean;
	options: AskOption[];
}

export interface Draft {
	/** Selected option indexes, in option order. */
	selected: number[];
	/** Other-answer / note text. */
	text: string;
}

export interface AskState {
	questions: AskQuestion[];
	drafts: Draft[];
	active: number;
	focus: "options" | "text";
	/** 0..options.length — the extra row is the text field. */
	cursor: number;
	/** First Esc arms, second dismisses. Any other action disarms. */
	escArmed: boolean;
}

export type AskAction =
	| { type: "cursor"; delta: number }
	| { type: "space" }
	| { type: "enter" }
	| { type: "digit"; digit: number }
	| { type: "typed"; text: string }
	| { type: "backspace" }
	| { type: "escape" }
	| { type: "nextQuestion" }
	| { type: "prevQuestion" };

export type AskEffect = { kind: "submit" } | { kind: "cancel" } | null;

export interface Reduced {
	state: AskState;
	effect: AskEffect;
}

export function initState(questions: AskQuestion[]): AskState {
	return {
		questions,
		drafts: questions.map(() => ({ selected: [], text: "" })),
		active: 0,
		focus: "options",
		cursor: 0, // the recommended option leads by convention, so Enter-Enter is the fast path
		escArmed: false,
	};
}

export function isAnswered(state: AskState, index: number): boolean {
	const draft = state.drafts[index];
	return draft.selected.length > 0 || draft.text.trim().length > 0;
}

export function allAnswered(state: AskState): boolean {
	return state.questions.every((_question, index) => isAnswered(state, index));
}

function firstUnanswered(state: AskState): number {
	const index = state.questions.findIndex((_question, i) => !isAnswered(state, i));
	return index === -1 ? state.active : index;
}

/** Answers keyed by question ID (never question text — ids survive rewording).
 *  Values are string arrays: selected labels in option order, then the text. */
export function answers(state: AskState): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	state.questions.forEach((question, index) => {
		const draft = state.drafts[index];
		const labels = draft.selected
			.slice()
			.sort((a, b) => a - b)
			.map((optionIndex) => question.options[optionIndex]?.label)
			.filter((label): label is string => label !== undefined);
		const note = draft.text.trim();
		out[question.id] = note ? [...labels, note] : labels;
	});
	return out;
}

function withDraft(state: AskState, index: number, draft: Draft): AskState {
	const drafts = state.drafts.slice();
	drafts[index] = draft;
	return { ...state, drafts };
}

function gotoQuestion(state: AskState, index: number): AskState {
	const count = state.questions.length;
	const active = ((index % count) + count) % count;
	return { ...state, active, cursor: 0, focus: "options", escArmed: false };
}

/** Advance after a committing action: next question, or submit when done —
 *  and never submit past an unanswered question silently. */
function advance(state: AskState): Reduced {
	if (state.active < state.questions.length - 1) {
		return { state: gotoQuestion(state, state.active + 1), effect: null };
	}
	if (allAnswered(state)) return { state, effect: { kind: "submit" } };
	return { state: gotoQuestion(state, firstUnanswered(state)), effect: null };
}

function commitOption(state: AskState, optionIndex: number): Reduced {
	const question = state.questions[state.active];
	if (optionIndex < 0 || optionIndex >= question.options.length) return { state, effect: null };
	const draft = state.drafts[state.active];
	if (question.multiSelect) {
		const selected = draft.selected.includes(optionIndex)
			? draft.selected.filter((index) => index !== optionIndex)
			: [...draft.selected, optionIndex];
		return {
			state: { ...withDraft(state, state.active, { ...draft, selected }), cursor: optionIndex, escArmed: false },
			effect: null,
		};
	}
	const next = withDraft(state, state.active, { ...draft, selected: [optionIndex] });
	return advance({ ...next, cursor: optionIndex, escArmed: false });
}

export function reduce(state: AskState, action: AskAction): Reduced {
	const question = state.questions[state.active];
	const draft = state.drafts[state.active];
	const textRow = question.options.length;

	switch (action.type) {
		case "cursor": {
			if (state.focus === "text") return { state, effect: null };
			const rows = textRow + 1;
			const cursor = (((state.cursor + action.delta) % rows) + rows) % rows;
			return { state: { ...state, cursor, escArmed: false }, effect: null };
		}

		case "space": {
			if (state.focus === "text") return { state: { ...state, drafts: state.drafts }, effect: null };
			if (state.cursor === textRow) return { state: { ...state, focus: "text", escArmed: false }, effect: null };
			if (question.multiSelect) return commitOption(state, state.cursor);
			return commitOption(state, state.cursor);
		}

		case "enter": {
			if (state.focus === "text") {
				// Committing the text field commits the QUESTION.
				return advance({ ...state, focus: "options", escArmed: false });
			}
			if (state.cursor === textRow) return { state: { ...state, focus: "text", escArmed: false }, effect: null };
			if (question.multiSelect) {
				// Enter commits the current row (if unselected) and the question.
				const withRow = draft.selected.includes(state.cursor)
					? { state: { ...state, escArmed: false }, effect: null as AskEffect }
					: commitOption(state, state.cursor);
				return advance(withRow.state);
			}
			return commitOption(state, state.cursor);
		}

		case "digit":
			return commitOption(state, action.digit - 1);

		case "typed": {
			// Printable input anywhere lands in the text field — no mode switch.
			const text = draft.text + action.text;
			return {
				state: { ...withDraft(state, state.active, { ...draft, text }), focus: "text", escArmed: false },
				effect: null,
			};
		}

		case "backspace": {
			if (state.focus !== "text") return { state, effect: null };
			return {
				state: withDraft(state, state.active, { ...draft, text: draft.text.slice(0, -1) }),
				effect: null,
			};
		}

		case "escape": {
			if (state.focus === "text") return { state: { ...state, focus: "options", escArmed: false }, effect: null };
			if (!state.escArmed) return { state: { ...state, escArmed: true }, effect: null };
			return { state, effect: { kind: "cancel" } };
		}

		case "nextQuestion":
			return { state: gotoQuestion(state, state.active + 1), effect: null };
		case "prevQuestion":
			return { state: gotoQuestion(state, state.active - 1), effect: null };
	}
}
