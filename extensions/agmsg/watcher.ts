/**
 * The receiving half: `watch.sh` as a long-lived child of this pi process.
 *
 * WHY A CHILD PROCESS AND NOT A POLL. agmsg's watcher already owns the hard
 * parts — claiming an identity so two sessions cannot receive the same role,
 * marking messages read exactly once, persisting a watermark so a restart does
 * not replay history, and tearing itself down on a `ctrl:despawn`. Polling
 * `inbox.sh` on a timer would reimplement all of it, badly, and would still
 * lose the despawn path.
 *
 * THE INSTANCE ID IS COMPOSITE ON PURPOSE. agmsg keys watcher state (pidfile,
 * watermark, actas lock) on `<session-id>.<pid>`, and `watch.sh` exits when the
 * embedded pid dies. Passing a bare session id there costs the liveness guard:
 * a watcher whose pi died would spin until something noticed. Our pid IS the pi
 * process, so the guard is exact — and it stays correct across `/new` and
 * `/resume`, where the session id changes but the process does not.
 *
 * RESTART, BUT NOT FOREVER. A watcher that exits because nothing is joined
 * ("nothing to do") is finished, not broken; restarting it would spawn a
 * process every second for the life of the session. A watcher that dies with
 * output pending is a crash and is worth retrying a few times with backoff.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { parseWatchLine, type AgmsgMessage } from "./message.ts";
import { agmsgHome, scriptPath } from "./paths.ts";

/** Backoff schedule for a watcher that died unexpectedly. Gives up after the last one. */
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];

export interface WatcherOptions {
	/** agmsg's resolved project root, not cwd. */
	project: string;
	/** pi's session id, or undefined for an ephemeral session. */
	sessionId: string | undefined;
	/** Injected for tests; defaults to this process. */
	pid?: number;
	home?: string;
	/**
	 * Receive EXCLUSIVELY as this identity (agmsg's `actas` mode).
	 *
	 * Set for a claimed role: the watcher then claims that one name, refuses if
	 * another live session holds it, and writes the readiness sentinel a
	 * `spawn --wait-ready` waits on. Left empty for a plain registration, where
	 * the watcher subscribes to every identity registered in the project — the
	 * leader case, and the reason this is not simply always set.
	 */
	activeName?: string;
	onMessage: (message: AgmsgMessage) => void;
	/** Watcher chatter and stderr: shown to the human, never to the model. */
	onNotice: (text: string) => void;
	/** Called once when the watcher stops for good (clean exit or exhausted retries). */
	onStopped?: (reason: "exited" | "failed") => void;
	/** Injected for tests. Defaults to node's spawn. */
	spawnFn?: typeof spawn;
	/** Injected for tests. Defaults to setTimeout. */
	scheduler?: (fn: () => void, ms: number) => unknown;
}

export interface Watcher {
	/** Idempotent. Safe to call from `session_shutdown` and again from a later stop. */
	stop(): void;
	/** True while a child is alive — the footer and `/agmsg status` read this. */
	running(): boolean;
}

/**
 * Compose the instance id agmsg expects.
 *
 * Exported because the shape is a contract with agmsg's `instance-id.sh`
 * ("last dot-segment is numeric marks the composite form"), and a test that
 * asserts it is cheaper than discovering a bare id in production by way of a
 * watcher that never exits.
 */
export function instanceId(sessionId: string | undefined, pid: number): string {
	const sid = sessionId?.trim() || `pi-${pid}`;
	return `${sid}.${pid}`;
}

export function startWatcher(options: WatcherOptions): Watcher {
	const {
		project,
		sessionId,
		pid = process.pid,
		home = agmsgHome(),
		activeName,
		onMessage,
		onNotice,
		onStopped,
		spawnFn = spawn,
		scheduler = setTimeout,
	} = options;

	let child: ChildProcess | null = null;
	let stopped = false;
	let attempt = 0;

	const launch = (): void => {
		if (stopped) return;

		// The 4th argument is optional and positional; passing an empty string
		// would look like "receive as the agent named ''" rather than "receive as
		// everyone", so it is omitted rather than blanked.
		const args = [instanceId(sessionId, pid), project, "pi"];
		if (activeName) args.push(activeName);

		const proc: ChildProcess = spawnFn(scriptPath("watch.sh", home), args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		child = proc;

		/**
		 * `error` and `exit` can BOTH fire for one launch (node makes no promise
		 * either way after a spawn error), and each would schedule its own retry —
		 * two watchers for one crash, each claiming the same identity. First one
		 * wins; the second is ignored.
		 */
		let settled = false;
		const settle = (clean: boolean): void => {
			if (settled) return;
			settled = true;
			child = null;
			retry(clean);
		};

		if (proc.stdout) {
			lineReader(proc.stdout, (line) => {
				const parsed = parseWatchLine(line);
				if (!parsed) return;
				if (parsed.kind === "message") onMessage(parsed);
				else onNotice(parsed.text);
			});
		}

		if (proc.stderr) {
			lineReader(proc.stderr, (line) => {
				const text = line.trim();
				if (text) onNotice(text);
			});
		}

		proc.on("error", (err: Error) => {
			onNotice(`agmsg watcher failed to start: ${err.message}`);
			settle(false);
		});

		/**
		 * THE EXIT CODE decides, not what the watcher printed.
		 *
		 * watch.sh exits 0 for every finished job: nothing joined here, the role
		 * was despawned, the pi it was bound to went away. Those must not be
		 * restarted — a restart loop in an unjoined project spawns a process a
		 * second, forever.
		 *
		 * Anything else is a crash, and a crash AFTER hours of delivering is the
		 * case that matters: judging by "did it produce output" would treat a
		 * long-running watcher's death as a completed job and silently end
		 * delivery for the rest of the session, with the footer still showing a
		 * role. A signal (no code) is a kill, which is likewise not a finish.
		 */
		proc.on("exit", (code: number | null) => settle(code === 0));
	};

	const retry = (clean: boolean): void => {
		if (stopped) return;
		if (clean) {
			stopped = true;
			onStopped?.("exited");
			return;
		}
		const delay = RESTART_DELAYS_MS[attempt];
		if (delay === undefined) {
			stopped = true;
			onNotice("agmsg watcher gave up after repeated failures — run /agmsg restart to retry.");
			onStopped?.("failed");
			return;
		}
		attempt += 1;
		scheduler(launch, delay);
	};

	launch();

	return {
		stop() {
			stopped = true;
			// SIGTERM, not SIGKILL: watch.sh traps it to release its actas claim and
			// remove the ready sentinel. Killing it outright leaves the identity
			// held until a later session reclaims it.
			child?.kill("SIGTERM");
			child = null;
		},
		running() {
			return child !== null;
		},
	};
}

/**
 * Split a stream into lines.
 *
 * `data` events do not respect line boundaries — one message can arrive in two
 * chunks, and two messages in one — so a consumer that treats a chunk as a line
 * drops and splices messages under exactly the load where it matters.
 */
function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			onLine(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
	});
	stream.on("end", () => {
		if (buffer) onLine(buffer);
		buffer = "";
	});
}
