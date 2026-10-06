/**
 * agent-check — a repo's ONE verification command for agents (HIV-3818).
 *
 * PURE half: where it lives, how to read its verdict, and how to say it. The
 * spawning is index.ts's `streamGate`, shared with the vendored gate.
 *
 * Why a repo would declare one, and why `quality_gate` prefers it. The
 * vendored gate's `quick` mode is lint only. That is the right default for a
 * tool meant to run constantly, and the wrong answer to the question an agent
 * actually asks before saying "done": does this change pass what CI will run?
 * In pyERP that is lint + type-checking the touched TypeScript packages + the
 * tests CI selects for the diff + whatever dependency/env bootstrap makes
 * those runnable in a fresh worktree. The repo knows that recipe; this tool
 * does not and should not. So a repo that declares `scripts/agent-check` owns
 * the recipe, and this module only has to read its verdict honestly.
 *
 * The contract this reads, and nothing more:
 *
 *   - executable `scripts/agent-check`, found from the gated directory upwards;
 *   - exit 0 only if every step that ran passed;
 *   - FINAL line: `AGENT-CHECK: PASS|FAIL ran=<steps> failed=<steps> skipped=<steps>`
 *     (comma-separated step names, `-` for none; `ran` includes the failed ones);
 *   - a skipped step is NOT RUN, never passed;
 *   - `--no-tests` / `--no-install` flags.
 *
 * Everything else a script prints is diagnostics for the model. Reading
 * per-step lines a particular implementation happens to print would turn its
 * formatting into an interface it never agreed to.
 */

import { tail } from "./gate.ts";
import type { GateProgress } from "./stream.ts";

/** Where a repo declares its agent check, relative to each searched directory. */
export const AGENT_CHECK_PATH = "scripts/agent-check";

export interface AgentCheckSummary {
	verdict: "PASS" | "FAIL";
	ran: string[];
	failed: string[];
	skipped: string[];
}

const SUMMARY = /^AGENT-CHECK: (PASS|FAIL) ran=(\S+) failed=(\S+) skipped=(\S+)\s*$/;

function names(field: string): string[] {
	return field === "-" ? [] : field.split(",").filter(Boolean);
}

/**
 * The summary, read from the FINAL non-empty line only.
 *
 * Only the final line, because that is the contract — and because a script
 * that crashed after echoing a summary-shaped line from a sub-command (or
 * printed its own usage text, which quotes the format) has not reached a
 * verdict. Searching upwards for "the last line that looks right" would
 * report one anyway.
 */
export function parseSummary(stdout: string): AgentCheckSummary | null {
	const lines = stdout.replace(/\s+$/, "").split("\n");
	const match = SUMMARY.exec((lines[lines.length - 1] ?? "").replace(/\r$/, ""));
	if (!match) return null;
	const ran = names(match[2]);
	const failed = names(match[3]);
	// A step named in `failed=` FAILED, whether or not `ran=` repeats it. The
	// contract says ran includes failed, but a script that forgets (pyERP's
	// unresolvable-merge-base exit prints `ran=- failed=scope`) has still said
	// plainly that something failed — refusing that as "no verdict" would bury
	// an explicit failure. So a failed step is counted as run, never dropped.
	for (const step of failed) if (!ran.includes(step)) ran.push(step);
	return { verdict: match[1] as "PASS" | "FAIL", ran, failed, skipped: names(match[4]) };
}

/**
 * The output the model reads: everything, minus the summary line itself
 * (its content is rendered above, in words). Removed by its LAST occurrence
 * in the combined stream — stdout and stderr interleave there, so it is not
 * necessarily the final line of it.
 */
export function withoutSummary(output: string): string {
	const lines = output.replace(/\s+$/, "").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (SUMMARY.test(lines[i].replace(/\r$/, ""))) return [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
	}
	return output.trim();
}

/**
 * Where the summary disagrees with itself or with the exit code.
 *
 * Each of these is a script that broke its own contract, and a broken
 * contract is not a verdict: reading PASS from a run that exited 1, or from
 * one whose `failed=` names a step, would be choosing the convenient half of
 * a contradiction.
 */
export function contradiction(summary: AgentCheckSummary, exitCode: number | null): string | null {
	if (summary.verdict === "PASS" && summary.failed.length > 0) {
		return `it says PASS but names failed steps (${summary.failed.join(", ")})`;
	}
	if (summary.verdict === "FAIL" && summary.failed.length === 0) return "it says FAIL but names no failed step";
	if (summary.verdict === "PASS" && exitCode !== 0) return `it says PASS but exited ${exitCode}`;
	if (summary.verdict === "FAIL" && exitCode === 0) return "it says FAIL but exited 0";
	const both = summary.skipped.filter((step) => summary.ran.includes(step));
	if (both.length > 0) return `steps listed as both run and skipped (${both.join(", ")})`;
	return null;
}

/** Fold the verdict into the gate widget's spec — one row per step. */
export function foldSummary(
	progress: GateProgress,
	summary: AgentCheckSummary | null,
	run: { exitCode: number | null; signal?: string | null; elapsedMs?: number },
): GateProgress {
	const { exitCode } = run;
	progress.running = [];
	progress.duration_ms = run.elapsedMs;
	if (typeof exitCode === "number") progress.exit_code = exitCode;
	// A killed run made no verdict, even if it printed a summary before it hung
	// in cleanup — the text says NO VERDICT, and the card must not say FAIL.
	if (run.signal || exitCode === null || !summary || contradiction(summary, exitCode)) {
		progress.status = "nosummary";
		return progress;
	}
	const failed = new Set(summary.failed);
	progress.checks = [
		...summary.ran.map((name) => ({ name, outcome: failed.has(name) ? ("failed" as const) : ("passed" as const) })),
		// `advisory` is the widget's only outcome for "made no verdict"; the
		// `missing_tools` list below is where "not run" is said in words.
		...summary.skipped.map((name) => ({ name, outcome: "advisory" as const, message: "not run" })),
	];
	progress.total = progress.checks.length;
	progress.done = progress.checks.length;
	progress.failures = summary.failed;
	progress.advisories = [];
	progress.missing_tools = summary.skipped.map((tool) => ({ tool, reason: "not run" }));
	// A PASS in which nothing ran is not a pass — the same rule the vendored
	// path applies to a zero-check trailer.
	progress.status = summary.verdict === "FAIL" ? "fail" : summary.ran.length === 0 ? "nosummary" : "pass";
	return progress;
}

export interface VerifyRenderOptions {
	command: string;
	exitCode: number | null;
	signal?: string | null;
	elapsedMs?: number;
	ceilingMs?: number;
	maxLines: number;
	/** Verify-mode knobs that do not apply and were ignored, named once. */
	ignored?: string[];
}

/** What the model reads. */
export function renderVerify(run: { output: string; stdout: string }, opts: VerifyRenderOptions): string {
	// The verdict comes from STDOUT's final line. In the combined stream a late
	// stderr chunk (a lingering child, unbuffered stderr behind buffered
	// stdout) can land after it, and that would refuse a script that kept the
	// contract.
	const summary = parseSummary(run.stdout);
	const text = withoutSummary(run.output);
	const secs = opts.elapsedMs !== undefined ? ` in ${(opts.elapsedMs / 1000).toFixed(1)}s` : "";
	const out: string[] = [];
	const note = opts.ignored?.length
		? `note: ${opts.ignored.join(", ")} ${opts.ignored.length === 1 ? "does" : "do"} not apply to the repo's agent check and ${opts.ignored.length === 1 ? "was" : "were"} ignored — pass mode "quick" (or "standard"/"thorough") for the vendored gate's knobs.`
		: "";
	const finish = (withOutput: boolean) => {
		if (note) out.push(note);
		if (withOutput && text) out.push("", tail(text, opts.maxLines));
		return out.join("\n");
	};

	// Killed: no verdict, whatever the output says so far.
	if (opts.signal || opts.exitCode === null) {
		const how = opts.signal ? ` (${opts.signal})` : "";
		out.push(`NO VERDICT — \`${opts.command}\` was terminated${how}${secs}, before it finished. Nothing was verified.`);
		if (opts.ceilingMs !== undefined) {
			out.push(
				`That was this tool's own ${(opts.ceilingMs / 1000).toFixed(0)}s ceiling. Run it with \`tests:false\` for the ` +
					`fast steps, or run \`${opts.command}\` directly and let it take as long as it takes.`,
			);
		}
		return finish(true);
	}

	if (!summary) {
		// The contract's final line is missing: the script crashed, was killed by
		// something it did not report, or is not an agent check. Its exit code
		// alone cannot say WHICH steps were verified, so this is not a FAIL list
		// and certainly not a pass.
		out.push(
			`NO VERDICT — \`${opts.command}\` exited ${opts.exitCode}${secs} without its \`AGENT-CHECK:\` summary line, ` +
				"so which steps ran and passed is unknown. Nothing here is a verdict; read its output below.",
		);
		return finish(true);
	}

	const broken = contradiction(summary, opts.exitCode);
	if (broken) {
		out.push(
			`NO VERDICT — \`${opts.command}\` contradicted its own contract: ${broken}. ` +
				"Neither half can be trusted; read its output below.",
		);
		return finish(true);
	}

	const notRun = summary.skipped.length
		? `not run: ${summary.skipped.join(", ")} — these steps made no claim about this code; the reason is in the output`
		: "";

	if (summary.verdict === "PASS" && summary.ran.length === 0) {
		out.push(`NOTHING CHECKED — \`${opts.command}\` ran no step${secs}. This is NOT a pass: nothing was verified.`);
		if (notRun) out.push(notRun);
		return finish(true);
	}

	if (summary.verdict === "PASS") {
		out.push(`PASS — ${summary.ran.length} step(s)${secs}: ${summary.ran.join(", ")}`);
		if (notRun) out.push(notRun);
		// The output matters on a pass only when something did not run: that is
		// where the reason lives, and the reason decides whether it matters.
		return finish(summary.skipped.length > 0);
	}

	out.push(`FAIL — ${summary.failed.length} of ${summary.ran.length} step(s)${secs}`);
	out.push(`failed: ${summary.failed.join(", ")}`);
	const passed = summary.ran.filter((step) => !summary.failed.includes(step));
	if (passed.length) out.push(`passed: ${passed.join(", ")}`);
	if (notRun) out.push(notRun);
	return finish(true);
}

/** argv for a verify request. */
export function agentCheckArgs(o: { tests?: boolean; install?: boolean }): string[] {
	const args: string[] = [];
	if (o.tests === false) args.push("--no-tests");
	if (o.install === false) args.push("--no-install");
	return args;
}
