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
 * pi falls back to a whitespace-insensitive match before reporting a miss, so
 * anything that survives to here already differs by more than spacing. Mirrored
 * (not imported) — `fuzzyFindText` lives at a non-root subpath of pi, and
 * `test/pi-api-surface.test.ts` forbids reaching in there for good reason.
 */
function squash(text: string): string {
	return toLF(text).replace(/[ \t]+/g, " ").trim();
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
 * `ok` means the anchor is present exactly once — the edit failed for some
 * other reason (overlap, an unreadable file, a guard) and this module has
 * nothing useful to add. Saying nothing is the right output then; a diagnosis
 * that always speaks is one the reader learns to skip.
 */
export function diagnose(content: string, anchor: string): EditDiagnosis {
	const text = toLF(content);
	const needle = toLF(anchor);
	if (!needle) return { kind: "absent" };

	const exact = occurrences(text, needle);
	if (exact.length === 1) return { kind: "ok" };
	if (exact.length > 1) {
		const lines = exact.map((at) => lineOf(text, at));
		return {
			kind: "duplicate",
			occurrences: exact.length,
			lines: lines.slice(0, MAX_DUPLICATES),
			moreLines: Math.max(0, lines.length - MAX_DUPLICATES),
		};
	}

	// Whitespace-insensitive duplicates: pi matches this way too, so N>1 here is
	// the same failure wearing different spacing.
	const squashedText = squash(text);
	const squashedNeedle = squash(needle);
	const fuzzy = squashedNeedle ? occurrences(squashedText, squashedNeedle) : [];
	if (fuzzy.length > 1) {
		return { kind: "duplicate", occurrences: fuzzy.length, lines: [], moreLines: 0 };
	}

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
