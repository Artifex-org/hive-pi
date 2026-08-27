/**
 * hiverun — the impure half of the hive-check gate path (HIV-1929).
 *
 * Spawning the CLI, resolving a credential, and following the run it created.
 * The fold and every rendering decision live in hivecheck.ts; this file only
 * gets the facts and hands them over.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

import { resolveAuth } from "../hive-common/identity.ts";
import { type HiveAuth, request, withTimeout } from "../hive-common/http.ts";
import { ancestors } from "./gate.ts";
import type { GateProgress } from "./stream.ts";
import { fold, type HiveRun, type HiveSubstep, type HiveTask, hiveCheckArgs, isQueued, isTerminalRun, type RunRef, parseRunRef } from "./hivecheck.ts";

/** A poll pair per two seconds. The substep ingest itself runs at ~1 Hz, so
 *  faster would mostly re-read the same rows at twice the server cost. */
export const POLL_INTERVAL_MS = 2_000;
/** Ceiling on the whole follow. A hive `test` step legitimately runs 20+ min;
 *  this is long because progress is VISIBLE the entire time — the short ceiling
 *  exists for the paths where a silent hold cannot be told from a hang. */
const FOLLOW_TIMEOUT_MS = 45 * 60_000;
/**
 * Ceiling while the run is still QUEUED, where that premise does not hold.
 *
 * The long ceiling above is justified by progress being visible throughout. A
 * queued run shows none: no step has started, nothing is on a node, and the
 * only thing that moves is the wait itself. Measured 2026-08-17 — an agent 27
 * minutes into a queue wait, its pane frozen and its card reading
 * `waiting on Running quality_gate`, indistinguishable from a hang.
 *
 * Ten minutes, from hive's own queue-wait stats over the trailing 7 days:
 * p50 is 6–120s across every cluster, and p90 reaches 1810s on a busy day. So
 * this clears the overwhelming majority of real waits, and the tail it does cut
 * is the tail worth cutting.
 *
 * ABORTING THE FOLLOW DOES NOT ABORT THE RUN — that is what makes a short
 * ceiling safe here. The run keeps going on the fleet; the caller gets its turn
 * back plus the run reference, and can watch it or check again. Blocking is the
 * expensive half, not waiting.
 */
const QUEUED_TIMEOUT_MS = 10 * 60_000;
/** The same number, for the message that has to name it. */
export const QUEUED_FOLLOW_MINUTES = QUEUED_TIMEOUT_MS / 60_000;
/** Ceiling on packing + uploading the working tree. Aurora's snapshot is ~220 MB. */
const DISPATCH_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_LINES = 40;
const MAX_LOG_TASKS = 3;

/**
 * hivePipelineDir finds the `.hive/` this repo gates through.
 *
 * Presence of the directory is the whole test: it is what `hive check` uploads
 * and evaluates, so a repo that has one can be checked and a repo that has none
 * cannot, regardless of what any config claims.
 */
export async function hivePipelineDir(cwd: string): Promise<string | null> {
	for (const dir of ancestors(cwd)) {
		try {
			await access(`${dir}/.hive`, constants.R_OK);
			return `${dir}/.hive`;
		} catch {
			/* not here */
		}
	}
	return null;
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
	/** Everything the CLI said, for the case where it created no run. */
	out: string;
	code: number;
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
export async function dispatch(steps: string[], cwd: string, signal: AbortSignal | undefined): Promise<Dispatch> {
	return await new Promise((resolve, reject) => {
		const child = spawn("hive", hiveCheckArgs(steps), { cwd, signal });
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
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ref: parseRunRef(out), out, code: code ?? 0 });
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
): Promise<{ progress: GateProgress; tasks: HiveTask[]; timedOut: boolean; stillQueued: boolean }> {
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
			if (isTerminalRun(run.state)) return { progress, tasks, timedOut, stillQueued };
		}
		if (signal?.aborted) return { progress, tasks, timedOut, stillQueued };
		// Two ceilings, because they answer different questions. The long one
		// bounds a run that is WORKING; this one bounds a run that has not
		// begun, where nothing is visible to reassure the caller it is alive.
		const queuedTooLong = isQueued(progress) && Date.now() - startedAtMs >= QUEUED_TIMEOUT_MS;
		if (queuedTooLong || Date.now() >= deadline) {
			timedOut = true;
			// WHICH ceiling fired decides whether the run is cancelled — see the
			// caller. A run that never started is not holding fleet capacity, and
			// cancelling it guarantees the work is never done.
			stillQueued = queuedTooLong;
			return { progress, tasks, timedOut, stillQueued };
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
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
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

/**
 * cancelRun stops a run the caller abandoned.
 *
 * Best effort, and deliberately fire-and-forget: an aborted tool call must not
 * wait on a cancel, but leaving the run to finish would spend fleet capacity on
 * a verdict nobody will ever read. A token without `trigger` scope simply gets a
 * 403 here, which is not worth reporting — the run then just runs to completion.
 */
export function cancelRun(auth: HiveAuth, id: string): void {
	void request(auth, "POST", `/runs/${id}/cancel`, {}, 3_000);
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
