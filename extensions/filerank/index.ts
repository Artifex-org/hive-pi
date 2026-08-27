/**
 * filerank — put the file the model wants first.
 *
 * See ./rank.ts for the argument about which half of `fff` is worth rebuilding,
 * and ./README.md for the whole reasoning. This file is only the wiring, and the
 * wiring turned out to be the interesting part, for one reason:
 *
 * THIS DOES NOT REGISTER A `find` TOOL, AND MUST NOT.
 *
 * The obvious implementation — and the one this was specified as — overrides the
 * built-in with `registerTool({ name: "find", … })`, which pi does support and
 * which `pretty-tools.ts` already uses. That is exactly the problem. pi resolves
 * duplicate tool names FIRST-REGISTRATION-WINS across extensions
 * (`core/extensions/runner.js` → `getAllRegisteredTools`), and the extension
 * order is raw `fs.readdirSync` order — filesystem order, not sorted
 * (`core/extensions/loader.js` → `discoverExtensionsInDir`). So two extensions
 * claiming `find` is a coin flip decided by inode ordering: either filerank
 * never executes and ranking is silently absent, or it displaces pretty-tools
 * and the compact find renderer is silently lost. Both failures are invisible
 * and neither is reproducible — which is precisely the nondeterminism rank.ts
 * goes to such lengths to keep out of the ordering itself.
 *
 * So the ranking rides on `tool_result`, the same place narrate puts its
 * reminder: pi hands the handler the finished result and takes a replacement
 * `content` back. It composes with whoever owns the tool name instead of
 * fighting them, it preserves the parameter schema and the result shape by
 * construction (we only reorder lines of text), and it is deterministic.
 *
 * The same handler does the learning half, which is the second thing the spec
 * got wrong: `tool_execution_end` carries `{toolCallId, toolName, result,
 * isError}` and NO arguments, so the path that was read is not in that event at
 * all. `tool_result` carries `input`. One subscription, both jobs, no second
 * handler on a deliberately small hooks budget.
 *
 * THE ONE MECHANICAL CONSTRAINT: pi awaits handlers serially, so a slow handler
 * IS the agent loop. Nothing below blocks. The store is an in-memory object
 * flushed on a debounce timer and at shutdown; git status is refreshed by a
 * detached subprocess whose result is used by the NEXT find, never awaited by
 * this one.
 */

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isFindToolResult } from "@earendil-works/pi-coding-agent";

import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";
import { MAX_RANKABLE_LINES, parseGitStatus, rankPaths, reorderFindOutput, type GitState } from "./rank.ts";
import { MAX_PATHS, flushStore, loadStore, recordAccess, recordSelection, storePath } from "./store.ts";

interface FilerankConfig {
	enabled: boolean;
	maxPaths: number;
	gitTtlMs: number;
}

/**
 * Defaults ON, like narrate and unlike hive-telemetry.
 *
 * Nothing here leaves the machine and nothing here is destructive: the entire
 * observable effect is that a list of file paths comes back in a different
 * order. The store does record which files a session opened, which is why it
 * lives in a mode-0600 file under ~/.pi/agent and is never transmitted — but a
 * local access-time cache is not the kind of thing that needs an opt-in
 * ceremony, and one that ships off by default ships unused.
 */
function loadConfig(): FilerankConfig {
	const raw = readJSON<Partial<FilerankConfig>>(configPathFor("filerank")) ?? {};
	return {
		enabled: raw.enabled !== false,
		maxPaths: numberOr(raw.maxPaths, MAX_PATHS, 100, 50_000),
		gitTtlMs: numberOr(raw.gitTtlMs, GIT_TTL_MS, 1_000, 600_000),
	};
}

/**
 * How long a git-status snapshot is trusted: 15 seconds.
 *
 * The signal it feeds is "what is the user working on right now", so it has to
 * survive an edit-search-edit loop without going stale, and 15s does: the
 * refresh is kicked off by the same find that reads the cache, so a second
 * search a minute later sees the file you just touched. It cannot be zero —
 * `git status` on Aurora takes 40-120ms and the whole point is that no find ever
 * waits for it — and it need not be smaller, because a file that changed state
 * within the last 15 seconds is a file the model almost certainly has in
 * context already.
 */
const GIT_TTL_MS = 15_000;

/**
 * How long the store may sit dirty in memory: 5 seconds.
 *
 * Long enough that a burst of twenty reads is one write rather than twenty;
 * short enough that a `kill -9` loses at most one search's worth of learning.
 * The timer is unref'd, so it can never be the reason a process stays alive.
 */
const FLUSH_DEBOUNCE_MS = 5_000;

/** Subprocess budget for a git call, matching hive-common's. Nothing awaits it. */
const GIT_TIMEOUT_MS = 800;

/** ~4MB of porcelain — a repo dirtier than this has no useful "right now" signal. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/** The tools whose `path` argument means "the model opened this file". */
const ACCESS_TOOLS = new Set(["read", "edit", "write"]);

const NO_GIT: ReadonlyMap<string, GitState> = new Map();

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	// Read in the factory so a disabled install registers NOTHING — no handler,
	// no command, no subprocess. narrate's reasoning, and it matters more here:
	// a no-op `tool_result` handler still forces pi to await it after every
	// single tool call in the session.
	if (!cfg.enabled) return;

	const cwd = process.cwd();
	const path = storePath();
	const store = loadStore(path);

	let gitStatus: ReadonlyMap<string, GitState> = NO_GIT;
	let gitCheckedAtMs = 0;
	let gitInFlight = false;

	let dirty = false;
	let flushTimer: NodeJS.Timeout | null = null;

	/**
	 * The find whose results we most recently ranked.
	 *
	 * This is what turns an access into a SELECTION. A read that follows a find,
	 * of a file that find returned, is the model answering its own question — and
	 * that answer is the strongest ranking signal we have. Cleared once consumed
	 * so a second read from the same result set does not overwrite the first
	 * (the first pick is the one the model committed to).
	 */
	let lastFind: { query: string; keys: Set<string> } | null = null;

	/**
	 * Refresh git status WITHOUT blocking anything.
	 *
	 * Two chained subprocesses, both detached: `rev-parse --show-toplevel` to
	 * find the root the porcelain paths are relative to, then `status
	 * --porcelain` from that root. Outside a repo the first one fails and the map
	 * stays empty, which the ranker reads as "no git signal" — the correct
	 * behaviour for a session in ~/notes, and never an error.
	 *
	 * The result lands for the NEXT find. That is not a compromise: a find that
	 * awaited this would put a 40-120ms subprocess on the agent loop to improve
	 * an ordering, which is the wrong trade in a way that would not show up in
	 * any test.
	 */
	function refreshGit(): void {
		if (gitInFlight) return;
		gitInFlight = true;
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: GIT_TIMEOUT_MS }, (rootErr, rootOut) => {
			const root = rootErr ? "" : rootOut.trim();
			if (!root) {
				gitInFlight = false;
				gitCheckedAtMs = Date.now();
				gitStatus = NO_GIT;
				return;
			}
			execFile(
				"git",
				["status", "--porcelain"],
				{ cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
				(statusErr, statusOut) => {
					gitInFlight = false;
					gitCheckedAtMs = Date.now();
					gitStatus = statusErr ? NO_GIT : parseGitStatus(statusOut, root, join);
				},
			);
		});
	}

	function flushNow(): void {
		if (!dirty) return;
		dirty = false;
		flushStore(store, path, cfg.maxPaths);
	}

	function scheduleFlush(): void {
		dirty = true;
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushNow();
		}, FLUSH_DEBOUNCE_MS);
		flushTimer.unref();
	}

	// Warm the cache before the first find asks for it. Extension load is not a
	// handler and this does not await, so it costs the session nothing.
	refreshGit();

	pi.on("tool_result", (event) => {
		// A failed tool says nothing about what the model wanted, and a failed
		// find has no list to reorder.
		if (event.isError) return;

		if (isFindToolResult(event)) {
			if (Date.now() - gitCheckedAtMs > cfg.gitTtlMs) refreshGit();
			// Disarm FIRST, so the invariant is "a selection follows the MOST
			// RECENT find". Without this, a find that takes an early exit inside
			// rankFind (one result, a shape we do not touch) leaves the previous
			// find still armed, and the next read records a selection against a
			// question the model has already moved on from — a wrong entry in the
			// strongest tier, written to disk.
			lastFind = null;
			return rankFind(event.input, event.content);
		}

		if (!ACCESS_TOOLS.has(event.toolName)) return;
		const opened = event.input.path;
		if (typeof opened !== "string" || !opened) return;
		// pi resolves a tool's relative path against the session cwd before
		// opening it. Keying on the raw argument would file the same file under
		// two names depending on how the model happened to spell it.
		const key = resolve(cwd, opened);
		const now = Date.now();
		recordAccess(store, key, now);
		if (lastFind && lastFind.keys.has(key)) {
			recordSelection(store, lastFind.query, key, now);
			lastFind = null;
		}
		scheduleFlush();
	});

	function rankFind(
		input: ToolResultEvent["input"],
		content: ToolResultEvent["content"],
	): { content: ToolResultEvent["content"] } | undefined {
		const first = content[0];
		// Anything other than a plain text block first is a shape we did not
		// write and do not understand. Leave it alone.
		if (!first || first.type !== "text") return undefined;
		const text = first.text;
		if (typeof text !== "string") return undefined;

		const searchRoot = resolve(cwd, typeof input.path === "string" && input.path ? input.path : ".");
		const query = typeof input.pattern === "string" ? input.pattern : undefined;
		const keys = new Set<string>();

		const out = reorderFindOutput(text, (paths) =>
			rankPaths(paths, {
				store,
				gitStatus,
				query,
				nowMs: Date.now(),
				// Called exactly once per result line by rankPaths, so the selection
				// key set costs one Set insert per line rather than a second pass.
				resolveKey: (candidate) => {
					const key = resolve(searchRoot, candidate);
					keys.add(key);
					return key;
				},
			}),
		);

		// Remember the candidate set even when the order did not change — the
		// model still asked a question, and whatever it opens next is still the
		// answer to it.
		if (query && keys.size > 0 && keys.size <= MAX_RANKABLE_LINES) lastFind = { query, keys };

		return out === null ? undefined : { content: [{ ...first, text: out }, ...content.slice(1)] };
	}

	// A debounced write is a write that might not have happened. This is the one
	// synchronous flush, and shutdown is the one place it is free.
	pi.on("session_shutdown", () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		flushNow();
	});

	pi.registerCommand("filerank-status", {
		description: "Show what filerank has learned and which signals are live",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const paths = Object.keys(store.paths).length;
			const selections = Object.keys(store.selections).length;
			const gitAge = gitCheckedAtMs ? `${Math.round((Date.now() - gitCheckedAtMs) / 1000)}s ago` : "never";
			ctx.ui.notify(
				[
					`store:      ${path}`,
					`paths:      ${paths} (cap ${cfg.maxPaths})`,
					`selections: ${selections}`,
					`git:        ${gitStatus.size} changed file(s), checked ${gitAge}`,
					`pending:    ${dirty ? "unflushed changes" : "clean"}`,
				].join("\n"),
			);
		},
	});
}
