/**
 * devservices — a disposable per-session PostgreSQL (HIV-1636).
 *
 * Sandboxed agents cannot reach the host's databases (private network
 * namespace, no docker), which forced every DB-backed dev loop through
 * `hive check`. This runs a real Postgres INSIDE the sandbox instead: TCP
 * loopback on a random port, no durability, lifetime of the session.
 *
 * The data dir lives under `~/.pi/devservices` when that is writable and
 * falls back to /tmp when it is not — see `resolveBaseDir` in pg.ts for why
 * disk beats tmpfs here (HIV-2407) and why the fallback is a real probe
 * rather than an assumption. It stays a per-process directory either way,
 * because a base can be shared between concurrent sandboxes.
 *
 * NOTE what changed with that move: /tmp cleared itself on reboot and disk
 * does not, so the sweep in reap.ts is now the ONLY thing bounding abandoned
 * clusters. It runs on session_start over every root in `sweepRoots`.
 *
 * The server binaries are a host prerequisite (~/.hive/tools/postgres,
 * installed once by workstation/bin/install-devservices-postgres) — a
 * sandboxed session cannot download them. pg.ts documents the measured
 * sandbox constraints that shaped every setting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { Type } from "typebox";
import { databaseUrl, dataDirFor, freePort, newInstanceToken, pgPaths, resolveBaseDir, runPg, serverArgs, startFailureHint, sweepRoots } from "./pg.ts";
import { HEARTBEAT_INTERVAL_MS, realReapDeps, reapOnce, writeHeartbeat } from "./reap.ts";

const START_TIMEOUT_S = 20;

/**
 * How long after session start the sweep runs (HIV-1980).
 *
 * Off a DETACHED timer, never from the handler body: pi awaits event handlers
 * serially, so work done there IS the agent loop — the idiom `agmsg` and
 * `readiness` both use.
 *
 * WHY THIS IS SMALL. It was 20s, on the reasoning that collecting week-old
 * litter is never urgent. But the timer is `unref`'d, so it only ever fires if
 * the process is still alive when it comes due — and a headless `pi -p` run
 * finishes in a few seconds. Measured: a real session ran to completion and
 * swept nothing, because it had already exited. A delay long enough to make the
 * feature unobservable is also long enough to make it not happen.
 *
 * A few seconds is all the separation the first turn needs from a `readdir` and
 * a `/proc` scan, and it keeps short sessions collecting too.
 */
export const SWEEP_DELAY_MS = 3_000;

// Both tools spawn postgres binaries and write only the extension's own
// per-instance data dir under /tmp (pid + a random token — see pg.ts).
const DB_CAPABILITY = {
	executes: true,
	writesExemptBecause: "writes only its own per-instance data dir under /tmp",
};

interface PgState {
	dataDir: string;
	port: number;
	databases: Set<string>;
}

function text(body: string, details: unknown) {
	return { content: [{ type: "text" as const, text: body }], details };
}

export default function (pi: ExtensionAPI) {
	let state: PgState | null = null;
	const paths = pgPaths();
	/**
	 * Minted once per process, and the whole of the HIV-1966 fix: a sandboxed
	 * session has its own PID namespace, so `process.pid` alone collided between
	 * live sessions sharing /tmp. See `dataDirFor` for the measured failure.
	 */
	const instanceToken = newInstanceToken();
	/**
	 * Resolved ONCE per process, not per call: the probe touches the filesystem,
	 * and every cluster this session creates must agree on where it lives — the
	 * sweep skips its own directory by path, so a base that moved mid-session
	 * would let a session reap itself.
	 */
	const baseDir = resolveBaseDir();
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	function installHint(): string {
		return [
			`Postgres binaries not found at ${paths.root}.`,
			"Host setup (once, outside the sandbox): run `install-devservices-postgres`",
			"(stowed from hive-pi workstation/bin), or set PI_DEVSERVICES_PG to an install.",
		].join(" ");
	}

	async function ensureServer(): Promise<PgState> {
		if (state) return state;
		if (!fs.existsSync(paths.bin)) throw new Error(installHint());

		const dataDir = dataDirFor(instanceToken, baseDir);
		const port = await freePort();

		if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
			fs.mkdirSync(dataDir, { recursive: true });
			// BEFORE initdb, not after: initdb takes seconds, and a directory that
			// exists with no heartbeat is exactly what a peer's sweep treats as a
			// candidate. Claim ownership the moment the directory exists.
			writeHeartbeat(path.dirname(dataDir));
			const init = await runPg(paths, "initdb", ["-D", dataDir, "-U", "dev", "--auth=trust", "--no-sync", "-E", "UTF8"]);
			if (init.code !== 0) throw new Error(`initdb failed: ${init.stderr.slice(-2000)}`);
		}
		startHeartbeat(path.dirname(dataDir));

		const start = await runPg(paths, "pg_ctl", [
			"-D", dataDir,
			"-w", "-t", String(START_TIMEOUT_S),
			"-l", path.join(dataDir, "server.log"),
			"-o", serverArgs(port).join(" "),
			"start",
		]);
		if (start.code !== 0) {
			let log = "";
			try {
				log = fs.readFileSync(path.join(dataDir, "server.log"), "utf8").slice(-2000);
			} catch {
				// keep pg_ctl's own output
			}
			// A raw postgres FATAL leaves the caller with no next move — measured:
			// three sessions hit HIV-1966 and all three abandoned the task rather
			// than recovering. The remedy travels with the failure.
			const hint = startFailureHint(`${start.stderr}\n${log}`);
			throw new Error(
				[`postgres failed to start: ${start.stderr.slice(-500)}`, log, hint].filter(Boolean).join("\n"),
			);
		}

		state = { dataDir, port, databases: new Set(["postgres"]) };
		return state;
	}

	/**
	 * Keep saying "this cluster is still owned" while the session lives.
	 *
	 * Unref'd, so a refresh never holds the process open — the same reason
	 * `background/jobs.ts` unrefs its timers. Started when a server starts and
	 * cleared when it stops, so a stopped-but-not-removed directory correctly
	 * goes stale and gets collected later.
	 */
	function startHeartbeat(dir: string): void {
		if (heartbeat) return;
		heartbeat = setInterval(() => writeHeartbeat(dir), HEARTBEAT_INTERVAL_MS);
		heartbeat.unref?.();
	}

	function stopHeartbeat(): void {
		if (!heartbeat) return;
		clearInterval(heartbeat);
		heartbeat = null;
	}

	async function stopServer(): Promise<void> {
		const s = state;
		state = null;
		stopHeartbeat();
		if (!s) return;
		await runPg(paths, "pg_ctl", ["-D", s.dataDir, "-m", "fast", "stop"]).catch(() => undefined);
		// Remove the directory too, now that each process gets its own (HIV-1966).
		// Under the old pid-keyed scheme a leftover cluster was accidentally
		// "reused"; under this one it is pure litter, and /tmp filling up is a
		// documented failure mode on this workstation. Best-effort: a stop that
		// did not fully release the data dir must not turn shutdown into an error.
		try {
			fs.rmSync(path.dirname(s.dataDir), { recursive: true, force: true });
		} catch {
			/* the OS reclaims /tmp eventually; a failed cleanup is not a failure */
		}
	}

	registerGuardedTool(pi, {
		capability: DB_CAPABILITY,
		name: "dev_db_start",
		label: "Dev DB: start",
		description:
			"Start (or reuse) this session's disposable Postgres and ensure a database exists. " +
			"Returns the DATABASE_URL to export. TCP loopback only; data lives under /tmp for the session's lifetime.",
		promptSnippet: "Start a per-session Postgres",
		parameters: Type.Object({
			database: Type.Optional(
				Type.String({
					pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$",
					description: "Database name to create if missing (default `app`).",
				}),
			),
		}),
		async execute(_id, params) {
			const database = params.database ?? "app";
			const s = await ensureServer();
			if (!s.databases.has(database)) {
				const created = await runPg(paths, "createdb", ["-h", "127.0.0.1", "-p", String(s.port), "-U", "dev", database]);
				// "already exists" is fine — the tracking set is per-process, the
				// cluster may predate a reloaded extension.
				if (created.code !== 0 && !created.stderr.includes("already exists")) {
					throw new Error(`createdb failed: ${created.stderr.slice(-500)}`);
				}
				s.databases.add(database);
			}
			const url = databaseUrl(s.port, database);
			return text(
				[
					`Postgres ready on 127.0.0.1:${s.port} (database "${database}", user "dev", trust auth).`,
					"",
					`export DATABASE_URL=${url}`,
					`psql "${url}"`,
					"",
					"Disposable: no durability, gone when the session ends.",
				].join("\n"),
				{ port: s.port, database, url, data_dir: s.dataDir },
			);
		},
	});

	registerGuardedTool(pi, {
		capability: DB_CAPABILITY,
		name: "dev_db_stop",
		label: "Dev DB: stop",
		description: "Stop this session's disposable Postgres and forget it (data dir stays under /tmp until reboot).",
		promptSnippet: "Stop the per-session Postgres",
		parameters: Type.Object({}),
		async execute() {
			const had = state !== null;
			await stopServer();
			return text(had ? "Stopped." : "Nothing was running.", { stopped: had });
		},
	});

	pi.on("session_shutdown", () => {
		// Best-effort: an orphaned postmaster outlives the session otherwise.
		void stopServer();
	});

	// Collect what a hard death left behind (HIV-1980). Detached, so the handler
	// returns immediately — see SWEEP_DELAY_MS.
	pi.on("session_start", () => {
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const ownDir = path.dirname(dataDirFor(instanceToken, baseDir));
					for (const root of sweepRoots(baseDir)) {
						await reapOnce(realReapDeps(), root, ownDir);
					}
				} catch {
					// A sweep that fails is litter left for the next session, not an
					// error worth surfacing to anyone mid-task.
				}
			})();
		}, SWEEP_DELAY_MS);
		timer.unref?.();
	});
}
