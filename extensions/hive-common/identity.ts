/**
 * hive-common — config, credential and project resolution shared by every
 * extension that talks to Hive (hive-telemetry, hive-remote).
 *
 * Extracted from hive-telemetry so there is ONE credential store and ONE
 * `/hive-login`. Two copies would mean two places to review when asking "what
 * can leave this machine", and two logins for one server.
 *
 * THE STATE DIRECTORY NAME IS FROZEN at ~/.pi/agent/hive-telemetry. It is no
 * longer an accurate name, and that is deliberate: a real credential already
 * lives at that path on every machine that ran /hive-login, so renaming the
 * directory would silently log all of them out and the failure would present as
 * "telemetry mysteriously stopped" rather than as a migration.
 *
 * Everything here does blocking I/O (file reads, `git`), so NONE of it may be
 * called from an event handler: pi awaits handlers serially, so a 15ms git call
 * inside one is 15ms of stalled agent loop. Callers resolve on a timer or in a
 * command handler instead.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const GIT_TIMEOUT_MS = 800;

export interface ResolvedAuth {
	token: string;
	url: string;
	/** Where the token came from, for a status command to report. Never the token. */
	source: string;
}

export interface ProjectIdentity {
	/** Normalized "owner/repo". Never a filesystem path. */
	repo: string;
	/** Stable pseudonymous bucket for a non-repo directory: `local-<12 hex>`. */
	projectHint: string;
}

export interface StoredCredential {
	token: string;
	url: string;
	user?: string;
	tokenName?: string;
	scope?: string;
	validatedAt?: string;
}

/**
 * State lives in a real directory under ~/.pi/agent/, NOT in the stow package.
 * Only extensions/, agents/, prompts/, skills/, AGENTS.md, mcp.json and
 * settings.json are symlinks into a tracked repo — so a credential written here
 * is structurally incapable of being committed.
 */
export function stateDir(): string {
	return join(homedir(), ".pi", "agent", "hive-telemetry");
}

export function credentialsPath(): string {
	return join(stateDir(), "credentials.json");
}

/** Per-extension config file, so hive-remote's settings never collide with hive-telemetry's. */
export function configPathFor(name: string): string {
	return join(stateDir(), name === "hive-telemetry" ? "config.json" : `${name}.config.json`);
}

export function spoolDirFor(name: string): string {
	return join(stateDir(), name === "hive-telemetry" ? "spool" : `${name}-spool`);
}

export function readJSON<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Atomic 0600 write into a 0700 directory: a partial write must never be read. */
export function atomicWrite(path: string, contents: string): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, contents, { mode: 0o600 });
	renameSync(tmp, path);
}

export function numberOr(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * resolveAuth finds a token and an endpoint.
 *
 * IMPORTANT: a token found in the environment is a CREDENTIAL SOURCE, never a
 * CONSENT SIGNAL. $HIVE_TOKEN already exists on this machine for the `hive`
 * CLI, and its mere presence must not switch anything on — each extension's
 * `enabled` flag does that, and only /hive-login sets it.
 *
 * There is deliberately no hardcoded default URL: a tailnet hostname baked into
 * a file that gets pushed to GitHub is exactly the leak this design avoids.
 */
export function resolveAuth(fallbackUrl = ""): ResolvedAuth | null {
	const stored = readJSON<StoredCredential>(credentialsPath());

	// Candidate ORDER is the contract here, and it depends on how this process
	// was started.
	//
	// Interactively, the stored credential outranks $HIVE_TOKEN: /hive-login is
	// the explicit act of validation, while $HIVE_TOKEN merely exists on this
	// machine for the `hive` CLI.
	//
	// In a LAUNCHED session the ranking inverts. hive-agent injects
	// HIVE_LAUNCH_ID and mints $HIVE_TOKEN for exactly this run, while
	// credentials.json is whatever /hive-login stored — possibly long ago,
	// possibly revoked since. A dead stored token would shadow the fresh launch
	// token and every call 401s: the session never attaches (the workspace shows
	// "session attaching…" indefinitely) and telemetry halts on its auth-failure
	// latch. The launcher's token is definitionally the right identity for the
	// run it provisioned, so it wins there. $HIVE_TELEMETRY_TOKEN stays the
	// explicit override in both modes, and this changes credential SELECTION
	// only — consent remains each extension's `enabled` flag.
	const launched = envNonEmpty("HIVE_LAUNCH_ID") !== null;
	const storedToken = () => stored?.token?.trim() || null;
	const envToken = () => envNonEmpty("HIVE_TOKEN");
	const candidates: Array<[source: string, get: () => string | null]> = launched
		? [
				["$HIVE_TELEMETRY_TOKEN", () => envNonEmpty("HIVE_TELEMETRY_TOKEN")],
				["$HIVE_TOKEN", envToken],
				["credentials.json", storedToken],
				["~/.config/hive/env", tokenFromHiveEnvFile],
			]
		: [
				["$HIVE_TELEMETRY_TOKEN", () => envNonEmpty("HIVE_TELEMETRY_TOKEN")],
				["credentials.json", storedToken],
				["$HIVE_TOKEN", envToken],
				["~/.config/hive/env", tokenFromHiveEnvFile],
			];

	let token: string | null = null;
	let source = "";
	for (const [name, get] of candidates) {
		token = get();
		if (token) {
			source = name;
			break;
		}
	}
	if (!token) return null;

	const url =
		envNonEmpty("HIVE_TELEMETRY_URL") ?? (stored?.url?.trim() || null) ?? envNonEmpty("HIVE_URL") ?? (fallbackUrl.trim() || null);
	if (!url) return null;

	return { token, url: url.replace(/\/+$/, ""), source };
}

function envNonEmpty(name: string): string | null {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : null;
}

/**
 * hiveBaseURL resolves the Hive endpoint WITHOUT requiring a token — for
 * probes (readyz) that only ask "is a Hive configured and reachable". Same
 * precedence as resolveAuth's URL half: telemetry override, stored credential,
 * $HIVE_URL. Returns null when this machine has no Hive configured, which
 * callers must treat as "unreachable" (their offline fallback), never as an
 * error — a public checkout of this repo has no Hive and that is fine
 * (HIV-1853: no endpoint may be baked into a file that gets pushed).
 */
export function hiveBaseURL(): string | null {
	const stored = readJSON<StoredCredential>(credentialsPath());
	const url = envNonEmpty("HIVE_TELEMETRY_URL") ?? (stored?.url?.trim() || null) ?? envNonEmpty("HIVE_URL");
	return url ? url.replace(/\/+$/, "") : null;
}

/**
 * A pi launched from a desktop launcher or a systemd unit has no shell env, so
 * the file the shell would have sourced is read directly as a last resort.
 */
function tokenFromHiveEnvFile(): string | null {
	try {
		const path = join(homedir(), ".config", "hive", "env");
		if (!existsSync(path)) return null;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const match = /^\s*(?:export\s+)?HIVE_TOKEN\s*=\s*(.+)\s*$/.exec(line);
			if (match) return match[1].replace(/^["']|["']$/g, "").trim() || null;
		}
	} catch {
		/* unreadable is the same as absent */
	}
	return null;
}

export function saveCredentials(cred: StoredCredential): void {
	atomicWrite(credentialsPath(), JSON.stringify(cred, null, 2));
}

export function clearCredentials(): void {
	try {
		if (existsSync(credentialsPath())) writeFileSync(credentialsPath(), "{}", { mode: 0o600 });
	} catch {
		/* best effort */
	}
}

export function readStoredCredential(): StoredCredential | null {
	return readJSON<StoredCredential>(credentialsPath());
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			timeout: GIT_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * resolveProject maps the working directory to a repo identity.
 *
 * `git remote get-url origin` is used rather than any path inspection, and it
 * was verified to behave identically from a linked worktree, from a bare repo
 * directory (~/repos/Aurora.git) and from an ordinary clone — so our bare-repo +
 * gwq layout needs no special handling.
 *
 * A directory that is not a repo becomes `local-<12 hex of the realpath>`: a
 * stable bucket that groups the same directory over time WITHOUT revealing it.
 * The obvious alternative — basename(cwd) — leaks directory names, which is the
 * whole thing we are avoiding.
 *
 * Blocking. Never call from an event handler.
 */
export function resolveProject(cwd: string): ProjectIdentity {
	const remote =
		git(cwd, ["remote", "get-url", "origin"]) ??
		git(cwd, ["remote", "get-url", "upstream"]) ??
		worktreeRootRemote(cwd);
	const repo = remote ? normalizeRemote(remote) : "";
	return { repo, projectHint: repo || localBucket(cwd) };
}

/**
 * worktreeRootRemote resolves a bare-repo + worktrees layout's PARENT directory.
 *
 * `~/repos/hive__worktrees` is where the worktrees live; it is not itself a
 * repo, so `git remote` fails there and the session was bucketed as an opaque
 * `local-<hash>`. But sessions are started from that directory constantly — it
 * is the natural place to stand while deciding which worktree to work in — so a
 * meaningful share of a developer's agent activity was landing in a bucket that
 * says nothing.
 *
 * The layout makes the answer deterministic: `<name>__worktrees` sits beside
 * `<name>.git`, the bare repo, whose remote is the identity we want. Read
 * through git rather than parsed off the directory name, so a coincidentally
 * named directory with no sibling repo still falls through to the local bucket.
 *
 * Walks UP, so a scratch subdirectory under the worktrees root resolves too.
 */
function worktreeRootRemote(cwd: string): string | null {
	let dir = cwd;
	for (let depth = 0; depth < 8; depth++) {
		const name = basename(dir);
		if (name.endsWith(WORKTREES_SUFFIX) && name.length > WORKTREES_SUFFIX.length) {
			const bare = join(dirname(dir), `${name.slice(0, -WORKTREES_SUFFIX.length)}.git`);
			return git(bare, ["remote", "get-url", "origin"]);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** The `gwq` convention this machine (and the KB) standardised on. */
const WORKTREES_SUFFIX = "__worktrees";

/** Current branch, or "" outside a repo / on a detached HEAD. Blocking. */
export function resolveBranch(cwd: string): string {
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch && branch !== "HEAD" ? branch.slice(0, 255) : "";
}

/**
 * normalizeRemote reduces any remote form to "owner/repo", dropping the scheme,
 * host, any embedded credentials and the .git suffix. Credentials in a remote
 * URL are the reason this strips rather than merely trims.
 */
export function normalizeRemote(remote: string): string {
	let s = remote.trim();
	if (!s) return "";
	// scp-style: git@github.com:Owner/Repo.git
	const scp = /^[^@/]+@([^:]+):(.+)$/.exec(s);
	if (scp) {
		s = scp[2];
	} else {
		const idx = s.indexOf("://");
		if (idx >= 0) {
			const rest = s.slice(idx + 3);
			const slash = rest.indexOf("/");
			// Drop scheme://[user:pass@]host/
			s = slash >= 0 ? rest.slice(slash + 1) : "";
		}
	}
	s = s.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
	// Keep only the last two segments: owner/repo.
	const parts = s.split("/").filter(Boolean);
	if (parts.length >= 2) s = parts.slice(-2).join("/");
	else s = parts.join("/");
	return s.slice(0, 200);
}

function localBucket(cwd: string): string {
	try {
		const real = realpathSync(cwd);
		return `local-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
	} catch {
		return "local-unknown";
	}
}

/** Where a session physically is, so an operator can join it at the machine. */
export interface TerminalLocation {
	/** Session name, e.g. "hive-agents-hive" or the bare "4". */
	name: string;
	kind: "tmux";
}

/**
 * resolveTerminal reports the multiplexer session this process is running in.
 *
 * TWO SOURCES, and the second is the one that earns this function.
 *
 * A launched agent is TOLD where it is — hive-agent injects HIVE_TMUX_SESSION
 * for the session it just created, which is exact and costs nothing. But most
 * sessions are not launched: they are the ones a developer opened by hand, and
 * tmux names those `0`, `4`, `7`… — precisely the names that are impossible to
 * tell apart in a sidebar and therefore most worth reporting.
 *
 * For those, $TMUX proves we are inside tmux (it is set by the server on every
 * pane) and one `display-message` resolves the name. BLOCKING, by way of a
 * subprocess — so this belongs on the attach path, which already runs git and
 * reads files on a timer, and never in an event handler, where pi awaits
 * serially and this would be the agent loop.
 */
export function resolveTerminal(): TerminalLocation | null {
	const told = process.env.HIVE_TMUX_SESSION?.trim();
	if (told) return { name: told.slice(0, 200), kind: "tmux" };

	// Not in tmux at all — the overwhelmingly common case for a session started
	// from a plain shell, and worth answering without spawning anything.
	if (!process.env.TMUX) return null;

	const name = tmux(["display-message", "-p", "#S"]);
	return name ? { name: name.slice(0, 200), kind: "tmux" } : null;
}

function tmux(args: string[]): string | null {
	try {
		return execFileSync("tmux", args, {
			timeout: GIT_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// No tmux binary, a dead socket, a server that went away mid-call. A
		// session whose location we cannot name is still a session.
		return null;
	}
}
