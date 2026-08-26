/**
 * brief — who last touched the files the task names (HIV-1806).
 *
 * The briefer sees the tree as it stands and nothing about how it got there.
 * That gap is expensive in a specific, repeated way: a task like "the brief
 * keeps timing out" is one `git log` away from the commit that set the timeout,
 * the measurement in its message, and the ticket key that explains the trade.
 * The expensive model runs that `git log` on turn one, every time.
 *
 * NO MODEL RUNS HERE, and that is the design rather than an optimisation.
 *
 *  - It is FREE. Two `git` reads per named file, tens of milliseconds, so it
 *    cannot push the wall-clock that HIV-1804 is spending a fan-out to reduce.
 *  - It is CHECKABLE. A commit hash is the one kind of fact a language model
 *    produces most convincingly and most wrongly. Measuring it removes the
 *    failure instead of prompting against it — which is also why `BriefDraft`
 *    keeps `history` out of the parse path entirely.
 *  - It needs no new capability. The alternative considered was granting the
 *    briefer role a shell, and "a cheap model with `bash`, running unattended
 *    before every session's first turn" is not a trade this feature needs to
 *    make for a `git log`.
 *
 * Everything here fails silent. Not a git repo, git missing, a detached or
 * empty history, a path that resolves to two files — every one of them returns
 * fewer facts, never an error, because this runs on the path that gates the
 * first turn.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_HISTORY, type BriefRef } from "./compile.ts";

const run = promisify(execFile);

/** Per-git-call wall. Local reads; anything slower than this is a wedged repo, not a slow one. */
const GIT_TIMEOUT_MS = 2_000;

/** Candidate paths considered. Above MAX_HISTORY so ambiguous ones can drop without starving the section. */
const MAX_CANDIDATES = 8;

/**
 * ASCII unit separator, written as an escape rather than a literal control
 * character so the format string survives an editor, a diff and a copy-paste.
 * Not a pipe or a tab: a commit subject may legitimately contain either, and a
 * subject that splits itself would put half a message in the date field of a
 * section whose whole claim is that it was measured.
 */
const FIELD_SEP = "\x1f";

/** `%h`, `%ad`, `%s` — hash, short date, subject. */
const LOG_FORMAT = `%h${FIELD_SEP}%ad${FIELD_SEP}%s`;

/**
 * Path-shaped tokens in the task.
 *
 * Extension-anchored, like `looksTaskLike`'s own test — a bare word is not a
 * path, and treating one as a filename produces an ambiguous `ls-files` match
 * that gets dropped anyway, having cost a git call to discover.
 */
const PATH_TOKEN = /[\w./-]*\w\.(?:ts|tsx|js|jsx|mjs|go|py|star|md|json|ya?ml|sql|sh|rs|toml)\b(?::\d+)?/g;

/** Path-like tokens named in the task, deduped, line suffixes stripped, in first-seen order. */
export function candidatePaths(task: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of task.match(PATH_TOKEN) ?? []) {
		const path = match.replace(/:\d+$/, "").replace(/^\.\//, "");
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
		if (out.length >= MAX_CANDIDATES) break;
	}
	return out;
}

/**
 * Turn `git log`'s one line into the note a fact carries.
 *
 * Exported for the test, because the parse is the part that silently degrades:
 * a format change upstream would leave this returning the raw line rather than
 * throwing, and a brief full of unsplit git output is a thing nobody would
 * notice reading a green suite.
 */
export function parseLogLine(line: string): string | null {
	const [hash, date, ...subject] = line.trim().split(FIELD_SEP);
	if (!hash || !date || subject.length === 0) return null;
	// Rejoined rather than taken as `subject[0]`: a separator cannot appear in a
	// commit subject, but rejoining makes that a property of the code instead of
	// an assumption about git's escaping.
	const text = subject.join(FIELD_SEP).trim();
	if (!text) return null;
	return `last changed ${date} in ${hash} — ${text}`;
}

export interface ProvenanceOptions {
	task: string;
	cwd: string;
	max?: number;
}

/**
 * Recent history for the files the task names, as brief facts.
 *
 * Concurrent across candidates and bounded on both ends: a repo with no match
 * for anything costs `2 × candidates` sub-second git reads and returns nothing.
 */
export async function collectProvenance(options: ProvenanceOptions): Promise<BriefRef[]> {
	const max = options.max ?? MAX_HISTORY;
	const candidates = candidatePaths(options.task);
	if (candidates.length === 0 || max <= 0) return [];

	const settled = await Promise.all(candidates.map((candidate) => historyFor(candidate, options.cwd)));
	const out: BriefRef[] = [];
	const seen = new Set<string>();
	for (const entry of settled) {
		if (!entry || seen.has(entry.ref)) continue;
		seen.add(entry.ref);
		out.push(entry);
		if (out.length >= max) break;
	}
	return out;
}

async function historyFor(candidate: string, cwd: string): Promise<BriefRef | null> {
	const resolved = await resolvePath(candidate, cwd);
	if (!resolved) return null;
	const line = await git(["log", "-n", "1", "--no-merges", "--date=short", `--format=${LOG_FORMAT}`, "--", resolved], cwd);
	if (!line) return null;
	const note = parseLogLine(line);
	return note ? { ref: resolved, note } : null;
}

/**
 * The tracked path this token means, or null.
 *
 * An AMBIGUOUS token resolves to nothing on purpose. `index.ts` matches a dozen
 * files in this repo alone, and reporting the most recently committed one of
 * them as "the" file the task named would be a confident wrong answer in a
 * section whose whole claim is that it was measured.
 */
async function resolvePath(candidate: string, cwd: string): Promise<string | null> {
	const basename = candidate.split("/").pop();
	if (!basename) return null;

	const listed = await git(["ls-files", "-z", "--", `*${basename}`], cwd);
	if (!listed) return null;
	const paths = listed.split("\0").filter(Boolean);
	if (paths.length === 0) return null;

	// An exact tail match wins outright: `brief/run.ts` names one file even in a
	// repo with five `run.ts`, which is the common case for a task written by
	// someone who was looking at it.
	const exact = paths.filter((p) => p === candidate || p.endsWith(`/${candidate}`));
	if (exact.length === 1) return exact[0]!;
	if (exact.length > 1) return null;
	return paths.length === 1 ? paths[0]! : null;
}

/** One git read. Returns its stdout, or null for every possible failure. */
async function git(args: string[], cwd: string): Promise<string | null> {
	try {
		const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true });
		const text = stdout.trim();
		return text ? text : null;
	} catch {
		// Not a repo, git absent, timeout, empty history, a pathspec git dislikes:
		// all of them mean the same thing here, which is "no history to report".
		return null;
	}
}
