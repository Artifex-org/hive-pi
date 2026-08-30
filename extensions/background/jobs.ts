/**
 * Background jobs — the pure fold.
 *
 * Everything that decides *what a job is*, *what it says when it finishes* and
 * *how much of it reaches the model* lives here, with no process, no timer and
 * no `pi`. `index.ts` owns the spawning and the delivery; this owns the rules.
 *
 * ## The rule that shapes the whole file
 *
 * A completion notification is **injected into context unconditionally**. The
 * model did not ask for it and cannot decline it, which makes it the most
 * expensive text in this extension per byte. So the notification is a capped
 * summary and the full output stays behind `background_result` — a pull the
 * model makes only when the summary is not enough.
 *
 * That asymmetry is why `OUTPUT_CAP_BYTES` (what we retain) and
 * `NOTIFY_TAIL_BYTES` (what we volunteer) are two different numbers two orders
 * of magnitude apart, rather than one shared constant.
 *
 * ## Tail, not head
 *
 * Retention keeps the END of the stream. A build that fails prints its error
 * last; a test runner prints its summary last. Keeping the head would reliably
 * discard the only part anybody wants, and "the first 64KB of a 900KB log" is
 * an expensive way to say nothing.
 *
 * Nothing mutable at module scope: pi builds a fresh jiti instance per
 * extension with `moduleCache: false`, so two importers get two module
 * instances and shared state here would silently never sync.
 */

/**
 * A job's terminal states are distinguished because they call for different
 * reactions, and collapsing them into a boolean would erase the distinction
 * exactly where the model needs it. `failed` is the command's own verdict and
 * is usually about the code. `timeout` and `canceled` say nothing about the
 * code at all — one is our limit, the other is a human — and treating either as
 * a test failure sends the model debugging a phantom.
 */
export type JobStatus = "running" | "done" | "failed" | "timeout" | "canceled";

/**
 * `watch` is a bash job by mechanism and a different thing by intent: it holds
 * a stream open rather than doing work, and its exit code is a REMOTE verdict
 * (the Hive run's) rather than a local command's. Worth its own name so the
 * list view and the completion message can say "the run failed" instead of
 * "the command failed", which are not the same claim.
 */
export type JobKind = "bash" | "subagent" | "watch";

export interface Job {
	id: string;
	/**
	 * The one-line human explanation, REQUIRED at the call site.
	 *
	 * This is the narration half of the feature and the reason it is a schema
	 * field rather than a nudge: a required parameter cannot decay over a long
	 * session the way a system-prompt instruction measurably does (see
	 * `narrate/README.md` — 18.6 tool calls per prose message in pi workstation
	 * sessions against Claude Code's 3.4). Claude Code's Bash `description` is
	 * the same trick.
	 */
	what: string;
	kind: JobKind;
	/** The command, or `role: task` — what actually ran, for the list view. */
	detail: string;
	status: JobStatus;
	startedAtMs: number;
	endedAtMs?: number;
	exitCode?: number;
	/** Retained output, already capped to the last OUTPUT_CAP_BYTES. */
	output: string;
	/** Bytes dropped from the FRONT by capping. Reported, never silent. */
	droppedBytes: number;
	/** Set once the completion notification has been delivered. */
	notified: boolean;
	/**
	 * Where the job ran.
	 *
	 * Kept so a CANCEL can look for what the kill may have stranded — a git
	 * `index.lock` lives in the repo the job was working in, not in the session's
	 * cwd, and by the time anyone asks the process is gone.
	 */
	cwd?: string;
	/**
	 * The Hive run a `watch` job is following.
	 *
	 * Kept so a TIMEOUT can say what the run was doing when the clock ran out —
	 * "never started" and "started and stuck" want opposite responses, and the
	 * log tail cannot tell them apart.
	 */
	runID?: string;
}

/**
 * How much output we retain per job, in memory, for `background_result`.
 *
 * 256KB is roughly a verbose test run. Above this the tail is kept and the
 * front is dropped with a count, because a job that produces megabytes is one
 * whose interesting part is at the end, and holding all of it would let a
 * single runaway `yes` exhaust the session's heap.
 */
export const OUTPUT_CAP_BYTES = 256 * 1024;

/**
 * How much output the completion notification volunteers unasked.
 *
 * Deliberately small. 2KB is enough to carry a stack trace or a test summary —
 * the cases where the model should act immediately — and not enough to matter
 * if it is noise. Everything else is one `background_result` call away.
 */
export const NOTIFY_TAIL_BYTES = 2 * 1024;

/** Default wall-clock limit for a background job. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Hard ceiling on a caller-supplied timeout. */
export const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Concurrent running jobs.
 *
 * A cap exists because each job is a real process and the failure mode of not
 * having one is a fork bomb written by an agent that thought it was being
 * efficient. Eight matches the parallel-subagent cap already in this house.
 */
export const MAX_CONCURRENT = 8;

export function createJob(input: {
	id: string;
	what: string;
	kind: JobKind;
	detail: string;
	startedAtMs: number;
	cwd?: string;
	runID?: string;
}): Job {
	return {
		id: input.id,
		what: input.what,
		kind: input.kind,
		detail: input.detail,
		status: "running",
		startedAtMs: input.startedAtMs,
		output: "",
		droppedBytes: 0,
		notified: false,
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.runID ? { runID: input.runID } : {}),
	};
}

/**
 * Append a chunk, keeping the tail within the cap.
 *
 * Returns a NEW job rather than mutating, so a caller cannot accidentally share
 * a record between the registry and a rendered view.
 */
export function appendOutput(job: Job, chunk: string, capBytes: number = OUTPUT_CAP_BYTES): Job {
	if (!chunk) return job;
	const combined = job.output + chunk;
	if (combined.length <= capBytes) return { ...job, output: combined };
	const kept = combined.slice(combined.length - capBytes);
	return {
		...job,
		output: kept,
		droppedBytes: job.droppedBytes + (combined.length - capBytes),
	};
}

/**
 * Move a job to a terminal state.
 *
 * A job that already finished is returned unchanged. That is not defensive
 * padding: a process can emit `close` after a kill we initiated, and without
 * this the `canceled` a human asked for would be overwritten by the
 * `failed`/exit-code-143 that our own kill produced — reporting the user's
 * deliberate stop as a crash.
 */
export function finishJob(
	job: Job,
	outcome: { status: Exclude<JobStatus, "running">; exitCode?: number; endedAtMs: number },
): Job {
	if (job.status !== "running") return job;
	return { ...job, status: outcome.status, exitCode: outcome.exitCode, endedAtMs: outcome.endedAtMs };
}

/** Exit code to terminal status. Zero is the only success. */
export function statusForExit(code: number | null): Exclude<JobStatus, "running" | "canceled" | "timeout"> {
	return code === 0 ? "done" : "failed";
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function elapsedMs(job: Job, nowMs: number): number {
	return (job.endedAtMs ?? nowMs) - job.startedAtMs;
}

const STATUS_ICON: Record<JobStatus, string> = {
	running: "⏳",
	done: "✓",
	failed: "✗",
	timeout: "⏱",
	canceled: "⊘",
};

/** The tail of a job's output, for the notification. */
export function outputTail(job: Job, maxBytes: number = NOTIFY_TAIL_BYTES): string {
	const trimmed = job.output.trimEnd();
	if (trimmed.length <= maxBytes) return trimmed;
	return `…\n${trimmed.slice(trimmed.length - maxBytes)}`;
}

/**
 * The text delivered into the session when a job finishes.
 *
 * Written as a report to a colleague who has been doing something else for the
 * last four minutes, because that is exactly the situation. It leads with the
 * outcome, names the job so a second notification cannot be confused with this
 * one, and ends by saying where the rest is — a model that is told the summary
 * is partial will ask for the remainder, and one that is not told assumes it
 * has everything.
 */
export function notificationFor(job: Job, nowMs: number, tailBytes: number = NOTIFY_TAIL_BYTES): string {
	const took = formatDuration(elapsedMs(job, nowMs));
	const head = `${STATUS_ICON[job.status]} background job \`${job.id}\` (${job.what}) ${verbFor(job)} after ${took}.`;
	const lines = [head, "", `\`\`\`\n${job.detail}\n\`\`\``];

	const tail = outputTail(job, tailBytes);
	if (tail) {
		const truncated = tail.length < job.output.trimEnd().length || job.droppedBytes > 0;
		lines.push("", truncated ? "Output (tail):" : "Output:", "```", tail, "```");
		if (truncated) {
			lines.push("", `Truncated — call \`background_result\` with id \`${job.id}\` for the full output.`);
		}
	} else {
		lines.push("", "It produced no output.");
	}

	// Only when there is something to decide. A successful job that already
	// showed its output does not need to be told what to do next, and a line of
	// advice on every completion is how a channel becomes noise the model skips.
	if (job.status !== "done") {
		lines.push(
			"",
			"This ran in the background while you worked on something else. Fold it into what you are doing " +
				"now — finish the current thought first if you are mid-task, then deal with this.",
		);
	}
	return lines.join("\n");
}

function verbFor(job: Job): string {
	switch (job.status) {
		case "done":
			return "finished";
		case "failed":
			return `failed (exit ${job.exitCode ?? "?"})`;
		case "timeout":
			return "was stopped at its time limit";
		case "canceled":
			return "was canceled";
		default:
			return "is still running";
	}
}

/** One line per job, for `background_list`. */
export function renderList(jobs: readonly Job[], nowMs: number): string {
	if (jobs.length === 0) return "No background jobs.";
	const rows = jobs.map((job) => {
		const took = formatDuration(elapsedMs(job, nowMs));
		const exit = job.status === "failed" ? ` exit ${job.exitCode ?? "?"}` : "";
		return `${STATUS_ICON[job.status]} ${job.id}  ${job.status}${exit}  ${took}  ${job.what}`;
	});
	return rows.join("\n");
}

/**
 * The footer segment: a running count, or nothing at all.
 *
 * This is the "periodically check" half, and it is deliberately the CHEAPEST
 * possible form of it. The footer is chrome — it costs no context tokens and
 * the model never sees it, so it can be updated as often as we like without
 * spending anything. What the model sees is a completion message, once.
 *
 * The rejected alternative was a timer that injects a status line. That is
 * banned by the doctrine in `agenda/loop.ts` ("the timer NEVER injects"), and
 * for a good reason: a periodic injection bills a turn every time it fires,
 * whether or not anything changed.
 */
export function footerSegment(jobs: readonly Job[]): string | null {
	const running = jobs.filter((job) => job.status === "running").length;
	if (running === 0) return null;
	return running === 1 ? "1 bg job" : `${running} bg jobs`;
}

/**
 * Jobs finished but not yet announced.
 *
 * Delivery is driven off this rather than off the process callback directly, so
 * that "finished" and "announced" stay separate facts. A notification that
 * throws (a session that went away mid-flight) leaves the job unannounced and
 * retryable, rather than silently consumed.
 */
export function pendingNotifications(jobs: readonly Job[]): Job[] {
	return jobs.filter((job) => job.status !== "running" && !job.notified);
}

/**
 * A short, stable, human-typeable id.
 *
 * Not a UUID: the model has to pass this back in a later tool call, and it
 * appears in prose the human reads. `bg-3` is legible in both places; a v7 UUID
 * is a transcription hazard in one and noise in the other. Uniqueness only has
 * to hold within one session's registry, which a monotonic counter gives.
 */
export function nextJobId(existing: readonly Job[]): string {
	let highest = 0;
	for (const job of existing) {
		const match = /^bg-(\d+)$/.exec(job.id);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return `bg-${highest + 1}`;
}

/** Clamp a caller-supplied timeout into the allowed band. */
export function resolveTimeoutMs(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.round(seconds * 1000), MAX_TIMEOUT_MS);
}

/**
 * The header `background_result` puts above a job's retained output.
 *
 * It lives here, next to `parseResultHeader`, because the two are one format
 * and a format with its writer and its reader in different files drifts in
 * silence. `index.ts` used to build this string inline; a reader written
 * against that literal would have gone stale the first time somebody reworded
 * it, and the failure would have been a background reproduction quietly
 * refusing to bind rather than anything that looks like a bug.
 */
export function resultHeader(job: Job, nowMs: number): string {
	const exit = job.exitCode === undefined ? "" : ` (exit ${job.exitCode})`;
	return (
		`${job.id} — ${job.what}\n` +
		`status ${job.status}${exit}, ${formatDuration(elapsedMs(job, nowMs))}\n` +
		`command: ${job.detail}`
	);
}

/**
 * Read a job's identity and verdict back out of a `background_result` payload.
 *
 * This exists for the bugfix evidence gate, which binds a phase to a tool
 * result it OBSERVED. A background job's outcome is not in the tool result's
 * `isError` flag — the pull succeeded, so the flag is false whatever the job
 * did — it is in this header. Without a reader for it, `background_result` was
 * a result the gate could see and could never accept: the agent held a genuine
 * failing gate run and got "needs an actual failing result" every time. Fifteen
 * papercuts in the week to 2026-08-30 say so, several after the refusal started
 * listing candidate ids, because listing an id that will be rejected on the
 * next line is not progress.
 *
 * It reports the STATUS, not a boolean, and the caller decides. That is the
 * distinction `JobStatus` exists to preserve: `failed` is the command's own
 * verdict, while `timeout` and `canceled` say nothing about the code at all, so
 * collapsing them here would let a killed job stand in as a reproduction and
 * send the reader debugging a phantom.
 *
 * Returns null for anything that is not this header. The caller also checks the
 * tool NAME, so a model that pastes a header-shaped string into some other
 * tool's output cannot mint evidence — the id has to come from a result the
 * background extension actually produced.
 */
export function parseResultHeader(text: string): { id: string; status: JobStatus } | null {
	const lines = text.split("\n");
	const id = /^(bg-\d+) — /.exec(lines[0] ?? "")?.[1];
	const status = /^status (running|done|failed|timeout|canceled)[ ,]/.exec(lines[1] ?? "")?.[1];
	if (!id || !status) return null;
	return { id, status: status as JobStatus };
}
