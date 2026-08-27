/**
 * The rules for backgrounding a delegation, kept pure so they can be tested
 * without spawning a worker.
 *
 * A refusal here is worth more than it looks. The whole point of backgrounding
 * is that the caller stops paying attention, so a mistake made at start time is
 * discovered — at best — when a notification arrives much later saying nothing
 * happened. Every condition that can be checked before the worker exists is
 * checked before the worker exists.
 */

import { formatDuration, type Job, type JobStatus } from "../background/jobs.ts";

/** Modes where a completion notification has somewhere to land. */
const DELIVERABLE_MODES = new Set(["tui", "rpc"]);

export interface BackgroundRequest {
	background?: boolean;
	what?: string;
	agent?: string;
	task?: string;
	tasks?: unknown[];
	chain?: unknown[];
}

/**
 * Why this delegation may not be backgrounded, or null.
 *
 * Each message names the remedy rather than only the rule, because the reader
 * is a model deciding what to do next and "not supported" leaves it guessing
 * between dropping the work and retrying the same call.
 */
export function backgroundRefusal(request: BackgroundRequest, mode: string): string | null {
	if (!DELIVERABLE_MODES.has(mode)) {
		return (
			`Background delegation is not available in ${mode} mode: this session ends or is replaced when the ` +
			"turn settles, so the completion notification would have nowhere to land. Run it in the foreground " +
			"instead — drop `background: true`."
		);
	}
	if ((request.chain?.length ?? 0) > 0) {
		return (
			"Background delegation is single mode only. A chain feeds each step's output into the next through " +
			"`{previous}`, so there is no point at which a partial result would mean anything to you. Run the " +
			"chain in the foreground, or background only its longest step."
		);
	}
	if ((request.tasks?.length ?? 0) > 0) {
		return (
			"Background delegation is single mode only. Parallel mode already runs its tasks concurrently inside " +
			"one call, so backgrounding it would just move where the waiting happens. Use one background " +
			"delegation per task if you want to walk away from them."
		);
	}
	if (!request.agent || !request.task) {
		return "Background delegation needs both `agent` and `task` (single mode).";
	}
	if (!request.what?.trim()) {
		return (
			"Background delegation needs `what`: one short line saying what this subagent is doing, e.g. " +
			"'auditing the migration for data loss'. It is what the person watching sees instead of a silent " +
			"tool call, and what you will see in `background_list` later."
		);
	}
	return null;
}

/**
 * The tool result for a delegation that has just been sent to the background.
 *
 * It tells the model three things in order of what it will get wrong without
 * them: the work is NOT done, it will be told when it is, and it should not
 * sit in a polling loop waiting. The last one matters most — a model that
 * backgrounds a job and then immediately polls for it in a loop has spent more
 * than it saved and produced a worse transcript than simply waiting.
 */
export function backgroundStartedMessage(id: string, what: string, agent: string): string {
	return [
		`Started background delegation \`${id}\`: ${agent} — ${what}`,
		"",
		"It is running now and you will be told when it finishes. Do NOT poll for it: carry on with " +
			"something else, and deal with the result when it arrives.",
		`\`background_list\` shows it; \`background_cancel\` with id \`${id}\` stops it.`,
	].join("\n");
}

/**
 * What a finished delegation reports back through the background registry.
 *
 * A subagent's own result is far too big to volunteer — the parallel path caps
 * model-visible output at 50KB per task — so this is the summary and the
 * registry keeps the rest for `background_result`.
 */
export function delegationOutcome(result: {
	exitCode: number;
	stderr: string;
	output: string;
}): { status: Exclude<JobStatus, "running">; exitCode: number } {
	return { status: result.exitCode === 0 ? "done" : "failed", exitCode: result.exitCode };
}

/** One line for a subagent job in `background_list`, used by the renderer. */
export function describeDelegation(job: Job, nowMs: number): string {
	return `${job.id} ${job.detail} — ${formatDuration((job.endedAtMs ?? nowMs) - job.startedAtMs)}`;
}
