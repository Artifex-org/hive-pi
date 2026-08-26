/**
 * The one-writer-per-worktree rule, in one place.
 *
 * Three things have to agree for this rule to hold, and until HIV-1132 only
 * the first was shared:
 *
 *   1. **the mechanism** — an `O_EXCL` file, not a module-level `Set`;
 *   2. **the scope** — which path two callers must agree names "this worktree";
 *   3. **the predicate** — which roles are writers at all.
 *
 * Disagree on ANY of the three and both halves believe they are the only
 * writer, which is the corruption the rule exists to prevent. That is not
 * hypothetical: `subagent/index.ts` guarded with a module `Set` while
 * `agenda/{worker,rpc-worker}.ts` used the file lock, and independently of
 * that, agenda locked the raw `cwd` while subagent locked the enclosing git
 * root — so even a shared lock file would have hashed two different keys
 * whenever a session ran from a subdirectory.
 *
 * ## Why the mechanism is a file
 *
 * A module-level `Set` has two holes. It is per-PROCESS, so it cannot see a
 * writer another pi process (or a resumed run) already has in the same
 * worktree. And it is per-EXTENSION: pi builds a fresh jiti per extension entry
 * with `moduleCache:false`, so two extensions importing one module get SEPARATE
 * instances — measured, not assumed. A `Set` shared by import silently forks.
 *
 * `O_EXCL` gives atomic acquire against every process on the machine, and the
 * payload records who holds it so a stale lock is diagnosable rather than
 * merely in the way.
 *
 * This file follows `spawn.ts`'s rule: NOTHING mutable at module scope. All
 * state is on disk, which is precisely the point.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** A lock older than this is assumed to belong to a process that died. */
export const STALE_LOCK_MS = 15 * 60_000;

/**
 * Tools that let a role change something.
 *
 * `pi-delegate`'s Go copy also lists `apply_patch`. That is an OpenAI Responses
 * built-in, not a pi tool name, so it can never match a role's `tools` — but it
 * is the kind of drift a second copy of this list invites, which is why there
 * is now one.
 */
const WRITER_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Can this role mutate the checkout?
 *
 * An ABSENT tool list means the role inherits pi's full default set, writers
 * included — so "unspecified" is treated as writer-capable rather than as
 * harmless. Getting this backwards would let the most capable roles run
 * unlocked, which is the opposite of what a conservative default should do.
 */
export function isWriterCapable(tools: string[] | undefined): boolean {
	if (!tools || tools.length === 0) return true;
	return tools.some((tool) => WRITER_TOOLS.has(tool.trim().toLowerCase()));
}

/**
 * The path two callers must agree on to be talking about the same worktree.
 *
 * Walks up to the enclosing `.git` and resolves symlinks. Both steps matter:
 * without the walk, a session in `repo/web` and one in `repo` take different
 * locks on one checkout; without the realpath, a symlinked worktree path takes
 * a different lock from its target.
 *
 * `.git` is tested with `existsSync` rather than `isDirectory` on purpose — in
 * a `gwq`/`git worktree` checkout it is a FILE pointing into the bare repo, and
 * a directory-only test would walk straight past every worktree we use.
 *
 * Falls back to the resolved input when there is no `.git` above it, so a
 * scratch directory still gets a stable, self-consistent key.
 */
export function writerScopeFor(cwd: string): string {
	let current = resolve(cwd);
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			try {
				return realpathSync(current);
			} catch {
				return current;
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	try {
		return realpathSync(resolve(cwd));
	} catch {
		return resolve(cwd);
	}
}

/**
 * Env var carrying the holder's token to its children.
 *
 * A writer that spawns a writer in the SAME worktree is not two writers: the
 * parent is blocked awaiting the child, so exactly one is running. Refusing it
 * would be a false positive that breaks a real pattern — an agenda worker
 * delegating through the subagent tool, which is reachable because workers are
 * not spawned with `--no-extensions`.
 *
 * Before the two halves shared a lock this never surfaced: the child process
 * started with an empty `Set` and admitted itself. Sharing the lock is what
 * makes re-entrancy something that has to be decided rather than stumbled into.
 *
 * The token is per-ACQUISITION, so it authorises re-entry into one specific
 * worktree's lock. A descendant that tries to lock a different worktree carries
 * a token that matches nothing there and takes the ordinary path.
 */
export const WRITER_TOKEN_ENV = "PI_HOUSE_WRITER_LOCK";

export interface LockPayload {
	pid: number;
	runId: string;
	nodeId: string;
	at: number;
	/** Authorises a descendant process to re-enter this lock. */
	token?: string;
}

export function lockDir(): string {
	return join(homedir(), ".pi", "agent", "agenda", "locks");
}

/** One lock per resolved worktree path; the hash keeps it filesystem-safe. */
export function lockPathFor(worktree: string): string {
	const key = createHash("sha1").update(worktree).digest("hex").slice(0, 16);
	return join(lockDir(), `${key}.lock`);
}

function readPayload(path: string): LockPayload | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as LockPayload;
		return typeof parsed?.at === "number" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Is this lock old enough to ignore?
 *
 * Time-based rather than liveness-based on purpose: `process.kill(pid, 0)` says
 * nothing useful once a pid has been recycled, and a cross-machine checkout
 * makes the pid meaningless anyway. A generous timeout that occasionally waits
 * too long beats a liveness probe that occasionally lets two writers run.
 */
export function isStale(payload: LockPayload | null, now: number): boolean {
	if (!payload) return true; // unparseable — treat as debris
	return now - payload.at >= STALE_LOCK_MS;
}

export interface AcquireResult {
	acquired: boolean;
	/** Set when the lock is held by someone else. */
	heldBy?: LockPayload;
	/**
	 * Env fragment every child of this holder must inherit. Spread it into the
	 * spawn env — returning it here rather than exposing a `tokenFor()` helper
	 * means a call site cannot quietly forget it and reintroduce the deadlock.
	 */
	childEnv: Record<string, string>;
	release(): void;
}

const NO_RELEASE = () => {};

/**
 * The result a read-only role gets: admitted, holding nothing, releasing
 * nothing.
 *
 * A function rather than a shared constant, per this file's no-mutable-module-
 * scope rule — a const object would be one aliased instance handed to every
 * caller across two extensions.
 */
export function noWriterLock(): AcquireResult {
	return { acquired: true, childEnv: {}, release: NO_RELEASE };
}

/**
 * Take the writer lock for a worktree, or report who holds it.
 *
 * `worktree` is resolved through `writerScopeFor` here rather than at each call
 * site. Leaving that to callers is exactly how the two halves came to lock
 * different keys for one checkout, and a lock whose key depends on the caller's
 * cwd is not a lock.
 *
 * Never throws: a lock we cannot take is a scheduling fact the caller has to
 * handle, not an error that should abort a whole run.
 */
export function acquireWriterLock(
	worktree: string,
	payload: Omit<LockPayload, "at" | "token">,
	now: number = Date.now(),
	env: NodeJS.ProcessEnv = process.env,
): AcquireResult {
	const path = lockPathFor(writerScopeFor(worktree));
	const inherited = env[WRITER_TOKEN_ENV];

	try {
		mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
	} catch {
		// Cannot create the lock directory. Fail OPEN rather than deadlocking the
		// orchestrator on an unwritable home — the in-batch guard in the caller
		// still prevents the common case.
		return { acquired: true, childEnv: {}, release: NO_RELEASE };
	}

	if (existsSync(path)) {
		const existing = readPayload(path);
		if (!isStale(existing, now)) {
			// A descendant of the holder re-entering its own lock. The release is a
			// no-op: the OUTERMOST holder owns the lock's lifetime, and letting an
			// inner frame release it would free the worktree while the outer writer
			// is still running — a worse bug than the deadlock this avoids.
			if (inherited && existing?.token && inherited === existing.token) {
				return {
					acquired: true,
					childEnv: { [WRITER_TOKEN_ENV]: existing.token },
					release: NO_RELEASE,
				};
			}
			return { acquired: false, heldBy: existing ?? undefined, childEnv: {}, release: NO_RELEASE };
		}
		try {
			rmSync(path, { force: true });
		} catch {
			return { acquired: false, heldBy: existing ?? undefined, childEnv: {}, release: NO_RELEASE };
		}
	}

	const token = randomUUID();
	try {
		// O_EXCL is the whole guarantee: atomic create-or-fail against every
		// process on the machine, not just this one.
		const fd = openSync(path, "wx", 0o600);
		writeSync(fd, JSON.stringify({ ...payload, at: now, token }));
		closeSync(fd);
	} catch {
		// Lost the race between the existence check and the create.
		return { acquired: false, heldBy: readPayload(path) ?? undefined, childEnv: {}, release: NO_RELEASE };
	}

	return {
		acquired: true,
		childEnv: { [WRITER_TOKEN_ENV]: token },
		release: () => {
			try {
				rmSync(path, { force: true });
			} catch {
				/* released by a reaper, or the home went away — either is fine */
			}
		},
	};
}
