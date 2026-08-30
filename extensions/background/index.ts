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
 * once, via `sendMessage({deliverAs:"followUp", triggerTurn:true})` — the exact
 * `agmsg` shape, for its exact reasons: `followUp` so the message never cuts in
 * between a tool call and its result, `triggerTurn` so an IDLE session actually
 * acts on it rather than sitting on it until the human types. Everything else
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
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGuardedTool } from "../guards-common/capability.ts";
import { resolveAuth } from "../hive-common/identity.ts";
import { isOverflowWedged } from "../hive-common/overflow.ts";
import { resolveRunUUID, runStateNote, watchCommand } from "./watch-run.ts";
import { strandedIndexLock } from "./indexlock.ts";
import {
	BACKGROUND_CANCEL_CHANNEL,
	BACKGROUND_JOB_CHANNEL,
	type BackgroundCancelEvent,
	type BackgroundJobEvent,
} from "./channel.ts";
import {
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
	type Job,
} from "./jobs.ts";

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

/** How long a run-number lookup may take before we stop waiting on it. */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * One bounded GET, and it never throws.
 *
 * Bounded because this sits in front of starting a job: a hung lookup would
 * turn "return immediately" — the entire point of the tool — into a stall, and
 * a tool that blocks while promising not to is worse than one that fails.
 */
async function fetchJSON(url: string, headers: Record<string, string>) {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			/* a non-JSON body is an error body; `ok` already carries the verdict */
		}
		return { ok: res.ok, status: res.status, body };
	} catch {
		return { ok: false, status: 0, body: null };
	}
}

export default function background(pi: ExtensionAPI) {
	/**
	 * All state lives in this closure. Nothing at module scope: pi builds a
	 * fresh jiti instance per extension with `moduleCache: false`, so two
	 * importers would get two registries and the second would silently never see
	 * the first's jobs.
	 */
	const jobs = new Map<string, Job>();
	const procs = new Map<string, ChildProcess>();
	const timers = new Map<string, NodeJS.Timeout>();
	let latestCtx: ExtensionContext | undefined;

	const allJobs = (): Job[] => [...jobs.values()];

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
		if (overflowWedged()) return;
		const content = notificationFor(job, Date.now());
		try {
			pi.sendMessage(
				{
					customType: "background",
					content,
					display: true,
					details: { id: job.id, status: job.status, exitCode: job.exitCode, what: job.what },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			return; // session gone — leave it unannounced rather than lying
		}
		jobs.set(job.id, { ...job, notified: true });
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
		const note = await runStateNote(job.runID, { baseURL: auth.url, token: auth.token, getJSON: fetchJSON });
		if (!note) return;
		const current = jobs.get(id);
		if (current) jobs.set(id, appendOutput(current, `\n${note}\n`));
	}

	const settle = (id: string, status: Exclude<Job["status"], "running">, exitCode?: number): void => {
		const job = jobs.get(id);
		if (!job || job.status !== "running") return;
		const finished = finishJob(job, { status, exitCode, endedAtMs: Date.now() });
		jobs.set(id, finished);
		releaseHandles(id);
		paintFooter();
		notify(finished);
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
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
		if (!event || typeof event.id !== "string") return;
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
				paintFooter();
				return;
			}
			case "output": {
				const job = jobs.get(event.id);
				if (job) jobs.set(event.id, appendOutput(job, event.chunk));
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
	pi.on("session_shutdown", () => {
		for (const id of [...procs.keys()]) killTree(id);
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
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

		let proc: ChildProcess;
		try {
			proc = spawn("bash", ["-lc", spec.command], {
				cwd: spec.cwd,
				env: process.env,
				// Its own process group, so killTree can take the whole tree.
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				// NO `signal`. The tool call's AbortSignal fires when this turn
				// ends, which is the moment the job must NOT die.
			});
		} catch (err) {
			jobs.delete(id);
			return textResult(`Could not start background job: ${(err as Error).message}`, true);
		}

		procs.set(id, proc);

		const absorb = (chunk: Buffer): void => {
			const job = jobs.get(id);
			if (job) jobs.set(id, appendOutput(job, chunk.toString("utf8")));
		};
		proc.stdout?.on("data", absorb);
		proc.stderr?.on("data", absorb);

		proc.on("error", (err) => {
			const job = jobs.get(id);
			if (job) jobs.set(id, appendOutput(job, `\n${err.message}\n`));
			settle(id, "failed", 1);
		});
		proc.on("close", (code) => settle(id, statusForExit(code), code ?? undefined));

		const timer = setTimeout(() => {
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
					settle(id, "timeout");
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
	 * 45s every time, because `pi-mcp-adapter` sends no MCP progress token and
	 * the server clamps a wait it cannot keep alive.
	 *
	 * `hive watch` has no such ceiling: it is a stream, not a request, and it
	 * ends when the run does. One call, no turns spent waiting, one report.
	 */
	registerGuardedTool(pi, {
		name: "hive_watch_run",
		label: "Background",
		description:
			"Watch a Hive CI run to completion in the background and return immediately. Use this INSTEAD of " +
			"calling wait_for_run repeatedly: wait_for_run is a request with a timeout, so a run longer than " +
			"that timeout costs you one turn and one full duplicate result per re-call. This is a stream — it " +
			"ends when the run ends, and you are told once, with the run's own verdict. Carry on with " +
			"something else meanwhile; use get_run or explain_failure when you actually need a detail.",
		promptSnippet: "hive_watch_run: watch a CI run in the background instead of re-calling wait_for_run",
		promptGuidelines: [
			"If you find yourself calling wait_for_run a second time on the same run, stop and use " +
				"hive_watch_run instead — every further re-call costs a turn and a duplicate result for no new information.",
		],
		parameters: Type.Object({
			run: Type.String({
				description: "The run's UUID, or the #N shown in the Hive UI and in `hive runs`.",
			}),
			what: Type.String({
				description:
					"A short human-readable description, e.g. 'waiting for the Borealis ci gate'. " +
					"Shown to the person watching instead of a bare command line.",
			}),
			project: Type.Optional(
				Type.String({ description: "Project, to disambiguate a run NUMBER (numbers are per pipeline)." }),
			),
			pipeline: Type.Optional(Type.String({ description: "Pipeline, to further disambiguate a run number." })),
			timeout_seconds: Type.Optional(
				Type.Number({ description: "Wall-clock limit. Default 1800 (30 min), maximum 14400 (4 h)." }),
			),
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
				getJSON: fetchJSON,
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
				note:
					"The job's own outcome IS the run's verdict — `hive watch` exits with the run's result — so a " +
					"`done` completion means the run passed and `failed` means it did not.",
			});
		},
	});

	// The two readers register unguarded and sit on the reviewed READ_ONLY
	// allowlist in `test/tool-capability.test.ts`: they only read this
	// extension's own in-memory registry. Declaring an empty capability instead
	// would pass the audit while saying nothing, which the audit rejects.
	pi.registerTool({
		name: "background_list",
		label: "Background",
		description: "List background jobs in this session with their status and elapsed time.",
		parameters: Type.Object({}),
		execute: async () => textResult(renderList(allJobs(), Date.now())),
	});

	pi.registerTool({
		name: "background_result",
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
