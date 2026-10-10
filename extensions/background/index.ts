/**
 * background — start work, walk away, get told when it lands.
 *
 * ## The problem
 *
 * Every tool call in this harness blocks the session. A four-minute build, a
 * long test run or a delegated worker is four minutes in which the orchestrator
 * — the expensive model — does nothing but wait, and the human watches a tool
 * call that looks frozen. pi 0.84 has no native backgrounding to lean on
 * (checked: no `background`/`detach` anywhere in its extension surface), so the
 * mechanism has to be ours.
 *
 * ## Three decisions worth reading before changing anything
 *
 * **1. Completion is pushed; status is pulled.** A finished job injects itself
 * once, through the shared waker (`hive-common/waker.ts`): never between a tool
 * call and its result, waking an IDLE session so it acts rather than sitting on
 * the result until the human types — but not one that has handed the turn to a
 * person, and never by stretching a run past the agent's final word. Everything else
 * — how many are running, what they have printed so far — is a tool the model
 * calls when it wants, plus a footer segment that costs no context at all.
 *
 * There is deliberately NO periodic status injection. `agenda/loop.ts` states
 * the doctrine ("the timer NEVER injects") and the economics agree: a timer
 * that injects bills a turn every time it fires whether or not anything
 * changed, while a completion message bills one turn per actual event.
 *
 * **2. The abort signal is not forwarded.** Surviving the turn that started it
 * IS the feature. This is the one place in the harness where dropping the
 * signal is correct rather than a bug — which is exactly why it needs saying
 * here, and why `session_shutdown` reaping below is not optional. An orphaned
 * child process outliving its session is a measured defect in this house
 * (agent sidecars OOMing a pod hours after the run that spawned them), and a
 * background feature without reaping is a factory for them.
 *
 * **3. It refuses to run where the notification has nowhere to land.** In
 * headless/`-p` mode the session is replaced immediately after settle, so an
 * injection either throws or vanishes. A background job there would run, finish
 * and tell nobody — worse than not backgrounding at all, because the model
 * believes it will be told. So the tool refuses and says to run it in the
 * foreground.
 *
 * ## Guarding
 *
 * `background_bash` runs a shell, and a new tool is unguarded by default —
 * `guards-bridge` matched the literal tool name `bash`. Rather than copy the
 * hook call here, that extension now matches a SET of shell tools which this
 * one is in. The guard stays in one place and this file has no security logic
 * of its own to drift.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { credentialChildState, registerCredentialConsumer } from "../hive-remote/credential-runtime.ts";
import { randomUUID } from "node:crypto";
import { JOB_RECORD, assertRecordedBranch, jobRecord, recoverJobs } from "./journal.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGuardedTool } from "../guards-common/capability.ts";
import { resolveAuth } from "../hive-common/identity.ts";
import { isOverflowWedged } from "../hive-common/overflow.ts";
import { announceOwnWork } from "../hive-common/own-work.ts";
import { createdPullURL } from "../hive-common/pull-delivery.ts";
import { createWaker } from "../hive-common/waker.ts";
import {
	fetchRunJSON,
	firstFailureNotice,
	resolveRunUUID,
	runStateNote,
	WATCH_RUN_DESCRIPTION,
	WATCH_RUN_GUIDELINE,
	WATCH_FIRST_FAILURE_NOTE,
	WATCH_RUN_PARAMS,
	WATCH_VERDICT_NOTE,
	watchCommand,
	watchFailureScanner,
} from "./watch-run.ts";
import { strandedIndexLock } from "./indexlock.ts";
import {
	BACKGROUND_CANCEL_CHANNEL,
	BACKGROUND_JOB_CHANNEL,
	WATCH_REPORTED_CHANNEL,
	type BackgroundCancelEvent,
	type BackgroundJobEvent,
	type WatchReportedEvent,
} from "./channel.ts";
import {
	EXIT_SETTLE_GRACE_MS,
	MAX_CONCURRENT,
	appendOutput,
	createJob,
	finishJob,
	footerSegment,
	formatDuration,
	nextJobId,
	notificationFor,
	pendingNotifications,
	renderList,
	resolveTimeoutMs,
	resultHeader,
	statusForExit,
	statusForWatchExit,
	type Job,
} from "./jobs.ts";
import { exposureFor } from "../loadout/policy.ts";

/**
 * How long a watch holds its first-failure notice. A watch started on a run that
 * has already ended replays the whole backlog, prints `run <state>` and exits;
 * its verdict already carries the failure, and a notice claiming the run is
 * still going would be false.
 */
const FIRST_FAILURE_HOLD_MS = 2_000;

/** Grace period between SIGTERM and SIGKILL when reaping. */
const KILL_GRACE_MS = 3_000;

/**
 * Where a background job can be started at all.
 *
 * `tui` and `rpc` both keep a session alive to receive the completion message.
 * Every other mode replaces or ends the session at settle.
 */
const DELIVERABLE_MODES = new Set(["tui", "rpc"]);

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

export default function background(pi: ExtensionAPI) {
	/**
	 * All state lives in this closure. Nothing at module scope: pi builds a
	 * fresh jiti instance per extension with `moduleCache: false`, so two
	 * importers would get two registries and the second would silently never see
	 * the first's jobs.
	 */
	const releaseCredentialConsumer = registerCredentialConsumer("background");
	const jobs = new Map<string, Job>();
	const procs = new Map<string, ChildProcess>();
	const timers = new Map<string, NodeJS.Timeout>();
	let latestCtx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let generation = 0;
	let persistenceFaulted = false;
	const executions = new Map<string, string>();
	const waker = createWaker(pi, "background");
	/** Per run: failures quality_gate's result already reported (channel.ts). */
	const reportedFailures = new Map<string, Set<string>>();
	pi.events.on(WATCH_REPORTED_CHANNEL, (data: unknown) => {
		const event = data as Partial<WatchReportedEvent> | undefined;
		if (typeof event?.run !== "string" || !Array.isArray(event.keys)) return;
		const keys = reportedFailures.get(event.run) ?? new Set<string>();
		for (const key of event.keys) if (typeof key === "string") keys.add(key);
		reportedFailures.set(event.run, keys);
	});

	const allJobs = (): Job[] => [...jobs.values()];
	const record = (job: Job): void => {
		const executionId = executions.get(job.id);
		if (!sessionId || !executionId || !latestCtx) throw new Error("Background job has no active session owner");
		const data = jobRecord(sessionId, executionId, job);
		try {
			if (latestCtx) assertRecordedBranch(latestCtx.sessionManager.getBranch(), latestCtx.sessionManager.getSessionFile());
			pi.appendEntry(JOB_RECORD, data);
		} catch (error) {
			// Pi appends to its in-memory tree BEFORE writing. Mark our own payload
			// so a same-process reload cannot mistake a failed write for durability.
			data.writeError = String(error);
			failSession(error);
			throw error;
		}
	};

	/**
	 * Touch the live ctx, tolerating a stale one.
	 *
	 * A ctx captured at `session_start` throws on EVERY property access once its
	 * session is replaced, so this is not defensive padding — it is the
	 * documented failure mode for anything that outlives a turn, which is
	 * everything in this file.
	 */
	const withCtx = (fn: (ctx: ExtensionContext) => void): void => {
		if (!latestCtx) return;
		try {
			fn(latestCtx);
		} catch {
			latestCtx = undefined;
		}
	};

	const paintFooter = (): void => {
		// Every job state change passes through here, so the shared running count
		// (hive-common/own-work.ts) is announced from the same place.
		const running = allJobs().filter((job) => job.status === "running");
		announceOwnWork(pi, "background", running.length, running.map((job) => job.what));
		const segment = footerSegment(allJobs());
		withCtx((ctx) => ctx.ui.setStatus("background", segment ?? undefined));
	};

	/**
	 * Is the session unable to send another request at all? See
	 * `hive-common/overflow.ts` for the measurement.
	 *
	 * FALSE on anything unreadable: silently withholding every completion
	 * because the session could not be inspected is a worse failure than the one
	 * this prevents.
	 */
	const overflowWedged = (): boolean => {
		if (!latestCtx) return false;
		try {
			return isOverflowWedged(latestCtx.sessionManager.getBranch() as readonly unknown[]);
		} catch {
			return false;
		}
	};

	/**
	 * Deliver one job's completion into the session.
	 *
	 * `notified` is set only after `sendMessage` returns without throwing, so a
	 * session that went away mid-flight leaves the job announceable rather than
	 * silently consumed — and the `session_start` sweep then re-delivers it.
	 * Consuming the notification on a throw would leave the model waiting
	 * forever for a message it was promised, which is the same failure the mode
	 * gate refuses headless sessions to avoid.
	 */
	const notify = (job: Job): void => {
		// A session wedged against its own context window cannot read this. The
		// wake lands as one more refused request, and each refusal leaves the
		// context larger than the last — measured, this path and hive-remote's
		// team messages together kept a session issuing identical 400s for
		// 12h27m (HIV-3060). Leaving the job unannounced is the SAFE side of the
		// asymmetry documented above: `notified` stays false, so the
		// `session_start` sweep re-delivers it to a session that can actually
		// run. Delivering now would consume the notification into a context that
		// will never be read.
		if (persistenceFaulted || overflowWedged()) return;
		const content = notificationFor(job, Date.now());
		const details = { id: job.id, status: job.status, exitCode: job.exitCode, what: job.what,
			sessionId, executionId: executions.get(job.id),
			// Authoritative command/outcome, before the displayed output is truncated.
			pullURL: job.kind === "bash" && job.status === "done" && job.exitCode === 0
				? createdPullURL(job.detail, job.output) : null };
		if (!latestCtx) return;
		try { assertRecordedBranch(latestCtx.sessionManager.getBranch(), latestCtx.sessionManager.getSessionFile()); }
		catch (error) { failSession(error); return; }
		try {
			// A completion the agent asked for wakes it — unless it has since
			// handed the turn to a person (a plan up for approval, a question, a
			// pending grant), and never by extending a run past its final word
			// (hive-common/waker.ts). A settling notice may only be in memory;
			// recovery uses actual transcript entries, never this volatile flag.
			waker.deliver(
				{
					customType: "background",
					content,
					display: true,
					details,
				},
				"completion",
			);
		} catch (error) {
			if (error instanceof Error && "code" in error) failSession(error); // also marks a native failed-write ghost entry
			return; // session gone — leave it unannounced rather than lying
		}
		jobs.set(job.id, { ...job, notified: true });
	};

	/**
	 * The early half of a watch: its first failed gate task, while the run goes on.
	 *
	 * A notice, not a completion. The job stays running and its one completion
	 * still comes, so this rides its own customType: job recovery (journal.ts),
	 * opmode's result index and the pull reporter all read a `background` message
	 * as the job's END. Not journaled either — a session restored mid-run gets the
	 * verdict, which is what a recovered watch can still promise.
	 */
	const notifyFirstFailure = (id: string, failure: { key: string; event: string; line: string }): void => {
		const job = jobs.get(id);
		if (!job || job.status !== "running" || !job.runID) return;
		if (persistenceFaulted || overflowWedged() || !latestCtx) return;
		try { assertRecordedBranch(latestCtx.sessionManager.getBranch(), latestCtx.sessionManager.getSessionFile()); }
		catch (error) { failSession(error); return; }
		try {
			waker.deliver(
				{
					customType: "background-progress",
					content: firstFailureNotice({ id, what: job.what, runID: job.runID, key: failure.key, line: failure.line }),
					display: true,
					details: { id, runID: job.runID, task: failure.key, event: failure.event, sessionId, executionId: executions.get(id) },
				},
				"completion",
			);
		} catch (error) {
			if (error instanceof Error && "code" in error) failSession(error);
			// Said in the job's own output, so the verdict that still comes carries it.
			const current = jobs.get(id);
			if (current) jobs.set(id, appendOutput(current, `\n[the early notice for failed task ${failure.key} could not be delivered: ${String(error)}]\n`));
		}
	};

	/** Clear a job's timer and forget its process handle. */
	const releaseHandles = (id: string): void => {
		const timer = timers.get(id);
		if (timer) clearTimeout(timer);
		timers.delete(id);
		procs.delete(id);
	};

	/**
	 * Kill a job's whole process tree.
	 *
	 * The negative pid is the point: children are spawned `detached`, giving each
	 * its own process group, and killing only the shell would leave a `make` or
	 * a `pytest` running with nothing watching it — the orphan problem this
	 * feature could otherwise industrialise. SIGTERM first so a well-behaved
	 * program can clean up, SIGKILL after a grace period so a badly-behaved one
	 * still dies.
	 */
	const killTree = (id: string): void => {
		const proc = procs.get(id);
		if (!proc?.pid) return;
		const pid = proc.pid;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			/* already gone */
		}
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone — the normal case */
			}
		}, KILL_GRACE_MS).unref();
	};

	/** Terminal transition + notification + footer, in one place. */
	/**
	 * Append what the run was doing, for a `watch` job that ran out of clock.
	 *
	 * Never throws and never blocks settling for long: `runStateNote` is bounded
	 * and swallows its own failures, and this is called from a `try`/`finally`
	 * whose `finally` settles regardless.
	 */
	async function annotateWatchTimeout(id: string): Promise<void> {
		const job = jobs.get(id);
		if (!job?.runID) return;
		const auth = resolveAuth();
		if (!auth) return;
		const ownerGeneration = generation;
		const note = await runStateNote(job.runID, { baseURL: auth.url, token: auth.token, getJSON: fetchRunJSON });
		if (!note || generation !== ownerGeneration) return;
		const current = jobs.get(id);
		if (current) jobs.set(id, appendOutput(current, `\n${note}\n`));
	}

	const settle = (id: string, status: Exclude<Job["status"], "running">, exitCode?: number): void => {
		const job = jobs.get(id);
		if (!job || job.status !== "running") return;
		let finished = finishJob(job, { status, exitCode, endedAtMs: Date.now() });
		try {
			record(finished); // evidence before notification; never persist `notified`
		} catch (error) {
			finished = appendOutput(finished, `\n[Background result was NOT saved for recovery: ${String(error)}]\n`);
		}
		jobs.set(id, finished);
		releaseHandles(id);
		paintFooter();
		notify(finished);
	};

	const restore = (ctx: ExtensionContext): void => {
		latestCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		jobs.clear();
		executions.clear();
		try {
			assertRecordedBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile());
			for (const recovered of recoverJobs(ctx.sessionManager.getBranch(), sessionId)) {
				jobs.set(recovered.job.id, recovered.job);
				executions.set(recovered.job.id, recovered.executionId);
			}
			persistenceFaulted = false;
		} catch (error) { failSession(error); }
	};

	pi.on("session_start", (_event, ctx) => {
		if (sessionId !== ctx.sessionManager.getSessionId()) {
			if (sessionId !== undefined) stopGeneration();
			restore(ctx);
		}
		else latestCtx = ctx;
		paintFooter();

		// Deliver anything that finished while there was no session to tell.
		//
		// `notify` only marks a job `notified` after `sendMessage` returns, so a
		// message lost to a session swap leaves the job announceable. Without
		// this sweep it would stay that way forever — and a job the model was
		// promised a notification for, that silently never arrives, is precisely
		// the failure the mode gate exists to prevent. This is the retry that
		// `pendingNotifications` was written for.
		for (const job of pendingNotifications(allJobs())) notify(job);
	});

	/**
	 * Jobs owned by another extension — today, backgrounded subagents.
	 *
	 * The owner keeps its own process and its own writer lock and merely
	 * narrates the job here, so `background_list` is one list and the trust gate
	 * that decides whether a role may run keeps having exactly one
	 * implementation. See `channel.ts` for why this is a bus and not an import.
	 *
	 * A `finish` for an id we never saw start is IGNORED rather than
	 * synthesised: it means the two sides disagree about what exists, and
	 * inventing a completed job from a stray event would put a notification in
	 * front of the model for work it cannot look up.
	 */
	pi.events.on(BACKGROUND_JOB_CHANNEL, (payload) => {
		const event = payload as BackgroundJobEvent | undefined;
		if (persistenceFaulted || !event || typeof event.id !== "string" || event.sessionId !== sessionId || typeof event.executionId !== "string") return;
		if (event.action !== "start" && executions.get(event.id) !== event.executionId) return;
		switch (event.action) {
			case "start": {
				if (jobs.has(event.id)) return; // duplicate start — keep the original
				jobs.set(
					event.id,
					createJob({
						id: event.id,
						what: event.what,
						kind: event.kind,
						detail: event.detail,
						startedAtMs: Date.now(),
					}),
				);
				executions.set(event.id, event.executionId);
				try { record(jobs.get(event.id)!); } catch (error) {
					withCtx((ctx) => ctx.ui.notify(`Background start was NOT saved for recovery: ${String(error)}`, "error"));
				}
				paintFooter();
				return;
			}
			case "output": {
				const job = jobs.get(event.id);
				if (job?.status === "running") jobs.set(event.id, appendOutput(job, event.chunk));
				return;
			}
			case "finish": {
				// `settle` is shared with locally-owned jobs, so an external job
				// gets the same one-notification-ever guarantee and the same
				// refusal to overwrite a terminal state.
				settle(event.id, event.status, event.exitCode);
				return;
			}
			default:
				return;
		}
	});

	/**
	 * Reap on shutdown. Not optional — see the header.
	 *
	 * Every running job is killed, and nothing is notified: the session that
	 * would have received the message is on its way out.
	 */
	const stopGeneration = (): void => {
		generation++; // fence callbacks BEFORE killing; do not manufacture a verdict
		sessionId = undefined; // also fence synchronous owner-bus cancellation callbacks
		latestCtx = undefined;
		for (const job of allJobs()) {
			if (job.kind === "subagent" && job.status === "running") pi.events.emit(BACKGROUND_CANCEL_CHANNEL, { id: job.id });
		}
		for (const id of [...procs.keys()]) killTree(id);
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		procs.clear();
	};
	const failSession = (error: unknown): void => {
		persistenceFaulted = true;
		const ctx = latestCtx;
		waker.close();
		stopGeneration();
		// A native failed append leaves memory-only parent ids. Never continue
		// journaling through that manager, even after the filesystem recovers.
		try { ctx?.ui.notify(`Session persistence failed: ${String(error)}. Restart/resume the saved session from disk, not /reload.`, "error"); }
		finally { ctx?.shutdown(); }
	};
	pi.on("session_shutdown", () => { releaseCredentialConsumer(); stopGeneration(); });
	pi.on("session_tree", (_event, ctx) => {
		stopGeneration();
		restore(ctx);
		paintFooter();
		for (const job of pendingNotifications(allJobs())) notify(job);
	});

	/**
	 * Start a detached job and register it — the body every backgrounding tool
	 * shares.
	 *
	 * Extracted when `hive_watch_run` arrived, because the parts worth getting
	 * right are the parts that are easy to omit on a second copy: the
	 * deliverable-mode refusal, the concurrency ceiling, `detached: true` so
	 * `killTree` can take the whole process group, and NOT forwarding the
	 * AbortSignal. A second tool that quietly dropped any one of those would
	 * look correct and leak processes.
	 */
	async function startJob(spec: {
		kind: Job["kind"];
		what: string;
		command: string;
		cwd: string;
		timeoutSeconds?: number | undefined;
		mode: ExtensionContext["mode"];
		/** Appended to the success text — where a tool has something extra to say. */
		note?: string;
		/** For a `watch` job: the run it follows, so a timeout can report its state. */
		runID?: string;
	}) {
		if (persistenceFaulted) return textResult("Session persistence failed. Restart/resume the saved session from disk, not /reload; no command was started.", true);
		if (!DELIVERABLE_MODES.has(spec.mode)) {
			return textResult(
				`Background jobs are not available in ${spec.mode} mode: this session ends or is replaced when ` +
					`the turn settles, so nothing would be left to receive the completion message. ` +
					`Run this with the normal bash tool instead.`,
				true,
			);
		}
		const running = allJobs().filter((job) => job.status === "running").length;
		if (running >= MAX_CONCURRENT) {
			return textResult(
				`Already running ${running} background jobs (the limit). Wait for one to finish, or cancel one ` +
					`with background_cancel.`,
				true,
			);
		}

		const what = spec.what.trim();
		if (!what) return textResult("`what` must say what this job is doing — it is what the human sees.", true);

		const id = nextJobId(allJobs());
		const timeoutMs = resolveTimeoutMs(spec.timeoutSeconds);
		jobs.set(id, createJob({
			id,
			what,
			kind: spec.kind,
			detail: spec.command,
			startedAtMs: Date.now(),
			cwd: spec.cwd,
			runID: spec.runID,
		}));

		executions.set(id, randomUUID());
		try { record(jobs.get(id)!); } catch (error) {
			jobs.delete(id);
			executions.delete(id);
			return textResult(`Could not record background job; command was NOT started: ${String(error)}`, true);
		}
		const startedGeneration = generation;
		const current = (): boolean => generation === startedGeneration;
		let localSessionID: string | undefined;
		try { localSessionID = latestCtx?.sessionManager.getSessionId(); } catch { /* stale context receives no credentials */ }
		const credentialChild = credentialChildState(localSessionID, process.env);
		let proc: ChildProcess;
		try {
			// `-c`, never `-lc`, exactly as pi's own bash tool runs a command. A
			// login shell reads /etc/profile, and Debian's REPLACES PATH rather
			// than appending to it — so every directory the launch put in front
			// (the harness Node, the `hive` CLI) vanished and `hive watch` died
			// 127, reported as a run with no verdict. Measured on ci-node03
			// (Debian 13) 2026-10-06; Arch's /etc/profile appends, which is why
			// it never showed on the machine this was written on. `env` already
			// carries the session's environment, which is all a job needs.
			proc = spawn("bash", ["-c", spec.command], {
				cwd: spec.cwd,
				env: credentialChild.env,
				// Its own process group, so killTree can take the whole tree.
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				// NO `signal`. The tool call's AbortSignal fires when this turn
				// ends, which is the moment the job must NOT die.
			});
		} catch (err) {
			settle(id, "failed", 1);
			return textResult(`Could not start background job: ${(err as Error).message}`, true);
		}

		procs.set(id, proc);

		const appendSafe = (chunk: Buffer): void => {
			if (!current()) return;
			const job = jobs.get(id);
			if (job && chunk.length) jobs.set(id, appendOutput(job, chunk.toString("utf8")));
		};
		// A watch reports its first failed test/lint task while the run continues
		// (watch-run.ts) — held briefly, and dropped if the run's end arrived or
		// the watch exited meanwhile: then the verdict alone is the news.
		const runID = spec.runID;
		const scanner = runID ? watchFailureScanner((key) => reportedFailures.get(runID)?.has(key) ?? false) : null;
		let exited = false;
		proc.on("exit", () => { exited = true; });
		proc.stdout?.on("data", (chunk: Buffer) => {
			const safe = credentialChild.push("stdout", chunk);
			appendSafe(safe);
			const failure = scanner && current() ? scanner.feed(safe) : null;
			if (!failure) return;
			setTimeout(() => {
				if (current() && !exited && !scanner?.ended) notifyFirstFailure(id, failure);
			}, FIRST_FAILURE_HOLD_MS).unref();
		});
		proc.stderr?.on("data", (chunk: Buffer) => appendSafe(credentialChild.push("stderr", chunk)));

		proc.on("error", (err) => {
			if (!current()) return;
			const job = jobs.get(id);
			if (job) jobs.set(id, appendOutput(job, `\n${err.message}\n`));
			settle(id, "failed", 1);
		});
		// The fast path, and the one that keeps the whole tail: `close` fires once
		// the shell has exited AND its pipes have reached EOF, so nothing more can
		// arrive. Cancelling the grace timer here keeps a normal job from waking a
		// handler two seconds after it is already over.
		let exitGrace: NodeJS.Timeout | undefined;
		/**
		 * Settle from the process's exit code — unless the job's own clock killed
		 * it. The timer below kills the tree and THEN settles `timeout` after an
		 * awaited annotation, so the kill's `close` used to win the race and
		 * report a job WE stopped as `failed (exit ?)` (HIV-3110).
		 */
		let expiring = false;
		const settleFromExit = (code: number | null): void => {
			if (!current() || expiring) return;
			if (!spec.runID) {
				settle(id, statusForExit(code), code ?? undefined);
				return;
			}
			const status = statusForWatchExit(code);
			if (status !== "unconfirmed") {
				settle(id, status, code ?? undefined);
				return;
			}
			// The watch ended without the run's verdict. Say what the run is doing
			// now, so "still running, re-watch it" is the reading and not "red".
			void (async () => {
				try {
					await annotateWatchTimeout(id);
				} finally {
					if (current()) settle(id, status, code ?? undefined);
				}
			})();
		};
		proc.on("close", (code) => {
			appendSafe(credentialChild.flush());
			if (exitGrace) clearTimeout(exitGrace);
			settleFromExit(code);
		});

		/**
		 * The slow path, for a job whose output outlives it.
		 *
		 * `close` waits for stdio EOF as well as exit, and the pipes are inherited
		 * by every descendant: a wrapper that spawns a worker and returns — a
		 * quality gate starting a `basedpyright`, say — leaves that worker holding
		 * fd 1 and 2 open with nothing to write to them. `close` then never comes,
		 * the record stays `running` long after node knows the exit code, and the
		 * wall clock eventually reports the job as `timeout` — the one status that
		 * explicitly says nothing about the command's own verdict (see
		 * `jobs.ts`). The completion message the model was told to wait for
		 * instead of polling is silent for that entire window.
		 *
		 * So the verdict comes from `exit`, after EXIT_SETTLE_GRACE_MS for the
		 * tail. `settle` refuses a job that is no longer running, so `close`,
		 * a cancel or a timeout winning this race makes the timer a no-op.
		 */
		proc.on("exit", (code) => {
			if (!current()) return;
			exitGrace = setTimeout(() => {
				if (!current()) return;
				const job = jobs.get(id);
				if (!job || job.status !== "running") return;
				jobs.set(
					id,
					appendOutput(
						job,
						"\n[the command finished; a surviving child process still held its output streams " +
							"open, and was stopped]\n",
					),
				);
				// BEFORE `settle`, which releases the process handle: after that the
				// survivor is unreachable by `killTree` and by the `session_shutdown`
				// reaper, and we would be leaving exactly the orphan this feature is
				// written not to industrialise (see the header, and `killTree`).
				killTree(id);
				settleFromExit(code);
			}, EXIT_SETTLE_GRACE_MS);
			// Unref'd for the same reason as the timeout below: a pending grace must
			// never be the reason node stays alive.
			exitGrace.unref();
		});

		const timer = setTimeout(() => {
			if (!current()) return;
			expiring = true;
			killTree(id);
			// A watch that hit its clock says nothing about WHY: the tail is
			// `task.ready` either way, whether the run never started or one step
			// wedged. Ask the run itself, then settle. The settle is in a
			// `finally` and the fetch is bounded — a job that failed to be
			// annotated must still be reported, or the footnote costs the whole
			// notification.
			void (async () => {
				try {
					await annotateWatchTimeout(id);
				} finally {
					if (current()) settle(id, "timeout");
				}
			})();
		}, timeoutMs);
		// Unref'd: a pending timeout must never be the reason node stays alive.
		timer.unref();
		timers.set(id, timer);

		paintFooter();

		return textResult(
			[
				`Started background job \`${id}\`: ${what}`,
				"",
				"It is running now. You will be told when it finishes — do NOT poll for it; carry on with " +
					"something else and deal with the result when it arrives.",
				...(spec.note ? [spec.note] : []),
				`Limit ${formatDuration(timeoutMs)}. \`background_list\` to see it, \`background_cancel\` to stop it.`,
			].join("\n"),
		);
	}

	registerGuardedTool(pi, {
		name: "background_bash",
		label: "Background",
		description:
			"Run a shell command in the background and return immediately. Use this for anything you expect " +
			"to take more than about thirty seconds — builds, test suites, installs, long greps — so you can " +
			"keep working while it runs. You are told when it finishes; you do not need to poll. " +
			"For a quick command, use the normal bash tool: backgrounding something short just adds a round trip.",
		promptSnippet: "background_bash: run a long command in the background; you are notified when it finishes",
		promptGuidelines: [
			"Before starting a background job, say in one short sentence what you are running and what you will " +
				"do while it runs, so the person watching is not looking at a silent tool call.",
			"Do not wait for a background job by polling background_list in a loop — you are notified on completion. " +
				"Start it, then do something else useful.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run." }),
			what: Type.String({
				description:
					"A short human-readable description of what this is doing, e.g. 'running the full test suite'. " +
					"Shown to the person watching instead of a bare command line.",
			}),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			timeout_seconds: Type.Optional(
				Type.Number({ description: "Wall-clock limit. Default 1800 (30 min), maximum 14400 (4 h)." }),
			),
		}),
		// `executes` is a declaration, not enforcement: the actual command check
		// is guards-bridge's shell hook, which now matches this tool by name.
		capability: { executes: true },
		execute: async (_id, params, _signal, _onUpdate, ctx) =>
			startJob({
				kind: "bash",
				what: params.what,
				command: params.command,
				cwd: params.cwd || ctx.cwd,
				timeoutSeconds: params.timeout_seconds,
				mode: ctx.mode,
			}),
	});

	/**
	 * Watch a Hive run instead of polling it.
	 *
	 * The cost this removes, measured on Borealis run #2047 (2026-08-17, HIV-1998):
	 * eight `wait_for_run` calls on one run, ~6 minutes, ~23KB of near-identical
	 * payload and eight turns of narration saying nothing new. The agent was not
	 * at fault — it passed `timeout_seconds: 900` every time and Hive answered at
	 * 45s every time, because pi-mcp-adapter sent no MCP progress token and the
	 * server clamps a wait it cannot keep alive. pi's built-in MCP does send one
	 * (HIV-3745), so a direct `wait_for_run` may now hold; this stays because a
	 * background watch also frees the turn while the run finishes.
	 *
	 * `hive watch` has no such ceiling: it is a stream, not a request, and it
	 * ends when the run does. One call, no turns spent waiting, one report.
	 */
	registerGuardedTool(pi, {
		name: "hive_watch_run",
		label: "Background",
		description: `${WATCH_RUN_DESCRIPTION} ${WATCH_FIRST_FAILURE_NOTE}`,
		promptSnippet: "hive_watch_run: watch a CI run in the background instead of re-calling wait_for_run",
		promptGuidelines: [WATCH_RUN_GUIDELINE],
		parameters: Type.Object({
			run: Type.String({ description: WATCH_RUN_PARAMS.run }),
			what: Type.String({ description: WATCH_RUN_PARAMS.what }),
			project: Type.Optional(Type.String({ description: WATCH_RUN_PARAMS.project })),
			pipeline: Type.Optional(Type.String({ description: WATCH_RUN_PARAMS.pipeline })),
			timeout_seconds: Type.Optional(Type.Number({ description: WATCH_RUN_PARAMS.timeout_seconds })),
		}),
		capability: { executes: true },
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const auth = resolveAuth();
			if (!auth) {
				return textResult(
					"No Hive credential resolved, so a run NUMBER cannot be looked up and the watch would " +
						"authenticate as nobody. Run `/hive-login`, or pass the run's UUID.",
					true,
				);
			}
			const resolved = await resolveRunUUID(params.run, params.project, params.pipeline, {
				baseURL: auth.url,
				token: auth.token,
				getJSON: fetchRunJSON,
			});
			if ("error" in resolved) return textResult(resolved.error, true);

			return startJob({
				kind: "watch",
				what: params.what,
				command: watchCommand(resolved.uuid),
				cwd: ctx.cwd,
				timeoutSeconds: params.timeout_seconds,
				mode: ctx.mode,
				runID: resolved.uuid,
				note: `${WATCH_VERDICT_NOTE} ${WATCH_FIRST_FAILURE_NOTE}`,
			});
		},
	});

	// The two readers register unguarded and sit on the reviewed READ_ONLY
	// allowlist in `test/tool-capability.test.ts`: they only read this
	// extension's own in-memory registry. Declaring an empty capability instead
	// would pass the audit while saying nothing, which the audit rejects.
	pi.registerTool({
		name: "background_list", exposure: exposureFor("background_list"),
		label: "Background",
		description: "List background jobs in this session with their status and elapsed time.",
		parameters: Type.Object({}),
		execute: async () => textResult(renderList(allJobs(), Date.now())),
	});

	pi.registerTool({
		name: "background_result", exposure: exposureFor("background_result"),
		label: "Background",
		description:
			"Get the full retained output of a background job. Use this when a completion notification was " +
			"truncated, or to check on a job that is still running.",
		parameters: Type.Object({
			id: Type.String({ description: "The job id, e.g. bg-1." }),
		}),
		execute: async (_id, params) => {
			const job = jobs.get(params.id);
			if (!job) {
				const known = allJobs().map((entry) => entry.id).join(", ") || "none";
				return textResult(`No background job \`${params.id}\`. Known jobs: ${known}.`, true);
			}
			const header = resultHeader(job, Date.now());
			const dropped = job.droppedBytes
				? `\n\n[${job.droppedBytes} earlier bytes dropped — this is the tail]`
				: "";
			const body = job.output.trimEnd() || "(no output)";
			return textResult(`${header}${dropped}\n\n${body}`);
		},
	});

	registerGuardedTool(pi, {
		name: "background_cancel",
		label: "Background",
		description: "Stop a running background job and its child processes.",
		parameters: Type.Object({
			id: Type.String({ description: "The job id, e.g. bg-1." }),
		}),
		// Killing a process tree is an execution side effect, declared for the
		// same reason the spawn is: so it appears in the capability audit.
		capability: { executes: true },
		execute: async (_id, params) => {
			const job = jobs.get(params.id);
			if (!job) return textResult(`No background job \`${params.id}\`.`, true);
			if (job.status !== "running") {
				return textResult(`Job \`${params.id}\` already ${job.status} — nothing to cancel.`);
			}

			// A job we did not spawn is cancelled by asking its owner. We must NOT
			// settle it here: the owner still has to abort a worker and release a
			// writer lock, and marking it canceled from this side would let the
			// next writer past a lock that is still held.
			if (!procs.has(params.id)) {
				pi.events.emit(BACKGROUND_CANCEL_CHANNEL, { id: params.id } satisfies BackgroundCancelEvent);
				return textResult(`Asked to cancel background job \`${params.id}\`.`);
			}

			killTree(params.id);
			// Settle immediately rather than waiting for `close`: the human asked
			// for this, and `finishJob` refuses the later exit-143 that our own
			// SIGTERM produces, so the record says "canceled" and not "failed".
			settle(params.id, "canceled");
			// A KILLED GIT LEAVES ITS LOCK BEHIND, and the next command inherits a
			// failure with no visible cause. Measured 2026-08-18: cancelling `bg-2`
			// stranded `…/worktrees/feature-cbcf2900/index.lock`, and the next job
			// died on `File exists` — with, an hour later, another session finding
			// "no Git process and the lock still there". The cancel is the last
			// moment anyone knows which repo was involved, so it is the right place
			// to say so.
			const stranded = strandedIndexLock(job.cwd);
			return textResult(`Canceled background job \`${params.id}\`.` + (stranded ? `\n\n${stranded}` : ""));
		},
	});

	pi.registerCommand("background", {
		description: "Show background jobs",
		handler: async (_args: string, ctx) => {
			ctx.ui.notify(renderList(allJobs(), Date.now()));
		},
	});
}
