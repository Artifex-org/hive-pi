/**
 * Per-session PostgreSQL plumbing (HIV-1636).
 *
 * Constraints measured 2026-08-09 inside a launch-shaped srt sandbox:
 *
 * - srt's seccomp blocks socket(AF_UNIX), so the server MUST run TCP-only:
 *   `unix_socket_directories=''` — with a socket dir configured, startup
 *   fails on the socket bind. `listen_addresses=127.0.0.1` works: a
 *   sandboxed session has a private network namespace, so in-sandbox
 *   loopback is free and ports cannot collide ACROSS sandboxed sessions.
 *   A random port is used anyway so hand-started (unsandboxed) sessions,
 *   which share the host loopback, do not collide either.
 * - The host has no Postgres server install; binaries are the portable
 *   theseus-rs build at ~/.hive/tools/postgres (glibc variant — the musl
 *   one needs a musl loader the host lacks — plus a libxml2.so.2 → .so.16
 *   compat symlink inside its lib/, created by the installer script).
 *   LD_LIBRARY_PATH must point at that lib/ for every binary invocation.
 * - Durability is deliberately off (fsync=off etc.): this is a disposable
 *   dev database whose lifetime is the session.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface PgPaths {
	root: string;
	bin: string;
	lib: string;
}

/**
 * A token that makes this process's data directory unique (HIV-1966).
 *
 * THE BUG IT FIXES. The directory used to be keyed on `process.pid` alone,
 * with the header reasoning "per-process dir because /tmp is shared between
 * sandboxes". Both halves of that are true and together they are the bug: a
 * sandboxed session has its own **PID namespace**, so pi is a low, repeated pid
 * in every one of them — three sessions reported the collision on 2026-08-16,
 * one of them at `/tmp/claude/pi-devservices-2/pg`. Two live sessions then
 * share a data directory and the second dies on `FATAL: pre-existing shared
 * memory block ... is still in use`, with no recovery path offered.
 *
 * A random token is minted once per process, so uniqueness no longer depends on
 * a number the sandbox is free to reuse.
 */
export function newInstanceToken(): string {
	return randomUUID().slice(0, 8);
}

/**
 * Where this process's cluster lives. Pure, so the collision case is testable
 * without a sandbox: same pid + different token must not collide.
 *
 * `base` is resolved once per process by `resolveBaseDir` — disk when we can
 * have it, `os.tmpdir()` when we cannot. It stays a plain parameter so this
 * function does no I/O and the collision tests need no filesystem.
 */
export function dataDirFor(token: string, base: string = os.tmpdir(), pid: number = process.pid): string {
	return path.join(base, `pi-devservices-${pid}-${token}`, "pg");
}

/** Escape hatch: an operator-chosen base dir wins over everything below. */
export const BASE_DIR_ENV = "PI_DEVSERVICES_DIR";

/**
 * Candidate base directories, best first.
 *
 * DISK BEFORE TMPFS, and this ordering is the fix for a failure that took the
 * workstation's tooling down four times (HIV-2407).
 *
 * `/tmp` here is tmpfs, and its inode budget — 1,048,576 on this box — is a
 * FIXED, GLOBAL allocation shared by every process on the machine. A DB-backed
 * suite that resets between tests churns relation files fast enough to eat it:
 * one abandoned data dir was measured holding 805,122 inodes, 99.3% of them
 * ZERO BYTES. At exhaustion every process writing /tmp fails with ENOSPC, which
 * on this workstation kills the coding agent's own tooling — each Bash call
 * writes its output under /tmp, so it fails before running anything, including
 * `df` and `rm`. The damage lands on whoever else is on the box, not on the
 * suite that caused it.
 *
 * `~/.pi` is the right home for it, for a reason that is easy to get wrong:
 *
 * - It is on disk (btrfs here), so there is no fixed inode budget to exhaust
 *   and no RAM cost — two live clusters were holding 2.1 GB of it.
 * - It is writable in EVERY srt profile. That is not luck and not a local
 *   quirk: hive puts `~/.pi` and `~/.pi-lens` in the sandbox's writable set as
 *   `AgentStatePaths`, and asserts it in `cmd/hive-agent/workstation_sandbox_test.go`.
 *   Verified independently against 10/10 generated `.hive-sandbox.json` files.
 *
 * The standing advice in the KB was `~/.cache`, and that advice is WRONG: srt
 * is allow-only for writes and binds /home read-only, so `~/.cache/...` returns
 * EROFS in exactly the sandboxed sessions this extension exists to serve. The
 * conclusion drawn from it — "moving off tmpfs needs a paired hive-side
 * allowlist change" — was drawn from that one rejected path. `~/.pi` is already
 * on the list, so no hive change is needed.
 *
 * `os.tmpdir()` stays last so a node whose policy differs still works.
 */
export function baseDirCandidates(
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
	tmp: string = os.tmpdir(),
): string[] {
	const override = env[BASE_DIR_ENV];
	const preferred = override && override.trim() ? override : path.join(home, ".pi", "devservices");
	return preferred === tmp ? [tmp] : [preferred, tmp];
}

/**
 * Turn off btrfs copy-on-write for the cluster tree. Best-effort by contract.
 *
 * Postgres on CoW is a well-known pathology (every page write forks an extent),
 * and this /home is `btrfs ... compress=zstd:3` — compressing a database's
 * pages is wasted CPU on top of it. `chattr +C` fixes both, but ONLY when the
 * directory is still empty, which is why this runs at creation and nowhere
 * else. On any other filesystem chattr simply fails, and that is fine: the
 * inode-budget win is the point and it does not depend on this.
 */
export function disableCow(dir: string): void {
	try {
		execFileSync("chattr", ["+C", dir], { stdio: "ignore" });
	} catch {
		// Not btrfs, or no chattr. Not a reason to fail a dev database.
	}
}

/**
 * First candidate we can actually create, probed rather than assumed.
 *
 * The header's "writable in every srt profile" clause was load-bearing for
 * years, so this does not trade one assumption for another: it tries to make
 * the directory and moves on to the next candidate on ANY error (EROFS from a
 * policy that omits `~/.pi`, ENOENT, a read-only home, anything). Universality
 * stops mattering when the probe is real.
 */
export function resolveBaseDir(
	candidates: string[] = baseDirCandidates(),
	mkdir: (dir: string) => void = (dir) => fs.mkdirSync(dir, { recursive: true }),
	onCreate: (dir: string) => void = disableCow,
	exists: (dir: string) => boolean = fs.existsSync,
): string {
	for (const dir of candidates) {
		try {
			const fresh = !exists(dir);
			mkdir(dir);
			// Only meaningful on an empty directory — see `disableCow`.
			if (fresh) onCreate(dir);
			return dir;
		} catch {
			// Next candidate. The last one is os.tmpdir(), i.e. the old behaviour.
		}
	}
	return candidates[candidates.length - 1];
}

/**
 * Every root a sweep must look at: where we put clusters now, and where
 * clusters still land from sessions that loaded the pre-fix module.
 *
 * That second root is not defensive padding. pi loads this extension at SESSION
 * START and keeps it for the session's life, so every session already running
 * when this ships keeps creating clusters under `os.tmpdir()` for hours
 * afterwards. Dropping the old root would strand exactly the litter this change
 * is meant to stop accumulating.
 */
export function sweepRoots(base: string, tmp: string = os.tmpdir()): string[] {
	return base === tmp ? [tmp] : [base, tmp];
}

/**
 * Turn a start failure into something the caller can act on.
 *
 * The papercut that produced HIV-1966 was not only the collision — it was that
 * the tool reported the raw postgres FATAL and stopped, so the agent had no
 * next move and abandoned the task. Guidance belongs in the tool result, at the
 * moment of use (technique #4), not in a README nobody reads.
 */
export function startFailureHint(output: string): string | null {
	if (/pre-existing shared memory block/i.test(output)) {
		return (
			"Another postgres is already running against this data directory. Since HIV-1966 each process gets " +
			"its own directory, so this means a stale server from a crashed session of THIS pid+token is still up: " +
			"stop it with `pg_ctl -D <data_dir> -m immediate stop`, or remove the directory and retry."
		);
	}
	if (/could not bind|address already in use/i.test(output)) {
		return "The chosen loopback port was taken between reservation and start. Retry — a fresh port is picked each time.";
	}
	if (/No such file or directory|error while loading shared libraries/i.test(output)) {
		return "The postgres bundle looks incomplete. Re-run `install-devservices-postgres` on the host.";
	}
	return null;
}

export function pgPaths(env: Record<string, string | undefined> = process.env, home = os.homedir()): PgPaths {
	const root = env.PI_DEVSERVICES_PG ?? path.join(home, ".hive", "tools", "postgres");
	return { root, bin: path.join(root, "bin"), lib: path.join(root, "lib") };
}

/** postgres server settings — every one of these is load-bearing, see header. */
export function serverArgs(port: number): string[] {
	return [
		"-c", "listen_addresses=127.0.0.1",
		"-c", `port=${port}`,
		"-c", "unix_socket_directories=",
		"-c", "fsync=off",
		"-c", "synchronous_commit=off",
		"-c", "full_page_writes=off",
		// Parallel-query DSM segments in the DATA DIR (on /tmp), not /dev/shm.
		//
		// The default (posix) allocates every parallel worker's segment in
		// /dev/shm, which is a small tmpfs in the sandbox — the same trap as
		// docker's 64 MB default. A focused test stays under it, so the server
		// looks healthy right up until a full `go test ./internal/api` +
		// `./internal/store` runs concurrently: a worker dies resizing its
		// segment, the postmaster restarts, and every other backend fails with
		// `the database system is not yet accepting connections (57P03)` —
		// which is the error the papercut reported (2026-08-20), two suites in.
		// mmap is marginally slower and immune; for a disposable dev database
		// that is the right trade, and it needs no shm sizing knob at all.
		"-c", "dynamic_shared_memory_type=mmap",
		// Bound the pending-unlink garbage a resetting test suite leaves behind
		// (HIV-2407). This is the setting that keeps /tmp's inode budget alive.
		//
		// TRUNCATE assigns a NEW relfilenode to the table and to every one of its
		// indexes and toast relations; the OLD file is truncated to zero and
		// physically unlinked only at the next CHECKPOINT. So a suite that resets
		// between tests — hive's `internal/testdb` does, ~900 DB-backed tests
		// across ./internal/store and ./internal/api — leaks one zero-byte file
		// per relation per reset, and the only thing bounding the pile is when a
		// checkpoint happens to fire. At the 5-minute default that is five
		// minutes of churn, and `/tmp` is tmpfs with a FIXED, GLOBAL 1,048,576
		// inodes shared with every other process on the box.
		//
		// Measured on this data (2026-08-24): one abandoned data dir held
		// **805,122 inodes**, of which a single database's base/ held 127,807
		// files — **126,892 of them zero bytes (99.3%)**. `df -h` read 7% the
		// whole time; only `df -i` saw it. At 81% of the global budget every
		// process writing /tmp started failing with ENOSPC, which on this
		// workstation takes out the coding agent's own tooling (each Bash call
		// writes its output under /tmp, so it fails before running anything —
		// including `df` and `rm`).
		//
		// Measured effect of this line — identical TRUNCATE workload for 95s,
		// relation-file count sampled every 5s:
		//
		//	           t=35s   t=40s   t=70s   t=95s (final)
		//	5min       4671    5116    8036    11312   ← monotonic, never reclaims
		//	30s        4631    1116    1481     1157   ← sawtooth: BOUNDED
		//
		// 9.8x apart after 95 seconds, and the gap grows LINEARLY with how long
		// the suite runs — which is why a long test run is what takes the box
		// down. The bounded series never exceeds ~30s of churn no matter how long
		// the suite lasts; that is the whole property being bought here.
		//
		// 30s is PostgreSQL's minimum. It is the right trade here and nowhere
		// else: a checkpoint costs almost nothing on a database that is already
		// `fsync=off`, `synchronous_commit=off` and disposable by contract, and
		// in exchange the garbage is bounded by a fixed time window instead of
		// growing with suite length.
		//
		// NOT the fix that was written down. The KB's standing advice was to move
		// the data dir off tmpfs — `dataDirFor` honours $TMPDIR, so it looks like
		// a one-liner. It is not: srt is allow-only for writes and binds /home
		// read-only, so a `~/.cache` data dir returns EROFS in exactly the
		// sandboxed sessions this extension exists to serve. Bounding the garbage
		// needs no allowlist change and helps sandboxed and host sessions alike.
		"-c", "checkpoint_timeout=30s",
	];
}

export function databaseUrl(port: number, database: string, user = "dev"): string {
	return `postgresql://${user}@127.0.0.1:${port}/${database}`;
}

/** A free loopback TCP port, reserved by binding then releasing. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			srv.close(() => {
				if (addr && typeof addr === "object") resolve(addr.port);
				else reject(new Error("no port assigned"));
			});
		});
	});
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a postgres binary with the bundle's lib dir on LD_LIBRARY_PATH. */
export function runPg(paths: PgPaths, binary: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(path.join(paths.bin, binary), args, {
			env: { ...process.env, LD_LIBRARY_PATH: paths.lib },
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
