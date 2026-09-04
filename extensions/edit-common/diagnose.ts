/**
 * Why an edit anchor missed — the evidence pi's error does not carry.
 *
 * MEASURED (HIV-1562, 182 sessions, 1,303 edit calls, 109 failures):
 * anchor-class failures are 79% of all edit failures — 8.3% of the
 * orchestrator's edits and 9.3% of workers'. Pairing each failure with the edit
 * that eventually worked on the same file (74 recoveries) says what was
 * actually wrong:
 *
 *     31%  NEAR miss — the anchor is a word or two off the real text
 *          '# Linear Issue Management' vs '# Linear Issue Manager'
 *          '"include": ["**\/*.ts"]'   vs '"include": ["*.ts"]'
 *     22%  ambiguous, and the recovery simply ADDED context
 *     12%  not found, and the recovery ADDED context
 *     11%  partly wrong        9%  bore little relation to the file
 *
 * So roughly half are "the model's idea of the file is slightly wrong" and a
 * third are "the anchor was right but not unique". Recovery costs a mean 1.23
 * extra edit calls and a median 13.8s (p90 44.8s) — a whole round trip with the
 * context re-sent.
 *
 * pi's own messages are:
 *
 *     "Could not find the exact text in <path>. The old text must match
 *      exactly including all whitespace and newlines."
 *     "Found 2 occurrences … Please provide more context to make it unique."
 *
 * Both are TRUE and neither carries a single byte of the file. The model
 * retries by guessing, which is exactly what the near-miss class cannot afford:
 * it already believes it knows the text. Showing it the line it nearly matched
 * turns a guess into a correction.
 *
 * This module is the evidence-gathering half, and it is pure: (content, anchor)
 * in, a diagnosis out. No filesystem, no pi API, no error-string parsing —
 * classification is done by re-examining the file, so a pi release that rewords
 * its errors cannot silently disable this.
 *
 * DELIBERATELY NOT a new edit format. The hash-anchored alternative (omp's
 * hashline, HIV-1562's original task 2) replaces the format the orchestrator's
 * model was post-trained on, for a benchmark gain that concentrates on weak
 * models. This keeps the format and fixes the feedback, which is the cheaper
 * arm of the same experiment and composes with the other if it is ever needed.
 */

/** Never quote more of the file back than this, per candidate. */
const MAX_CANDIDATE_LINES = 12;
/** At most this many near-miss candidates. Two is enough to disambiguate; more is noise. */
const MAX_CANDIDATES = 2;
/** At most this many duplicate sites are listed by line number. */
const MAX_DUPLICATES = 6;
/**
 * Below this similarity a "closest match" is not a near miss, it is an
 * unrelated chunk of the file — and offering it as a suggestion would send the
 * model to edit the wrong place. The 9% "bore little relation" class is real,
 * and for it the honest answer is "nothing here resembles this".
 */
const NEAR_MISS_FLOOR = 0.55;
/** Files past this are scanned only for exact/duplicate hits, not similarity. */
const MAX_SCANNED_LINES = 20_000;

export interface NearMiss {
	/** 1-based, matching what an editor and pi's own read tool show. */
	line: number;
	/** 1-based inclusive end of the quoted region — an anchor is usually several lines. */
	endLine: number;
	similarity: number;
	text: string;
	truncated: boolean;
}

export type EditDiagnosis =
	| { kind: "ok" }
	| { kind: "duplicate"; occurrences: number; lines: number[]; moreLines: number }
	| { kind: "near-miss"; candidates: NearMiss[] }
	| { kind: "absent" };

/** pi matches after normalizing line endings; so must we, or offsets drift on CRLF. */
function toLF(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/**
 * A deliberately LOOSER fold than pi's, and used only for SIMILARITY SCORING.
 *
 * Collapsing interior runs of spaces and tabs is what lets a re-indented block
 * still score as a near miss, and that is the whole point of the near-miss
 * class: the model's idea of the file is slightly wrong and we want to show it
 * the region it meant. For scoring, being generous is free — the score is
 * advisory and NEAR_MISS_FLOOR still has to be cleared before anything is said.
 *
 * It must NEVER be used to count duplicates, and until `normalizeLikePi` below
 * existed it was. pi does not collapse interior whitespace, so two blocks
 * differing only in indentation are two different strings to pi's matcher.
 * Reporting them as "that text occurs 2 times" tells the model to add
 * disambiguating context for an ambiguity pi never saw, when pi's real
 * complaint was that it could not find the text at all — a confidently wrong
 * instruction, which is worse for the reader than the silence it replaced.
 */
function squash(text: string): string {
	return toLF(text).replace(/[ \t]+/g, " ").trim();
}

/**
 * pi's OWN fuzzy fold, mirrored from `normalizeForFuzzyMatch`
 * (pi-coding-agent, `core/tools/edit-diff.js`): NFKC, then a per-line trimEnd,
 * then smart quotes, the seven dash codepoints and the special spaces folded to
 * their ASCII equivalents.
 *
 * This is the fold pi COUNTS OCCURRENCES IN. Its `countOccurrences` normalizes
 * both sides before splitting — unconditionally, even when the raw text matched
 * exactly — so "Found 2 occurrences … Please provide more context" fires on
 * pairs that are not byte-identical anywhere in the file. This module used to
 * count raw exact hits only, so the commonest real shape of that failure (the
 * papercut's own "parallel except blocks": two identical bodies, the second
 * carrying a trailing space, an NBSP, an em-dash or an NFKC twin) scanned as
 * exactly ONE hit, returned `ok`, `explain` returned null, and NOTHING was
 * appended. The model then received pi's bare "provide more context" with not
 * one line number in it — precisely the round trip this module exists to save.
 *
 * Mirrored rather than imported: `normalizeForFuzzyMatch` lives at a non-root
 * subpath of pi and `test/pi-api-surface.test.ts` forbids reaching in there,
 * for the reason the file states. The cost of a copy is that a pi release could
 * change the fold under us; the failure mode of that drift is a diagnosis that
 * goes quiet, never one that lies about a file, which is the trade this module
 * already makes everywhere else.
 *
 * The ORDER is pi's, not a tidier one. NFKC runs first, so an NBSP is already a
 * plain space by the time the per-line trimEnd sees it, and a compatibility
 * ligature has already expanded before anything is measured against it.
 */
function normalizeLikePi(text: string): string {
	return toLF(text)
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		// Escapes rather than the literal glyphs, and pi's own inventory comments
		// kept with them: every codepoint below is invisible or near-invisible in
		// an editor, and this file is read and edited by the same models whose
		// confusion between those glyphs it exists to explain.
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
		// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus.
		.replace(/[‐‑‒–—―−]/g, "-")
		// U+00A0 NBSP, U+2002-U+200A the en/em/thin family, U+202F narrow NBSP,
		// U+205F medium math space, U+3000 ideographic space.
		.replace(/[  -   　]/g, " ");
}

/** Character-bigram Dice coefficient: cheap, order-aware enough, no dependency. */
export function similarity(a: string, b: string): number {
	const left = squash(a);
	const right = squash(b);
	if (!left && !right) return 1;
	if (!left || !right) return 0;
	if (left === right) return 1;
	if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;

	const bigrams = new Map<string, number>();
	for (let i = 0; i < left.length - 1; i++) {
		const gram = left.slice(i, i + 2);
		bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < right.length - 1; i++) {
		const gram = right.slice(i, i + 2);
		const seen = bigrams.get(gram) ?? 0;
		if (seen > 0) {
			bigrams.set(gram, seen - 1);
			shared++;
		}
	}
	return (2 * shared) / (left.length - 1 + right.length - 1);
}

/** Every 0-based index at which `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	if (!needle) return found;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		found.push(at);
		from = at + Math.max(1, needle.length);
	}
}

function lineOf(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * The duplicate verdict with its sites named, built the same way whichever scan
 * found them. Both callers pass the string they searched, so `lineOf` counts
 * newlines in the same coordinates the indices came from.
 */
function duplicateAt(searched: string, at: number[]): EditDiagnosis {
	const lines = at.map((index) => lineOf(searched, index));
	return {
		kind: "duplicate",
		occurrences: at.length,
		lines: lines.slice(0, MAX_DUPLICATES),
		moreLines: Math.max(0, lines.length - MAX_DUPLICATES),
	};
}

function candidateAt(lines: string[], start: number, count: number, score: number): NearMiss {
	const shown = Math.min(count, MAX_CANDIDATE_LINES);
	const slice = lines.slice(start, start + shown);
	return {
		line: start + 1,
		endLine: start + slice.length,
		similarity: score,
		text: slice.join("\n"),
		truncated: count > MAX_CANDIDATE_LINES,
	};
}

/**
 * What is really the matter with this anchor.
 *
 * `ok` means the anchor is present exactly once IN PI'S TERMS as well as in the
 * file's raw bytes — the edit failed for some other reason (overlap, an
 * unreadable file, a guard) and this module has nothing useful to add. Saying
 * nothing is the right output then; a diagnosis that always speaks is one the
 * reader learns to skip. Getting the "in pi's terms" qualifier wrong is not a
 * quiet imprecision, it is the whole failure: an `ok` on a duplicate pi did see
 * suppresses the diagnosis entirely, which is a silence indistinguishable from
 * this module not being installed.
 */
export function diagnose(content: string, anchor: string): EditDiagnosis {
	const text = toLF(content);
	const needle = toLF(anchor);
	if (!needle) return { kind: "absent" };

	const exact = occurrences(text, needle);

	// pi's fold is counted FIRST, and the raw scan below is only its fallback.
	//
	// The order is the correction. Counting raw first looks harmless — a raw
	// duplicate is a real duplicate — but it answers with a SMALLER set than the
	// error it is appended to. A file holding two byte-identical copies plus a
	// third that differs only by an NBSP makes pi say "Found 3 occurrences"
	// while a raw-first diagnosis says "occurs 2 times … at lines 1, 3": it
	// contradicts the message printed directly above it, and it omits line 5 —
	// the one site the model cannot see and the only reason this module exists.
	// Reported as a defect against the first version of this fix, reproduced
	// through diagnoseFailedEdit before it was changed.
	//
	// Reordering rather than deleting the raw branch is also deliberate. It is
	// tempting to argue the fold can only ever find MORE sites, so raw is
	// redundant — but NFKC composes, and a base character followed by a
	// combining mark can fold into a single codepoint across the needle's end
	// boundary, so a raw hit is not guaranteed to survive into fold space.
	// Keeping raw as the fallback costs one comparison and needs no such
	// assumption.
	//
	// Counted on 0 exact hits AND on 1: one exact hit is NOT yet "fine".
	//
	// One exact hit is NOT yet "fine", which is the correction this branch is.
	// pi's `countOccurrences` folds both sides unconditionally, so a second site
	// that differs from the first only by a trailing space, an NBSP, an em-dash
	// or an NFKC twin is a duplicate to pi while being invisible to the raw scan
	// above. That combination — raw count 1, pi count 2 — was the exact shape the
	// papercut kept hitting, and it used to leave here as `ok`: pi refused the
	// edit, `explain` returned null, and the model was handed "Found 2
	// occurrences … Please provide more context" with nothing appended to it.
	//
	// The line numbers survive the fold. Every rule in it is either a per-line
	// trimEnd or a 1:1 character substitution, and none of them emits or eats a
	// newline — NFKC maps nothing to U+000A — so the folded string carries the
	// same lines in the same order, and `lineOf` over it is the file's own
	// numbering. That is why this can name lines rather than say "somewhere".
	const folded = normalizeLikePi(text);
	const foldedNeedle = normalizeLikePi(needle);
	const fuzzy = foldedNeedle ? occurrences(folded, foldedNeedle) : [];
	if (fuzzy.length > 1) return duplicateAt(folded, fuzzy);
	if (exact.length > 1) return duplicateAt(text, exact);

	if (exact.length === 1) return { kind: "ok" };

	const lines = text.split("\n");
	if (lines.length > MAX_SCANNED_LINES) return { kind: "absent" };

	// Score every window the anchor's height. Windows overlap, so a good match
	// produces a run of near-equal scores; keep only the best of each run so two
	// "candidates" are two PLACES, not two offsets into the same place.
	const height = Math.max(1, needle.split("\n").length);
	const scored: NearMiss[] = [];
	for (let start = 0; start + 1 <= lines.length; start++) {
		const window = lines.slice(start, start + height).join("\n");
		const score = similarity(needle, window);
		if (score < NEAR_MISS_FLOOR) continue;
		const previous = scored[scored.length - 1];
		if (previous && start - (previous.line - 1) < height) {
			if (score > previous.similarity) scored[scored.length - 1] = candidateAt(lines, start, height, score);
			continue;
		}
		scored.push(candidateAt(lines, start, height, score));
	}

	if (scored.length === 0) return { kind: "absent" };
	scored.sort((a, b) => b.similarity - a.similarity);
	return { kind: "near-miss", candidates: scored.slice(0, MAX_CANDIDATES) };
}

/**
 * The diagnosis as the sentence the model reads.
 *
 * Written as evidence plus one instruction, because the measured failure is a
 * model confidently retrying a guess. "Here is what line 1 actually says" ends
 * that; "please provide more context" does not.
 *
 * Returns null when there is nothing worth adding — the caller then leaves pi's
 * own error untouched.
 */
export function explain(diagnosis: EditDiagnosis, path: string): string | null {
	switch (diagnosis.kind) {
		case "ok":
			return null;
		case "duplicate": {
			const where = diagnosis.lines.length
				? ` at lines ${diagnosis.lines.join(", ")}${diagnosis.moreLines ? ` (and ${diagnosis.moreLines} more)` : ""}`
				: "";
			return (
				`That text occurs ${diagnosis.occurrences} times in ${path}${where}. ` +
				`Extend oldText with an adjacent line that differs between them — do not retry the same anchor.`
			);
		}
		case "near-miss": {
			// Fenced rather than gutter-numbered on purpose. A line-number gutter
			// would be more readable, but the model has to copy these bytes back
			// EXACTLY, and stripping a gutter reintroduces the transcription step
			// that is the measured failure. The markers exist so a trailing blank
			// line — invisible otherwise — is unambiguous.
			const parts = diagnosis.candidates.map((candidate) => {
				const span = candidate.line === candidate.endLine ? `line ${candidate.line}` : `lines ${candidate.line}-${candidate.endLine}`;
				const head = `${span} (${Math.round(candidate.similarity * 100)}% similar) actually read:`;
				return `${head}\n--- begin ---\n${candidate.text}\n--- end ---${candidate.truncated ? "\n(region continues past what is shown)" : ""}`;
			});
			return (
				`Nothing in ${path} matches that text exactly. The closest region is not identical to your oldText:\n\n` +
				`${parts.join("\n\n")}\n\n` +
				`Copy the text between the markers verbatim if that is the region you meant. ` +
				`Do not re-send the anchor you just used.`
			);
		}
		case "absent":
			return (
				`Nothing in ${path} resembles that text — this is not a whitespace or a uniqueness problem, ` +
				`the content is not there. Read the file (or the region you are aiming at) before editing it again.`
			);
	}
}
