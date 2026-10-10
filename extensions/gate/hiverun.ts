/**
 * hiverun — the impure half of the hive-check gate path (HIV-1929).
 *
 * Spawning the CLI, resolving a credential, and following the run it created.
 * The fold and every rendering decision live in hivecheck.ts; this file only
 * gets the facts and hands them over.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

import { repoRoot } from "../hive-common/git.ts";
import { resolveAuth } from "../hive-common/identity.ts";
import { type HiveAuth, request, withTimeout } from "../hive-common/http.ts";
import type { GateProgress } from "./stream.ts";
import { failedWhileRunning, fold, type HiveRun, type HiveSubstep, type HiveTask, hiveCheckArgs, isQueued, isTerminalRun, type RunRef, parseRunRef } from "./hivecheck.ts";

/** A poll pair per two seconds. The substep ingest itself runs at ~1 Hz, so
 *  faster would mostly re-read the same rows at twice the server cost. */
export const POLL_INTERVAL_MS = 2_000;
/** Keep fast checks synchronous; slower work belongs to the background watcher. */
export const FOLLOW_TIMEOUT_MS = 2 * 60_000;
/** A shorter wait when every unfinished task is waiting for admission. */
export const QUEUED_TIMEOUT_MS = 60_000;
/** Ceiling on packing + uploading the working tree. Aurora's snapshot is ~220 MB. */
const DISPATCH_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_LINES = 40;
const MAX_LOG_TASKS = 3;

/**
 * hivePipelineDir finds the `.hive/` this repo gates through.
 *
 * TWO conditions, both taken from what `hive check` itself does, and both
 * earned by a misfire:
 *
 *   - the directory must hold `main.star`. That file IS the pipeline — hive's
 *     resolver loads `.hive/main.star` and a snapshot without it is refused
 *     (internal/dsl/resolver.go, api/check_plan.go). A bare `.hive/` is not
 *     one: `~/.hive` is the Hive CLI's CONFIG directory, it sits above every
 *     checkout under $HOME, and testing for the directory alone made every repo
 *     there look Hive-gated. Papercut 2026-09-29T20:15: quality_gate ran
 *     `hive check --step lint` on hive-pi, which has no pipeline, and got
 *     "fetch .hive/main.star@… file not found".
 *   - it must be THIS repository's, at its root. `hive check` packs the
 *     checkout's tree and evaluates `.hive/` from the git root, so a pipeline
 *     in an enclosing directory (or a nested one) is not one it would read. Outside any checkout there
 *     is nothing for `hive check` to pack, so the answer is null.
 */
export async function hivePipelineDir(cwd: string): Promise<string | null> {
	const root = repoRoot(cwd);
	if (!root) return null;
	try {
		await access(`${root}/.hive/main.star`, constants.R_OK);
		return `${root}/.hive`;
	} catch {
		return null;
	}
}

/**
 * The credential to follow the run with.
 *
 * $HIVE_URL/$HIVE_TOKEN FIRST, which inverts hive-common's usual precedence,
 * for a reason specific to this path: the CLI we just spawned authenticated
 * with exactly those, so the run exists on THAT server. Preferring the stored
 * /hive-login credential could point the follow at a different endpoint, where
 * the run id does not exist and the widget would report a 404 for a check that
 * is running perfectly well. The stored credential is the fallback, for a
 * machine whose CLI reads `~/.config/hive/env` instead of the environment.
 */
export function resolveCheckAuth(): HiveAuth | null {
	const url = process.env.HIVE_URL?.trim();
	const token = process.env.HIVE_TOKEN?.trim();
	if (url && token) return { url: url.replace(/\/+$/, ""), token };
	const stored = resolveAuth();
	return stored ? { url: stored.url, token: stored.token } : null;
}

export interface Dispatch {
	ref: RunRef | null;
	/** Everything the CLI said, for the case where no run came back. */
	out: string;
	/**
	 * The CLI's exit code, or null when a signal ended it instead.
	 *
	 * Null rather than 0, for the reason the vendored-gate path already states:
	 * a missing code means the process did not exit, and substituting 0 would
	 * claim it did. `code ?? 0` here turned the 10-minute SIGKILL below into a
	 * clean success, so a dispatch killed mid-upload was reported as "created no
	 * run (exit 0)" — a definite claim sourced from a process nobody let finish.
	 *
	 * The codes are a documented contract (hive's cmd/hive/exitcode.go, HIV-664):
	 * 1 gate failed · 2 usage · 3 never ran · 4 NEVER CONFIRMED.
	 */
	code: number | null;
	/** The signal that killed the CLI, when one did. */
	signal: NodeJS.Signals | null;
}

/**
 * `hive check` exit 4: "the result was never confirmed".
 *
 * The CLI earns this one. It POSTs the snapshot, and when the wait expires
 * AWAITING HEADERS the body was already delivered — so the server was very
 * likely evaluating the pipeline when the client gave up. It refuses to call
 * that a failure, and exits 4 to say the outcome is unknown.
 */
export const EXIT_UNCONFIRMED = 4;

/**
 * Did this dispatch end without establishing whether a run exists?
 *
 * Two ways, and they are not the same as "no run came back". A missing
 * `ref` only means WE did not learn of one — the question is whether the CLI
 * was in a position to know. Exit 4 says it was not; a signal says it never
 * got to finish the sentence.
 *
 * Every other exit IS a statement about the run (1 failed, 2 usage, 3 never
 * ran), and those may be reported as fact.
 */
export function dispatchUnconfirmed(run: Pick<Dispatch, "code" | "signal"> & Partial<Pick<Dispatch, "out">>): boolean {
	return run.signal !== null || run.code === EXIT_UNCONFIRMED || staleCLITimedOut(run);
}

/**
 * The exit-4 contract is only as old as 2026-09-04, and the CLI a workstation's
 * launched agents run is whatever the operator last built — measured eight
 * days behind on 2026-09-10, on the node this wrapper's author uses. A CLI from
 * before the contract exits 1 on the same lost-response timeout, and the
 * wrapper then printed "created no run" for it: 20 papercuts in the seven days
 * AFTER the exit-4 branch shipped, on both developers' nodes.
 *
 * So the CLI's own words are read as well as its exit code. Go's client
 * timeout and the CLI's context deadline both name the request that timed
 * out; a gate FAILURE never prints either.
 */
export function staleCLITimedOut(run: Pick<Dispatch, "code"> & Partial<Pick<Dispatch, "out">>): boolean {
	if (run.code !== 1 || !run.out) return false;
	return /Post "[^"]*\/api\/v1\/runs":.*(context deadline exceeded|Client\.Timeout exceeded)/.test(run.out);
}

/**
 * dispatch runs `hive check … --no-wait` and reads back the run it created.
 *
 * The CLI is used for the one thing only it can do — pack the working tree,
 * upload it, and evaluate the pipeline from the snapshot's own `.hive/` — and
 * then gets out of the way. Failures are returned, never thrown: a refusal
 * ("refusing to dispatch the whole pipeline", an unknown step name and the
 * pipeline's actual step list) is the most useful thing the caller can print.
 */
export async function dispatch(
	steps: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	opts: { project?: string } = {},
): Promise<Dispatch> {
	return await new Promise((resolve, reject) => {
		const child = spawn("hive", hiveCheckArgs(steps, opts), { cwd, signal });
		let out = "";
		const onData = (buf: Buffer) => {
			out += buf.toString();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const timer = setTimeout(() => child.kill("SIGKILL"), DISPATCH_TIMEOUT_MS);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, killedBy) => {
			clearTimeout(timer);
			resolve({ ref: parseRunRef(out), out, code, signal: killedBy });
		});
	});
}

interface RunResponse {
	run?: HiveRun;
	tasks?: HiveTask[];
}

interface SubstepsResponse {
	substeps?: HiveSubstep[];
}

/**
 * follow polls the run until it is over, reporting a snapshot on every tick.
 *
 * A read that fails is skipped rather than fatal: one 502 from a rolling
 * hive-server must not end a 20-minute check that is still running perfectly
 * well on a node. The loop ends on a terminal run state, the caller's abort, or
 * the ceiling — and the LAST fold always wins, so the final spec is the server's
 * own last word rather than whatever the previous tick happened to see.
 */
export async function follow(
	auth: HiveAuth,
	ref: RunRef,
	steps: string[],
	signal: AbortSignal | undefined,
	onSnapshot: (p: GateProgress) => void,
): Promise<{ progress: GateProgress; tasks: HiveTask[]; timedOut: boolean; stillQueued: boolean; failedTask: string | null }> {
	const startedAtMs = Date.now();
	const deadline = startedAtMs + FOLLOW_TIMEOUT_MS;
	let run: HiveRun = { state: "queued" };
	let tasks: HiveTask[] = [];
	let progress = fold({ run, tasks, substeps: [], steps, ref, nowMs: Date.now() });
	let timedOut = false;
	let stillQueued = false;

	for (;;) {
		const [runRes, ssRes] = await Promise.all([
			request<RunResponse>(auth, "GET", `/runs/${ref.id}`),
			request<SubstepsResponse>(auth, "GET", `/runs/${ref.id}/substeps`),
		]);
		if (runRes.ok && runRes.body?.run) {
			run = runRes.body.run;
			tasks = runRes.body.tasks ?? [];
			progress = fold({
				run,
				tasks,
				substeps: ssRes.ok ? (ssRes.body?.substeps ?? []) : [],
				steps,
				ref,
				nowMs: Date.now(),
			});
			onSnapshot(progress);
			if (isTerminalRun(run.state)) return { progress, tasks, timedOut, stillQueued, failedTask: null };
			// The first red test/lint shard ends the FOREGROUND follow, never the
			// run: the caller hands the rest to the watcher for the final verdict.
			const failed = failedWhileRunning(tasks);
			if (failed) return { progress, tasks, timedOut, stillQueued, failedTask: failed };
		}
		if (signal?.aborted) return { progress, tasks, timedOut, stillQueued, failedTask: null };
		// Both ceilings only end the foreground follow, never the fleet work.
		const queuedTooLong = isQueued(progress) && Date.now() - startedAtMs >= QUEUED_TIMEOUT_MS;
		if (queuedTooLong || Date.now() >= deadline) {
			timedOut = true;
			stillQueued = isQueued(progress);
			return { progress, tasks, timedOut, stillQueued, failedTask: null };
		}
		await sleep(POLL_INTERVAL_MS, signal);
	}
}

/**
 * The wait between polls. NOT `unref`'d — measured, and the distinction is the
 * whole comment.
 *
 * `unref` is right for a timeout GUARD (hive-common's `withTimeout`): it must
 * not be the reason a process stays alive. Here the timer IS the work — it is
 * what holds the follow between two reads — and unref'ing it let the event loop
 * empty out. In the first live smoke run node printed "Detected unsettled
 * top-level await" and exited after ONE tick, having followed nothing. Inside pi
 * other handles would usually have masked this; "usually" is not a property to
 * ship a verification path on.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});
}

/**
 * failedTaskLogs fetches the tail of each failed step's log.
 *
 * The same epilogue `hive check` prints, and for the same reason: a verdict
 * without the failing output costs a round trip that the agent will spend
 * anyway. Bounded to three steps — a run with ten red shards has one cause, and
 * ten tails is a context bill, not ten diagnoses.
 */
export async function failedTaskLogs(auth: HiveAuth, tasks: HiveTask[]): Promise<{ task: string; tail: string }[]> {
	const failed = tasks.filter((t) => (t.state === "failed" || t.state === "timed_out") && t.id).slice(0, MAX_LOG_TASKS);
	const out: { task: string; tail: string }[] = [];
	for (const task of failed) {
		const text = await getText(auth, `/tasks/${task.id}/logs`);
		if (text) out.push({ task: task.key, tail: tailLines(text, LOG_TAIL_LINES) });
	}
	return out;
}

/** Keep the END: a step prints its way to the failure, so the last lines are it. */
export function tailLines(text: string, max: number): string {
	const lines = text.trimEnd().split("\n");
	if (lines.length <= max) return lines.join("\n");
	return [`[… ${lines.length - max} earlier line(s) omitted …]`, ...lines.slice(-max)].join("\n");
}

/** A plain-text GET (logs are `text/plain`, so the JSON helper cannot serve). */
async function getText(auth: HiveAuth, path: string): Promise<string | null> {
	try {
		const res = await withTimeout(10_000, (s) =>
			fetch(`${auth.url}/api/v1${path}`, { headers: { Authorization: `Bearer ${auth.token}` }, signal: s }),
		);
		if (!res.ok) return null;
		return await res.text();
	} catch {
		// A log we could not fetch is a missing diagnosis, never a failed check.
		return null;
	}
}
