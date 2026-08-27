/**
 * filerank/rank.ts — the half of `fff` that is worth rebuilding.
 *
 * `@ff-labs/pi-fff` replaces find and grep with a Rust SIMD engine plus frecency
 * ranking. We are not rebuilding the engine, for three reasons that all point
 * the same way: `rg` and `fd` already answer in milliseconds on our repos, a
 * background index built at session start is pure overhead for a one-shot
 * factory run that will read forty files and exit, and a native binary is a new
 * dependency in an epic whose headline property is that it adds none.
 *
 * The RANKING layer is a different question. It needs no binary, and it is the
 * part that actually changes what a model does: putting the right file first
 * saves a round trip — a whole request, its prefill and its latency — whereas
 * shaving 8ms off `fd` saves nothing an LLM can perceive.
 *
 * Everything in this file is pure and takes `nowMs` as a parameter. It is called
 * from a pi event handler, and pi awaits handlers serially: a slow handler IS
 * the agent loop. No `Date.now()`, no filesystem, no process spawning — the
 * caller does all of that, off the handler path.
 */

import type { FilerankStore } from "./store.ts";

/** What `git status --porcelain` says about a file, in the order we trust it. */
export type GitState = "staged" | "modified" | "untracked";

export interface RankContext {
	store: FilerankStore;
	/** Absolute path → git state. Empty outside a repo, which means "no git signal". */
	gitStatus: ReadonlyMap<string, GitState>;
	/** The find pattern, verbatim, or undefined. Matched against selection history. */
	query?: string;
	nowMs: number;
	/**
	 * Maps a result path to the store's key space.
	 *
	 * `find` returns paths relative to its search root; the store keys on
	 * absolute paths. Without this the two never meet and the whole extension is
	 * a silent no-op — which is exactly the kind of failure that ships green.
	 * Defaults to identity so tests can work in one space.
	 */
	resolveKey?: (path: string) => string;
}

/**
 * Frecency half-life: 7 days.
 *
 * The number has to be argued for, because it is the only thing separating this
 * from an arbitrary constant, and the argument is about DIVISION OF LABOUR
 * between the signals rather than about how memory decays.
 *
 * Git status already answers "what is the user touching right now" — precisely,
 * from the working tree, with no decay parameter at all. So frecency's job is
 * the tier below that: "what is this week's working set", the files you were in
 * on Tuesday that are not currently dirty. A half-life of hours would collapse
 * that into a duplicate of the git signal; a half-life of months would rank the
 * files from last quarter's migration alongside today's.
 *
 * Seven days puts the crossover where it reads correctly: a file touched once
 * yesterday (1 × 2^-1/7 = 0.91) outranks a file touched ten times a month ago
 * (10 × 2^-30/7 = 0.51), while a file touched ten times today (10) beats both.
 * One day of staleness costs ~9%; a fortnight costs 75%.
 */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Frecency: frequency, decayed by recency.
 *
 * Multiplicative rather than a weighted sum, because the two factors are not
 * independent evidence to be added — the count is the claim ("this file matters")
 * and the decay is the confidence in it ("as of when?"). A file read 50 times
 * two years ago should score near zero, not "half of 50".
 *
 * A lastAccessMs in the future (clock skew, a resumed session, a restored
 * backup) is clamped to no decay rather than allowed to become an amplifier.
 */
export function score(entry: { count: number; lastAccessMs: number }, nowMs: number): number {
	const ageMs = Math.max(0, nowMs - entry.lastAccessMs);
	return entry.count * Math.pow(2, -ageMs / HALF_LIFE_MS);
}

/**
 * Tiers, strongest first. These are separated into tiers rather than folded
 * into one weighted score on purpose: a weighted sum lets enough frecency
 * outvote a git signal, and there is no amount of "I read this a lot last week"
 * that should outrank "this file is staged for commit right now".
 */
const TIER_SELECTION = 3;
const TIER_GIT = 2;
const TIER_KNOWN = 1;
const TIER_UNKNOWN = 0;

/**
 * Within the git tier: staged beats modified beats untracked.
 *
 * Staged is the strongest statement a working tree makes — someone decided this
 * file is part of the next commit. Untracked is the weakest: it is also every
 * build artefact and stray scratch file that .gitignore happens not to cover,
 * so it earns a place above untouched files but the bottom of its own tier.
 */
const GIT_WEIGHT: Record<GitState, number> = { staged: 3, modified: 2, untracked: 1 };

interface Scored {
	path: string;
	index: number;
	tier: number;
	git: number;
	frecency: number;
}

/**
 * Order `paths` best-first.
 *
 * TOTAL AND STABLE BY CONSTRUCTION. The comparator ends in the original index,
 * so no two elements ever compare equal and the result does not depend on the
 * sort implementation's stability, on object key order, or on how the caller
 * built the list. Two runs on the same inputs give the same list — which is
 * tested, because a ranker that reshuffles identical inputs would make every
 * cached prefix of a session's tool output a cache miss.
 *
 * Paths the store has never seen are not dropped and not randomised: they fall
 * to the bottom tier and keep `fd`'s own order among themselves, which is
 * alphabetical-ish and at least predictable.
 */
export function rankPaths(paths: readonly string[], ctx: RankContext): string[] {
	const resolveKey = ctx.resolveKey;
	const selected = ctx.query ? ctx.store.selections[ctx.query]?.path : undefined;

	const scored: Scored[] = paths.map((path, index) => {
		const key = resolveKey ? resolveKey(path) : path;
		const entry = ctx.store.paths[key];
		const git = ctx.gitStatus.get(key);
		const frecency = entry ? score(entry, ctx.nowMs) : 0;
		const tier =
			selected !== undefined && key === selected
				? TIER_SELECTION
				: git !== undefined
					? TIER_GIT
					: frecency > 0
						? TIER_KNOWN
						: TIER_UNKNOWN;
		return { path, index, tier, git: git !== undefined ? GIT_WEIGHT[git] : 0, frecency };
	});

	scored.sort(compare);
	return scored.map((item) => item.path);
}

function compare(a: Scored, b: Scored): number {
	if (a.tier !== b.tier) return b.tier - a.tier;
	if (a.git !== b.git) return b.git - a.git;
	if (a.frecency !== b.frecency) return b.frecency - a.frecency;
	return a.index - b.index;
}

/**
 * Cap on how many result lines are worth reordering.
 *
 * `find` caps itself at 1000 results by default, so this only trips when a
 * caller raised `limit`. The point is not the sort — sorting 5000 strings is
 * microseconds — it is that `resolveKey` does a path resolution per line and
 * this runs inside a handler pi awaits. Above the cap the result is returned
 * untouched, because a slow rank is worse than an unranked list.
 */
export const MAX_RANKABLE_LINES = 5000;

/**
 * Matches find's trailing notice block: a blank line then `[…]` at the very end.
 *
 * The notice ("1000 results limit reached…", "[Truncated: …]") is metadata about
 * the search, not a result, and reordering it into the middle of the file list
 * would be a lie about which file it refers to.
 */
const NOTICE = /\n\n\[[^\]]*\]$/;

/**
 * Reorder a `find` result's text, or return null to leave it exactly as it was.
 *
 * NULL IS THE DEFAULT ANSWER for anything unexpected — an empty body, a single
 * result, a body with blank lines in it (find never emits those, so one means we
 * are looking at something other than a file list), a rank callback that returns
 * the wrong number of paths, or a reordering that changed nothing. Same ethos as
 * pretty-tools' edit diagnosis: an augmentation that can break the tool it
 * augments is a bad trade, and here the augmentation is worth strictly less than
 * the tool.
 *
 * "No files found matching pattern" falls out of the single-line guard, so it is
 * never touched and never needs a special case.
 */
export function reorderFindOutput(text: string, rank: (paths: readonly string[]) => string[]): string | null {
	if (!text) return null;

	const match = NOTICE.exec(text);
	const body = match ? text.slice(0, match.index) : text;
	const notice = match ? match[0] : "";
	if (!body) return null;

	const lines = body.split("\n");
	if (lines.length < 2 || lines.length > MAX_RANKABLE_LINES) return null;
	for (const line of lines) if (!line) return null;

	const ranked = rank(lines);
	if (ranked.length !== lines.length) return null;

	const out = ranked.join("\n") + notice;
	return out === text ? null : out;
}

/**
 * Parse `git status --porcelain` into absolute path → state.
 *
 * Porcelain v1 is a frozen format — that is what "porcelain" means in git — so
 * parsing it is safe in a way that parsing human output never is. Two shapes
 * need care: a rename prints `R  old -> new` and only the destination exists,
 * and `core.quotepath` wraps non-ASCII names in double quotes with C escapes.
 * The quotes are stripped; the escapes are not un-escaped, so a file with a
 * literal backslash in its name simply fails to match the store and loses its
 * git signal. That is the correct failure: a missing boost, not a wrong one.
 *
 * `join` is passed in rather than imported so the tests can exercise posix
 * behaviour without depending on the host platform.
 */
export function parseGitStatus(
	porcelain: string,
	root: string,
	join: (a: string, b: string) => string = (a, b) => (a.endsWith("/") ? `${a}${b}` : `${a}/${b}`),
): Map<string, GitState> {
	const status = new Map<string, GitState>();
	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length < 4) continue;
		const index = line[0];
		const worktree = line[1];
		// `!` is an ignored file (only with --ignored) and ` ` in both columns is
		// not a status at all; neither is evidence of work in progress.
		if (index === "!" || (index === " " && worktree === " ")) continue;

		let path = line.slice(3);
		const arrow = path.lastIndexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) path = path.slice(1, -1);
		if (!path) continue;

		// A file both staged and dirty (`MM`) counts as staged: the stronger
		// statement wins, and it is the same file either way.
		const state: GitState = index === "?" && worktree === "?" ? "untracked" : index !== " " ? "staged" : "modified";
		status.set(join(root, path), state);
	}
	return status;
}
