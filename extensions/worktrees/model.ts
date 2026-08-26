/**
 * worktrees — pure model (HIV-1223). Parsing, resolution and guard decisions,
 * testable without gwq, git or a TUI.
 *
 * Resolution happens HERE and not in gwq on purpose: `gwq get <pattern>` and
 * `gwq remove` open an interactive fuzzy finder on an ambiguous pattern,
 * which inside a pi command handler is a hung process. Everything gwq is
 * asked to do by this extension must be exact.
 */

import * as path from "node:path";

export interface WorktreeInfo {
	path: string;
	branch: string;
	isMain: boolean;
}

/** `gwq list --json` — defensively; a parse failure is an empty list, and the
 *  caller reports "no worktrees" rather than a stack trace. */
export function parseWorktreeList(json: string): WorktreeInfo[] {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const out: WorktreeInfo[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const value = entry as Record<string, unknown>;
		if (typeof value.path !== "string" || typeof value.branch !== "string") continue;
		out.push({ path: value.path, branch: value.branch, isMain: value.is_main === true });
	}
	return out;
}

/** The bare repo itself shows up in gwq's list (`…/name.git`, is_main). It is
 *  never a place a session can live. */
export function isBareEntry(worktree: WorktreeInfo): boolean {
	return worktree.path.endsWith(".git");
}

/**
 * The pull-only anchor of a bare-repo layout (`…__worktrees/main` or
 * `…__worktrees/feature`). Sessions must not move INTO one: hive-pi's anchor
 * IS the live stowed config, every anchor is hard-reset by repo-sync.timer,
 * and non-git mutations there are guard-blocked. The remediation is always a
 * work worktree.
 */
export function isPullOnlyAnchor(target: string): boolean {
	const normalized = path.resolve(target);
	const base = path.basename(normalized);
	return (base === "main" || base === "feature") && path.dirname(normalized).endsWith("__worktrees");
}

/** Where a session lands when its own worktree is removed. */
export function anchorOf(list: readonly WorktreeInfo[]): WorktreeInfo | undefined {
	const anchor = list.find((worktree) => !isBareEntry(worktree) && isPullOnlyAnchor(worktree.path));
	if (anchor) return anchor;
	// Non-bare layouts: the main checkout is a fine landing spot.
	return list.find((worktree) => worktree.isMain && !isBareEntry(worktree));
}

export type Resolution = { ok: true; worktree: WorktreeInfo } | { ok: false; error: string };

/** Exact branch first, then unique substring of branch or directory name. */
export function resolveWorktree(list: readonly WorktreeInfo[], pattern: string): Resolution {
	const candidates = list.filter((worktree) => !isBareEntry(worktree));
	const exact = candidates.find((worktree) => worktree.branch === pattern);
	if (exact) return { ok: true, worktree: exact };

	const matches = candidates.filter(
		(worktree) => worktree.branch.includes(pattern) || path.basename(worktree.path).includes(pattern),
	);
	if (matches.length === 1) return { ok: true, worktree: matches[0] };
	if (matches.length === 0) {
		const known = candidates.map((worktree) => worktree.branch).join(", ") || "none";
		return { ok: false, error: `no worktree matches "${pattern}" (known: ${known})` };
	}
	return {
		ok: false,
		error: `"${pattern}" is ambiguous: ${matches.map((worktree) => worktree.branch).join(", ")}`,
	};
}

export type WtCommand =
	| { sub: "list" }
	| { sub: "fork"; branch: string }
	| { sub: "checkout"; pattern: string }
	| { sub: "rm"; pattern?: string }
	| { error: string };

const USAGE = "usage: /wt [list] | /wt fork <branch> | /wt checkout <pattern> | /wt rm [pattern]";

export function parseWtArgs(raw: string): WtCommand {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	const [sub, arg, extra] = parts;
	if (extra) return { error: USAGE };
	switch (sub ?? "list") {
		case "list":
		case "ls":
			return arg ? { error: USAGE } : { sub: "list" };
		case "fork":
			return arg ? { sub: "fork", branch: arg } : { error: "usage: /wt fork <branch>" };
		case "checkout":
		case "co":
			return arg ? { sub: "checkout", pattern: arg } : { error: "usage: /wt checkout <pattern>" };
		case "rm":
		case "remove":
			return { sub: "rm", ...(arg ? { pattern: arg } : {}) };
		default:
			return { error: USAGE };
	}
}

export function formatList(list: readonly WorktreeInfo[], cwd: string): string[] {
	const here = path.resolve(cwd);
	const rows = list.filter((worktree) => !isBareEntry(worktree));
	if (rows.length === 0) return ["no worktrees — /wt fork <branch> creates one via gwq"];
	return rows.map((worktree) => {
		const marker = path.resolve(worktree.path) === here ? "▶" : " ";
		const anchor = isPullOnlyAnchor(worktree.path) ? " (pull-only anchor)" : "";
		return `${marker} ${worktree.branch}  ${worktree.path}${anchor}`;
	});
}
