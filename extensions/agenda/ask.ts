/**
 * The `ask` policy — turn a decision asked in PROSE into a decision card.
 *
 * `ask_user_question` blocks the turn and renders an answerable card, and every
 * piece of plumbing behind it exists: the overlay, the Hive question row, the
 * typed `question_answer` command, the judge's ratification path. What is
 * missing is that nothing tells a model to reach for it — `ask_user_question`
 * appears in no prompt, role or skill in this repo outside the plan-grill kick.
 *
 * A prose question is not a question anyone is asked. No card renders, the
 * session is not marked as waiting, and the next automatic re-entry answers on
 * the user's behalf — which `question-guard.ts` calls "the single worst failure
 * mode of unattended re-entry, because it is silent and it looks like progress".
 *
 * ## This is rare, and that is not an argument against it
 *
 * Measured over 7,864 end-of-turn messages from one fleet-week: 8 ended in a
 * question mark (the existing guard's territory) and 4 asked in prose without
 * one. Roughly one in six hundred settles.
 *
 * It earns its place on cost, not frequency. Each of those four is a session
 * that either stalled with nobody knowing it was waiting, or was answered by a
 * policy continuation on the operator's behalf — and the four real endings read
 * like "Awaiting your scope decision: preserve the email-only boundary, or
 * authorize integrating the separately owned Shipping repair". Those are not
 * decisions a harness should be making by default.
 *
 * ## Why this is a nudge and not a wider guard
 *
 * The obvious fix is to widen `endsWithQuestion` so the guard vetoes these too.
 * That is the wrong trade. The guard's own header explains why it is a bare
 * final-character test: a false positive there STALLS the item, silently, and
 * a stalled item looks exactly like a finished one. Its narrowness is load
 * bearing.
 *
 * So this policy deliberately covers only what the guard does NOT: endings that
 * ask for a decision without a trailing question mark. Those are not vetoed
 * today — the chain runs straight past them — so converting one into a nudge
 * cannot stall anything that is not already stalling. A wrong guess costs one
 * turn, and the model is free to ignore the nudge and carry on.
 *
 * The pattern is the harness playbook's `ForceTool`: ask for the tool in a soft
 * prompt first, rather than compelling it. Escalating to native tool forcing is
 * deliberately not done here — the model may have good reason to proceed.
 */

import { atCap, record } from "./ledger.ts";
import type { Policy, PolicyContext, PolicyWork } from "./policy.ts";
import { stripCode } from "./question-guard.ts";

/**
 * Nudges per session.
 *
 * Three, not one: a long session legitimately reaches several decision points,
 * and one budget for the whole session would silently stop protecting after the
 * first. Not unbounded, because a model that ignores the nudge twice is telling
 * us it intends to proceed, and a fourth reminder is just a spent turn.
 */
export const MAX_ASK_NUDGES = 3;

const LEDGER_ID = "ask";

/**
 * Phrasings that ask a human to decide, WITHOUT a question mark.
 *
 * Deliberately request-shaped rather than topic-shaped. "confirm" alone matches
 * "I can confirm the tests pass", which is a report; "please confirm" cannot be
 * anything but a request.
 *
 * Every entry was validated against a fleet-week of real endings: this set
 * matches 4 of 7,864 and all four are genuine requests. Two candidates were cut
 * for firing on statements — "confirm whether", which matched "it will confirm
 * whether the missing install is the cause", and "unless you say otherwise",
 * which accompanies a stated assumption and a decision already taken. The
 * second is the behaviour we WANT unattended, not a question to convert.
 *
 * When adding a phrase, re-run that check. A false positive here costs one
 * wasted turn, which is cheap — but a set that drifts toward matching reports
 * turns every summary into a nudge.
 */
const DECISION_PHRASES: readonly RegExp[] = [
	/\blet me know\b/i,
	/\byour call\b/i,
	/\bshall i\b/i,
	/\bdo you want\b/i,
	/\bwould you like\b/i,
	/\bwhich (?:one )?(?:would you|should i|do you)\b/i,
	/\bbefore i proceed\b/i,
	/\bplease (?:confirm|advise|choose|decide|pick|specify)\b/i,
	/\bawaiting your\b/i,
	/\bsay the word\b/i,
];

/**
 * The final sentence of `text`, with code removed.
 *
 * Only the last sentence decides, for the same reason the question guard gives:
 * a message that quotes a question and then states a conclusion is not itself
 * asking one.
 */
function lastSentence(text: string): string {
	const stripped = stripCode(text).trim();
	if (!stripped) return "";
	// Split on sentence terminators followed by whitespace, and on line breaks —
	// a bulleted "- Let me know which you prefer" is a sentence for our purposes
	// even without terminal punctuation.
	const parts = stripped.split(/(?<=[.!?])\s+|\n+/).filter((part) => part.trim().length > 0);
	return (parts[parts.length - 1] ?? "").trim();
}

/**
 * Does this turn end by asking the user to decide, in prose?
 *
 * Returns false for anything ending in `?` — that case belongs to
 * `question-guard.ts`, which vetoes re-entry outright. Two mechanisms reacting
 * to the same ending would mean the guard's veto races a nudge that can never
 * be delivered.
 */
export function endsWithProseDecisionRequest(text: string | undefined): boolean {
	if (!text) return false;
	const sentence = lastSentence(text);
	if (!sentence) return false;
	// Strip trailing delimiters the same way the guard does before testing.
	const trimmed = sentence.replace(/[\s)\]}"'*_>]+$/u, "");
	if (trimmed.endsWith("?")) return false;
	return DECISION_PHRASES.some((phrase) => phrase.test(sentence));
}

export const ASK_NUDGE = [
	"That turn ended by asking the operator to decide something, in prose.",
	"",
	"A prose question reaches nobody: no decision card is rendered, the session is not",
	"marked as waiting on input, and the next automatic continuation will answer on the",
	"operator's behalf.",
	"",
	"If you genuinely cannot proceed without their decision, ask it with `ask_user_question` —",
	"one question, 2-4 concrete options, the one you would pick first and marked",
	'"(Recommended)". If you can proceed, then decide, state the assumption you made, and',
	"carry on. Either is fine. Ending the turn on the question is the one thing that is not.",
].join("\n");

export interface AskHooks {
	/**
	 * Can a human actually answer right now?
	 *
	 * False for an unattended run, where a blocking question is a stall with
	 * nobody to clear it — the failure HIV-1449 measured at 68 minutes. There,
	 * deciding and stating the assumption is the correct behaviour and this
	 * policy must stay silent.
	 */
	attended(): boolean;
}

export function createAskPolicy(hooks: AskHooks): Policy {
	return {
		name: "ask",

		decide(context: PolicyContext): PolicyWork | null {
			if (!endsWithProseDecisionRequest(context.lastAssistantText)) return null;
			if (!hooks.attended()) return null;
			if (atCap(context.ledger, LEDGER_ID, MAX_ASK_NUDGES)) return null;

			return {
				name: "ask",
				status: "",
				run: async () => ({
					metric: { outcome: "fail", value: 1 },
					inject: ASK_NUDGE,
					ledger: (state) => record(state, LEDGER_ID),
				}),
			};
		},
	};
}
