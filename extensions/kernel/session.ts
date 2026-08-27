/**
 * The kernel subprocess — spawn, NDJSON plumbing, lifetime. The impure half.
 *
 * `protocol.ts` decides what a frame means; this decides when a process exists,
 * which interpreter it is, what it can see of the environment, and how it dies.
 * Everything here touches `child_process`, `fs` or `process.env`, which is
 * precisely why it is a separate file: the rules stay testable without a
 * Python on the box, and the plumbing stays testable without `pi`.
 *
 * ## Three decisions worth reading before changing anything
 *
 * **1. One kernel per (session, cwd, interpreter).** Not one per session: an
 * agent that `cd`s into a sibling worktree and keeps computing in a namespace
 * whose relative paths point at the old one is a debugging session nobody wants.
 * Not one per call either — surviving the turn is the entire feature. The
 * interpreter is in the key because switching venvs must not silently keep the
 * old site-packages.
 *
 * **2. The environment is an allowlist, not a filter.** `background/index.ts`
 * passes `process.env` wholesale to its shell, which is defensible there because
 * the agent chose the command and the shell is the point. Here the agent is
 * running code in a namespace that persists across turns, and the harness's
 * provider keys live in that env. A denylist would need updating every time a
 * new key is invented; an allowlist is wrong only in the direction of "the cell
 * cannot see something", which is a message the model can act on.
 *
 * **3. Cancellation is SIGINT to the process GROUP, then SIGKILL, then a new
 * kernel.** SIGINT because `runner.py` catches `KeyboardInterrupt` around the
 * cell and keeps the namespace: a cell that overran its timeout has usually
 * already set the variables that matter, and killing the interpreter would throw
 * them away for nothing. The GROUP because `!cmd` and `%%bash` start children,
 * and signalling only the interpreter leaves them running with nothing watching
 * them — a measured defect in this house (agent sidecars OOMing a pod hours
 * after the run that spawned them), and the reason `background/jobs.ts` kills
 * `-pid`.
 *
 * Nothing mutable at module scope: pi builds a fresh jiti instance per extension
 * with `moduleCache: false`, so a pool kept here would silently not be shared.
 * `KernelPool` is a class the extension instantiates in its factory closure.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	applyFrame,
	emptyExecution,
	encodeRequest,
	parseFrame,
	splitFrames,
	type Execution,
} from "./protocol.ts";

/** How long the runner gets to answer a SIGINT before we stop being polite. */
export const CANCEL_GRACE_MS = 2_000;

/** Where the managed venv lives, alongside devservices' postgres bundle. */
export const MANAGED_VENV = path.join(".hive", "tools", "kernel-venv");

/** The lowest Python this runner is written against (`ast`, f-strings, match-free). */
export const MIN_PYTHON = [3, 10] as const;

export interface Interpreter {
	path: string;
	/** Which rule found it — reported, so a surprising site-packages is explicable. */
	origin: "PI_KERNEL_PYTHON" | "VIRTUAL_ENV" | "managed venv" | "system";
}

/**
 * Environment variables a kernel may see.
 *
 * Exact names plus prefixes. `PI_` is included because it is how the harness
 * talks to its own children — `PI_ARTIFACT_DIR` is set through it, which is the
 * artifact contract's stated child-adoption mechanism working for free.
 */
export const ENV_ALLOW_EXACT = ["PATH", "HOME", "LANG", "VIRTUAL_ENV", "PYTHONPATH"];
export const ENV_ALLOW_PREFIX = ["LC_", "XDG_", "PI_"];

/**
 * Filter an environment down to the allowlist.
 *
 * Pure over its input so the interesting assertion — that a provider key does
 * NOT survive — is a unit test rather than a hope. It is a whole exported
 * function for that reason alone.
 */
export function allowedEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (ENV_ALLOW_EXACT.includes(key) || ENV_ALLOW_PREFIX.some((prefix) => key.startsWith(prefix))) {
			out[key] = value;
		}
	}
	return { ...out, ...extra };
}

/**
 * The `-c` program that asks an interpreter whether it is new enough.
 *
 * Exported and separate so it can be asserted on, because the first version of
 * it shipped broken in a way nothing but a real run could catch: it built the
 * version bound with `JSON.stringify(MIN_PYTHON)`, which is `[3,10]` — a Python
 * LIST. `sys.version_info >= [3, 10]` raises TypeError, the probe exited
 * non-zero, and every interpreter on the machine was rejected as too old. The
 * typecheck was clean, the unit tests were green (they inject a fake probe), and
 * the extension answered "No usable Python 3.10+ found" on a box running 3.14.
 * A tuple is not a list, and a string built for another language does not get
 * checked by this one.
 */
export const VERSION_PROBE = `import sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON.join(", ")}) else 1)`;

/** Does this binary exist and satisfy MIN_PYTHON? Executed, not parsed. */
export function usablePython(candidate: string): boolean {
	if (!candidate) return false;
	const probe = spawnSync(candidate, ["-c", VERSION_PROBE], { stdio: "ignore", timeout: 10_000 });
	return probe.status === 0;
}

/**
 * Find an interpreter, in the order the README states.
 *
 * Asking the candidate what version it is, rather than parsing `--version`
 * output or trusting a filename, is the same discipline `usablePython` exists
 * for: `python3` on a long-lived box has meant anything from 3.6 to 3.14, and a
 * kernel that spawns and then fails on the first f-string is a worse outcome
 * than one that says up front which interpreters it looked at.
 */
export function resolveInterpreter(
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
	probe: (candidate: string) => boolean = usablePython,
): Interpreter | null {
	const override = env.PI_KERNEL_PYTHON;
	if (override && probe(override)) return { path: override, origin: "PI_KERNEL_PYTHON" };

	const venv = env.VIRTUAL_ENV;
	if (venv) {
		const candidate = path.join(venv, "bin", "python");
		if (existsSync(candidate) && probe(candidate)) return { path: candidate, origin: "VIRTUAL_ENV" };
	}

	const managed = path.join(home, MANAGED_VENV, "bin", "python");
	if (existsSync(managed) && probe(managed)) return { path: managed, origin: "managed venv" };

	for (const candidate of ["python3", "python"]) {
		if (probe(candidate)) return { path: candidate, origin: "system" };
	}
	return null;
}

/**
 * What to say when there is no interpreter.
 *
 * Shaped like `devservices/index.ts`'s `installHint` and for its reason: a
 * sandboxed session cannot download a Python, so the only useful answer names
 * the host-side script that can. A bare "python not found" leaves the agent with
 * no next move, and the measured consequence of that (HIV-1966) was three
 * sessions abandoning the task rather than recovering.
 */
export function installHint(home: string = os.homedir()): string {
	return [
		`No usable Python ${MIN_PYTHON.join(".")}+ found.`,
		`Looked at: $PI_KERNEL_PYTHON, $VIRTUAL_ENV/bin/python, ${path.join(home, MANAGED_VENV, "bin", "python")}, python3, python.`,
		"Host setup (once, outside the sandbox): run `install-kernel-venv` (stowed from this repo's workstation/bin),",
		"or point PI_KERNEL_PYTHON at an interpreter. A sandboxed session cannot download one itself.",
	].join(" ");
}

/**
 * The identity of a kernel. See decision 1 in the header.
 *
 * cwd is normalized (trailing slashes, `..`) so that `/repo` and `/repo/` are
 * one kernel rather than two — the failure otherwise is silent and expensive:
 * two namespaces, and the variable you set is in the other one.
 */
export function kernelKey(sessionId: string, cwd: string, interpreter: string): string {
	return `${sessionId}\0${path.resolve(cwd)}\0${interpreter}`;
}

export interface ExecuteOutcome {
	exec: Execution;
	/** True when this call spawned the process. */
	spawned: boolean;
	interpreter: Interpreter;
	cwd: string;
}

/**
 * One live interpreter and the reader that feeds it.
 *
 * Deliberately NOT an EventEmitter subclass: exactly one execution is in flight
 * at a time (the tool call awaits it), so a queue and a subscription model would
 * be machinery for a concurrency this tool does not have. The single `pending`
 * slot makes "a frame arrived for nothing" a case the code has to name rather
 * than one it silently drops.
 */
export class Kernel {
	readonly interpreter: Interpreter;
	readonly cwd: string;
	private proc: ChildProcess | null = null;
	private buffer = "";
	/** The runner's own stderr — its crashes, not the cell's. */
	private runnerStderr = "";
	private pending: { requestId: string; onFrame: (line: string) => void; onExit: () => void } | null = null;
	private seq = 0;

	constructor(
		interpreter: Interpreter,
		cwd: string,
		private readonly runnerPath: string,
		private readonly env: NodeJS.ProcessEnv,
	) {
		this.interpreter = interpreter;
		this.cwd = cwd;
	}

	get alive(): boolean {
		return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
	}

	private start(): void {
		const proc = spawn(this.interpreter.path, ["-u", this.runnerPath], {
			cwd: this.cwd,
			env: this.env,
			// Its own process group, so a SIGINT/SIGKILL reaches the children a
			// cell started with !cmd or %%bash. Killing only the interpreter is
			// how a feature like this quietly accumulates orphans.
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			// NO `signal`: the abort of the turn that spawned it must not kill a
			// kernel whose whole purpose is to outlive that turn. Cancellation of
			// the CELL is handled explicitly in `execute`.
		});
		this.proc = proc;
		this.buffer = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			const { lines, rest } = splitFrames(this.buffer);
			this.buffer = rest;
			for (const line of lines) this.pending?.onFrame(line);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.runnerStderr = (this.runnerStderr + chunk.toString("utf8")).slice(-4_000);
		});
		const exited = () => {
			this.proc = null;
			this.pending?.onExit();
		};
		proc.on("error", exited);
		proc.on("close", exited);
	}

	/**
	 * Run one cell. Resolves when the runner says `done`, or when we give up.
	 *
	 * `signal` is the tool call's. Forwarding it here is correct — unlike
	 * `background`, this tool's result IS awaited, so an aborted turn should stop
	 * the cell — but it stops the CELL, not the kernel: the interrupt is a SIGINT
	 * the runner catches, so the namespace survives an abort.
	 */
	execute(code: string, timeoutSeconds: number, signal?: AbortSignal): Promise<ExecuteOutcome> {
		// One cell at a time, ENFORCED rather than assumed.
		//
		// `index.ts` asks pi for `executionMode: "sequential"`, but that is a
		// request to a scheduler this file does not own, and a single `pending`
		// slot silently garbles two concurrent calls: the first call's frames fold
		// into the second as stray output, and the first resolves only when its
		// own timeout fires. Both callers then get a plausible, wrong answer. A
		// refusal the model can read and retry is strictly better than that.
		if (this.pending) {
			return Promise.resolve({
				exec: {
					...emptyExecution(""),
					done: true,
					status: "error",
					error:
						"A cell is already running in this kernel. Wait for it to finish — a kernel is one " +
						"interpreter and cells share a namespace, so they cannot run concurrently.",
				},
				spawned: false,
				interpreter: this.interpreter,
				cwd: this.cwd,
			});
		}

		const spawned = !this.alive;
		if (spawned) this.start();
		const proc = this.proc;
		if (!proc?.stdin) {
			return Promise.resolve({
				exec: { ...emptyExecution(""), done: true, status: "crashed", error: this.crashText() },
				spawned,
				interpreter: this.interpreter,
				cwd: this.cwd,
			});
		}

		this.seq += 1;
		const requestId = `k${this.seq}`;
		let exec = emptyExecution(requestId);

		return new Promise<ExecuteOutcome>((resolve) => {
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;

			const finish = (final: Execution): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", onAbort);
				this.pending = null;
				resolve({ exec: final, spawned, interpreter: this.interpreter, cwd: this.cwd });
			};

			this.pending = {
				requestId,
				onFrame: (line) => {
					const frame = parseFrame(line);
					if (!frame) return;
					exec = applyFrame(exec, frame);
					if (exec.done) finish(exec);
				},
				// The interpreter died mid-cell. Whatever it printed first is kept:
				// a segfault in a native extension is diagnosed from the last line
				// before the crash, and discarding the partial output would remove
				// the only evidence there is.
				onExit: () => finish({ ...exec, done: true, status: "crashed", error: this.crashText() }),
			};

			/**
			 * The interrupt path, used by both the timeout and the abort.
			 *
			 * SIGINT to the group first — the runner turns that into a
			 * KeyboardInterrupt, answers `done` with status `cancelled`, and stays
			 * alive with its namespace intact. Only if it does not answer within
			 * the grace do we conclude it is wedged (a C loop ignoring signals, a
			 * child eating the SIGINT) and take the whole group with SIGKILL. The
			 * next call then finds `alive === false` and spawns a fresh kernel.
			 */
			const interrupt = (): void => {
				this.signalGroup("SIGINT");
				killTimer = setTimeout(() => {
					this.signalGroup("SIGKILL");
					finish({ ...exec, done: true, status: "cancelled" });
				}, CANCEL_GRACE_MS);
				killTimer.unref();
			};

			const onAbort = (): void => interrupt();
			signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(interrupt, timeoutSeconds * 1_000);
			timer.unref();

			proc.stdin?.write(encodeRequest({ id: requestId, code, timeout: timeoutSeconds }));
		});
	}

	private crashText(): string {
		const tail = this.runnerStderr.trim();
		return tail ? `The Python kernel exited.\n${tail}` : "The Python kernel exited.";
	}

	/** Signal the whole process group. Safe to call on a dead kernel. */
	private signalGroup(sig: NodeJS.Signals): void {
		const pid = this.proc?.pid;
		if (!pid) return;
		try {
			process.kill(-pid, sig);
		} catch {
			/* already gone — the normal case on the SIGKILL follow-up */
		}
	}

	/** Terminate the kernel and its children. Used by reset and by shutdown. */
	dispose(): void {
		this.signalGroup("SIGTERM");
		const pid = this.proc?.pid;
		this.proc = null;
		if (pid === undefined) return;
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, CANCEL_GRACE_MS).unref();
	}
}

/**
 * The live kernels of one pi process, keyed by `kernelKey`.
 *
 * A class rather than a module-level Map for the reason in the header: two
 * importers get two module instances under jiti, so module state would be a
 * second, invisible pool.
 */
export class KernelPool {
	private readonly kernels = new Map<string, Kernel>();

	constructor(
		private readonly runnerPath: string,
		private readonly envFor: () => NodeJS.ProcessEnv,
	) {}

	get size(): number {
		return this.kernels.size;
	}

	/** Get or create the kernel for this key. `reset` discards any existing one. */
	acquire(key: string, interpreter: Interpreter, cwd: string, reset = false): Kernel {
		const existing = this.kernels.get(key);
		if (existing && reset) {
			existing.dispose();
			this.kernels.delete(key);
		} else if (existing) {
			return existing;
		}
		const kernel = new Kernel(interpreter, cwd, this.runnerPath, this.envFor());
		this.kernels.set(key, kernel);
		return kernel;
	}

	/**
	 * Kill everything. Called from `session_shutdown`, and NOT optional: a
	 * kernel is spawned detached specifically so it survives the turn, which
	 * means nothing but this reaps it.
	 */
	disposeAll(): void {
		for (const kernel of this.kernels.values()) kernel.dispose();
		this.kernels.clear();
	}
}
