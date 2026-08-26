/**
 * Applying a row script — where "never guess" is enforced.
 *
 * See ./rowscript.ts for the format and the measurement that justifies it. The
 * parser makes the payload unambiguous; this module makes the LOCATION
 * unambiguous, which is the other half of the 82% anchor-class failure rate.
 * Three rules do the work, and all three are refusals:
 *
 *   0 matches  -> ANCHOR_MISS. Not "closest wins".
 *   2+ matches -> ANCHOR_AMBIGUOUS, carrying the line numbers. Not "the first".
 *   any failure -> the whole FILE is rejected, not the operations that happened
 *                  to resolve.
 *
 * Applying to the first of several candidates is the failure this refuses to
 * make. A miss costs a round trip and the model knows it happened; a silent
 * misapply costs a corrupted file that nobody notices until later, and the
 * measured 33.7% "ambiguous" class says the model reaches for non-unique
 * anchors often enough that guessing would be firing regularly.
 *
 * NO FILESYSTEM. `applyScript` takes a Map of current contents and returns new
 * contents. That is not squeamishness about I/O: it is what makes every rule
 * above testable without a temp directory, and it keeps the decision of whether
 * to write anything at all with the caller, who is the only one that knows
 * whether a partially-successful multi-file script should land.
 *
 * ORIGINAL-COORDINATES RESOLUTION. Every operation is resolved against the file
 * as it arrived, collected as an edit over original line numbers, and spliced
 * in one pass at the end. Two `@INS.PRE` operations in one payload therefore do
 * not shift each other's targets — the classic bug in this kind of applier, and
 * the reason line-addressed inserts would otherwise be a trap rather than the
 * escape hatch they are meant to be.
 *
 * WHOLE-LINE MATCHING, trailing-whitespace tolerant. A row matches a file line
 * when the two are equal, or equal after trailing spaces and tabs are removed.
 * Trailing whitespace is invisible in every place a model reads a file from, so
 * demanding it is demanding a coin flip. Interior whitespace is NOT normalised:
 * `if(x)` and `if (x)` are different lines and a tool that quietly equates them
 * is one that can rewrite the wrong statement. Exact matching runs first and
 * wins outright — a single exact hit is used even where the tolerant pass would
 * have found several, because the exact hit is the one the model actually wrote.
 *
 * DELIBERATELY NO SEQUENTIAL CONSUMPTION. Two identical hunks aimed at two
 * identical regions both see 2 candidates and both fail as ambiguous. A
 * "consume matches in order" fallback would make them work — and would also
 * make a script that is one hunk short silently edit the wrong occurrence. That
 * is the guess this module exists not to make.
 */

import { diagnose, explain } from "./diagnose.ts";
import { type Operation, type ParsedScript, type Row, anchorRows } from "./rowscript.ts";

/** At most this many duplicate sites are named. Beyond it the list is noise. */
const MAX_AMBIGUOUS_LINES = 8;

export type Failure =
	/** The script names a file the caller did not supply. */
	| { code: "FILE_MISSING"; path: string }
	/** The anchor block is nowhere in the file, exactly or trailing-whitespace-tolerantly. */
	| { code: "ANCHOR_MISS"; anchor: string }
	/** The anchor block occurs more than once. `lines` are 1-based starts. */
	| { code: "ANCHOR_AMBIGUOUS"; anchor: string; lines: number[]; more: number }
	/** A line-addressed insert names a line the file does not have. */
	| { code: "LINE_OUT_OF_RANGE"; target: number; lineCount: number }
	/**
	 * Two operations in one payload touch the same lines. `lines` are 1-based
	 * and inclusive. `operation` equals `withOperation` when a @REPLACE collides
	 * with itself — two of its own hunks — which needs different advice.
	 */
	| { code: "OVERLAP"; operation: number; withOperation: number; lines: [number, number] };

export interface OperationRef {
	/** Index within this file's operation list, 0-based. */
	index: number;
	kind: Operation["kind"];
	/** 1-based line in the SCRIPT where the operation was written. */
	scriptLine: number;
}

export type OperationOutcome =
	| { op: OperationRef; status: "ok"; /** 1-based first line the edit touches. */ at: number }
	| { op: OperationRef; status: "failed"; failure: Failure };

export interface FileOutcome {
	path: string;
	/** True only when EVERY operation resolved. A false here means nothing was applied to this file. */
	ok: boolean;
	operations: OperationOutcome[];
	/** Set only for a file-level fault, which today means the caller supplied no content. */
	failure?: Failure;
}

export interface ApplyResult {
	/** True when every file succeeded. */
	ok: boolean;
	/** New contents, keyed by path — present only for files whose operations ALL resolved. */
	files: Map<string, string>;
	outcomes: FileOutcome[];
}

/**
 * A line and the terminator it was written with.
 *
 * Terminators are carried per line rather than normalised to one dominant
 * ending, so a CRLF file stays CRLF, a file with no trailing newline keeps not
 * having one, and — the case that actually corrupts diffs — a file with mixed
 * endings is not silently rewritten end to end by an edit to three lines of it.
 */
interface SourceLine {
	text: string;
	/** "\n", "\r\n", or "" for a final line with no newline after it. */
	term: string;
}

function splitLines(content: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const breaks = /\r?\n/g;
	let from = 0;
	for (;;) {
		const match = breaks.exec(content);
		if (!match) break;
		lines.push({ text: content.slice(from, match.index), term: match[0] });
		from = match.index + match[0].length;
	}
	if (from < content.length) lines.push({ text: content.slice(from), term: "" });
	return lines;
}

/**
 * Reassemble, repairing terminators.
 *
 * A line that already has a terminator keeps its own — the dominant ending is
 * only a fallback, for inserted lines and for a line that used to be last and
 * no longer is. Reaching for `eol` unconditionally on the final line is the
 * subtle version of the whole-file rewrite this per-line bookkeeping exists to
 * avoid: in an LF-dominant file whose last line happens to be CRLF, an edit
 * three lines up would otherwise quietly restyle a line it never touched.
 *
 * Whether the file ends with a newline at all is the file's own habit and is
 * preserved. An originally EMPTY file is treated as having ended with one:
 * there is no previous last line whose lack of a newline we would be keeping,
 * and a file whose whole content is a line the model just wrote should end like
 * every other text file.
 */
function joinLines(lines: SourceLine[], eol: string, finalNewline: boolean): string {
	if (lines.length === 0) return "";
	let out = "";
	for (let i = 0; i < lines.length; i++) {
		const last = i === lines.length - 1;
		const own = lines[i].term || eol;
		out += lines[i].text + (last && !finalNewline ? "" : own);
	}
	return out;
}

function dominantEol(lines: SourceLine[]): string {
	for (const line of lines) if (line.term) return line.term;
	return "\n";
}

/** Trailing spaces and tabs only. Interior whitespace is load-bearing and stays. */
function rtrim(text: string): string {
	return text.replace(/[ \t]+$/, "");
}

/** A resolved operation, in ORIGINAL line coordinates, half-open [start, end). */
interface Edit {
	index: number;
	start: number;
	end: number;
	lines: SourceLine[];
}

/**
 * Where the anchor block sits, or why it does not.
 *
 * Exact first, tolerant second, and the tolerant pass runs ONLY when the exact
 * one found nothing — so tolerance can rescue a miss but can never turn a clean
 * exact hit into an ambiguity.
 */
function locate(lines: SourceLine[], anchor: string[]): { start: number } | Failure {
	const text = anchor.join("\n");
	const exact = scan(lines, anchor, (a, b) => a === b);
	if (exact.length === 1) return { start: exact[0] };
	if (exact.length > 1) return ambiguous(text, exact);

	const tolerant = scan(lines, anchor, (a, b) => rtrim(a) === rtrim(b));
	if (tolerant.length === 1) return { start: tolerant[0] };
	if (tolerant.length > 1) return ambiguous(text, tolerant);
	return { code: "ANCHOR_MISS", anchor: text };
}

function scan(lines: SourceLine[], anchor: string[], equal: (a: string, b: string) => boolean): number[] {
	const found: number[] = [];
	if (anchor.length === 0 || anchor.length > lines.length) return found;
	for (let start = 0; start + anchor.length <= lines.length; start++) {
		let hit = true;
		for (let k = 0; k < anchor.length; k++) {
			if (!equal(lines[start + k].text, anchor[k])) {
				hit = false;
				break;
			}
		}
		if (hit) found.push(start);
	}
	return found;
}

function ambiguous(anchor: string, starts: number[]): Failure {
	const shown = starts.slice(0, MAX_AMBIGUOUS_LINES).map((start) => start + 1);
	return { code: "ANCHOR_AMBIGUOUS", anchor, lines: shown, more: Math.max(0, starts.length - shown.length) };
}

function isFailure(value: { start: number } | Failure): value is Failure {
	return "code" in value;
}

/**
 * Rebuild a matched region from its rows.
 *
 * Context rows emit the FILE's line, not the script's — including its
 * terminator and any trailing whitespace. The row said "keep this as-is", and
 * an edit that quietly strips trailing spaces from lines it was told to leave
 * alone produces diff noise nobody asked for. It is also the only correct
 * behaviour once matching is trailing-whitespace tolerant: the two strings can
 * legitimately differ, and the file's is the one that is true.
 */
function rebuild(rows: Row[], lines: SourceLine[], start: number, eol: string): SourceLine[] {
	const out: SourceLine[] = [];
	let offset = 0;
	for (const row of rows) {
		if (row.kind === "add") {
			out.push({ text: row.text, term: eol });
			continue;
		}
		const source = lines[start + offset];
		offset++;
		if (row.kind === "context") out.push(source);
	}
	return out;
}

/** The `+` rows of an operation, as lines ready to splice. */
function addedLines(rows: Row[], eol: string): SourceLine[] {
	const out: SourceLine[] = [];
	for (const row of rows) if (row.kind === "add") out.push({ text: row.text, term: eol });
	return out;
}

/**
 * Where the `-` rows sit INSIDE the anchor block, as offsets into it.
 *
 * `@INS.BEFORE`/`@INS.AFTER` insert relative to the `-` rows, not to the whole
 * anchor. A context row exists to make the anchor unique; letting it move the
 * insertion point would mean that adding context — the documented remedy for an
 * ambiguity — silently relocates the edit, which is the misapply this module
 * refuses to make everywhere else. With a body of bare `-` rows the two
 * readings coincide, which is how the difference stayed invisible.
 *
 * `validate` in ./rowscript.ts guarantees at least one `-` row for these two
 * operations. The fallback spans the whole anchor so that a hand-built script
 * cannot produce an offset outside it.
 */
function removeSpan(rows: Row[], anchorLength: number): { first: number; last: number } {
	let offset = 0;
	let first = -1;
	let last = -1;
	for (const item of rows) {
		if (item.kind === "add") continue;
		if (item.kind === "remove") {
			if (first === -1) first = offset;
			last = offset;
		}
		offset++;
	}
	return first === -1 ? { first: 0, last: anchorLength - 1 } : { first, last };
}

function refOf(op: Operation, index: number): OperationRef {
	return { index, kind: op.kind, scriptLine: op.line };
}

/**
 * Resolve one operation to an edit over original coordinates.
 *
 * `@REPLACE` resolves each of its hunks independently and returns them as
 * separate edits, which is what makes a multi-hunk replace behave exactly like
 * several single-hunk ones — including being caught by the overlap check if two
 * of its own hunks collide.
 */
function resolve(op: Operation, lines: SourceLine[], eol: string, index: number): Edit[] | Failure {
	switch (op.kind) {
		case "replace": {
			const edits: Edit[] = [];
			for (const hunk of op.hunks) {
				const anchor = anchorRows(hunk.rows);
				const at = locate(lines, anchor);
				if (isFailure(at)) return at;
				edits.push({
					index,
					start: at.start,
					end: at.start + anchor.length,
					lines: rebuild(hunk.rows, lines, at.start, eol),
				});
			}
			return edits;
		}
		case "delete": {
			const anchor = anchorRows(op.rows);
			const at = locate(lines, anchor);
			if (isFailure(at)) return at;
			return [{ index, start: at.start, end: at.start + anchor.length, lines: rebuild(op.rows, lines, at.start, eol) }];
		}
		case "insert-before":
		case "insert-after": {
			const anchor = anchorRows(op.rows);
			const at = locate(lines, anchor);
			if (isFailure(at)) return at;
			// The anchor is matched and kept; only the `+` rows land. They go in
			// as one block on the chosen side of the `-` ROWS — not of the whole
			// anchor — wherever in the body they were written. Context rows
			// disambiguate the match and never move the insertion point.
			const span = removeSpan(op.rows, anchor.length);
			const where = op.kind === "insert-before" ? at.start + span.first : at.start + span.last + 1;
			return [{ index, start: where, end: where, lines: addedLines(op.rows, eol) }];
		}
		case "insert-at": {
			// PRE accepts one past the end, which is how a line-addressed script
			// appends. POST does not accept 0: "after line 0" is a way of writing
			// "before line 1" that the format already has a word for.
			const limit = op.where === "pre" ? lines.length + 1 : lines.length;
			if (op.target > limit) return { code: "LINE_OUT_OF_RANGE", target: op.target, lineCount: lines.length };
			const where = op.where === "pre" ? op.target - 1 : op.target;
			return [{ index, start: where, end: where, lines: addedLines(op.rows, eol) }];
		}
	}
}

/**
 * Order the edits for a single forward splice.
 *
 * By start, then zero-width inserts before any replacement that begins at the
 * same place, then script order. The middle term is the only non-obvious one
 * and it exists to make a documented answer out of a genuine tie: an insert at
 * line N and a replacement starting at line N do not overlap under half-open
 * ranges, so both are legal, and "the insert lands above the replacement"
 * has to be true regardless of which the model happened to write first.
 */
function orderEdits(edits: Edit[]): Edit[] {
	return edits
		.map((edit, order) => ({ edit, order }))
		.sort((a, b) => {
			if (a.edit.start !== b.edit.start) return a.edit.start - b.edit.start;
			const aWidth = a.edit.end - a.edit.start === 0 ? 0 : 1;
			const bWidth = b.edit.end - b.edit.start === 0 ? 0 : 1;
			if (aWidth !== bWidth) return aWidth - bWidth;
			return a.order - b.order;
		})
		.map((entry) => entry.edit);
}

/**
 * Two edits collide when their ranges intersect.
 *
 * Half-open, so a zero-width insert never collides with anything — including
 * the region it sits at the edge of. Two operations that overwrite the same
 * lines do collide, and must, because whichever won would be a coin flip the
 * model could not see.
 */
function findOverlaps(edits: Edit[]): { later: Edit; earlier: Edit }[] {
	const found: { later: Edit; earlier: Edit }[] = [];
	for (let i = 0; i < edits.length; i++) {
		for (let j = i + 1; j < edits.length; j++) {
			const a = edits[i];
			const b = edits[j];
			if (a.start < b.end && b.start < a.end) {
				found.push(a.index >= b.index ? { later: a, earlier: b } : { later: b, earlier: a });
			}
		}
	}
	return found;
}

function splice(lines: SourceLine[], edits: Edit[]): SourceLine[] {
	const out: SourceLine[] = [];
	let cursor = 0;
	for (const edit of edits) {
		if (edit.start > cursor) out.push(...lines.slice(cursor, edit.start));
		out.push(...edit.lines);
		cursor = Math.max(cursor, edit.end);
	}
	out.push(...lines.slice(cursor));
	return out;
}

/**
 * Apply a parsed script to a set of file contents.
 *
 * All-or-nothing PER FILE: one failed operation rejects that file's whole
 * result, because an edit script is a plan and half a plan is not a smaller
 * plan. Other files in the same script are unaffected and their new contents
 * are returned — `ok` is the verdict on all of them together, and a caller that
 * wants a script to land atomically across files should check `ok` before
 * writing anything.
 */
export function applyScript(files: Map<string, string>, script: ParsedScript): ApplyResult {
	const results = new Map<string, string>();
	const outcomes: FileOutcome[] = [];

	for (const target of script.files) {
		const content = files.get(target.path);
		if (content === undefined) {
			outcomes.push({
				path: target.path,
				ok: false,
				operations: [],
				failure: { code: "FILE_MISSING", path: target.path },
			});
			continue;
		}

		const lines = splitLines(content);
		const eol = dominantEol(lines);
		const finalNewline = lines.length === 0 ? true : lines[lines.length - 1].term !== "";

		const operations: OperationOutcome[] = [];
		const edits: Edit[] = [];
		// Every operation is resolved even after one has failed: the model gets
		// the complete list of what is wrong in one reply rather than peeling
		// them off a round trip at a time, which is the cost this whole format
		// is trying to remove.
		for (let index = 0; index < target.ops.length; index++) {
			const op = target.ops[index];
			const resolved = resolve(op, lines, eol, index);
			if (!Array.isArray(resolved)) {
				operations.push({ op: refOf(op, index), status: "failed", failure: resolved });
				continue;
			}
			edits.push(...resolved);
			operations.push({ op: refOf(op, index), status: "ok", at: (resolved[0]?.start ?? 0) + 1 });
		}

		const ordered = orderEdits(edits);
		for (const collision of findOverlaps(ordered)) {
			const outcome = operations[collision.later.index];
			// Only the later of a colliding pair is blamed, and only once: the
			// earlier one is a perfectly good operation that something else ran
			// into, and reporting both would read as two problems to fix.
			if (outcome && outcome.status === "ok") {
				operations[collision.later.index] = {
					op: outcome.op,
					status: "failed",
					failure: {
						code: "OVERLAP",
						operation: collision.later.index,
						withOperation: collision.earlier.index,
						// A zero-width insert covers no lines, so its range is
						// reported as the single line it sits above rather than
						// as the inverted pair the arithmetic would give.
						lines: [collision.later.start + 1, Math.max(collision.later.end, collision.later.start + 1)],
					},
				};
			}
		}

		const ok = operations.every((outcome) => outcome.status === "ok");
		outcomes.push({ path: target.path, ok, operations });
		if (ok) results.set(target.path, joinLines(splice(lines, ordered), eol, finalNewline));
	}

	return { ok: outcomes.every((outcome) => outcome.ok), files: results, outcomes };
}

/**
 * A failure as the sentence the model reads.
 *
 * Same shape as `explain` in ./diagnose.ts, and for ANCHOR_MISS it simply hands
 * over: HIV-1562 already built the machinery that quotes back the region the
 * anchor nearly matched, and a miss under this format is the same 31% near-miss
 * class wearing a different marker. `content` is optional so the caller can
 * skip the scan when it does not have the file to hand; the diagnosis only ever
 * runs on the failure path, never on the way to a successful apply.
 */
export function describeFailure(path: string, failure: Failure, content?: string): string {
	switch (failure.code) {
		case "FILE_MISSING":
			return `No content was supplied for ${path}. Check the path in the \`[${failure.path}]\` header — it must be a file that exists.`;
		case "ANCHOR_MISS": {
			const diagnosis = content === undefined ? null : explain(diagnose(content, failure.anchor), path);
			if (diagnosis) return diagnosis;
			return (
				`No lines in ${path} match that anchor block. Rows match WHOLE lines (trailing whitespace is ignored, ` +
				`interior whitespace is not), so a fragment of a line will never match. Read the region and copy the lines verbatim, ` +
				`or address the edit by line number with @INS.PRE / @INS.POST.`
			);
		}
		case "ANCHOR_AMBIGUOUS": {
			const more = failure.more ? ` (and ${failure.more} more)` : "";
			return (
				`That anchor block occurs ${failure.lines.length + failure.more} times in ${path}, starting at lines ` +
				`${failure.lines.join(", ")}${more}. Add an adjacent context row that differs between them — or, if the region ` +
				`genuinely repeats, address it by line number with @INS.PRE / @INS.POST. Do not resend the same anchor.`
			);
		}
		case "LINE_OUT_OF_RANGE":
			return (
				`${path} has ${failure.lineCount} lines, so line ${failure.target} does not exist. ` +
				`@INS.PRE accepts 1..${failure.lineCount + 1} (one past the end appends); @INS.POST accepts 1..${failure.lineCount}.`
			);
		case "OVERLAP": {
			const where =
				failure.lines[0] === failure.lines[1] ? `line ${failure.lines[0]}` : `lines ${failure.lines[0]}-${failure.lines[1]}`;
			// A @REPLACE whose own two hunks collide is already one operation, so
			// "merge them" would be advice it cannot act on. Its fix is a hunk
			// boundary, not an operation boundary.
			if (failure.withOperation === failure.operation) {
				return (
					`Two hunks of the same operation edit ${where} of ${path}. Overlapping hunks have no defined result, ` +
					`so none of them was applied — combine them into one hunk covering the whole region.`
				);
			}
			return (
				`Two operations edit the same ${where} of ${path} (also touched by operation ${failure.withOperation + 1}). ` +
				`Merge them into one operation — the result of applying both is not defined, so neither was applied.`
			);
		}
	}
}
