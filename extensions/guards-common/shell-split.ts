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
 * It is a segmenter, not a shell. It knows about quotes, backslash escapes,
 * `$( … )`, the `&` that belongs to a redirect (`2>&1`, `>&2`, `&>file`) and
 * here-documents, and nothing else — no process substitution, no subshell
 * grouping. The two directions it can be wrong in are not symmetric.
 * Under-splitting is harmless: an unbalanced quote swallows the rest of the
 * string into one segment, which is exactly the whole-command scan a caller
 * would otherwise have done. OVER-splitting is the one that costs coverage —
 * honouring a separator the shell would not leaves the tail of a command in a
 * segment a caller then skips. The redirect `&` was the visible case (a
 * delivery guard read `git push … 2>&1` as a push followed by a command named
 * `1`); it is no longer a separator.
 *
 * A here-document fed to a command that only READS its input (`gh pr create
 * --body-file - <<'EOF'`, `git commit -F -`, `cat`) is data, not commands, so
 * its body never becomes segments: a quoted-delimiter body (`<<'EOF'`) is
 * literal bytes and is dropped from the segment text, and an expanding body
 * that contains `$` or a backtick stays attached to its command's segment, so
 * a caller parsing that segment sees the substitution. A body fed to anything
 * else — a shell, an interpreter, `ssh`, or a reader whose output is piped on
 * (`cat <<EOF | bash`) — may be a script, so its lines are split as commands,
 * exactly as if the here-document were not there.
 */

export type Separator = "&&" | "||" | ";" | "|" | "&" | "\n" | "";

/** One top-level command and the operator that ends it ("" for the last). */
export interface CommandSegment {
	text: string;
	separator: Separator;
}

const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([A-Za-z_][\w.-]*))/y;

interface PendingHeredoc {
	delimiter: string;
	quoted: boolean;
	stripTabs: boolean;
	/** The consuming command only reads its input; it never runs it. */
	reader: boolean;
	/** Index of the segment the operator belongs to. */
	segment: number;
}

/** Commands that read a here-document as data and do not execute it. */
const HEREDOC_READERS = new Set(["cat", "gh", "git", "hive", "tee", "wc", "head", "tail", "grep", "jq", "base64"]);

function commandName(segment: string): string {
	const words = segment.trim().split(/\s+/);
	while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
	return (words[0] ?? "").replace(/^.*\//, "");
}

/** Inside an arithmetic `(( … ))`, `<<` is a shift, not a here-document. */
function inArithmetic(segment: string): boolean {
	return (segment.match(/\(\(/g)?.length ?? 0) > (segment.match(/\)\)/g)?.length ?? 0);
}

/**
 * Consume the here-document bodies that start after the newline at `start`.
 * Returns where parsing resumes and the body text a caller must still see
 * (expanding bodies with a substitution in them), or "".
 */
function consumeHeredocs(command: string, start: number, pending: PendingHeredoc[]): { resume: number; kept: string } {
	let pos = start;
	let kept = "";
	for (const doc of pending) {
		let body = "";
		while (pos < command.length) {
			const end = command.indexOf("\n", pos);
			const line = command.slice(pos, end < 0 ? command.length : end);
			pos = end < 0 ? command.length : end + 1;
			if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
			body += `${line}\n`;
		}
		if (!doc.quoted && /[$`]/.test(body)) kept += `\n${body}`;
	}
	return { resume: pos, kept };
}

/**
 * Split a compound shell command into its top-level segments, each with the
 * operator that ends it.
 *
 * `&&`, `||`, `;`, `|` and a background `&` separate segments; quotes,
 * backslash escapes and `$( … )` are respected so a separator inside a body
 * value does not split. Callers checking execution boundaries can opt into
 * top-level newlines too.
 */
export function splitCommandList(command: string, splitNewlines = false): CommandSegment[] {
	const segments: CommandSegment[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let depth = 0; // $( ) nesting
	let heredocs: PendingHeredoc[] = [];
	const end = (separator: Separator) => {
		segments.push({ text: current, separator });
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote) {
			current += ch;
			if (quote === '"' && ch === "\\" && next !== undefined) {
				current += next;
				i++;
			} else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			current += ch + next;
			i++;
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
		if (depth > 0) {
			current += ch;
			continue;
		}
		// `<<<` is a here-string, never a here-document (at either of its `<<`).
		if (ch === "<" && next === "<" && command[i + 2] !== "<" && command[i - 1] !== "<" && !inArithmetic(current)) {
			HEREDOC.lastIndex = i;
			const match = HEREDOC.exec(command);
			if (match) {
				const quoted = match[2] !== undefined || match[3] !== undefined || match[4] === "\\";
				heredocs.push({ delimiter: match[2] ?? match[3] ?? match[5], quoted, stripTabs: match[1] === "-", reader: HEREDOC_READERS.has(commandName(current)), segment: segments.length });
				current += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (ch === "\n" && heredocs.length > 0) {
			const data = heredocs.every((doc) => doc.reader && !segments.slice(doc.segment).some((segment) => segment.separator === "|"));
			if (!data) heredocs = []; // a script: its lines are parsed as commands below
		}
		if (ch === "\n" && heredocs.length > 0) {
			const { resume, kept } = consumeHeredocs(command, i + 1, heredocs);
			heredocs = [];
			current += kept;
			if (splitNewlines) end("\n");
			else current += "\n";
			i = resume - 1;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			end(ch === "&" ? "&&" : "||");
			i++;
			continue;
		}
		// The `&` of a redirect (`2>&1`, `>&2`, `<&0`, `&>file`) and the `|` of
		// `>|` belong to the redirect, not a separator.
		const prev = command[i - 1];
		if ((ch === "&" && (prev === ">" || prev === "<" || next === ">")) || (ch === "|" && prev === ">")) {
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || (splitNewlines && ch === "\n")) {
			end(ch as Separator);
			continue;
		}
		current += ch;
	}
	if (current.trim()) segments.push({ text: current, separator: "" });
	return segments;
}

/**
 * Split a compound shell command into its top-level segments.
 *
 * The text-only view of {@link splitCommandList}. `onPipeline` is called for
 * every `|` or background `&` separator.
 */
export function splitCommands(command: string, splitNewlines = false, onPipeline?: () => void): string[] {
	return splitCommandList(command, splitNewlines).map((segment) => {
		if (segment.separator === "|" || segment.separator === "&") onPipeline?.();
		return segment.text;
	});
}

const FD_DUPLICATION = /[<>]&(?:\d+|-)(?=[\s;&|)]|$)/y;
const DISCARDED_OUTPUT = /(?:&>>?|>>?|>\|)[ \t]*\/dev\/null(?=[\s;&|)]|$)/y;
const HEREDOC_OPERATOR = /<<-?[ \t]*(?:'[^'\n]*'|"[^"\n]*"|\\?[A-Za-z_][\w.-]*)/y;

/**
 * Remove the redirections from ONE segment that neither read nor write a file:
 * fd duplication (`2>&1`, `>&2`, `<&0`, `>&-`), output discarded to
 * `/dev/null`, and here-document operators (whose bodies {@link
 * splitCommandList} already took out). `other` reports any redirection left —
 * a file read or write, a here-string, a process substitution — which a
 * caller cannot see the effect of.
 */
export function stripBenignRedirects(segment: string): { text: string; other: boolean } {
	let out = "";
	let other = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		const next = segment[i + 1];
		if (quote) {
			out += ch;
			if (quote === '"' && ch === "\\" && next !== undefined) {
				out += next;
				i++;
			} else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			out += ch + next;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch !== "<" && ch !== ">" && !(ch === "&" && next === ">")) {
			out += ch;
			continue;
		}
		let matched = 0;
		for (const pattern of [FD_DUPLICATION, DISCARDED_OUTPUT, HEREDOC_OPERATOR]) {
			pattern.lastIndex = i;
			const match = pattern.exec(segment);
			if (match && !(pattern === HEREDOC_OPERATOR && (segment[i + 2] === "<" || segment[i - 1] === "<"))) {
				matched = match[0].length;
				break;
			}
		}
		if (matched === 0) {
			other = true;
			out += ch;
			continue;
		}
		// An fd number written directly before the operator (`2>&1`) is part of it.
		out = out.replace(/(^|\s)\d+$/, "$1") + " ";
		i += matched - 1;
	}
	return { text: out, other };
}
