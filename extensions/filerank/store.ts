/**
 * filerank/store.ts — what the ranker remembers between sessions.
 *
 * Two tables, and the split matters: `paths` is what the agent HAS touched
 * (frequency + recency, the frecency input), `selections` is what the agent
 * touched AFTER a specific `find` — which is a much stronger signal, because it
 * is the answer to a question the model actually asked. A hundred reads of
 * package.json tell you it is a popular file; one read of
 * `extensions/narrate/narrate.ts` right after `find **\/narrate*` tells you what
 * "narrate" means in this repo.
 *
 * Everything here is a state transition on a plain object plus two file
 * operations at the edges. The transitions are called from a pi event handler
 * and must stay allocation-light — pi awaits handlers serially, so a slow
 * handler IS the agent loop. The file operations are NOT called from a handler:
 * the load runs once at extension load, and the flush runs on a debounce timer
 * or at `session_shutdown`.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readJSON } from "../hive-common/identity.ts";

/** One path's access history. Keys are ABSOLUTE paths; see index.ts on why. */
export interface AccessEntry {
	/** How many times a read/edit/write tool touched this path. */
	count: number;
	/** Epoch ms of the most recent touch. */
	lastAccessMs: number;
}

/**
 * One query→path selection.
 *
 * The timestamp is not read by the ranker. It exists so `pruneStore` has
 * something defensible to evict on: a cap with no eviction order is a cap that
 * throws away whichever key the JSON parser happened to emit first.
 */
export interface SelectionEntry {
	path: string;
	atMs: number;
}

export interface FilerankStore {
	paths: Record<string, AccessEntry>;
	/** Keyed by the raw find pattern, which is what the model typed. */
	selections: Record<string, SelectionEntry>;
}

/**
 * Cap on remembered paths.
 *
 * Four thousand, chosen against the thing that actually grows: a long-running
 * factory container or a workstation session that reads its way through a large
 * repo. Aurora has ~11k tracked files and a busy day touches a few hundred, so
 * 4k holds weeks of real working set while bounding the file at roughly 300KB —
 * small enough that the debounced flush stays a sub-millisecond write, which is
 * the property that lets the flush be synchronous at shutdown.
 */
export const MAX_PATHS = 4000;

/**
 * Cap on remembered selections. An order of magnitude smaller than MAX_PATHS
 * because a session asks far fewer distinct questions than it reads files, and
 * because a selection only helps when the SAME pattern comes back — a query
 * from a thousand searches ago almost certainly never will.
 */
export const MAX_SELECTIONS = 500;

/**
 * Where the store lives.
 *
 * NOT under `stateDir()` (~/.pi/agent/hive-telemetry). That directory is the
 * credential store, and a file that is written on a timer from every session has
 * no business sharing a directory whose whole point is "review what is in here
 * before you ask what can leave this machine".
 */
export function storePath(): string {
	return join(homedir(), ".pi", "agent", "filerank.json");
}

export function emptyStore(): FilerankStore {
	return { paths: {}, selections: {} };
}

/**
 * loadStore never throws and never returns a partially-trusted object.
 *
 * A missing file is the first run. A corrupt file is a half-finished write from
 * a killed process, or a hand-edit — and in both cases the right answer is an
 * empty store, because the alternative (an entry whose `count` is a string, or
 * whose `lastAccessMs` is null) turns into a NaN inside the comparator and a
 * NaN inside a comparator is a nondeterministic sort. Sanitising here is what
 * lets rank.ts assume its inputs are numbers.
 */
export function loadStore(path: string = storePath()): FilerankStore {
	return sanitize(readJSON<unknown>(path));
}

function sanitize(raw: unknown): FilerankStore {
	const store = emptyStore();
	if (!raw || typeof raw !== "object") return store;
	const input = raw as { paths?: unknown; selections?: unknown };

	if (input.paths && typeof input.paths === "object") {
		for (const [path, value] of Object.entries(input.paths as Record<string, unknown>)) {
			if (!path || !value || typeof value !== "object") continue;
			const entry = value as { count?: unknown; lastAccessMs?: unknown };
			const count = finitePositive(entry.count);
			const lastAccessMs = finitePositive(entry.lastAccessMs);
			if (count === null || lastAccessMs === null) continue;
			store.paths[path] = { count, lastAccessMs };
		}
	}

	if (input.selections && typeof input.selections === "object") {
		for (const [query, value] of Object.entries(input.selections as Record<string, unknown>)) {
			if (!query || !value || typeof value !== "object") continue;
			const entry = value as { path?: unknown; atMs?: unknown };
			const atMs = finitePositive(entry.atMs);
			if (typeof entry.path !== "string" || !entry.path || atMs === null) continue;
			store.selections[query] = { path: entry.path, atMs };
		}
	}

	return store;
}

function finitePositive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Fold one file touch. Mutates in place: this runs on the hot loop. */
export function recordAccess(state: FilerankStore, path: string, nowMs: number): void {
	if (!path) return;
	const entry = state.paths[path];
	if (entry) {
		entry.count += 1;
		// Clock skew and resumed sessions both exist; a lastAccessMs that goes
		// backwards would make a file look staler than it is.
		if (nowMs > entry.lastAccessMs) entry.lastAccessMs = nowMs;
		return;
	}
	state.paths[path] = { count: 1, lastAccessMs: nowMs };
}

/**
 * Record that `path` was opened in answer to `query`.
 *
 * LAST ONE WINS, deliberately. This is not a frequency table — it is "what did
 * this question turn out to mean", and the most recent answer is the one that
 * reflects where the code lives now. Keeping a ranked list per query would
 * pin a moved or deleted file to the top of a search forever.
 */
export function recordSelection(state: FilerankStore, query: string, path: string, nowMs: number): void {
	if (!query || !path) return;
	state.selections[query] = { path, atMs: nowMs };
}

/**
 * Drop the coldest entries once either table is over its cap.
 *
 * Eviction is by RECENCY, not by the frecency score the ranker uses. That is a
 * deliberate simplification and not merely a way to avoid importing rank.ts:
 * pruning only ever bites at thousands of paths, where the question is "has
 * this path been touched this month at all", and a count-weighted score would
 * keep a file read 40 times during one migration a year ago ahead of the file
 * being edited this week.
 *
 * Ties break on count then on the path itself, so the result is a total order —
 * two runs on the same store evict the same entries.
 */
export function pruneStore(state: FilerankStore, maxPaths: number = MAX_PATHS, maxSelections: number = MAX_SELECTIONS): void {
	const paths = Object.keys(state.paths);
	if (paths.length > maxPaths) {
		paths.sort((a, b) => {
			const ea = state.paths[a];
			const eb = state.paths[b];
			return eb.lastAccessMs - ea.lastAccessMs || eb.count - ea.count || (a < b ? -1 : a > b ? 1 : 0);
		});
		for (const path of paths.slice(maxPaths)) delete state.paths[path];
	}

	const queries = Object.keys(state.selections);
	if (queries.length > maxSelections) {
		queries.sort((a, b) => {
			const diff = state.selections[b].atMs - state.selections[a].atMs;
			return diff || (a < b ? -1 : a > b ? 1 : 0);
		});
		for (const query of queries.slice(maxSelections)) delete state.selections[query];
	}
}

/**
 * Write the store out, atomically, best effort.
 *
 * tmp + rename because the reader is `loadStore` on the next session's startup
 * and a torn write would present as "filerank forgot everything" with no other
 * symptom. Errors are swallowed: a ranking cache that can fail a session is a
 * worse trade than a ranking cache that occasionally forgets.
 *
 * Prunes first, so the cap is enforced on what is written rather than only on
 * what is read back.
 */
export function flushStore(state: FilerankStore, path: string = storePath(), maxPaths: number = MAX_PATHS): boolean {
	try {
		pruneStore(state, maxPaths);
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}
