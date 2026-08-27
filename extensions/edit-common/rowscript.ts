/**
 * A row-oriented edit script — the format answer to anchor failures.
 *
 * MEASURED (`~/.pi/agent/scripts/measure-edit-failures.py`, 247 sessions /
 * 417 subagent runs): the orchestrator's edit-failure rate is 7.3%
 * (168/2,300), and **82.0% of every failure is anchor-class** (141/172) —
 * 48.3% "anchor not found", 33.7% "anchor ambiguous (matched N>1)". That is
 * 6.0% of all 2,343 edits, each one a wasted round trip on a paid model.
 *
 * HIV-1562 (`./diagnose.ts`) attacked the FEEDBACK: when an anchor missed, it
 * showed the model the line it nearly matched instead of "please provide more
 * context". That is worth having and this module does not replace it. But it
 * leaves the format alone, and the format is where the ambiguity is born:
 * `oldText` is a free-floating blob of file bytes whose boundaries, whitespace
 * and uniqueness are all the model's problem to get right in one shot.
 *
 * THE FORMAT (adapted from mitsuhiko/agent-stuff `unified-edit.ts`):
 *
 *     [path/to/file.ts]
 *     @REPLACE
 *      context line kept as-is
 *     -old line to remove
 *     +new line to insert
 *      more context
 *     @@
 *     -second hunk old
 *     +second hunk new
 *
 * Every payload line carries exactly ONE marker character and the content is
 * the remainder of the line, verbatim. That single rule is the whole reason the
 * format is unambiguous, and it is also the escaping rule: a line whose content
 * starts with a marker looks doubled (`++literal plus`, `--literal minus`), but
 * nothing special is happening — `+` is the marker, `+literal plus` is the
 * content. Content starting with a character that is a marker only in another
 * position needs no doubling at all: `+@decorator` inserts `@decorator`, and
 * ` @@` is a context row for a file line that reads `@@`.
 *
 * Row semantics are uniform across every operation, which is what lets one
 * anchor resolver serve them all (see ./apply.ts):
 *
 *     ' '  context — must be present in the file, and is kept
 *     '-'  must be present in the file. REMOVED by @REPLACE and @DEL;
 *          matched and KEPT by @INS.BEFORE and @INS.AFTER, where it is a
 *          pure anchor and deletes nothing
 *     '+'  inserted
 *
 * A context row widens the block that must match; it never changes what an
 * operation DOES. For @INS.BEFORE/@INS.AFTER that is load-bearing: the `+` rows
 * land against the `-` rows, so adding context to break an ambiguity — the
 * remedy this format recommends — cannot move the insertion point.
 *
 * Operations:
 *
 *     @REPLACE            hunks of ' ' / '-' / '+' rows, `@@` between hunks
 *     @INS.PRE <N>        insert the '+' rows before 1-based line N
 *     @INS.POST <N>       insert the '+' rows after 1-based line N
 *     @INS.BEFORE         insert the '+' rows before a '-' anchor block
 *     @INS.AFTER          insert the '+' rows after a '-' anchor block
 *     @DEL                delete a '-' anchor block
 *
 * `@INS.PRE`/`@INS.POST` are line-addressed on purpose: they are the escape
 * hatch for the 48.3% class, because a line number cannot be "not found". The
 * model has just read the file with line numbers in the gutter; asking it to
 * re-transcribe bytes it can already address numerically is the transcription
 * step that fails.
 *
 * This module is the PARSER and it is pure: text in, a structure or a typed
 * fault out. It never throws on malformed input — a thrown exception is a stack
 * trace for the human and nothing for the model, whereas a fault with a line
 * number and a sentence is the next edit's correction. Validation happens here,
 * before anything has touched a file, so "you wrote @INS.PRE without a line
 * number" costs a parse, not a half-applied file.
 */

/** Marker characters, in the one place a reader has to look. */
const CONTEXT = " ";
const REMOVE = "-";
const ADD = "+";

/** Every operation keyword, matched case-insensitively (see `parseOpLine`). */
const OPERATIONS = ["@REPLACE", "@DEL", "@INS.PRE", "@INS.POST", "@INS.BEFORE", "@INS.AFTER"] as const;

export type RowKind = "context" | "remove" | "add";

export interface Row {
	kind: RowKind;
	/** The content with its marker stripped — exactly the bytes of a file line. */
	text: string;
}

/** One `@@`-separated section of a `@REPLACE`. */
export interface Hunk {
	/** 1-based line in the SCRIPT where this hunk's first row sits, for error messages. */
	line: number;
	rows: Row[];
}

export type Operation =
	| { kind: "replace"; line: number; hunks: Hunk[] }
	| { kind: "delete"; line: number; rows: Row[] }
	| { kind: "insert-before"; line: number; rows: Row[] }
	| { kind: "insert-after"; line: number; rows: Row[] }
	/** Line-addressed insert. `where` picks the side of `target`. */
	| { kind: "insert-at"; line: number; where: "pre" | "post"; target: number; rows: Row[] };

export interface ScriptFile {
	path: string;
	ops: Operation[];
}

export interface ParsedScript {
	ok: true;
	files: ScriptFile[];
}

export interface ParseError {
	ok: false;
	/** 1-based line in the script. 0 when the fault is the script as a whole. */
	line: number;
	message: string;
}

function fail(line: number, message: string): ParseError {
	return { ok: false, line, message };
}

/** Rows are file bytes, so a marker is stripped and nothing else is touched. */
function row(kind: RowKind, raw: string): Row {
	return { kind, text: raw.slice(1) };
}

/**
 * Which operation this `@` line names, or null if it names none.
 *
 * Case-insensitive: a model that writes `@replace` has made no ambiguity, only
 * a typo, and refusing it costs the same round trip this whole format exists to
 * save. The keyword is compared uppercased; the argument is not touched.
 */
function parseOpLine(raw: string): { name: string; rest: string } | null {
	const match = /^@([A-Za-z.]+)(.*)$/.exec(raw);
	if (!match) return null;
	const name = `@${match[1].toUpperCase()}`;
	if (!(OPERATIONS as readonly string[]).includes(name)) return null;
	return { name, rest: match[2] };
}

/**
 * The line-number argument of `@INS.PRE`/`@INS.POST`.
 *
 * Strict about the shape (one positive integer, nothing else) because the
 * alternative to a precise complaint here is a silent misparse that addresses
 * the wrong line — the one failure mode worse than a refusal.
 */
function parseTarget(rest: string): number | null {
	const match = /^\s+([0-9]+)\s*$/.exec(rest);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function rowsOf(op: Operation): Row[] {
	return op.kind === "replace" ? op.hunks.flatMap((hunk) => hunk.rows) : op.rows;
}

function counts(rows: Row[]): { context: number; remove: number; add: number } {
	let context = 0;
	let remove = 0;
	let add = 0;
	for (const item of rows) {
		if (item.kind === "context") context++;
		else if (item.kind === "remove") remove++;
		else add++;
	}
	return { context, remove, add };
}

/**
 * Whether a finished operation is answerable, and if not, why.
 *
 * Runs when the operation CLOSES rather than as rows arrive, because the
 * interesting faults ("this hunk has nothing to anchor on", "@DEL deletes
 * nothing") are properties of the whole body and cannot be judged a row at a
 * time.
 */
function validate(op: Operation): ParseError | null {
	const all = rowsOf(op);
	if (all.length === 0) {
		return fail(op.line, `${describeOp(op)} has no rows. An operation with an empty body cannot be applied.`);
	}

	switch (op.kind) {
		case "replace": {
			for (const hunk of op.hunks) {
				const n = counts(hunk.rows);
				if (hunk.rows.length === 0) {
					return fail(hunk.line, "Empty @REPLACE hunk. Every `@@` must be followed by rows.");
				}
				if (n.remove === 0 && n.context === 0) {
					return fail(
						hunk.line,
						"This @REPLACE hunk has no `-` rows and no context rows, so there is nothing to locate it by. " +
							"Add the surrounding lines as context rows, or use @INS.PRE <line> / @INS.POST <line> to insert by line number.",
					);
				}
				// The mirror of the check above: that one cannot find a region,
				// this one finds a region and then does nothing to it. Silently
				// succeeding at nothing is the worse of the two, because the model
				// is told its edit landed.
				if (n.remove === 0 && n.add === 0) {
					return fail(
						hunk.line,
						"This @REPLACE hunk is all context rows, so it locates a region and then changes nothing. " +
							"Mark the lines to drop with `-` and the lines to insert with `+`, or drop the hunk.",
					);
				}
			}
			return null;
		}
		case "delete": {
			const n = counts(op.rows);
			if (n.remove === 0) return fail(op.line, "@DEL has no `-` rows, so it deletes nothing.");
			if (n.add > 0) {
				return fail(op.line, "@DEL cannot contain `+` rows. Use @REPLACE to swap lines, or @INS.AFTER to add some.");
			}
			return null;
		}
		case "insert-before":
		case "insert-after": {
			const n = counts(op.rows);
			const name = op.kind === "insert-before" ? "@INS.BEFORE" : "@INS.AFTER";
			if (n.remove === 0) {
				return fail(op.line, `${name} has no \`-\` rows, so there is no anchor to insert relative to.`);
			}
			if (n.add === 0) return fail(op.line, `${name} has no \`+\` rows, so it inserts nothing.`);
			return null;
		}
		case "insert-at": {
			const n = counts(op.rows);
			const name = op.where === "pre" ? "@INS.PRE" : "@INS.POST";
			if (n.remove > 0 || n.context > 0) {
				return fail(
					op.line,
					`${name} ${op.target} is addressed by line number, so it takes only \`+\` rows. ` +
						"Drop the context and `-` rows, or use @REPLACE if you meant to match text.",
				);
			}
			if (n.add === 0) return fail(op.line, `${name} ${op.target} has no \`+\` rows, so it inserts nothing.`);
			return null;
		}
	}
}

function describeOp(op: Operation): string {
	switch (op.kind) {
		case "replace":
			return "@REPLACE";
		case "delete":
			return "@DEL";
		case "insert-before":
			return "@INS.BEFORE";
		case "insert-after":
			return "@INS.AFTER";
		case "insert-at":
			return `${op.where === "pre" ? "@INS.PRE" : "@INS.POST"} ${op.target}`;
	}
}

/**
 * Parse a row script.
 *
 * Returns the FIRST fault rather than a list. Once a line has been
 * misunderstood every line after it is being read in the wrong state, and a
 * cascade of derived complaints buries the one that is true — the same reason
 * a compiler's tenth error is rarely worth reading.
 *
 * Two normalisations happen up front, both because the payload arrives through
 * a model and a JSON transport rather than off a disk:
 *
 *   - a trailing `\r` is stripped from every script line. CRLF here is a
 *     transport artefact; line endings for the FILE come from the file itself
 *     (see ./apply.ts), never from the script.
 *   - completely empty lines at the very END of the script are dropped. Models
 *     emit trailing newlines constantly, and inside an operation an empty line
 *     is a meaningful row (an empty context row). Dropping only the trailing
 *     run is safe: a trailing context row is pure anchor, so losing it can make
 *     an anchor shorter — never wrong. A trailing `+` row inserting a blank
 *     line is the two-character line `+`, not an empty line, and survives.
 */
export function parseRowScript(text: string): ParsedScript | ParseError {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const files: ScriptFile[] = [];
	let file: ScriptFile | null = null;
	let op: Operation | null = null;
	let hunk: Hunk | null = null;

	/** Close the open operation, validating it. */
	const closeOp = (): ParseError | null => {
		if (!op) return null;
		const fault = validate(op);
		op = null;
		hunk = null;
		return fault;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const at = i + 1;

		// A header is unconditional: every payload row carries a marker, so a
		// bare `[...]` line can only be a path.
		// `trimEnd` only: a trailing space is a transport artefact, while a
		// LEADING space is the context marker, and trimming it would turn the
		// context row ` [section]` into a file header.
		const header = raw.trimEnd();
		if (raw.startsWith("[") && header.endsWith("]")) {
			const fault = closeOp();
			if (fault) return fault;
			if (file && file.ops.length === 0) {
				return fail(at, `[${file.path}] has no operations. Every file section needs at least one @-operation.`);
			}
			const path = header.slice(1, -1).trim();
			if (!path) return fail(at, "Empty file header `[]`. A header must name a path, e.g. `[src/main.ts]`.");
			// Repeating a path is legal and merges: every operation resolves
			// against the ORIGINAL file anyway, so two sections are the same
			// script as one.
			const existing = files.find((entry) => entry.path === path);
			if (existing) file = existing;
			else {
				file = { path, ops: [] };
				files.push(file);
			}
			continue;
		}

		if (raw.startsWith("@")) {
			if (!file) return fail(at, `\`${raw}\` appears before any \`[file]\` header. Start the script with \`[path/to/file]\`.`);

			if (raw.trim() === "@@") {
				if (!op || op.kind !== "replace") {
					return fail(at, "`@@` separates hunks inside a @REPLACE, but no @REPLACE is open here.");
				}
				if (!hunk || hunk.rows.length === 0) {
					return fail(at, "Empty @REPLACE hunk before `@@`. Every hunk must have rows.");
				}
				hunk = { line: at + 1, rows: [] };
				op.hunks.push(hunk);
				continue;
			}

			const parsed = parseOpLine(raw);
			if (!parsed) {
				return fail(
					at,
					`Unknown operation \`${raw}\`. Valid operations are ${OPERATIONS.join(", ")} (and \`@@\` between @REPLACE hunks). ` +
						"To write a file line that starts with `@`, give it a row marker: `+@decorator`, `-@decorator` or ` @decorator`.",
				);
			}

			const fault = closeOp();
			if (fault) return fault;

			switch (parsed.name) {
				case "@REPLACE": {
					if (parsed.rest.trim()) return fail(at, "@REPLACE takes no argument. Anchor it with `-` and context rows.");
					hunk = { line: at + 1, rows: [] };
					op = { kind: "replace", line: at, hunks: [hunk] };
					break;
				}
				case "@DEL": {
					if (parsed.rest.trim()) return fail(at, "@DEL takes no argument. Anchor it with `-` rows.");
					op = { kind: "delete", line: at, rows: [] };
					break;
				}
				case "@INS.BEFORE":
				case "@INS.AFTER": {
					if (parsed.rest.trim()) {
						return fail(
							at,
							`${parsed.name} takes no argument — it anchors on the \`-\` rows that follow. ` +
								`Did you mean ${parsed.name === "@INS.BEFORE" ? "@INS.PRE" : "@INS.POST"} <line>?`,
						);
					}
					op = { kind: parsed.name === "@INS.BEFORE" ? "insert-before" : "insert-after", line: at, rows: [] };
					break;
				}
				case "@INS.PRE":
				case "@INS.POST": {
					const target = parseTarget(parsed.rest);
					if (target === null) {
						return fail(
							at,
							`${parsed.name} takes exactly one positive line number, e.g. \`${parsed.name} 42\`` +
								`${parsed.rest.trim() ? ` — got \`${parsed.rest.trim()}\`` : " — none was given"}.`,
						);
					}
					op = { kind: "insert-at", line: at, where: parsed.name === "@INS.PRE" ? "pre" : "post", target, rows: [] };
					break;
				}
			}
			if (op) file.ops.push(op);
			continue;
		}

		// Outside an operation there is no row for a blank line to be, so it is
		// formatting: between the header and the first `@`, or between two
		// operations, or above the whole script. Inside one it is a row (below).
		if (!op && raw.trim() === "") continue;

		// Everything else is a payload row. An empty line is an empty context
		// row — a blank line in the file, which is common enough inside a hunk
		// that demanding a lone trailing space would fail on whitespace nobody
		// can see.
		const kind: RowKind | null =
			raw.startsWith(ADD) ? "add" : raw.startsWith(REMOVE) ? "remove" : raw.startsWith(CONTEXT) ? "context" : raw === "" ? "context" : null;

		if (kind === null) {
			if (!file) {
				return fail(at, `\`${raw}\` appears before any \`[file]\` header. Start the script with \`[path/to/file]\`.`);
			}
			return fail(
				at,
				`\`${raw}\` has no row marker. Inside an operation every line must start with \`+\` (insert), \`-\` (match, and remove for @REPLACE/@DEL) or a space (context). ` +
					"The marker is stripped and the rest of the line is used verbatim, so a file line that itself starts with `+` is written `++like this`.",
			);
		}

		if (!file) {
			return fail(at, `\`${raw}\` appears before any \`[file]\` header. Start the script with \`[path/to/file]\`.`);
		}
		if (!op) {
			return fail(
				at,
				`\`${raw}\` is a row outside any operation. Open one first — @REPLACE, @DEL, @INS.PRE <line>, @INS.POST <line>, @INS.BEFORE or @INS.AFTER.`,
			);
		}

		// `row` slices one marker off, which for the empty line yields the empty
		// context row it is meant to be.
		const built = row(kind, raw);
		if (hunk) hunk.rows.push(built);
		else if (op.kind !== "replace") op.rows.push(built);
		else return fail(at, "Internal: @REPLACE with no open hunk.");
	}

	const fault = closeOp();
	if (fault) return fault;
	if (file && file.ops.length === 0) {
		return fail(lines.length, `[${file.path}] has no operations. Every file section needs at least one @-operation.`);
	}
	if (files.length === 0) {
		return fail(0, "No `[file]` header found. A row script starts with `[path/to/file]` followed by one or more @-operations.");
	}
	return { ok: true, files };
}

/**
 * The rows an operation must find in the file, in order.
 *
 * Context and `-` rows both mean "must be present"; they differ only in what
 * happens afterwards, which is the applier's business. Exported because the
 * applier and its error messages both need exactly this sequence and deriving
 * it twice is how the two drift apart.
 */
export function anchorRows(rows: Row[]): string[] {
	const anchor: string[] = [];
	for (const item of rows) if (item.kind !== "add") anchor.push(item.text);
	return anchor;
}
