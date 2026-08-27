/**
 * Collecting abandoned Postgres clusters (HIV-1980).
 *
 * ## What went wrong
 *
 * `session_shutdown` removes this session's data directory, and that covers a
 * clean exit and nothing else. A session that is SIGKILLed, whose pane is
 * destroyed, or that crashes leaves the directory — and sometimes the server —
 * behind forever. Nothing collected them afterwards.
 *
 * On 2026-08-17 the workstation ran out of **inodes**: 61 free of 1,048,576, with
 * 25G of bytes still available. `/tmp` is tmpfs, so inodes are a fixed global
 * allocation rather than disk space, and one abandoned cluster from 2026-08-10
 * held 244,138 files — 23% of the machine's entire budget. Every process on the
 * host that wrote to /tmp began failing with ENOSPC, including five live agents.
 * One leaked dev database denied the whole machine.
 *
 * ## Why the obvious liveness check is WRONG
 *
 * The directory is named after the creating pid, so "is that pid alive?" looks
 * like the answer. It is not, and the reason is the same one that produced
 * HIV-1966: **a sandboxed session has its own PID namespace**. Measured on this
 * node, a live cluster's `postmaster.pid` records pid **10054** while the real
 * host pid is **2857879**. So on the host:
 *
 * - `/proc/10054` describes a STRANGER, not that postgres; and
 * - `pg_ctl stop` would signal 10054 — an unrelated host process.
 *
 * Nothing in `postmaster.pid` is usable from outside the namespace that wrote
 * it. This file therefore never reads it. It scans `/proc/&#42;/cmdline` for a
 * postmaster started with `-D <that exact directory>`, which yields the pid in
 * OUR namespace — the only one we may signal.
 *
 * ## Why the server must be stopped BEFORE the directory is removed
 *
 * Unlinking files a live postgres holds open frees no inodes: the open fds pin
 * them until the process exits. A sweep that removed the directory without
 * stopping the server would report success and reclaim nothing — failing at its
 * one job, silently. So a confirmed-stopped (or confirmed-absent) server gates
 * every removal.
 *
 * ## Why only UNSANDBOXED sessions sweep
 *
 * Inside a sandbox, `/proc` is namespace-local: a sandboxed sweeper cannot see a
 * host postmaster, so it can never make the check above safely and would delete
 * live clusters it is blind to. It also cannot signal one. Host sessions are
 * frequent enough to do all the collecting, a sandboxed session's own orphans
 * die with its namespace, and the leak that hurt is on the host filesystem.
 *
 * ## Two ways a directory can be judged abandoned
 *
 * The owning session writes a `heartbeat` file and refreshes it. Stale heartbeat
 * = abandoned. But a **missing** heartbeat must not mean abandoned: a peer part
 * way through `initdb` has a directory and no heartbeat yet, and on the first
 * deploy of this code EVERY live session lacks one (a running pi keeps the
 * extension it loaded). Those fall back to the directory's own mtime, which is
 * old for real litter and fresh for anything in use — and is what correctly
 * collects the pre-HIV-1966 directories that started all this.
 */

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Name of the liveness file inside a cluster's parent directory. */
export const HEARTBEAT_FILE = "heartbeat";

/** How often the owner refreshes it. Comfortably inside STALE_AFTER_MS. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Silence for this long means abandoned.
 *
 * Six missed heartbeats. Generous on purpose: the cost of waiting is disk we
 * were going to reclaim anyway, and the cost of being wrong is deleting a
 * working session's database.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** A pass never considers more than this. A sweep must not become the workload. */
export const MAX_SWEEP_DIRS = 64;

/** How long a stopped postmaster gets to actually exit before we give up on it. */
export const STOP_GRACE_MS = 3_000;

export const DIR_PREFIX = "pi-devservices-";

/**
 * How far below a tmp root we look for clusters.
 *
 * ONE level, and the reason is the whole point of this constant. A cluster is
 * created under the CREATING session's `TMPDIR`, and a sandboxed session runs
 * with `TMPDIR=/tmp/claude` — so every directory that has ever leaked here lives
 * at `/tmp/claude/pi-devservices-*`, one level below the host's `os.tmpdir()`.
 *
 * The first version of this sweep looked only in `os.tmpdir()`. It deployed,
 * ran, found nothing, and reported success while 244k files sat one directory
 * away: the sweeper searched `/tmp` and the litter was in `/tmp/claude`. No unit
 * test could catch it — they all inject `tmp` — and only running the real thing
 * on the real machine did.
 *
 * Descending is safe because nothing is judged by location: a candidate must
 * still be named `pi-devservices-*`, be stale, and have no live server.
 */
export const MAX_ROOT_DEPTH = 1;

/**
 * How many immediate subdirectories of a tmp root we will look inside.
 *
 * /tmp on a busy workstation holds hundreds of unrelated directories, and a
 * sweep must never become the workload. One `readdir` each, capped.
 */
export const MAX_NESTED_ROOTS = 64;

export interface ReapDeps {
	now(): number;
	/** Entry names directly under tmp. */
	listDir(dir: string): string[];
	/** True when the path is a directory — used to find nested tmp roots. */
	isDir(target: string): boolean;
	/** Directory mtime in ms, or null when it cannot be read. */
	mtimeMs(target: string): number | null;
	readText(file: string): string | null;
	/** Real pid, in OUR namespace, of a postmaster running with `-D dataDir`. */
	findPostmaster(dataDir: string): number | null;
	kill(pid: number, signal: NodeJS.Signals): void;
	removeTree(target: string): void;
	wait(ms: number): Promise<void>;
	/** True inside an srt sandbox — see the header on why we then do nothing. */
	sandboxed(): boolean;
}

export type Verdict =
	| "own"
	| "fresh"
	| "unknown-owner"
	| "server-would-not-stop"
	| "reaped";

export interface ReapOutcome {
	skipped?: "sandboxed";
	verdicts: Record<string, Verdict>;
	reaped: string[];
}

/**
 * Is this directory abandoned? Pure, so every branch is testable without a
 * filesystem — including the two that matter most, "no heartbeat but recent"
 * and "no heartbeat and ancient".
 */
export function isAbandoned(deps: Pick<ReapDeps, "now" | "readText" | "mtimeMs">, dir: string): boolean {
	const raw = deps.readText(path.join(dir, HEARTBEAT_FILE));
	const beat = raw === null ? Number.NaN : Number(raw.trim());
	if (Number.isFinite(beat)) return deps.now() - beat > STALE_AFTER_MS;
	// No heartbeat, or an unreadable one: fall back to the directory's own age
	// rather than assuming the worst. See the header — a peer mid-initdb and
	// every session predating this code look identical to litter otherwise.
	const mtime = deps.mtimeMs(dir);
	if (mtime === null) return false;
	return deps.now() - mtime > STALE_AFTER_MS;
}

/**
 * Has this cluster's owner ever reported? Distinguishes "the owner stopped
 * talking" from "the owner was never able to talk", which are the same silence
 * and very different facts.
 */
export function hasHeartbeat(deps: Pick<ReapDeps, "readText">, dir: string): boolean {
	const raw = deps.readText(path.join(dir, HEARTBEAT_FILE));
	return raw !== null && Number.isFinite(Number(raw.trim()));
}

/** Data directory inside a cluster directory — mirrors `dataDirFor`. */
export function dataDirIn(dir: string): string {
	return path.join(dir, "pg");
}

/**
 * Every cluster directory reachable from a tmp root, including the ones a
 * SANDBOXED session left one level down under its own TMPDIR. See
 * MAX_ROOT_DEPTH for why that level exists and what it cost to learn.
 *
 * Listing failures are swallowed per-root: /tmp holds other users' and other
 * tools' directories, and an unreadable one is normal, not a fault.
 */
export function candidateDirs(deps: Pick<ReapDeps, "listDir" | "isDir">, tmp: string): string[] {
	const found: string[] = [];
	const roots = [tmp];
	let names: string[] = [];
	try {
		names = deps.listDir(tmp);
	} catch {
		return found;
	}
	for (const name of names) {
		if (name.startsWith(DIR_PREFIX)) {
			found.push(path.join(tmp, name));
			continue;
		}
		const nested = path.join(tmp, name);
		if (roots.length - 1 < MAX_NESTED_ROOTS && deps.isDir(nested)) roots.push(nested);
	}
	for (const root of roots.slice(1)) {
		try {
			for (const name of deps.listDir(root)) {
				if (name.startsWith(DIR_PREFIX)) found.push(path.join(root, name));
			}
		} catch {
			// Not ours to read — /tmp is shared.
		}
	}
	return found;
}

/**
 * One sweep. Never throws: this runs on a detached timer at session start, and
 * an unhandled rejection there is an extension error nobody is watching.
 *
 * `ownDir` is this session's own cluster directory, which is never a candidate
 * however it looks — a session must not collect itself.
 */
export async function reapOnce(deps: ReapDeps, tmp: string, ownDir: string | null): Promise<ReapOutcome> {
	const out: ReapOutcome = { verdicts: {}, reaped: [] };
	if (deps.sandboxed()) return { ...out, skipped: "sandboxed" };

	const candidates = candidateDirs(deps, tmp);

	for (const dir of candidates.slice(0, MAX_SWEEP_DIRS)) {
		const name = path.basename(dir);
		try {
			if (ownDir && path.resolve(dir) === path.resolve(ownDir)) {
				out.verdicts[name] = "own";
				continue;
			}
			if (!isAbandoned(deps, dir)) {
				out.verdicts[name] = "fresh";
				continue;
			}
			// A RUNNING server with no heartbeat at all is not evidence of
			// abandonment — it is an absence of evidence, and the two look
			// identical from here. Killing it would end a working session's
			// database.
			//
			// This is not hypothetical: it is the state of every live cluster the
			// first time this code deploys, because a running pi keeps the
			// extension it loaded and never starts a heartbeat. Measured at that
			// exact moment — two live postmasters, both heartbeat-less, both
			// already past the staleness threshold on directory mtime alone.
			//
			// Once a session has written even one heartbeat the ambiguity is gone:
			// a STALE heartbeat plus a live server really is an orphan, and is
			// reaped below. So this costs nothing after the transition.
			if (!hasHeartbeat(deps, dir) && deps.findPostmaster(dataDirIn(dir)) !== null) {
				out.verdicts[name] = "unknown-owner";
				continue;
			}
			if (!(await stopPostmaster(deps, dataDirIn(dir)))) {
				// Removing files a live postgres holds open frees NO inodes — the
				// fds pin them — so a failed stop must abort the removal rather
				// than produce a reclaim that reclaimed nothing.
				out.verdicts[name] = "server-would-not-stop";
				continue;
			}
			deps.removeTree(dir);
			out.verdicts[name] = "reaped";
			out.reaped.push(name);
		} catch {
			// One bad directory must not end the pass.
		}
	}
	return out;
}

/**
 * Stop the postmaster for a data directory, if one is visible to us. True means
 * "no server is holding this directory any more" — including the common case
 * where there never was one.
 *
 * SIGQUIT is postgres's *immediate* shutdown: no checkpoint, recover on next
 * start. Correct here — this cluster is disposable by construction and is about
 * to be deleted.
 */
export async function stopPostmaster(deps: ReapDeps, dataDir: string): Promise<boolean> {
	const pid = deps.findPostmaster(dataDir);
	if (pid === null) return true;
	try {
		deps.kill(pid, "SIGQUIT");
	} catch {
		return false;
	}
	await deps.wait(STOP_GRACE_MS);
	// Re-scan rather than trusting the signal: the only evidence that counts is
	// that nothing holds the directory now.
	return deps.findPostmaster(dataDir) === null;
}

// ---------------------------------------------------------------------------
// The real dependency set
// ---------------------------------------------------------------------------

/**
 * Find a postmaster by the directory it was started with.
 *
 * `/proc/<pid>/cmdline` is NUL-separated argv, so this matches the `-D` argument
 * exactly rather than by substring — `/tmp/x/pg` must not match `/tmp/x/pg2`.
 * The argv[0] check keeps a `psql`, an editor, or this very sweep's own shell
 * from being mistaken for a server and signalled.
 */
export function findPostmasterOnHost(dataDir: string): number | null {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let argv: string[];
		try {
			argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
		} catch {
			continue; // the process exited between readdir and read; not ours to mind
		}
		if (!/(^|\/)postgres$/.test(argv[0] ?? "")) continue;
		const flag = argv.indexOf("-D");
		if (flag === -1 || argv[flag + 1] !== dataDir) continue;
		return Number(entry);
	}
	return null;
}

/** Record that this session still owns its cluster directory. */
export function writeHeartbeat(dir: string, now: number = Date.now()): void {
	try {
		writeFileSync(path.join(dir, HEARTBEAT_FILE), String(now));
	} catch {
		// A missing heartbeat only makes us fall back to mtime, which is correct
		// for a live directory anyway. Never worth failing a startup over.
	}
}

export function realReapDeps(): ReapDeps {
	return {
		now: () => Date.now(),
		listDir: (dir) => readdirSync(dir),
		isDir: (target) => {
			try {
				return statSync(target).isDirectory();
			} catch {
				return false;
			}
		},
		mtimeMs: (target) => {
			try {
				return statSync(target).mtimeMs;
			} catch {
				return null;
			}
		},
		readText: (file) => {
			try {
				return readFileSync(file, "utf8");
			} catch {
				return null;
			}
		},
		findPostmaster: findPostmasterOnHost,
		kill: (pid, signal) => process.kill(pid, signal),
		removeTree: (target) => rmSync(target, { recursive: true, force: true }),
		wait: (ms) =>
			new Promise((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref?.();
			}),
		// srt sets this in the sandbox environment; see the header on why a
		// sandboxed sweeper must not act.
		sandboxed: () => Boolean(process.env.SANDBOX_RUNTIME),
	};
}
