/**
 * status-footer — what am I working on?
 *
 * Resolves the cwd into the identifiers the Hive and Linear watchers need: the
 * repository name, the branch, and the pull request (number, url, title).
 *
 * Everything here shells out to `git` and `gh`, so it is ALL async and none of
 * it may be awaited from a pi event handler — pi runs handlers serially, so a
 * 300ms `gh pr view` inside one is 300ms of stalled agent loop. Callers resolve
 * on a timer or in a command handler instead.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 6_000;

export interface Workspace {
	cwd: string;
	/** Repository name from the origin remote, e.g. "hive-pi". Null outside a git repo. */
	repo: string | null;
	branch: string | null;
	pr: number | null;
	prUrl: string | null;
	prTitle: string | null;
}

export const EMPTY_WORKSPACE: Workspace = {
	cwd: "",
	repo: null,
	branch: null,
	pr: null,
	prUrl: null,
	prTitle: null,
};

async function run(cwd: string, command: string, args: string[], timeout: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(command, args, { cwd, encoding: "utf8", timeout });
		const trimmed = stdout.trim();
		return trimmed || null;
	} catch {
		return null;
	}
}

/**
 * repoNameFromRemote takes the last path segment of a remote URL, in either the
 * scp-ish (`git@github.com:Artifex-org/hive-pi.git`) or the URL
 * (`https://github.com/Artifex-org/hive-pi`) form, and strips the `.git`.
 */
export function repoNameFromRemote(remote: string): string | null {
	const cleaned = remote.trim().replace(/[/\\]+$/, "");
	if (!cleaned) return null;
	const segment = cleaned.split(/[/:]/).pop();
	if (!segment) return null;
	const name = segment.replace(/\.git$/, "");
	return name || null;
}

/**
 * projectLabel is the human name for the workspace, used by the footer whether
 * or not the repo is known to Hive. Falls back through the remote, the git root
 * and finally the directory basename so it is never empty.
 */
export function projectLabel(cwd: string, repo: string | null, gitRoot: string | null): string {
	if (process.env.HOME === cwd) return "Home";
	if (repo) return repo;
	if (gitRoot) return path.basename(gitRoot);
	return path.basename(cwd) || "Home";
}

interface GhPullView {
	number?: number;
	url?: string;
	title?: string;
}

/**
 * parsePullView reads `gh pr view --json number,url,title`. A missing or
 * non-numeric number means "no PR for this branch", which is the common case and
 * not an error.
 */
export function parsePullView(raw: string | null): Pick<Workspace, "pr" | "prUrl" | "prTitle"> {
	if (!raw) return { pr: null, prUrl: null, prTitle: null };
	try {
		const view = JSON.parse(raw) as GhPullView;
		if (typeof view.number !== "number" || !Number.isFinite(view.number)) {
			return { pr: null, prUrl: null, prTitle: null };
		}
		return {
			pr: view.number,
			prUrl: typeof view.url === "string" && view.url ? view.url : null,
			prTitle: typeof view.title === "string" && view.title ? view.title : null,
		};
	} catch {
		return { pr: null, prUrl: null, prTitle: null };
	}
}

export async function resolveWorkspace(cwd: string): Promise<Workspace> {
	// git first and in parallel — cheap, and the remote decides whether the `gh`
	// call is worth making at all.
	const [remote, branch, gitRoot] = await Promise.all([
		run(cwd, "git", ["remote", "get-url", "origin"], GIT_TIMEOUT_MS),
		run(cwd, "git", ["branch", "--show-current"], GIT_TIMEOUT_MS),
		run(cwd, "git", ["rev-parse", "--show-toplevel"], GIT_TIMEOUT_MS),
	]);

	const repo = remote ? repoNameFromRemote(remote) : null;
	const base: Workspace = {
		cwd,
		repo: repo ?? (gitRoot ? path.basename(gitRoot) : null),
		branch,
		pr: null,
		prUrl: null,
		prTitle: null,
	};
	// No remote means no forge, so no PR to look up — skip the slowest call.
	if (!remote) return base;

	const pull = parsePullView(await run(cwd, "gh", ["pr", "view", "--json", "number,url,title"], GH_TIMEOUT_MS));
	return { ...base, ...pull };
}

/** Two workspaces are the same watch target when repo, branch and PR all match. */
export function sameWorkspace(a: Workspace, b: Workspace): boolean {
	return a.repo === b.repo && a.branch === b.branch && a.pr === b.pr && a.cwd === b.cwd;
}
