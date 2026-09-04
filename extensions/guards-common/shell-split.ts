/**
 * Top-level segmentation of a compound shell command.
 *
 * This started life inside `pr-attachments/logic.ts`, where it answered one
 * question: which segment of `git push && gh pr create …` is the `gh` call the
 * attachment nudge should talk about. `gh-body-guard.ts` needs the same answer
 * for the opposite reason — to stop attributing ANOTHER command's `--body` to
 * gh — so the splitter moved here, to the directory both can import from, and
 * `pr-attachments/logic.ts` re-exports it so its own callers and tests are
 * untouched.
 *
 * It is a segmenter, not a shell. It knows about quotes and `$( … )` and
 * nothing else — no heredocs, no process substitution, no backslash-escaped
 * separators outside quotes. That is deliberate, and the two directions it can
 * be wrong in are not symmetric. Under-splitting is harmless: an unbalanced
 * quote swallows the rest of the string into one segment, which is exactly the
 * whole-command scan a caller would otherwise have done. OVER-splitting is the
 * one that costs coverage — this honours a separator the shell would not, most
 * visibly a lone `&` inside a redirect (`2>&1`), which can leave the tail of a
 * command in a segment a caller then skips. That is the fail-open direction
 * every guard in this directory already accepts.
 */

/**
 * Split a compound shell command into its top-level segments.
 *
 * `&&`, `||`, `;`, and `|` separate segments; quotes and `$( … )` are respected
 * so a separator inside a body value does not split. Good enough to decide
 * which segment is the `gh` invocation — the guard does the same kind of scan.
 */
export function splitCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let depth = 0; // $( ) nesting
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "$" && next === "(") {
			depth++;
			current += ch;
			continue;
		}
		if (ch === ")" && depth > 0) {
			depth--;
			current += ch;
			continue;
		}
		if (depth === 0) {
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				segments.push(current);
				current = "";
				i++;
				continue;
			}
			if (ch === ";" || ch === "|" || ch === "&") {
				segments.push(current);
				current = "";
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current);
	return segments;
}
