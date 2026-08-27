/**
 * ask — in-house `ask_user_question` (HIV-1220, replacing
 * `@juicesharp/rpiv-ask-user-question`).
 *
 * The interaction rules live in state.ts (pure, tested); the view in view.ts
 * (pure, tested); this file is the thin shell: schema, key routing, the
 * bottom-anchored overlay (the rpiv package's proven placement), fallbacks
 * for non-TUI modes, the `details` envelope the Hive request/question widget
 * consumes (HIV-1201), and a deck attention signal while a question is
 * pending (HIV-1219).
 *
 * Deliberately absent, recorded here so their absence reads as a decision:
 * previews (v2 if missed), overlay collapse (the deck signal covers "there
 * is a question" when the overlay is dismissed — and Esc-Esc + re-ask is the
 * recovery), vim j/k navigation (typing-first: every printable character
 * lands in the answer/note field, which is worth more than two extra nav
 * keys), and idle auto-continue timeouts.
 *
 * Queued user messages supersede the question. A blocking modal behind
 * which a steering message sits queued is a deadlock: the model waits for an
 * answer, the user's already-typed message waits for the model, and nobody
 * moves until someone finds the pane and hits Esc-Esc (observed 2026-08-19,
 * AUR-5500 planning session). So execute() refuses to open when
 * `ctx.hasPendingMessages()` is already true, and an `input` event arriving
 * while the overlay is up closes it — both return a `superseded` envelope
 * telling the model to read the user's message instead of re-asking.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DECK_SECTION_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import {
	QUESTION_ANSWER_CHANNEL,
	QUESTION_LISTENER_CHANNEL,
	type QuestionListenerEvent,
} from "../hive-common/channels.ts";
import { waitForAnswer } from "../hive-common/remoteAnswer.ts";
import {
	allAnswered,
	answers,
	initState,
	isAnswered,
	reduce,
	type AskAction,
	type AskQuestion,
	type AskState,
} from "./state.ts";
import { renderAskLines, type AskStyle } from "./view.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "1-5 words. Put the recommended option FIRST with '(Recommended)' appended." }),
	description: Type.Optional(Type.String({ description: "What choosing this means. One sentence." })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable snake_case id — answers are keyed on it, so keep it constant across retries." }),
	header: Type.String({ description: "Chip label, max 12 chars (e.g. 'Auth method')." }),
	question: Type.String({ description: "The complete question. Clear, specific, ends with a question mark." }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options." })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 mutually exclusive choices. NEVER include an 'Other' or 'None of the above' option — the UI always offers free text.",
	}),
});

export interface AskDetails {
	questions: AskQuestion[];
	answers?: Record<string, string[]>;
	dismissed?: boolean;
	no_ui?: boolean;
	/** A queued or newly arrived user message closed the question unanswered. */
	superseded?: boolean;
}

/** Normalize model-provided questions: ids unique and present, headers
 *  clamped, shapes forced. Pure so the rules are testable. */
export function sanitizeQuestions(
	raw: Array<{ id: string; header: string; question: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }>,
): AskQuestion[] {
	const seen = new Set<string>();
	return raw.map((question, index) => {
		let id = (question.id || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
		if (!id || seen.has(id)) id = `q${index + 1}${id ? `_${id}` : ""}`;
		seen.add(id);
		return {
			id,
			header: question.header.length > 12 ? question.header.slice(0, 12) : question.header,
			question: question.question,
			multiSelect: question.multiSelect === true,
			options: question.options.slice(0, 4).map((option) => ({
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			})),
		};
	});
}

function askStyle(theme: Theme): AskStyle {
	return {
		accent: (text) => theme.fg("accent", text),
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
		muted: (text) => theme.fg("muted", text),
		warning: (text) => theme.fg("warning", text),
		success: (text) => theme.fg("success", text),
	};
}

/** Raw terminal data → reducer action. Control keys first; every remaining
 *  printable lands in the text field (typing-first, no mode switch). */
export function routeKey(state: AskState, data: string): AskAction | null {
	if (matchesKey(data, Key.escape)) return { type: "escape" };
	if (matchesKey(data, Key.enter)) return { type: "enter" };
	if (matchesKey(data, Key.backspace)) return { type: "backspace" };
	if (matchesKey(data, Key.tab)) return { type: "nextQuestion" };
	if (matchesKey(data, Key.shift("tab"))) return { type: "prevQuestion" };
	if (matchesKey(data, Key.up)) return { type: "cursor", delta: -1 };
	if (matchesKey(data, Key.down)) return { type: "cursor", delta: 1 };
	if (state.focus === "options") {
		if (matchesKey(data, Key.right)) return { type: "nextQuestion" };
		if (matchesKey(data, Key.left)) return { type: "prevQuestion" };
		if (matchesKey(data, Key.space)) return { type: "space" };
		for (let digit = 1; digit <= 9; digit++) {
			if (matchesKey(data, String(digit) as "1")) return { type: "digit", digit };
		}
	}
	if (matchesKey(data, Key.space)) return { type: "typed", text: " " };
	// Printable text (including paste): no ESC sequences, no C0 controls.
	if (data.length > 0 && ![...data].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
		return { type: "typed", text: data };
	}
	return null;
}

function formatAnswerContent(questions: AskQuestion[], result: Record<string, string[]>): string {
	const lines = questions.map((question) => {
		const values = result[question.id] ?? [];
		return `${question.header}: ${values.length > 0 ? values.join("; ") : "(unanswered)"}`;
	});
	return `User answered:\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	// Tell hive-remote something here can be answered from a browser (HIV-1765).
	// It declares the `can_answer_questions` capability from listeners rather than
	// from config, so this announcement is what makes the answer form appear —
	// and its absence is what correctly hides one.
	//
	// ON session_start, NOT at registration. Extension factories run in load
	// order, and an announcement made while hive-remote has not yet subscribed
	// reaches nobody — the capability would then depend on which extension
	// happened to load first, which is exactly the kind of silent, ordering-shaped
	// bug this whole feature exists to remove. `session_start` runs after the
	// whole registry is built (the same reason plan defers `--plan` to it).
	pi.on("session_start", () => {
		try {
			pi.events.emit(QUESTION_LISTENER_CHANNEL, { tool: "ask_user_question" } satisfies QuestionListenerEvent);
		} catch {
			/* no bus, or hive-remote is not loaded — the local overlay is unaffected */
		}
	});

	// A user message outranks a pending question (see header). Registered once;
	// `supersedeActive` points at the currently open overlay's teardown, or is
	// null while no question is pending.
	let supersedeActive: (() => void) | null = null;
	pi.on("input", () => {
		supersedeActive?.();
	});

	const supersededResult = (details: AskDetails) => ({
		content: [
			{
				type: "text" as const,
				text: "A user message is waiting — the questions were closed unanswered. Read that message and act on it; only re-ask (in plain chat) if the decision is still open afterwards.",
			},
		],
		details: { ...details, superseded: true },
	});

	const signalPending = (pending: AskQuestion[] | null) => {
		try {
			pi.events.emit(DECK_SECTION_CHANNEL, {
				section: "ask",
				state: pending
					? {
							kind: "lines",
							// No ⚠ here — the deck's attention segment already prepends
							// one from `waitingOnInput`, and "⚠ 1 waiting on input · ⚠
							// question pending" (first dogfood session) says it twice.
							summary: "question pending",
							lines: [`? awaiting your answer: ${pending.map((question) => question.header).join(" · ")}`],
							waitingOnInput: 1,
						}
					: null,
			} satisfies DeckSectionEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask the user",
		description: [
			"Ask the user 1-4 structured multiple-choice questions and block until they answer.",
			"Use when you genuinely cannot proceed without a decision that is the user's to make.",
			"The UI always adds a free-text row, so never include an 'Other'/'None of the above' option.",
			"Answers come back keyed by question id as arrays of labels (plus any typed note).",
		].join(" "),
		promptSnippet: "Ask the user structured clarifying questions",
		promptGuidelines: [
			"Prefer one question with 2-4 concrete options; put the recommended option first with '(Recommended)'. Ask only when the answer changes what you do next.",
		],
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
		}),
		renderCall: (args, theme) => {
			const headers = Array.isArray((args as { questions?: Array<{ header?: string }> }).questions)
				? ((args as { questions: Array<{ header?: string }> }).questions ?? []).map((question) => question.header ?? "?")
				: [];
			return new Text(theme.fg("accent", "? ") + theme.bold(headers.join(" · ") || "question"), 0, 0);
		},
		renderResult: (result, _options, theme) => {
			const details = result.details as AskDetails | undefined;
			if (details?.superseded) return new Text(theme.fg("warning", "? superseded by a user message"), 0, 0);
			if (details?.dismissed) return new Text(theme.fg("warning", "? dismissed by the user"), 0, 0);
			if (details?.no_ui) return new Text(theme.fg("dim", "? no interactive UI — asked in chat"), 0, 0);
			const parts = Object.entries(details?.answers ?? {}).map(([, values]) => values.join("; "));
			return new Text(theme.fg("accent", "? ") + theme.fg("dim", parts.join(" · ") || "answered"), 0, 0);
		},
		async execute(callID, params, _signal, _onUpdate, ctx) {
			const questions = sanitizeQuestions(params.questions);
			const details: AskDetails = { questions };

			// Headless: no one is there to answer. Say so and let the model ask in
			// prose — hanging a factory run on a modal would be worse than useless.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return {
					content: [
						{
							type: "text" as const,
							text: "No interactive UI in this mode — ask the user directly in your reply instead.",
						},
					],
					details: { ...details, no_ui: true },
				};
			}

			// The deadlock guard (see header): a message the user already queued
			// answers before the overlay does — opening a blocking modal in front
			// of it would wedge the session until someone finds the pane.
			if (ctx.hasPendingMessages()) {
				return supersededResult(details);
			}

			signalPending(questions);
			try {
				if (ctx.mode === "rpc") {
					const result = await rpcFallback(ctx, questions);
					if (result === null) {
						return {
							content: [{ type: "text" as const, text: "The user dismissed the questions without answering." }],
							details: { ...details, dismissed: true },
						};
					}
					return { content: [{ type: "text" as const, text: formatAnswerContent(questions, result) }], details: { ...details, answers: result } };
				}

				// THE RACE (HIV-1765): this overlay, or a browser.
				//
				// A Hive-launched session runs pi as a real TUI in a tmux pane, so the
				// overlay opens exactly as it does locally — and nobody is sitting in
				// front of it. The operator is in a browser tab, where the same
				// question is now rendered with the same options. Whichever answers
				// first wins, and the loser is simply discarded: `done` resolves
				// `ctx.ui.custom` and tears the overlay down, so a remote answer closes
				// the local prompt rather than leaving two live ways to answer one
				// question.
				//
				// `remote` is disposed in every path (the finally below), which is not
				// tidiness: an undisposed waiter holds `done` for the rest of the
				// session and a later answer would fire it at a tool that has returned.
				const remote = waitForAnswer(pi.events, QUESTION_ANSWER_CHANNEL, callID);
				let settle: ((value: Record<string, string[]> | null) => void) | null = null;
				// Held rather than dropped if it wins the tighter race against the
				// factory below: an answer that arrives before the overlay exists
				// still has to be applied, not lost because nothing was listening for
				// the microsecond it took to open.
				let early: Record<string, string[]> | null = null;
				void remote.answered.then((answered) => {
					if (settle) settle(answered);
					else early = answered;
				});

				// Same held-if-early shape as `remote`: a user message that lands in
				// the instant before the overlay factory runs must still close it.
				let superseded = false;
				supersedeActive = () => {
					superseded = true;
					if (settle) settle(null);
				};

				let result: Record<string, string[]> | null;
				try {
					result = await ctx.ui.custom<Record<string, string[]> | null>(
						(tui, theme, _keybindings, done) => {
							let state = initState(questions);
							settle = done;
							if (superseded) done(null);
							else if (early) done(early);
							return {
								render: () => renderAskLines(state, askStyle(theme)),
								invalidate() {},
								handleInput(data: string): void {
									const action = routeKey(state, data);
									if (action) {
										const { state: next, effect } = reduce(state, action);
										state = next;
										if (effect?.kind === "submit") done(answers(state));
										else if (effect?.kind === "cancel") done(null);
									}
									tui.requestRender();
								},
							};
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "bottom-center",
								width: "100%",
								maxHeight: "90%",
								margin: { left: 0, right: 0, bottom: 0 },
							},
						},
					);
				} finally {
					settle = null;
					supersedeActive = null;
					remote.dispose();
				}

				if (result === null && superseded) {
					return supersededResult(details);
				}
				if (result === null) {
					return {
						content: [{ type: "text" as const, text: "The user dismissed the questions without answering. Do not re-ask; proceed on your best judgment or ask in plain chat." }],
						details: { ...details, dismissed: true },
					};
				}
				return {
					content: [{ type: "text" as const, text: formatAnswerContent(questions, result) }],
					details: { ...details, answers: result },
				};
			} finally {
				signalPending(null);
			}
		},
	});
}

/** RPC hosts get a sequential select/input walk — the sub-protocol has no
 *  custom components (the Aurora-embedding lesson: `select`/`confirm`/`input`
 *  are the only client-served callbacks). */
async function rpcFallback(ctx: ExtensionContext, questions: AskQuestion[]): Promise<Record<string, string[]> | null> {
	const out: Record<string, string[]> = {};
	for (const question of questions) {
		const labels = question.options.map((option) =>
			option.description ? `${option.label} — ${option.description}` : option.label,
		);
		const OTHER = "Other (type an answer)";
		const pick = await ctx.ui.select(question.question, [...labels, OTHER]);
		if (pick === undefined) return null;
		if (pick === OTHER) {
			const typed = await ctx.ui.input(question.question, "your answer");
			if (typed === undefined) return null;
			out[question.id] = [typed];
		} else {
			const index = labels.indexOf(pick);
			out[question.id] = [question.options[index]?.label ?? pick];
		}
	}
	return out;
}

// Re-exported for tests.
export { allAnswered, answers, initState, isAnswered, reduce };
