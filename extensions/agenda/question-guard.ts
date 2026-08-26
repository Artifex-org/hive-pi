/**
 * The stale-question guard — pure, no I/O.
 *
 * An automatic re-entry that lands on a turn which ended by ASKING THE USER
 * something answers the question on the user's behalf, with whatever the
 * policy's prompt happens to say. The model then proceeds on a decision the
 * human never made. This is the single worst failure mode of unattended
 * re-entry, because it is silent and it looks like progress.
 *
 * So: if the last assistant turn ended on a question and the pending injection
 * is automatic, the iteration is cancelled and the item is marked as waiting on
 * the user. Ported from `~/.claude/hooks/loop-question-guard.sh`; living in the
 * driver rather than in one policy means it protects goal continuations and
 * loop wakes alike.
 *
 * Human-initiated turns are never guarded — a human who types while their own
 * question is on screen has answered it.
 */

/**
 * Strip fenced code blocks and inline code before looking for a question mark.
 *
 * Without this, a turn ending in a shell snippet (`grep -q "x" && echo "?"`) or
 * a regex reads as a question and silently stalls the item. Unterminated fences
 * are treated as running to end-of-text, which is the conservative reading: the
 * trailing content is code, so it cannot be a question.
 */
function stripCode(text: string): string {
	const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
	return withoutFences.replace(/`[^`\n]*`/g, " ");
}

/**
 * Does this assistant text end by asking the user something?
 *
 * Trailing whitespace and closing delimiters are ignored, so "Should I? )" and
 * "Ready?\n\n" both count. A question mark anywhere earlier does not — only the
 * final sentence decides, because an explanation that quotes a question and
 * then states a conclusion is not itself a question.
 */
export function endsWithQuestion(text: string): boolean {
	const stripped = stripCode(text);
	// Drop trailing whitespace and closing brackets/quotes, then look at the
	// last remaining character.
	const trimmed = stripped.replace(/[\s)\]}"'*_>]+$/u, "");
	return trimmed.endsWith("?");
}

export interface GuardInput {
	/** Text of the most recent assistant turn, or undefined when there is none. */
	lastAssistantText: string | undefined;
	/** Is the pending re-entry automatic (a policy) rather than typed by a human? */
	automatic: boolean;
}

/**
 * True when the pending automatic re-entry must be cancelled and handed back to
 * the human. Pure so the whole matrix is testable without pi.
 */
export function blocksReentry({ lastAssistantText, automatic }: GuardInput): boolean {
	if (!automatic) return false;
	if (!lastAssistantText) return false;
	return endsWithQuestion(lastAssistantText);
}
