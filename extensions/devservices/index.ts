/**
 * Disposable PostgreSQL for coding sessions.
 *
 * Standalone pi keeps the direct dev_db_start/stop tools. In a Hive launch they
 * are a rollout bridge only: an old server (resource route = 404) still works,
 * while a server with the managed API redirects starts/stops to request_resource.
 * This preserves private-netns reachability without letting a second local tool
 * bypass the lifecycle row once the control plane supports it.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { SessionPublisher, type HiveSessionBinding } from "../hive-common/session-publisher.ts";
import { request } from "../hive-common/http.ts";
import { Type } from "typebox";
import {
	databaseUrl,
	dataDirFor,
	freePort,
	newInstanceToken,
	pgPaths,
	resolveBaseDir,
	runPg,
	serverArgs,
	startFailureHint,
	sweepRoots,
} from "./pg.ts";
import { HEARTBEAT_INTERVAL_MS, realReapDeps, reapOnce, writeHeartbeat } from "./reap.ts";
import {
	claimResourceRequests,
	completeResourceRequest,
	reportResource,
	type ResourceReport,
	type ResourceRequest,
} from "./resource.ts";

const START_TIMEOUT_S = 20;
const REQUEST_POLL_MS = 2_000;
const HEALTH_POLL_MS = 15_000;
const RESOURCE_TTL_SECONDS = 45;
export const SWEEP_DELAY_MS = 3_000;

const DB_CAPABILITY = {
	executes: true,
	writesExemptBecause: "writes only its own per-instance data dir under /tmp",
};

interface PgState {
	dataDir: string;
	port: number;
	databases: Set<string>;
	processID?: number;
}

interface WorkOutcome {
	ok: boolean;
	state: "ready" | "ended" | "error";
	health: "healthy" | "unknown" | "unhealthy";
	error: string;
}

interface ManagedWork {
	request: ResourceRequest;
	binding: HiveSessionBinding;
	startedAt: number;
	outcome?: WorkOutcome;
	finalPublished: boolean;
}

function text(body: string, details: unknown) {
	return { content: [{ type: "text" as const, text: body }], details };
}

function readPostmasterPID(dataDir: string): number | undefined {
	try {
		const value = Number.parseInt(fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0], 10);
		return Number.isInteger(value) && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let state: PgState | null = null;
	const paths = pgPaths();
	const instanceToken = newInstanceToken();
	const baseDir = resolveBaseDir();
	const managed = Boolean(process.env.HIVE_LAUNCH_ID);
	const publisher = managed ? new SessionPublisher(pi) : null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let requestTimer: ReturnType<typeof setInterval> | null = null;
	let healthTimer: ReturnType<typeof setInterval> | null = null;
	let lifecycleBusy = false;
	let healthBusy = false;
	let shuttingDown = false;
	let generation: string | null = null;
	let sequence = -1;
	let managedDatabase = "app";
	const workQueue: ManagedWork[] = [];

	function installHint(): string {
		return [
			`Postgres binaries not found at ${paths.root}.`,
			"Host setup (once, outside the sandbox): run `install-devservices-postgres`",
			"(stowed from hive-pi workstation/bin), or set PI_DEVSERVICES_PG to an install.",
		].join(" ");
	}

	async function ensureServer(onStarting?: (candidate: PgState) => Promise<void>): Promise<PgState> {
		if (state) return state;
		if (!fs.existsSync(paths.bin)) throw new Error(installHint());
		const dataDir = dataDirFor(instanceToken, baseDir);
		const port = await freePort();
		const candidate: PgState = { dataDir, port, databases: new Set(["postgres"]) };
		if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
			fs.mkdirSync(dataDir, { recursive: true });
			writeHeartbeat(path.dirname(dataDir));
			const init = await runPg(paths, "initdb", ["-D", dataDir, "-U", "dev", "--auth=trust", "--no-sync", "-E", "UTF8"]);
			if (init.code !== 0) throw new Error(`initdb failed: ${init.stderr.slice(-2000)}`);
		}
		startHeartbeat(path.dirname(dataDir));
		await onStarting?.(candidate);
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
				// pg_ctl's stderr remains the evidence.
			}
			stopHeartbeat();
			await runPg(paths, "pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"]).catch(() => undefined);
			try {
				fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
			} catch {
				// A later host-side sweep gets what a failed start left behind.
			}
			const hint = startFailureHint(`${start.stderr}\n${log}`);
			throw new Error([`postgres failed to start: ${start.stderr.slice(-500)}`, log, hint].filter(Boolean).join("\n"));
		}
		candidate.processID = readPostmasterPID(dataDir);
		state = candidate;
		return candidate;
	}

	async function ensureDatabase(server: PgState, database: string): Promise<void> {
		if (server.databases.has(database)) return;
		const created = await runPg(paths, "createdb", ["-h", "127.0.0.1", "-p", String(server.port), "-U", "dev", database]);
		if (created.code !== 0 && !created.stderr.includes("already exists")) {
			throw new Error(`createdb failed: ${created.stderr.slice(-500)}`);
		}
		server.databases.add(database);
	}

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

	async function stopServer(): Promise<boolean> {
		const server = state;
		state = null;
		stopHeartbeat();
		if (!server) return false;
		await runPg(paths, "pg_ctl", ["-D", server.dataDir, "-m", "fast", "stop"]).catch(() => undefined);
		try {
			fs.rmSync(path.dirname(server.dataDir), { recursive: true, force: true });
		} catch {
			// A later host-side sweep gets what a hard failure left behind.
		}
		return true;
	}

	function nextReport(
		stateName: ResourceReport["state"],
		health: ResourceReport["health"],
		database: string,
		error = "",
	): ResourceReport | null {
		if (!generation) return null;
		sequence += 1;
		const report: ResourceReport = {
			generation,
			sequence,
			state: stateName,
			health,
			database_name: database,
			error: error.slice(0, 4000),
			ttl_seconds: RESOURCE_TTL_SECONDS,
		};
		if (stateName !== "ended" && stateName !== "error" && state) {
			report.host = "127.0.0.1";
			report.port = state.port;
			report.connection_url = databaseUrl(state.port, database);
			report.process_id = state.processID;
		}
		return report;
	}

	async function publish(binding: HiveSessionBinding, report: ResourceReport | null): Promise<boolean> {
		if (!report) return true;
		const result = await reportResource(binding.auth, binding.sessionID, "postgres", report);
		return result.ok;
	}

	async function performOperation(work: ManagedWork): Promise<void> {
		const request = work.request;
		if (request.action === "stop") {
			if (generation && state) {
				await publish(work.binding, nextReport("stopping", "unknown", managedDatabase));
			}
			await stopServer();
			work.outcome = { ok: true, state: "ended", health: "unknown", error: "" };
			return;
		}
		if (!generation) {
			generation = randomUUID();
			sequence = -1;
		}
		managedDatabase = request.database_name;
		try {
			const server = await ensureServer(async (candidate) => {
				// State is assigned only after pg_ctl succeeds; publish the allocated
				// endpoint explicitly for the starting reading.
				state = candidate;
				await publish(work.binding, nextReport("starting", "unknown", managedDatabase));
				state = null;
			});
			await ensureDatabase(server, managedDatabase);
			work.outcome = { ok: true, state: "ready", health: "healthy", error: "" };
		} catch (error) {
			const message = error instanceof Error ? error.message : "postgres start failed";
			await stopServer();
			work.outcome = { ok: false, state: "error", health: "unhealthy", error: message };
		}
	}

	async function advanceWork(work: ManagedWork): Promise<boolean> {
		if (!work.outcome) await performOperation(work);
		const outcome = work.outcome as WorkOutcome;
		if (!work.finalPublished && generation) {
			const report = nextReport(outcome.state, outcome.health, work.request.database_name, outcome.error);
			if (!(await publish(work.binding, report))) return false;
			work.finalPublished = true;
		}
		const completed = await completeResourceRequest(
			work.binding.auth,
			work.binding.sessionID,
			work.request.id,
			outcome.ok,
			outcome.error,
			Date.now() - work.startedAt,
		);
		if (!completed.ok && completed.status !== 409) return false;
		if (outcome.state === "ended" || outcome.state === "error") {
			generation = null;
			sequence = -1;
		}
		return true;
	}

	async function pollManagedRequests(): Promise<void> {
		if (!publisher || shuttingDown || lifecycleBusy) return;
		lifecycleBusy = true;
		try {
			if (workQueue.length > 0) {
				if (await advanceWork(workQueue[0])) workQueue.shift();
				return;
			}
			const binding = await publisher.binding();
			if (!binding) return;
			const claimed = await claimResourceRequests(binding.auth, binding.sessionID);
			if (!claimed.ok) return;
			for (const request of claimed.body?.items ?? []) {
				workQueue.push({ request, binding, startedAt: Date.now(), finalPublished: false });
			}
		} finally {
			lifecycleBusy = false;
		}
	}

	async function publishHealth(): Promise<void> {
		if (!publisher || !generation || !state || lifecycleBusy || healthBusy || shuttingDown) return;
		healthBusy = true;
		try {
			const binding = await publisher.binding();
			if (!binding || !state) return;
			const probe = await runPg(paths, "pg_isready", ["-h", "127.0.0.1", "-p", String(state.port), "-U", "dev"]);
			await publish(binding, nextReport("ready", probe.code === 0 ? "healthy" : "unhealthy", managedDatabase));
		} finally {
			healthBusy = false;
		}
	}

	async function managedPosture(): Promise<"local" | "managed" | "legacy" | "unavailable"> {
		if (!managed) return "local";
		const binding = await publisher?.binding();
		if (!binding) return "unavailable";
		const result = await request(
			binding.auth,
			"GET",
			`/agent-sessions/${encodeURIComponent(binding.sessionID)}/resources`,
		);
		if (result.ok) return "managed";
		if (result.status === 404) return "legacy";
		return "unavailable";
	}

	function managedToolReply(action: "start" | "stop") {
		return text(
			`Hive manages this session's Postgres. Use request_resource with resource \"postgres\" and action \"${action}\"; poll the same call_id until it finishes.`,
			{ managed: true, resource: "postgres", action },
		);
	}

	function registerLocalTools(): void {
		registerGuardedTool(pi, {
			capability: DB_CAPABILITY,
			name: "dev_db_start",
			label: "Dev DB: start",
			description: "Start (or reuse) this session's disposable Postgres and ensure a database exists.",
			promptSnippet: "Start a per-session Postgres",
			parameters: Type.Object({
				database: Type.Optional(Type.String({ pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" })),
			}),
			async execute(_id, params) {
				const database = params.database ?? "app";
				const posture = await managedPosture();
				if (posture === "managed") return managedToolReply("start");
				if (posture === "unavailable") {
					throw new Error("Hive resource control is temporarily unavailable; retry instead of starting an untracked database.");
				}
				const server = await ensureServer();
				await ensureDatabase(server, database);
				const url = databaseUrl(server.port, database);
				return text(
					[
						`Postgres ready on 127.0.0.1:${server.port} (database "${database}", user "dev", trust auth).`,
						"",
						`export DATABASE_URL=${url}`,
						`psql "${url}"`,
						"",
						"Disposable: no durability, gone when the session ends.",
					].join("\n"),
					{ port: server.port, database, url, data_dir: server.dataDir },
				);
			},
		});

		registerGuardedTool(pi, {
			capability: DB_CAPABILITY,
			name: "dev_db_stop",
			label: "Dev DB: stop",
			description: "Stop this session's disposable Postgres and forget it.",
			promptSnippet: "Stop the per-session Postgres",
			parameters: Type.Object({}),
			async execute() {
				// A local process always remains stoppable, even during an API outage.
				if (!state) {
					const posture = await managedPosture();
					if (posture === "managed") return managedToolReply("stop");
					if (posture === "unavailable") {
						throw new Error("Hive resource control is temporarily unavailable; retry the managed stop request.");
					}
				}
				const stopped = await stopServer();
				return text(stopped ? "Stopped." : "Nothing was running.", { stopped });
			},
		});
	}

	registerLocalTools();

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (requestTimer) clearInterval(requestTimer);
		if (healthTimer) clearInterval(healthTimer);
		const shouldReportEnded = Boolean(generation && state);
		// Cleanup is the lifecycle guarantee. Never put a network lookup or report
		// in front of it: Hive may be unavailable precisely while the session dies.
		await stopServer();
		const binding = shouldReportEnded ? await publisher?.binding() : null;
		if (binding && generation) {
			await publish(binding, nextReport("ended", "unknown", managedDatabase));
		}
		publisher?.dispose();
	});

	pi.on("session_start", () => {
		if (managed) {
			requestTimer = setInterval(() => void pollManagedRequests(), REQUEST_POLL_MS);
			requestTimer.unref?.();
			healthTimer = setInterval(() => void publishHealth(), HEALTH_POLL_MS);
			healthTimer.unref?.();
			void pollManagedRequests();
		}
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const ownDir = path.dirname(dataDirFor(instanceToken, baseDir));
					for (const root of sweepRoots(baseDir)) await reapOnce(realReapDeps(), root, ownDir);
				} catch {
					// Litter remains for the next session.
				}
			})();
		}, SWEEP_DELAY_MS);
		timer.unref?.();
	});
}
