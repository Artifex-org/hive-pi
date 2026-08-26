/**
 * papercuts — the log format and its parser.
 *
 * WHY IN-THE-MOMENT AND NOT AFTER-THE-FACT.
 *
 * The workstation already mines transcripts nightly (the session-introspection
 * timer, 07:00). That is archaeology: it can only recover friction that left a
 * trace — a failed command, a guard hit, a retry loop. The expensive friction
 * leaves no trace at all, because the model ROUTES AROUND it and succeeds. A
 * doc that was wrong, a workflow that took four steps, a tool whose error message
 * sent it down a dead end for one turn — all of that ends in a green result and
 * is therefore invisible to any miner. The only moment it is knowable is the
 * moment it is felt, by the only party that felt it.
 *
 * WHY A FILE FORMAT AT ALL, RATHER THAN JSONL.
 *
 * Two readers with opposite needs. A human runs `grep -n "hive check" papercuts.md`
 * and wants to read the hit without a jq incantation; a future miner wants the
 * fields back. Markdown with a fixed skeleton serves both — the friction text is
 * literal in the file, and `parseEntries` recovers the record. JSONL would serve
 * only the second, and this log's whole value is that someone actually reads it.
 *
 * THE FORMAT.
 *
 *     ## 2026-08-15T09:12:04.113Z · blocking
 *     - cwd: /home/dev/repos/hive-pi__worktrees/feature-hiv-1883
 *     - context: running the scoped test file
 *     > `npm run check` is whole-project, so a half-written sibling file
 *     > fails a run that has nothing to do with my change.
 *
 * Append-only: a new entry is bytes at the end, never a rewrite (the rewrite
 * happens only when capping, and is a separate, explicit step). Greppable: every
 * field is on its own line, in plain text, with a literal key.
 *
 * The friction body is BLOCKQUOTED, which is the one non-obvious choice here. It
 * is what makes the format closed under its own content: friction text about
 * markdown headings ("the README's `## Config` section is wrong") would otherwise
 * open a new entry mid-body and split one record into two. `> ` also survives a
 * markdown renderer intact, so the file reads as a document rather than as a
 * dump.
 *
 * Everything in this module is pure and synchronous. It is called from a TOOL,
 * not from an event handler — but the house constraint (pi awaits handlers
 * serially, so a slow handler IS the agent loop) is the reason the parser does
 * one pass over lines and allocates one object per entry rather than reaching
 * for a markdown library.
 */

/**
 * How bad it was.
 *
 * Three levels, not five. The distinction that has to survive a model's snap
 * judgement mid-task is "did this stop me" (blocking) vs "did this cost me a
 * detour" (moderate) vs "this was merely annoying" (minor). A finer scale would
 * be filled in more precisely by nobody and would make the log harder to sort.
 */
export type Severity = "minor" | "moderate" | "blocking";

export const SEVERITIES: readonly Severity[] = ["minor", "moderate", "blocking"];

/** What the model supplies. */
export interface PapercutInput {
	friction: string;
	context?: string;
	severity?: Severity;
}

/** What the harness supplies. Split from the input so a test can pin both. */
export interface EntryMeta {
	/** ISO 8601, UTC. Passed in rather than read here, so tests are deterministic. */
	at: string;
	cwd: string;
}

/** One logged papercut, as stored and as recovered. */
export interface Entry {
	at: string;
	severity: Severity;
	cwd: string;
	friction: string;
	/** Absent — not empty — when the model did not say what it was doing. */
	context?: string;
}

/** The heading that opens an entry. Anchored, so a blockquoted `## ` never matches. */
const HEADING = /^## (\S+) · (minor|moderate|blocking)\s*$/;
const META = /^- (cwd|context): ?(.*)$/;

/**
 * A missing or unrecognised severity is `minor`.
 *
 * The default has to be the LOW one. A tool whose omitted field means "blocking"
 * teaches the model to think before every call, and thinking before the call is
 * exactly the tax that stops it being made at all. The cost of a misfiled minor
 * is that someone reading the log sorts it themselves.
 */
export function normalizeSeverity(value: unknown): Severity {
	return SEVERITIES.includes(value as Severity) ? (value as Severity) : "minor";
}

/**
 * Normalize an input into the record that will actually be stored.
 *
 * Exported because it is half of the round-trip property: the file cannot hold
 * what was never storable, so `parseEntries(formatEntry(x))[0]` equals
 * `toEntry(x)` — not `x`. Everything lossy (trimming, collapsing a multi-line
 * `context` onto its one line) happens HERE, once, where a test can see it,
 * rather than being smeared across the renderer and the parser.
 */
export function toEntry(input: PapercutInput, meta: EntryMeta): Entry {
	const context = collapse(input.context ?? "");
	return {
		// `at` has to survive the heading, which is WHITESPACE-DELIMITED: a
		// timestamp with a space in it renders a heading `parseEntries` cannot
		// match, and the entry then vanishes on the way back out — silently, which
		// is the worst way for a log to lose a record. Stripped here rather than in
		// the renderer so that `toEntry` stays the single place the round trip can
		// be broken, and so a test can see the loss.
		at: collapse(meta.at).replace(/\s/g, "") || new Date(0).toISOString(),
		severity: normalizeSeverity(input.severity),
		cwd: collapse(meta.cwd),
		// Interior newlines survive: the body is a blockquote, and a stack trace
		// or a pasted error is often the most useful thing in the entry.
		friction: input.friction.trim(),
		...(context ? { context } : {}),
	};
}

/** Render a stored record. Trailing newline included: the file is append-only. */
export function renderEntry(entry: Entry): string {
	const lines = [`## ${entry.at} · ${entry.severity}`, `- cwd: ${entry.cwd}`];
	if (entry.context) lines.push(`- context: ${entry.context}`);
	for (const line of entry.friction.split("\n")) {
		// A bare `>` for an empty line: `> ` with a trailing space is invisible
		// in a diff and gets eaten by editors that strip trailing whitespace,
		// which would silently drop the blank line on the way back out.
		lines.push(line ? `> ${line}` : ">");
	}
	return `${lines.join("\n")}\n\n`;
}

/** The one call sites make: normalize, then render. */
export function formatEntry(input: PapercutInput, meta: EntryMeta): string {
	return renderEntry(toEntry(input, meta));
}

/**
 * Read the log back.
 *
 * NEVER THROWS. This parses a plain file that a human is invited to grep, open
 * and edit, so malformed content is the expected steady state, not an error
 * case: a half-written entry from a killed process, a hand-added note, a
 * conflict marker. Anything that is not a well-formed entry is skipped and the
 * entries around it still come back — the alternative (one bad block loses the
 * file) is how a log stops being trusted.
 *
 * An entry needs only its heading to be recovered. A heading with no body yields
 * an empty `friction`, which is honest: the timestamp and severity were really
 * recorded, and dropping the record would hide that something was logged.
 */
export function parseEntries(markdown: string): Entry[] {
	const entries: Entry[] = [];
	let current: Entry | null = null;
	let body: string[] = [];

	const flush = () => {
		if (!current) return;
		// Trailing blank lines are the separator between entries, not content.
		while (body.length > 0 && body[body.length - 1] === "") body.pop();
		current.friction = body.join("\n");
		entries.push(current);
		current = null;
		body = [];
	};

	for (const line of markdown.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			current = { at: heading[1], severity: heading[2] as Severity, cwd: "", friction: "" };
			continue;
		}
		if (!current) continue; // preamble, or junk before the first entry
		const meta = META.exec(line);
		if (meta && body.length === 0) {
			// Meta lines only count BEFORE the body starts. After it, `- cwd: …`
			// is just text the model wrote about a cwd.
			const value = meta[2].trim();
			if (meta[1] === "cwd") current.cwd = value;
			else if (value) current.context = value;
			continue;
		}
		if (line.startsWith("> ")) body.push(line.slice(2));
		else if (line === ">") body.push("");
		else if (line.trim() === "") body.push("");
		// Anything else inside an entry is foreign content — a hand-written note,
		// a stray line from an interrupted write. Dropped, entry kept.
	}
	flush();
	return entries;
}

/**
 * Cap the log at `maxEntries`, keeping the most recent.
 *
 * Pure, and it works on TEXT rather than on parsed entries, so capping cannot
 * rewrite what it does not understand: a hand-added note between two entries, or
 * a field a newer version of this file writes and this one does not know, is
 * carried through byte-for-byte in the blocks it keeps. A cap implemented as
 * parse-then-re-render would quietly launder the file on every append.
 *
 * The preamble — anything before the first heading — is always kept. That is
 * where a title or a "this file is written by the papercut tool" note lives, and
 * losing it on the 501st entry would be a surprise.
 */
export function capEntries(markdown: string, maxEntries: number): string {
	// A cap that is not a usable count leaves the file ALONE rather than
	// truncating it. `NaN` is the case that matters: every comparison against it
	// is false, so the unguarded version fell through to `starts[NaN]` →
	// `undefined` → `lines.slice(undefined)` → the whole file, re-emitted with its
	// preamble prepended a second time. A cap that cannot be computed must not be
	// allowed to corrupt or empty a log.
	const keep = Math.floor(maxEntries);
	if (!Number.isFinite(keep)) return markdown;
	if (keep <= 0) return "";
	const lines = markdown.split("\n");
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (HEADING.test(lines[i])) starts.push(i);
	}
	if (starts.length <= keep) return markdown;

	const head = lines.slice(0, starts[0]).join("\n").replace(/\s+$/, "");
	const preamble = head ? `${head}\n\n` : "";
	const kept = lines.slice(starts[starts.length - keep]).join("\n");
	return `${preamble}${kept.replace(/\n+$/, "")}\n\n`;
}

/** Collapse to a single greppable line. Interior runs of whitespace become one space. */
function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
