/**
 * Run a formatting plan on one file and describe what happened, for the model.
 *
 * The model needs to hear about formatting in exactly two cases, and nothing
 * else: the file CHANGED (its next edit anchor may be stale — anchor misses are
 * most edit failures, see `edit-common/diagnose.ts`), or the formatter FAILED
 * (so it does not believe a file is formatted that is not). A clean, no-op
 * format is silence.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { Plan, Step } from "./detect.ts";

/** Per step. ruff and gofmt answer in milliseconds, `vp fmt` in ~0.6 s; a minute is a hung tool. */
export const STEP_TIMEOUT_MS = 10_000;

/** A changed region this short is shown in full, so the model can anchor on it without a `read`. */
const SHOW_REGION_LINES = 20;
/** Enough of a formatter's complaint to act on; the rest is a stack trace. */
const ERROR_LINES = 8;
/** Output kept from one step — a formatter that prints megabytes is not read past this. */
const MAX_OUTPUT = 64 * 1024;

interface StepResult {
	ok: boolean;
	output: string;
	timedOut: boolean;
	code: number | null;
}

/**
 * Run one step, and on timeout end the WHOLE process tree before returning.
 *
 * `execFile`'s timeout kills the direct child only. `vp fmt` is a launcher: it
 * starts `node …/oxfmt` as a child, and that child survived the kill and
 * rewrote the file seconds AFTER the model had been told it was untouched
 * (measured on a 21 MB file with a 3 s limit: callback at 3.0 s, oxfmt alive
 * at 5.1 s, file rewritten by 9.2 s) — a lost update for whatever the model
 * edited in between. So each step leads its own process group, a timeout
 * signals the group, and this resolves only once the leader has gone.
 */
function runStep(step: Step, timeoutMs: number): Promise<StepResult> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		let settled = false;
		const done = (result: StepResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(step.command, step.args, { cwd: step.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, output: (error as Error).message, timedOut: false, code: null });
			return;
		}
		const collect = (chunk: Buffer) => {
			if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				/* the group is already gone */
			}
			// A grandchild that left the group can hold the pipes open; the
			// leader's exit is what this waits for, so let go of them.
			child.stdout?.destroy();
			child.stderr?.destroy();
		}, timeoutMs);
		child.on("error", (error) => done({ ok: false, output: error.message, timedOut: false, code: null }));
		// `close`, not `exit`: it fires once the output is fully read. On a
		// timeout the pipes were destroyed above, so it cannot wait on them.
		child.on("close", (code) =>
			done({ ok: code === 0 && !timedOut, output: output.trim(), timedOut, code: typeof code === "number" ? code : null }),
		);
	});
}

/**
 * The lines that differ between `before` and `after`, as a 1-based range in
 * `after`. Common prefix and suffix are trimmed — formatting changes are
 * usually local, and when they are not, the range says "most of the file",
 * which is the right thing to hear.
 */
export function changedRegion(before: string, after: string): { start: number; end: number; lines: string[] } | null {
	if (before === after) return null;
	const a = before.split("\n");
	const b = after.split("\n");
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const lines = b.slice(prefix, b.length - suffix);
	// A pure deletion leaves no lines in `after`; point at where they were.
	const start = prefix + 1;
	return { start, end: Math.max(start, prefix + lines.length), lines };
}

function firstLines(text: string, count: number): string {
	const lines = text.split("\n");
	return lines.length <= count ? text : `${lines.slice(0, count).join("\n")}\n… (${lines.length - count} more lines)`;
}

export interface FormatOutcome {
	/** Text to append to the tool result; null when the model needs to hear nothing. */
	note: string | null;
}

/**
 * Format `file` with `plan` and say what the model must know.
 *
 * `before` is read HERE, after the edit landed, not taken from the edit's own
 * input: the file on disk is the only thing the formatter and the next edit
 * both see.
 */
export async function formatFile(file: string, plan: Extract<Plan, { kind: "format" }>, timeoutMs = STEP_TIMEOUT_MS): Promise<FormatOutcome> {
	let before: string;
	try {
		before = await readFile(file, "utf8");
	} catch {
		// The edit reported success but the file is not readable now (deleted
		// by a concurrent step, a write to a path that is not a regular file).
		// Nothing was formatted, and there is nothing true to add.
		return { note: null };
	}

	const labels = plan.steps.map((step) => `\`${step.label}\``).join(" + ");
	for (const step of plan.steps) {
		const result = await runStep(step, timeoutMs);
		if (!result.ok) {
			const after = await readFile(file, "utf8").catch(() => before);
			const why = result.timedOut
				? `did not finish within ${Math.round(timeoutMs / 1000)}s and was killed`
				: `failed${result.code !== null ? ` (exit ${result.code})` : ""}:\n${firstLines(result.output, ERROR_LINES)}`;
			const state =
				after === before
					? "The file is as your edit left it — not formatted."
					: "It changed the file before failing — re-read it before the next edit.";
			return { note: `[format-on-edit] \`${step.label}\` ${why}\n${state}` };
		}
	}

	let after: string;
	try {
		after = await readFile(file, "utf8");
	} catch {
		return { note: `[format-on-edit] ${labels} ran, but the file could not be read back afterwards.` };
	}
	const region = changedRegion(before, after);
	if (!region) return { note: null };
	const where = region.start === region.end ? `line ${region.start}` : `lines ${region.start}–${region.end}`;
	const head =
		`[format-on-edit] ${labels} reformatted this file: ${where} changed after your edit was written. ` +
		"Anchor your next edit on the formatted text, not on what you sent.";
	if (region.lines.length === 0 || region.lines.length > SHOW_REGION_LINES) {
		return { note: `${head} Re-read ${where} before editing them again.` };
	}
	const width = String(region.end).length;
	const shown = region.lines.map((line, index) => `${String(region.start + index).padStart(width)}  ${line}`).join("\n");
	return { note: `${head} They now read:\n${shown}` };
}
