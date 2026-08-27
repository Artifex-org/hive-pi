/**
 * Failure distillation — compact, structured retry notes (HIV-1232).
 *
 * The measured result this ports (arXiv 2604.16529, "Parallel-Distill-Refine"):
 * conditioning a re-attempt on a DISTILLED summary of the prior failure beats
 * both raw-log conditioning and starting fresh — full trajectories are too
 * long to compare, but a compact note of what was tried and how it failed
 * carries the signal. The paper uses a model to distill; this is the
 * mechanical version — extraction, not summarization — because it runs on
 * every failure and must cost nothing.
 *
 * Consumers: the subagent tool appends a note to failed delegations (the
 * orchestrator writes retry prompts from tool results, so the note lands
 * exactly where the next attempt is authored), and the conductor's verify
 * stage keeps the previous note to show red-vs-red drift ("the failure
 * changed" is progress; "identical failure" means change approach).
 */

const MAX_NOTE_CHARS = 1200;
const MAX_KEY_LINES = 8;
const TAIL_CHARS = 400;

const ERROR_LINE = /\b(error|fail(ed|ure)?|exception|traceback|panic|assert(ion)?|refused|denied|timed?\s?out|cannot|unable)\b/i;

export interface FailureInput {
	/** What was being attempted — a task or a command. First line is kept. */
	attempted: string;
	/** Raw failure output: stderr, check output, or an error message. */
	output: string;
	timedOut?: boolean;
	/** Worker stop reason, when one exists (`error`, `aborted`). */
	stopReason?: string;
}

function classify(input: FailureInput): string {
	if (input.timedOut) return "timeout";
	if (input.stopReason === "aborted") return "aborted";
	const out = input.output;
	if (/\b\d+ (test|spec)s? (failed|failing)\b/i.test(out) || /\bFAILED\b/.test(out)) return "test-failure";
	if (/\b(lint|eslint|ruff|biome|tsc|type-?check)\b/i.test(out)) return "check-failure";
	return input.stopReason === "error" ? "worker-error" : "failure";
}

/**
 * Extract a ≤~300-token note from a failure. Pure string work — key lines are
 * the ones that look like errors, deduplicated, oldest first; the tail is kept
 * because the final lines of a check usually carry the summary counts.
 */
export function distillFailure(input: FailureInput): string {
	const attempted = input.attempted.trim().split("\n")[0].slice(0, 160);
	const output = input.output.trim();

	const seen = new Set<string>();
	const keyLines: string[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || !ERROR_LINE.test(trimmed)) continue;
		const collapsed = trimmed.slice(0, 160);
		if (seen.has(collapsed)) continue;
		seen.add(collapsed);
		keyLines.push(collapsed);
		if (keyLines.length >= MAX_KEY_LINES) break;
	}

	const parts = [`attempted: ${attempted}`, `class: ${classify(input)}`];
	if (keyLines.length > 0) parts.push(`key lines:\n${keyLines.map((line) => `  ${line}`).join("\n")}`);
	const tail = output.slice(-TAIL_CHARS).trim();
	if (tail && keyLines.length === 0) parts.push(`output tail:\n  ${tail.split("\n").join("\n  ")}`);

	return parts.join("\n").slice(0, MAX_NOTE_CHARS);
}

/**
 * The red-vs-red comparison line for a repeated failure. Same note → the
 * strongest available signal that the last fix attempt changed nothing.
 */
export function compareFailures(previous: string, current: string): string {
	return previous === current
		? "This failure is IDENTICAL to the previous attempt — the last fix changed nothing observable. Change approach rather than retrying it."
		: `Previous attempt (distilled, for comparison — if the failure moved, you are making progress):\n${previous}`;
}
