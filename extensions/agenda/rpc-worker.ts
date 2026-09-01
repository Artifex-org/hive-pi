/**
 * Durable workers — the process boundary for a `pi --mode rpc` child.
 *
 * `worker.ts` spawns a one-shot worker: dispatch, collect stdout, exit. That is
 * right for a plan node, which is a pure function from prompt to result. It
 * stops being right the moment the orchestrator learns something mid-flight —
 * the requirement changed, another node invalidated this one — because the only
 * lever a one-shot offers is kill and re-dispatch, throwing away everything the
 * worker has done.
 *
 * A durable worker stays alive and addressable: `send()` re-tasks it, `steer`
 * interrupts, `follow_up` queues. Spike W1 confirmed against the pinned 0.83.0
 * that a `follow_up` on a live session produces a second turn in the same
 * session.
 *
 * Everything foldable lives in `rpc-protocol.ts` and is tested with no child
 * process. What is here is exactly the part that cannot be: spawn, framing over
 * real chunk boundaries, timeouts, and the registry's lifetime.
 *
 * Nothing mutable at module scope — pi builds a fresh jiti per extension entry,
 * so a module-level registry would fork silently. The registry is created by
 * the extension factory and passed in.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn, WorkerResult } from "./executor.ts";
import { acquireWriterLock, isWriterCapable, noWriterLock } from "../harness/writer.ts";
import { guardWorkerCwd, workerCwdRefusal } from "../guards-common/capability.ts";
import {
	type DeliveryMode,
	emptyWorkerState,
	finalText,
	foldLine,
	frame,
	type OutboundCommand,
	takeReplies,
	type WorkerState,
} from "./rpc-protocol.ts";
import { getPiInvocation } from "./spawn.ts";
import { resolveNodeOutput } from "./structured-node.ts";
import { discoverAgents } from "../harness/roles.ts";

/** A durable worker gets this long total before it is killed. */
export const DURABLE_TIMEOUT_MS = 30 * 60_000;
/** How long we wait for the child to settle after a send. */
export const SETTLE_TIMEOUT_MS = 15 * 60_000;

/** One delivered command adds one turn beyond both completed and already-queued work. */
export function advanceDesiredTurns(desired: number, completed: number): number {
	return Math.max(desired, completed) + 1;
}

/** A waiter follows the latest command generation, not the command that created it. */
export function reachedDesiredTurns(busy: boolean, completed: number, desired: number): boolean {
	return !busy && completed >= desired;
}

export interface WorkerHandle {
	id: string;
	role: string;
	cwd: string;
	state(): WorkerState;
	alive(): boolean;
	/** Re-task a live worker. Rejects if it has exited — see below. */
	send(message: string, mode: DeliveryMode): Promise<void>;
	waitForSettle(timeoutMs?: number): Promise<void>;
	stop(): void;
	/**
	 * Turns this worker OWES: commands accepted minus turns completed.
	 *
	 * Without it a worker that never received its first prompt renders exactly
	 * like a healthy one that has just started — "idle, 0 turn(s), 0 tokens" is
	 * both. That ambiguity is what made a stalled fleet unreadable: measured on
	 * this workstation, 43 of 43 worker readings across five sessions were that
	 * one string, and nothing in the listing said whether any of them was owed a
	 * turn nobody had delivered.
	 */
	owedTurns(): number;
	/**
	 * The child's stderr tail, or "" when it has said nothing.
	 *
	 * It was already captured and bounded here — and then read by nobody, so
	 * every reason a worker failed to start was collected and discarded. A
	 * failure the supervisor cannot see is a failure it cannot report.
	 */
	stderrTail(): string;
}

export function durableWorkerID(runId: string, nodeId: string, workId: string): string {
	return `${runId}:${nodeId}:${workId}`;
}

export function intentionallyStoppedResult(worker: WorkerHandle): WorkerResult {
	const state = worker.state();
	return {
		ok: true,
		value: { status: "stopped_by_orchestrator", worker_id: worker.id },
		tokens: state.tokens,
		cost: state.usage.cost,
	};
}

export const MAX_LIVE_DURABLE_WORKERS = 8;

type SlotWaiter = {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export class WorkerRegistry {
	private readonly workers = new Map<string, WorkerHandle>();
	private readonly intentionallyStopped = new WeakSet<WorkerHandle>();
	private readonly waiters: SlotWaiter[] = [];
	private slots = 0;

	constructor(private readonly maxLive = MAX_LIVE_DURABLE_WORKERS) {}

	/** Session-global admission across every overlapping durable run. */
	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("aborted while waiting for a durable-worker slot"));
		if (this.slots < this.maxLive) {
			this.slots++;
			return Promise.resolve(this.releaseFactory());
		}
		return new Promise((resolve, reject) => {
			const waiter: SlotWaiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("aborted while waiting for a durable-worker slot"));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	register(handle: WorkerHandle): void {
		if (this.workers.has(handle.id)) throw new Error(`durable worker id collision: ${handle.id}`);
		this.workers.set(handle.id, handle);
	}

	remove(id: string, expected?: WorkerHandle): boolean {
		const current = this.workers.get(id);
		if (!current || (expected && current !== expected)) return false;
		this.workers.delete(id);
		return true;
	}

	get(id: string): WorkerHandle | undefined {
		const worker = this.workers.get(id);
		if (worker && !worker.alive()) {
			this.remove(id, worker);
			return undefined;
		}
		return worker;
	}

	/**
	 * Find a worker by the full id OR by a trailing segment of it.
	 *
	 * The listing prints `run-<uuid>:<node>:<work>` and an exact-only lookup
	 * then refuses the very id it just showed — observed verbatim in one
	 * session, the refusal printed directly above a listing containing that
	 * id:
	 *
	 *   No live worker "96fac376567e9ec8".
	 *   Live workers:
	 *     run-38c9a8e7-…:tes8841:96fac376567e9ec8 (retriever) — idle, …
	 *
	 * A supervisor that cannot address its own worker cannot steer or stop it.
	 * Ambiguity is an ERROR rather than a guess: steering the wrong worker is
	 * worse than being told to be specific.
	 */
	resolve(id: string): { worker?: WorkerHandle; ambiguous?: WorkerHandle[] } {
		const exact = this.get(id);
		if (exact) return { worker: exact };
		const matches = this.list().filter(
			(worker) => worker.id.endsWith(`:${id}`) || worker.id.split(":").includes(id),
		);
		if (matches.length === 1) return { worker: matches[0] };
		if (matches.length > 1) return { ambiguous: matches };
		return {};
	}

	list(): WorkerHandle[] {
		for (const [id, worker] of this.workers) {
			if (!worker.alive()) this.remove(id, worker);
		}
		return [...this.workers.values()];
	}

	stop(id: string): WorkerHandle | undefined {
		const worker = this.get(id);
		if (!worker) return undefined;
		this.intentionallyStopped.add(worker);
		worker.stop();
		this.remove(id, worker);
		return worker;
	}

	wasIntentionallyStopped(worker: WorkerHandle): boolean {
		return this.intentionallyStopped.has(worker);
	}

	/** Kill everything. Called on `session_shutdown`: an orphaned child outlives
	 *  the session that made it and holds its worktree lock invisibly. */
	stopAll(): void {
		for (const worker of this.workers.values()) worker.stop();
		this.workers.clear();
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("durable-worker registry stopped"));
		}
	}

	private releaseFactory(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift()!;
				if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal?.aborted) continue;
				waiter.resolve(this.releaseFactory());
				return;
			}
			this.slots = Math.max(0, this.slots - 1);
		};
	}
}

interface StartOptions {
	id: string;
	role: string;
	cwd: string;
	model?: string;
	tools?: string[];
	/** The role's persona. Delivered exactly as `runRoleAgent` delivers it. */
	systemPrompt?: string;
	env?: Record<string, string>;
}

export function startDurableWorker(options: StartOptions): WorkerHandle {
	const args = ["--mode", "rpc", "--no-session"];
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));

	// The role's system prompt goes via a temp file and `--append-system-prompt`,
	// the same way `runRoleAgent` does it. Omitting it would silently produce a
	// worker with the right tools and the wrong persona — which reads as a bad
	// model rather than as a missing flag.
	let promptDir: string | null = null;
	if (options.systemPrompt?.trim()) {
		promptDir = mkdtempSync(join(tmpdir(), "hive-pi-durable-"));
		const promptFile = join(promptDir, `${options.role}.md`);
		writeFileSync(promptFile, options.systemPrompt, "utf8");
		args.push("--append-system-prompt", promptFile);
	}

	// Never RpcClient's default `cliPath`: it is a bare relative "dist/cli.js"
	// resolved against the child's cwd, and it hardcodes `spawn("node", …)`
	// rather than the parent's runtime. `getPiInvocation` is the one place that
	// answers "how do we re-invoke ourselves".
	const invocation = getPiInvocation(args);

	const child: ChildProcess = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		// Depth 1 by construction: a worker cannot start its own orchestration.
		env: { ...process.env, PI_AGENDA_WORKER: "1", ...options.env },
	});

	let state = emptyWorkerState;
	let buffer = "";
	let exited = false;
	let stderr = "";
	let commandId = 0;
	// Every prompt/steer/follow-up owns one eventual turn_end. This watermark is
	// shared by ALL waiters: when the parent steers an in-flight worker, the
	// original dispatch must wait for the replacement turn too rather than
	// resolving on the interrupted turn's settlement.
	let desiredTurns = 0;
	const settleWaiters: Array<() => void> = [];

	const resolveSettledWaiters = () => {
		if (!reachedDesiredTurns(state.busy, state.turns, desiredTurns)) return;
		const waiters = settleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	};

	/**
	 * Returns whether the command actually reached the child.
	 *
	 * It used to return void on every path, which made an undeliverable command
	 * indistinguishable from a delivered one. `send()` had ALREADY advanced
	 * `desiredTurns` by then, so the worker was recorded as owing a turn that
	 * nothing would ever produce: `reachedDesiredTurns` stayed false, the
	 * dispatch waited out the full 15-minute settle timeout, and the listing
	 * showed a serene "idle, 0 turn(s), 0 tokens" throughout. `send()`'s own
	 * contract — "An error, never a silent drop" — was being broken one function
	 * down from where it is written.
	 */
	const write = (command: OutboundCommand): boolean => {
		if (exited || !child.stdin?.writable) return false;
		try {
			child.stdin.write(`${JSON.stringify(command)}\n`);
			return true;
		} catch {
			// The child went away between the check and the write. Not an
			// exception to swallow: the caller must learn the command is lost.
			return false;
		}
	};

	const hardTimeout = setTimeout(() => {
		stop();
	}, DURABLE_TIMEOUT_MS);

	child.stdout?.on("data", (chunk: Buffer) => {
		const framed = frame(buffer, chunk.toString());
		buffer = framed.rest;
		for (const line of framed.lines) {
			const before = state.busy;
			state = foldLine(state, line);

			// Answer anything the child is blocking on IMMEDIATELY. An unanswered
			// extension_ui_request hangs the child forever — it is unattended, so
			// nobody else will ever answer it.
			const drained = takeReplies(state);
			state = drained.state;
			for (const reply of drained.replies) write(reply);

			// Check after EVERY line. pi may emit turn_end before or after
			// agent_settled; keying only on busy→idle makes one ordering wait until
			// the timeout despite having reached the desired generation.
			if (before !== state.busy || !state.busy) resolveSettledWaiters();
		}
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		// Bounded: a chatty child must not grow the parent's heap for the life of
		// the session. The tail is what diagnoses a crash anyway.
		stderr = (stderr + chunk.toString()).slice(-4000);
	});

	child.on("close", () => {
		exited = true;
		clearTimeout(hardTimeout);
		cleanupPrompt();
		state = { ...state, busy: false };
		const waiters = settleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	});

	child.on("error", () => {
		exited = true;
		clearTimeout(hardTimeout);
		cleanupPrompt();
		state = { ...state, busy: false };
		const waiters = settleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	});

	function cleanupPrompt(): void {
		if (!promptDir) return;
		try {
			rmSync(promptDir, { recursive: true, force: true });
		} catch {
			/* a leaked temp dir is not worth failing a worker for */
		}
		promptDir = null;
	}

	function stop(): void {
		cleanupPrompt();
		if (exited) return;
		exited = true;
		clearTimeout(hardTimeout);
		state = { ...state, busy: false };
		const waiters = settleWaiters.splice(0);
		for (const resolve of waiters) resolve();
		try {
			child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}

	const waitForSettle = (timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> =>
		new Promise((resolve) => {
			if (exited || (reachedDesiredTurns(state.busy, state.turns, desiredTurns) && state.everSettled)) {
				resolve();
				return;
			}
			const timer = setTimeout(() => {
				// Resolve rather than reject: a timeout here means "stopped waiting",
				// and the caller reads `alive()`/`state()` for the verdict. Rejecting
				// would make an ordinary slow turn indistinguishable from a crash.
				resolve();
			}, timeoutMs);
			settleWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});

	return {
		id: options.id,
		role: options.role,
		cwd: options.cwd,
		state: () => state,
		alive: () => !exited,
		owedTurns: () => Math.max(0, desiredTurns - state.turns),
		stderrTail: () => stderr,
		async send(message: string, mode: DeliveryMode) {
			// An error, never a silent drop. A supervisor that believes it re-tasked
			// a worker which had already exited waits forever for a result that is
			// not coming — and "delivered" is the one thing it cannot verify later.
			if (exited) throw new Error(`worker "${options.id}" has exited`);
			commandId++;
			const id = `${options.id}-${commandId}`;
			// Written BEFORE the watermark moves. The old order raised
			// `desiredTurns` and then dropped the command on an unwritable stdin,
			// leaving the worker permanently owing a turn nothing would deliver.
			// A command that did not land must leave the watermark untouched.
			if (!write(mode === "steer" ? { id, type: "steer", message } : { id, type: "follow_up", message })) {
				const tail = stderr.trim();
				throw new Error(
					`worker "${options.id}" did not accept the command (stdin unwritable)${tail ? `: ${tail.slice(-500)}` : ""}`,
				);
			}
			desiredTurns = advanceDesiredTurns(desiredTurns, state.turns);
		},
		waitForSettle,
		stop,
	};
}

/**
 * A `Spawn` whose workers stay addressable for the life of the dispatch.
 *
 * Drop-in for `makeSpawn`: `executor.ts` takes `Spawn` as a parameter, so this
 * needs no change there at all. The difference is only that the worker is
 * registered while it runs, so `worker_send` can reach it.
 *
 * The writer lock is held for the WHOLE session rather than one exchange, and
 * released in `finally` — including on crash, timeout and abort. A lock
 * released only on the happy path permanently wedges a worktree after the first
 * killed worker.
 */
export function makeDurableSpawn(cwd: string, runId: string, registry: WorkerRegistry): Spawn {
	const roles = discoverAgents(cwd, "both").agents;

	return async (dispatch, signal) => {
		const role = roles.find((candidate) => candidate.name === dispatch.role);
		if (!role) return { ok: false, value: null, tokens: 0, error: `unknown role "${dispatch.role}"` };

		// The THIRD spawn path, and the one easiest to miss: durable RPC workers.
		// Same reasoning as the subagent tool and agenda's one-shot worker — a
		// worker runs `--no-extensions`, carries no guards-bridge, and so the
		// parent is the last place a writer aimed at a protected checkout can be
		// refused. Guarding two of three paths would leave the bypass open on the
		// one that keeps a writer alive LONGEST.
		if (isWriterCapable(role.tools)) {
			const block = guardWorkerCwd(cwd, "orchestrate");
			if (block) {
				return { ok: false, value: null, tokens: 0, error: workerCwdRefusal(role.name, cwd, block) };
			}
		}

		let releaseSlot: () => void;
		try {
			releaseSlot = await registry.acquire(signal);
		} catch (error) {
			return { ok: false, value: null, tokens: 0, error: String(error) };
		}

		const lock = isWriterCapable(role.tools)
			? acquireWriterLock(cwd, { pid: process.pid, runId, nodeId: dispatch.nodeId })
			: noWriterLock();
		if (!lock.acquired) {
			releaseSlot();
			const holder = lock.heldBy ? ` (held by run ${lock.heldBy.runId}, node ${lock.heldBy.nodeId})` : "";
			return { ok: false, value: null, tokens: 0, error: `worktree is held by another writer${holder}: ${cwd}` };
		}

		const worker = startDurableWorker({
			// Full run + work identity: repeated or overlapping waves may use the
			// same node id and prompt, and must still remain independently steerable.
			id: durableWorkerID(runId, dispatch.nodeId, dispatch.workId),
			role: role.name,
			cwd,
			model: dispatch.model ?? role.model,
			tools: role.tools,
			systemPrompt: role.systemPrompt,
			// The writer token, so a subagent this worker delegates to re-enters
			// the lock instead of deadlocking against the worker awaiting it.
			env: lock.childEnv,
		});
		try {
			registry.register(worker);
		} catch (error) {
			worker.stop();
			lock.release();
			releaseSlot();
			return { ok: false, value: null, tokens: 0, error: String(error) };
		}

		const onAbort = () => worker.stop();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			// A durable worker keeps its session, so a schema retry is a second
			// turn rather than a second process — cheaper than the one-shot path,
			// and the model can see its own rejected answer. `resolveNodeOutput`
			// does not care which it is; it asks for text and judges text.
			const outcome = await resolveNodeOutput(dispatch.outputSchema, dispatch.prompt, isWriterCapable(role.tools), async (prompt) => {
				if (registry.wasIntentionallyStopped(worker)) return { ok: false, error: "stopped by orchestrator" };
				await worker.send(prompt, "follow_up");
				await worker.waitForSettle();
				if (registry.wasIntentionallyStopped(worker)) return { ok: false, error: "stopped by orchestrator" };
				const state = worker.state();
				// The child's own words, when it left any. Every one of these
				// failures used to be reported with no cause at all, while the
				// stderr that explains it sat captured and unread in the handle.
				const tail = worker.stderrTail().trim();
				const because = tail ? `: ${tail.slice(-500)}` : "";
				if (!worker.alive() && !state.everSettled) return { ok: false, error: `worker exited before settling${because}` };
				// Alive, owes a turn, and never produced one: it did not answer
				// within the settle timeout. Distinct from "answered with nothing",
				// and the distinction is the whole diagnosis — one is a stuck
				// child, the other is a bad answer.
				if (worker.alive() && worker.owedTurns() > 0 && !state.everSettled) {
					return {
						ok: false,
						error: `worker never took its first turn — ${worker.owedTurns()} command(s) delivered, none answered within the settle timeout${because}`,
					};
				}
				const text = finalText(state);
				// An exit-0 worker that said NOTHING is a failure, not an empty
				// success — the same rule worker.ts enforces, and for the same reason.
				if (!text) return { ok: false, error: `worker produced no output${because}` };
				return { ok: true, text };
			});

			if (registry.wasIntentionallyStopped(worker)) return intentionallyStoppedResult(worker);
			const state = worker.state();
			if (!outcome.ok) return { ok: false, value: null, tokens: state.tokens, cost: state.usage.cost, error: outcome.error };
			return { ok: true, value: outcome.value, tokens: state.tokens, cost: state.usage.cost };
		} catch (err) {
			if (registry.wasIntentionallyStopped(worker)) return intentionallyStoppedResult(worker);
			return { ok: false, value: null, tokens: worker.state().tokens, cost: worker.state().usage.cost, error: String(err) };
		} finally {
			signal?.removeEventListener("abort", onAbort);
			worker.stop();
			registry.remove(worker.id, worker);
			lock.release();
			releaseSlot();
		}
	};
}
