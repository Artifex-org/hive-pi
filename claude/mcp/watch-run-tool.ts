/**
 * `hive_watch_run` and `background_cancel` — pi's background run watch, served
 * to a Claude session.
 *
 * Measured in the HIV-3802 A/B eval (2026-10-08): with no such tool, the Claude
 * arm waited for CI with `sleep 90; hive runs …` and `sleep 100; hive runs …`
 * Bash calls and four blocking 900 s `wait_for_run` calls, while the pi arm
 * started one `hive_watch_run` and was told once. The run-reference resolution,
 * the command, the verdict mapping and the "what was the run doing" note are
 * pi's (`extensions/background/watch-run.ts`, `jobs.ts`); this file is the host:
 * a detached `hive watch` process group per job, and the completion reported
 * as ONE wake on the aux spool, which the Hive driver delivers as a follow-up
 * for a job id it saw announced (`hive-pi-job: <id>`).
 *
 * Exactly one wake per announced job, whatever ends it — the run's verdict, the
 * watch's wall clock, the model's `background_cancel`, or the server shutting
 * down — because the driver shows an announced job as running until its wake.
 */

import { spawn } from "node:child_process";
import { EXIT_SETTLE_GRACE_MS, formatDuration, MAX_CONCURRENT, resolveTimeoutMs, statusForWatchExit } from "../../extensions/background/jobs.ts";
import {
	fetchRunJSON,
	resolveRunUUID,
	runStateNote,
	WATCH_RUN_DESCRIPTION,
	WATCH_RUN_PARAMS,
	WATCH_VERDICT_NOTE,
	watchCommand,
	type ResolveDeps,
} from "../../extensions/background/watch-run.ts";
import { killTree } from "../../extensions/hive-common/child-tree.ts";
import type { Spool } from "../spool.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";
import { cancelledByCaller, type BackgroundJobs } from "./subagent-tool.ts";

export const WATCH_RUN_TOOL: ToolDefinition = {
	name: "hive_watch_run",
	description: `${WATCH_RUN_DESCRIPTION} Use it instead of \`sleep N; hive runs …\` loops as well.`,
	inputSchema: {
		type: "object",
		properties: {
			run: { type: "string", description: WATCH_RUN_PARAMS.run },
			what: { type: "string", description: WATCH_RUN_PARAMS.what },
			project: { type: "string", description: WATCH_RUN_PARAMS.project },
			pipeline: { type: "string", description: WATCH_RUN_PARAMS.pipeline },
			timeout_seconds: { type: "number", description: WATCH_RUN_PARAMS.timeout_seconds },
		},
		required: ["run", "what"],
		additionalProperties: false,
	},
};

export const BACKGROUND_CANCEL_TOOL: ToolDefinition = {
	name: "background_cancel",
	description:
		"Stop a running hive-pi background job — a `hive_watch_run` watch or a background `subagent` delegation — " +
		"by the id its start announced (`hive-pi-job: <id>`). You still get its one completion notice, saying it was cancelled.",
	inputSchema: {
		type: "object",
		properties: { id: { type: "string", description: "The job id, e.g. watch-1-ab12cd34." } },
		required: ["id"],
		additionalProperties: false,
	},
};

/** Output kept for the wake: the end of `hive watch`'s stream, where the verdict is. */
const TAIL_CHARS = 1_500;
/** After SIGTERM, how long a watch gets before its group is killed outright. */
const KILL_GRACE_MS = 2_000;

export interface WatchHost {
	cwd: string;
	jobs: BackgroundJobs;
	spool: Spool;
	/** True when the driver can deliver a completion (the aux spool is set). */
	canWake: boolean;
	auth: { url: string; token: string } | null;
	/** Injected so a test can answer the run lookups; the real one is bounded and never throws. */
	getJSON?: ResolveDeps["getJSON"];
	env?: NodeJS.ProcessEnv;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function startWatchRun(args: Record<string, unknown>, host: WatchHost): Promise<ToolResult> {
	const run = str(args.run);
	const what = str(args.what);
	if (!run) return { text: "`run` is required: the run's UUID or the #N shown in the Hive UI.", isError: true };
	if (!what) return { text: "`what` must say what this watch is waiting for — it is what the human sees.", isError: true };
	const timeoutSeconds = typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;
	if (!host.canWake) {
		return {
			text:
				"A background watch reports through the Hive driver's aux spool, and this launch has none (HIVE_AUX_SPOOL is unset), " +
				"so nothing would ever tell you the run finished. Run `hive watch <run>` as a background Bash command instead.",
			isError: true,
		};
	}
	if (host.jobs.size >= MAX_CONCURRENT) {
		return { text: `Already running ${host.jobs.size} hive-pi background jobs (the limit). Wait for one to finish, or background_cancel one.`, isError: true };
	}
	if (!host.auth) {
		return {
			text: "No Hive credential in this launch (HIVE_URL/HIVE_TOKEN), so a run NUMBER cannot be looked up and the watch would authenticate as nobody.",
			isError: true,
		};
	}
	const deps: ResolveDeps = { baseURL: host.auth.url, token: host.auth.token, getJSON: host.getJSON ?? fetchRunJSON };
	const resolved = await resolveRunUUID(run, str(args.project), str(args.pipeline), deps);
	if ("error" in resolved) return { text: resolved.error, isError: true };
	const uuid = resolved.uuid;
	const timeoutMs = resolveTimeoutMs(timeoutSeconds);
	// Again after the lookup's await: a parallel batch all passed the first check.
	if (host.jobs.size >= MAX_CONCURRENT) {
		return { text: `Already running ${host.jobs.size} hive-pi background jobs (the limit). Wait for one to finish, or background_cancel one.`, isError: true };
	}

	const id = host.jobs.start(async (signal, jobId) => {
		const text = await watchToEnd({ uuid, what, jobId, timeoutMs, signal, cwd: host.cwd, env: host.env ?? process.env, deps });
		host.spool.wake(jobId, text);
	}, "watch");
	return {
		// The `hive-pi-job:` line is the driver's handshake: it delivers a wake
		// only for a job id it saw announced in a tool result.
		text: [
			`Started background watch \`${id}\`: ${what} (run ${uuid})`,
			`hive-pi-job: ${id}`,
			"",
			"It is running now and you will be told once when the run ends. Do NOT poll it with sleep, `hive runs` or " +
				"wait_for_run: carry on with something else, and deal with the result when it arrives.",
			WATCH_VERDICT_NOTE,
			`Limit ${formatDuration(timeoutMs)}. \`background_cancel\` with id \`${id}\` stops it.`,
		].join("\n"),
	};
}

/** How a watch ended, before it is put into words. */
type Ending = { kind: "exit"; code: number | null } | { kind: "timeout" } | { kind: "aborted" } | { kind: "spawn-error"; message: string };

/**
 * Run `hive watch <uuid>` in its own process group until it ends, and return
 * the wake text. Never throws: a watch that cannot be reported is a job the
 * model waits on forever.
 */
async function watchToEnd(o: {
	uuid: string;
	what: string;
	jobId: string;
	timeoutMs: number;
	signal: AbortSignal;
	cwd: string;
	env: NodeJS.ProcessEnv;
	deps: ResolveDeps;
}): Promise<string> {
	let tail = "";
	const keep = (chunk: Buffer) => {
		tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
	};
	const startedAt = Date.now();
	const ending = await new Promise<Ending>((resolve) => {
		let settled = false;
		/** Set when WE end the watch (clock, cancel, shutdown): the exit that follows is our kill, not a verdict. */
		let forced: Ending | undefined;
		/** Set once `hive watch` itself has exited: from then on its code IS the verdict, whatever ends the wait. */
		let exited: { code: number | null } | undefined;
		const finish = (value: Ending) => {
			if (settled) return;
			settled = true;
			clearTimeout(clock);
			o.signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		// `-c`, never `-lc`: a login shell's /etc/profile can replace PATH and lose
		// the launch's `hive` (pi's background/index.ts measured it on Debian).
		// Detached so the whole group is killed, never only the shell.
		const child = spawn("bash", ["-c", watchCommand(o.uuid)], { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const signalGroup = (signal: NodeJS.Signals) => {
			try {
				killTree(child, signal, true);
			} catch {
				/* already gone — the normal case */
			}
		};
		/**
		 * End the watch ourselves, and settle only once the group is gone (or the
		 * kill grace has passed): a server shutdown awaits this job, and must not
		 * exit while a `hive watch` it started is still running.
		 */
		const end = (why: Ending) => {
			if (settled || forced) return;
			// Already exited with a verdict, only a descendant still holds the pipes:
			// report the verdict, not our own clock or cancel.
			forced = exited ? { kind: "exit", code: exited.code } : why;
			signalGroup("SIGTERM");
			// Not unref'd: during a shutdown these two are what keeps the process
			// alive long enough to deliver the SIGKILL. Both are bounded.
			const kill = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
			const giveUp = setTimeout(() => finish(forced as Ending), KILL_GRACE_MS + 500);
			child.once("close", () => {
				clearTimeout(kill);
				clearTimeout(giveUp);
			});
		};
		const onAbort = () => end({ kind: "aborted" });
		const clock = setTimeout(() => end({ kind: "timeout" }), o.timeoutMs);
		clock.unref();
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.once("error", (error) => finish(forced ?? { kind: "spawn-error", message: error.message }));
		child.once("close", (code) => finish(forced ?? { kind: "exit", code }));
		// A descendant that keeps the pipes open would hold `close` back forever;
		// the exit code is the verdict, so settle from `exit` after a grace for the tail.
		child.once("exit", (code) => {
			exited = { code };
			setTimeout(() => {
				if (settled || forced) return;
				signalGroup("SIGKILL");
				finish({ kind: "exit", code });
			}, EXIT_SETTLE_GRACE_MS).unref();
		});
		if (o.signal.aborted) onAbort();
		else o.signal.addEventListener("abort", onAbort, { once: true });
	});

	const head = `Background watch \`${o.jobId}\` (${o.what}), run ${o.uuid}`;
	const elapsed = formatDuration(Date.now() - startedAt);
	const output = tail.trim() ? `\n\nOutput (tail):\n\`\`\`\n${tail.trim()}\n\`\`\`` : "";
	switch (ending.kind) {
		case "aborted":
			return cancelledByCaller(o.signal)
				? `${head}: cancelled at your request (background_cancel) after ${elapsed}. Nothing is watching the run now.`
				: `Background job ${o.jobId} (hive_watch_run — ${o.what}) was cancelled because the helper server restarted; watch run ${o.uuid} again.`;
		case "spawn-error":
			return `${head}: the watch could not start: ${ending.message}. Check the run with get_run.`;
		case "timeout": {
			const note = await runStateNote(o.uuid, o.deps);
			return `${head}: the watch hit its ${formatDuration(o.timeoutMs)} limit without the run's verdict.${note ? ` ${note}` : ""}${output}`;
		}
		case "exit": {
			const status = statusForWatchExit(ending.code);
			if (status === "done") return `${head}: the run PASSED (after ${elapsed}).${output}`;
			if (status === "failed") return `${head}: the run FAILED (after ${elapsed}). Start with explain_failure on it.${output}`;
			const note = await runStateNote(o.uuid, o.deps);
			return `${head}: \`hive watch\` ended (exit ${ending.code ?? "?"}) without the run's verdict.${note ? ` ${note}` : " Check it with get_run."}${output}`;
		}
	}
}

export function cancelBackgroundJob(args: Record<string, unknown>, jobs: BackgroundJobs): ToolResult {
	const id = str(args.id);
	if (!id) return { text: "`id` is required: the job id its start announced.", isError: true };
	if (!jobs.cancel(id)) return { text: `No running hive-pi background job \`${id}\` — it has finished already, or the id is wrong.`, isError: true };
	return { text: `Cancelling background job \`${id}\`. Its one completion notice says how it ended — cancelled, unless it had already finished.` };
}
