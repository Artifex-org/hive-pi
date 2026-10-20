/**
 * Git identity guard: a session commits as the identity it was launched with,
 * or not at all.
 *
 * In the HIV-3906 eval a launch with no git author configured did not stop and
 * say so: it committed as `git -c user.name="<another person>" -c
 * user.email=… commit`, borrowing a colleague's identity from the log. Nothing
 * refused it, and the commit was attributed to someone who never wrote it.
 *
 * So this blocks any command that WRITES an identity differing from the one git
 * resolves for the session — `git -c user.*=…` on a commit-creating verb,
 * `git commit --author=…`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name/email
 * assignments for such a git, and `git config user.name|user.email <value>`.
 * Reads (`git config user.name`, `git log --author=x`, `git shortlog`) pass, as does the
 * same identity spelled out explicitly, and so does any of it aimed at a
 * repository outside the session's worktree (a scratch repo under /tmp, or a
 * `git init` in a `cd "$(mktemp -d)"` directory earlier in the same command)
 * — test fixtures set throwaway identities all the time and harm nobody.
 *
 * Pure apart from the injected probe, so the rules are tested without git.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { splitCommands } from "./shell-split.ts";
import { literalWords } from "../toolhints/contextual.ts";

export interface GitIdentity {
	name?: string;
	email?: string;
}

export interface IdentityProbe {
	/** The identity git resolves in `dir` (repo, global and system config). */
	configured(dir: string): GitIdentity;
	/** The worktree root holding `dir`, or null outside a repository. */
	toplevel(dir: string): string | null;
}

export type IdentityVerdict = { kind: "allow" } | { kind: "block"; reason: string };

const ALLOW: IdentityVerdict = { kind: "allow" };

/** Verbs that create commits (or tags) and therefore record an identity. */
const COMMIT_WRITERS = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "pull", "tag", "notes", "stash"]);
const IDENTITY_KEY = /^(?:user|author|committer)\.(name|email)$/i;
const IDENTITY_ENV = /^(GIT_(?:AUTHOR|COMMITTER)_(NAME|EMAIL))=(.*)$/s;

const read = (args: string[], cwd: string): string | null => {
	try { return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
	catch { return null; }
};

export const realIdentityProbe: IdentityProbe = {
	configured: (dir) => ({ name: read(["config", "user.name"], dir) || undefined, email: read(["config", "user.email"], dir) || undefined }),
	toplevel: (dir) => read(["rev-parse", "--show-toplevel"], dir) || null,
};

/** One identity value a command would write, and where it applies. */
interface IdentityWrite {
	field: "name" | "email" | "author";
	value: string;
	/** How the command spells it, for the message. */
	shown: string;
	/** The directory the write applies to; null when it cannot be read. */
	dir: string | null;
}

const inside = (root: string, dir: string) => {
	const rel = relative(root, dir);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Every identity write in a compound command, and whether the command creates
 * a repository in a directory it computes at run time (`cd "$(mktemp -d)" &&
 * git init`), which is where writes to an unreadable directory then land.
 */
function identityWrites(command: string, cwd: string): { writes: IdentityWrite[]; scratch: boolean } {
	const writes: IdentityWrite[] = [];
	let scratch = false;
	let dir: string | null = cwd;
	// `export GIT_AUTHOR_NAME=…` applies to every later git in the command.
	const exported: Omit<IdentityWrite, "dir">[] = [];
	for (const segment of splitCommands(command, true)) {
		const words = literalWords(segment, true) ?? segment.trim().split(/\s+/);
		if (words[0] === "cd") {
			dir = words.length === 2 && dir && !/[$`]/.test(words[1]) ? resolve(dir, words[1]) : null;
			continue;
		}
		let i = 0;
		if (words[0] === "export" || words[0] === "env") i = 1;
		// Identity in the environment only matters to a git that records it, so
		// `GIT_AUTHOR_NAME=t go test ./...` (a fixture's own setting) passes.
		const environment: Omit<IdentityWrite, "dir">[] = [];
		for (; i < words.length; i++) {
			const assignment = IDENTITY_ENV.exec(words[i]);
			if (assignment) environment.push({ field: assignment[2] === "NAME" ? "name" : "email", value: assignment[3], shown: `${assignment[1]}=${assignment[3]}` });
			else if (!/^[A-Za-z_]\w*=/.test(words[i]) && !(words[0] === "env" && words[i].startsWith("-"))) break;
		}
		if (words[0] === "export") { exported.push(...environment); continue; }
		if (words[i] !== "git") continue;
		let target = dir;
		const overrides: IdentityWrite[] = [];
		for (i++; i < words.length && words[i].startsWith("-"); i++) {
			const option = words[i];
			if (option === "-C") { target = target && words[i + 1] && !/[$`]/.test(words[i + 1]) ? resolve(target, words[i + 1]) : null; i++; continue; }
			const config = option === "-c" ? words[++i] ?? "" : option.startsWith("--config-env=") ? option.slice("--config-env=".length) : null;
			if (config === null) continue;
			const key = config.split("=")[0];
			const field = IDENTITY_KEY.exec(key)?.[1]?.toLowerCase() as "name" | "email" | undefined;
			if (field) overrides.push({ field, value: option === "-c" ? config.slice(key.length + 1) : `$${config.slice(key.length + 1)}`, shown: option === "-c" ? `-c ${config}` : option, dir: target });
		}
		const verb = words[i];
		const args = words.slice(i + 1);
		if (verb === "init") { scratch ||= target === null || args.some((a) => /[$`]/.test(a)); continue; }
		if (COMMIT_WRITERS.has(verb)) writes.push(...overrides, ...[...exported, ...environment].map((write) => ({ ...write, dir: target })));
		if (verb === "commit") {
			for (let j = 0; j < args.length; j++) {
				if (args[j] === "--author" && args[j + 1] !== undefined) writes.push({ field: "author", value: args[j + 1], shown: `--author ${args[j + 1]}`, dir: target });
				else if (args[j].startsWith("--author=")) writes.push({ field: "author", value: args[j].slice(9), shown: args[j], dir: target });
			}
		}
		if (verb === "config") writes.push(...configWrites(args, target));
	}
	return { writes, scratch };
}

/** `git config [scope] user.name <value>` (and `set`/`--unset`); reads produce nothing. */
function configWrites(args: string[], dir: string | null): IdentityWrite[] {
	const rest = args[0] === "set" || args[0] === "unset" ? args.slice(1) : args;
	if (args[0] === "get" || rest.some((a) => /^(?:--get|--get-all|--get-regexp|-l|--list|--show-origin|--name-only)$/.test(a))) return [];
	const unset = args[0] === "unset" || rest.some((a) => a === "--unset" || a === "--unset-all");
	const positional: string[] = [];
	for (let j = 0; j < rest.length; j++) {
		if (["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"].includes(rest[j])) { j++; continue; }
		if (!rest[j].startsWith("-")) positional.push(rest[j]);
	}
	const field = IDENTITY_KEY.exec(positional[0] ?? "")?.[1]?.toLowerCase() as "name" | "email" | undefined;
	if (!field) return [];
	if (unset) return [{ field, value: "", shown: `git config --unset ${positional[0]}`, dir }];
	return positional.length >= 2 ? [{ field, value: positional[1], shown: `git config ${positional[0]} ${positional[1]}`, dir }] : [];
}

function matches(write: IdentityWrite, identity: GitIdentity): boolean {
	if (write.field === "author") {
		const parsed = /^(.*?)\s*<([^>]*)>$/.exec(write.value.trim());
		return !!parsed && parsed[1] === identity.name && parsed[2] === identity.email;
	}
	return write.value !== "" && write.value === identity[write.field];
}

/**
 * Block a command that writes a git identity other than the session's own.
 * `cwd` is where the command runs; `sessionRoot` the session's worktree
 * (defaults to the repository holding `cwd`).
 */
export function identityVerdict(command: string | undefined, cwd: string, probe: IdentityProbe = realIdentityProbe, sessionRoot?: string): IdentityVerdict {
	// Cheap textual prefilter: this runs on every shell command.
	if (!command || !/user\.(?:name|email)|author|committer|GIT_(?:AUTHOR|COMMITTER)_/i.test(command)) return ALLOW;
	const { writes, scratch } = identityWrites(command, cwd);
	if (writes.length === 0) return ALLOW;
	const root = sessionRoot ?? probe.toplevel(cwd) ?? cwd;
	for (const write of writes) {
		if (write.dir && !inside(root, write.dir)) continue; // a scratch repository elsewhere
		if (write.dir === null && scratch) continue; // the repository this command just created somewhere computed
		const identity = probe.configured(write.dir ?? cwd);
		if (matches(write, identity)) continue;
		const own = identity.name || identity.email ? `${identity.name ?? "(no user.name)"} <${identity.email ?? "no user.email"}>` : null;
		return {
			kind: "block",
			reason: [
				`BLOCKED: \`${write.shown}\` sets a git identity ${own ? `that differs from this session's configured identity (${own})` : "while this session has no git identity configured"}.`,
				"",
				"Never borrow or invent an identity: commits must carry the identity this session was launched with, or the work is",
				"attributed to someone who did not write it.",
				own
					? "Commit without the override; if the configured identity is wrong for this task, stop and report that instead."
					: "Stop and report that no git identity is configured (user.name/user.email), so the launcher can be fixed; do not set one yourself.",
				"(Identity writes in a scratch repository outside this worktree, such as a test fixture under /tmp, are not affected.)",
			].join("\n"),
		};
	}
	return ALLOW;
}
