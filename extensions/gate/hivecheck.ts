/**
 * hivecheck — the gate widget for repos whose gate is a Hive pipeline.
 *
 * PURE half: the CLI argv, the run reference the CLI prints, and the fold from
 * Hive's own run/task/substep JSON into the SAME `GateProgress` the vendored
 * quality-gate path produces. The spawning and the polling live in index.ts so
 * all of this is testable without a shell or a server.
 *
 * ## Why this exists
 *
 * `quality_gate` discovers a VENDORED gate and streams its `##hive:substep`
 * markers into a live widget. A Hive-gated repo has no such script: the gate is
 * `hive check --step <name>`, which the agent ran through bash — a call that
 * reports nothing at all for up to twenty minutes, on the one path a sandboxed
 * agent has (its netns cannot reach a host Postgres, so `hive check` is its only
 * DB-backed verification). The tool that told it to shell out is the tool that
 * should have shown it the checks.
 *
 * ## Why the API rather than the CLI's own output
 *
 * `hive check` prints a human progress stream, and parsing it would be reading a
 * rendering. The server already publishes the structured facts — tasks with
 * states, and per-check substeps ingested ~1/s WHILE the step runs (the same
 * `##hive:substep` protocol, one layer further out) — so the CLI is used for the
 * one thing only it can do (pack and upload the working tree) and the run is
 * then followed over `/runs/{id}` and `/runs/{id}/substeps`.
 *
 * ## Two levels, one spec
 *
 * A Hive run has STEPS (lint, test-1, web-check) and a step may report CHECKS
 * (ruff, basedpyright, …). The meter counts steps, because that is the
 * denominator the run plan actually knows; the rows are checks where a step
 * reported them and the step itself where it did not. `group` carries which step
 * a row came from — optional in the widget contract, so an older hive renders
 * these rows unchanged.
 */

import type { GateCheckProgress, GateProgress } from "./stream.ts";

/** Step run when the caller named none. Lint is the fast, always-relevant one. */
export const DEFAULT_STEPS = ["lint"];

/** Hive task states that mean "no longer going to change". */
const TERMINAL_TASK = new Set(["succeeded", "failed", "timed_out", "canceled", "skipped", "error"]);
/** Hive task states that mean "on a node right now". */
const ACTIVE_TASK = new Set(["running", "dispatched"]);
/** Run states that mean the run is over. */
const TERMINAL_RUN = new Set(["succeeded", "failed", "canceled", "error", "timed_out"]);

export function isTerminalRun(state: string): boolean {
	return TERMINAL_RUN.has(state);
}

/**
 * Argv for the check.
 *
 * `--no-wait` deliberately: the CLI's wait loop and ours would be two consumers
 * of the same run, and only one of them can own the abort. It packs and uploads
 * the snapshot, prints the run reference, and gets out of the way.
 */
export function hiveCheckArgs(steps: string[]): string[] {
	return ["check", "--step", steps.join(","), "--no-wait"];
}

/**
 * The steps a request asks for.
 *
 * `only` is the vendored gate's "run just these checks" parameter and it means
 * the same thing here one level out — the step names. An unknown one is NOT
 * rejected locally: the server answers with the pipeline's actual step list,
 * which is a far better error than anything this file could guess.
 */
export function stepsFrom(only: string | undefined): string[] {
	return namedSteps(only) ?? DEFAULT_STEPS;
}

/** The steps the CALLER named, or null when it named none and got the default. */
export function namedSteps(only: string | undefined): string[] | null {
	const named = (only ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return named.length > 0 ? named : null;
}

/**
 * The steps this run's plan DOES have, when the server rejected a step it has
 * never heard of.
 *
 * The third rejection shape, and the one that had no answer. `prunedStepSurvivors`
 * handles a step the pipeline DECLARES and this diff pruned ("…PRUNED it…Steps
 * that DID survive:"). A misspelling is deliberately left alone. This is
 * neither: the step is simply not in the repo's pipeline, and the server says
 *
 *     step "lint" is not in this run's plan. Steps in this plan: config-check, test, typecheck
 *
 * `DEFAULT_STEPS` is `["lint"]` — Hive's and Aurora's fast static check. hive-pi
 * has no `lint` step at all (`typecheck`, `test`, `config-check`), so EVERY
 * `quality_gate` call there that named no `only` asked for a step that cannot
 * exist and came back `NO VERDICT` (measured 2026-08-19 01:52). Not an unlucky
 * diff, the way a prune is — a permanent property of the repo.
 *
 * Returns null when the message carries a "Did you mean" — that is the server's
 * own evidence of a TYPO, and the one case that must keep the verbatim refusal.
 * Callers must additionally only act on this when the step was DEFAULTED: a name
 * the caller typed and got wrong is theirs to correct, and silently running
 * something else is how `--step lint` becomes the whole gate.
 */
export function planStepsFromRefusal(out: string): string[] | null {
	// The pruned sentence has its own recovery and its own list; never both.
	if (out.includes("PRUNED it")) return null;
	// The server suggests a near-miss only on real evidence of a typo.
	if (/Did you mean/.test(out)) return null;
	// Bounded to the SENTENCE, not to the next quote. Unlike the pruned
	// message — where the list ends the sentence — this one continues
	// "…: test, typecheck. It may still be a real step this run pruned away…",
	// so a greedy capture swallows the entire explanation and hands it back as
	// step names. Captured from the live 400, which is the only reason this is
	// right: written from memory it looked fine and was not.
	// Lazy to the first sentence end, then every token validated as a step key.
	// Both halves earned their place against the live 400: a greedy capture ran
	// past "typecheck." into the explanation, and a class that allowed "." ran
	// past it too — the survivors filter then silently dropped `typecheck` and
	// returned a plausible, wrong ["test"].
	const inPlan = /Steps in this plan:\s*(.+?)\.(?:\s|$)/.exec(out);
	if (!inPlan) return null;
	const steps = inPlan[1]
		.split(",")
		.map((t) => t.trim())
		.filter((t) => /^[a-z0-9][a-z0-9_-]*$/i.test(t));
	return steps.length > 0 ? steps : null;
}

/**
 * The steps that DID survive, when the server rejected the request because the
 * step asked for was pruned out of this run's plan.
 *
 * ## The dead end this exists to end
 *
 * `DEFAULT_STEPS` is `["lint"]` — the fast, always-relevant one, except that it
 * is not always relevant. Hive's `lint` is `go vet`, gated on `ctx.changed`, so
 * a diff that touches only `web/` prunes it out of the plan and the dispatch
 * comes back 400:
 *
 *     step "lint" is not in this run's plan because this run PRUNED it: …
 *     Steps that DID survive: file-length, loc, web-check
 *
 * That is the server being right. The step genuinely had nothing to do. But the
 * caller asked "check my work" and got `NO VERDICT` — measured 6 times on
 * 2026-08-17 alone, every one an agent in a `hive__worktrees/` checkout that
 * then shipped with nothing verified. A well-formed refusal that leaves the
 * agent with no verdict is the failure mode, not the 400.
 *
 * The recovery costs nothing to find, because the server already put it on the
 * wire: it names the surviving steps in the same sentence. Re-running with them
 * turns "nothing was checked" into the verdict that was actually available —
 * `web-check` is exactly the gate that web diff wanted.
 *
 * ## Why this must NOT fire on an unknown step
 *
 * The other rejection here is a TYPO — `unknown step "linte"; available steps:
 * …` — and it also carries a step list. Retrying that one would run steps the
 * caller never asked for because they misspelled something, which is how a
 * `--step lint` turns into the whole gate on a slow afternoon. So the match is
 * on the PRUNED sentence specifically, not on the presence of a step list.
 *
 * Returns null when the output is anything else, which is every ordinary
 * failure and keeps the existing verbatim-refusal path exactly as it was.
 */
export function prunedStepSurvivors(out: string): string[] | null {
	// The prune is the server's own word for it, and the discriminator against
	// the typo message. Both carry a step list; only one means "your step had
	// nothing to do".
	if (!out.includes("PRUNED it")) return null;
	const survived = /Steps that DID survive:\s*([^"\\\n]+)/.exec(out);
	if (!survived) return null;
	const steps = survived[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return steps.length > 0 ? steps : null;
}

export interface RunRef {
	id: string;
	number?: number;
	url?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RUN_URL = new RegExp(`(https?://\\S+?/runs/(${UUID.source}))`, "i");
const RUN_NUMBER = /run #(\d+) started/i;

/**
 * parseRunRef finds the run the CLI just created — and only then.
 *
 * The CLI prints `run #N started on your working tree (base abc1234)` followed
 * by `<base>/runs/<uuid>`, both from the same printf, so a created run always
 * has both. A bare UUID anywhere in the output is NOT accepted, and that
 * restriction is the whole subtlety here: measured against the live server, a
 * rejected dispatch answers with problem+json carrying a `request_id` UUID —
 *
 *   {"detail":"unknown step \"lint\"; available steps: …","request_id":"ede6a0c9-…"}
 *
 * — and a fallback that scanned for any UUID adopted it as a run id. The tool
 * then polled a run that does not exist, never reached a terminal state, and sat
 * at "running" until its ceiling: a refusal that took 45 minutes to report,
 * which is worse than the silent bash call this replaces.
 *
 * Returns null for every such case, so the caller reports the CLI's own words.
 */
export function parseRunRef(stdout: string): RunRef | null {
	const number = RUN_NUMBER.exec(stdout);
	// The `/runs/<uuid>` URL is the proof a run exists: it is printed by the same
	// statement as the "run #N started" line and by nothing else. No URL, no run.
	const url = RUN_URL.exec(stdout);
	if (!url) return null;
	return {
		id: url[2],
		number: number ? Number(number[1]) : undefined,
		url: url[1],
	};
}

/** The subset of `GET /runs/{id}` this reads. */
export interface HiveRun {
	state: string;
	number?: number;
	/** When the run was CREATED — the clock a queue wait is measured against. */
	created_at?: string | null;
	started_at?: string | null;
	finished_at?: string | null;
	error?: string | null;
}

export interface HiveTask {
	id?: string;
	key: string;
	state: string;
	error?: string | null;
	started_at?: string | null;
	finished_at?: string | null;
}

/** The subset of `GET /runs/{id}/substeps` this reads. */
export interface HiveSubstep {
	task_key?: string;
	name: string;
	outcome: string;
	duration_ms?: number;
	message?: string;
}

/**
 * Map a substep outcome onto the widget's vocabulary.
 *
 * The emitters (`checks.star`, quality-gate's reporter) write `passed`/`failed`
 * only, and a `warn` is reported as `passed` with the truth in the message —
 * because a red substep inside a green step reads as a broken UI. Anything else
 * is `error`: an outcome this build does not know is not evidence of a pass.
 */
function substepOutcome(raw: string, message?: string): GateCheckProgress["outcome"] {
	if (raw === "passed") return message && /advisory|warn/i.test(message) ? "advisory" : "passed";
	if (raw === "failed") return "failed";
	return "error";
}

/**
 * A finished step's own outcome, for steps that reported no substeps.
 *
 * `skipped` is `advisory`, not `passed`: a step Hive pruned made no claim about
 * this code, and colouring it green is the "green gate that checked nothing"
 * failure this widget family exists to prevent. `canceled` is the same fact
 * arriving a different way.
 */
function taskOutcome(state: string): GateCheckProgress["outcome"] {
	if (state === "succeeded") return "passed";
	if (state === "failed" || state === "timed_out") return "failed";
	if (state === "skipped" || state === "canceled") return "advisory";
	return "error";
}

function durationMs(from?: string | null, to?: string | null): number | undefined {
	if (!from || !to) return undefined;
	const a = Date.parse(from);
	const b = Date.parse(to);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
	return b - a;
}

export interface FoldInput {
	run: HiveRun;
	tasks: HiveTask[];
	substeps: HiveSubstep[];
	steps: string[];
	ref: RunRef;
	/** Wall clock, for the duration of a run the server has not finished yet. */
	nowMs?: number;
}

/**
 * fold builds the whole spec from the current server state.
 *
 * A SNAPSHOT, recomputed from scratch on every poll rather than accumulated:
 * the transport already ships cumulative updates, a task can move backwards
 * (retried after a node failure), and a fold that appended would then show the
 * same check twice with two different verdicts.
 */
export function fold(input: FoldInput): GateProgress {
	const { run, tasks, substeps, steps, ref } = input;
	// Only meaningful while nothing has started; once a step is on a node the
	// wait is over and the number would be a stale fact drawn as a live one.
	const createdMs = run.created_at ? Date.parse(run.created_at) : NaN;
	// `nowMs` is optional on FoldInput — a caller that omits it is not asking for
	// a live clock, and inventing one with Date.now() here would make the fold
	// impure and untestable.
	const queuedSecs =
		Number.isFinite(createdMs) && input.nowMs !== undefined
			? Math.max(0, Math.round((input.nowMs - createdMs) / 1000))
			: undefined;

	const byTask = new Map<string, HiveSubstep[]>();
	for (const ss of substeps) {
		const key = ss.task_key ?? "";
		const list = byTask.get(key);
		if (list) list.push(ss);
		else byTask.set(key, [ss]);
	}

	const checks: GateCheckProgress[] = [];
	const failures: string[] = [];
	const advisories: string[] = [];
	const running: string[] = [];
	let done = 0;

	for (const task of tasks) {
		const terminal = TERMINAL_TASK.has(task.state);
		if (terminal) done++;
		if (ACTIVE_TASK.has(task.state)) running.push(task.key);

		const reported = byTask.get(task.key) ?? [];
		for (const ss of reported) {
			const message = ss.message || undefined;
			const outcome = substepOutcome(ss.outcome, message);
			checks.push({
				name: ss.name,
				group: task.key,
				outcome,
				duration_ms: typeof ss.duration_ms === "number" ? ss.duration_ms : undefined,
				message,
			});
			if (outcome === "failed" || outcome === "error") failures.push(`${task.key} › ${ss.name}`);
			if (outcome === "advisory") advisories.push(`${task.key} › ${ss.name}`);
		}

		// A step that reported checks is represented by them. One that did not
		// still has to appear once it is over — a `test` step is one opaque check
		// as far as this widget can honestly claim.
		if (reported.length === 0 && terminal) {
			const outcome = taskOutcome(task.state);
			checks.push({
				name: task.key,
				group: task.key,
				outcome,
				duration_ms: durationMs(task.started_at, task.finished_at),
				// The step's own error is the only diagnosis a substep-less step
				// offers; dropping it leaves a bare red row.
				message: task.error || (task.state === "skipped" ? "skipped — made no claim" : undefined),
			});
			if (outcome === "failed" || outcome === "error") failures.push(task.key);
			if (outcome === "advisory") advisories.push(task.key);
		}
	}

	return {
		status: runStatus(run.state),
		// The header reads "hive check · lint" — the command that produced this,
		// not the vendored gate's mode/scope vocabulary, which does not apply.
		mode: "hive check",
		scope: steps.join(","),
		// The run plan's own step count. Known as soon as the run exists, and
		// never invented: a run whose tasks have not materialised yet reports no
		// denominator rather than a guess.
		total: tasks.length > 0 ? tasks.length : undefined,
		done,
		checks,
		failures,
		advisories,
		// Hive has no equivalent signal: a missing tool inside a step fails that
		// step's own check. Always empty here, and honestly so.
		missing_tools: [],
		running,
		duration_ms: durationMs(run.started_at, run.finished_at ?? isoOf(input.nowMs)),
		url: ref.url,
		run_number: ref.number ?? run.number,
		run_id: ref.id,
		run_state: run.state,
		// How long this has been waiting for a slot, measured from the run's own
		// creation rather than from when the follow attached: `hive check` packs
		// and uploads a snapshot first, so the two differ by however long that
		// took, and the run's clock is the one Hive's own queue stats use.
		...(queuedSecs !== undefined ? { queued_secs: queuedSecs } : {}),
	};
}

/**
 * Nothing has started yet: the wait is for a fleet slot, not for this code.
 *
 * Derived from the TASKS, not from `run_state`, and that is a measured
 * correction rather than a preference. Hive marks a run `running` the moment it
 * is admitted — observed on run #3262, `"state":"running"` with its only task
 * still `"ready"` eleven minutes in — so the run's own word cannot say whether
 * any work has begun. Nothing finished and nothing on a node can.
 *
 * `run_state !== undefined` keeps this to the hive path: a vendored gate is also
 * momentarily 0-done and 0-running at startup, and "queued" would be the wrong
 * word for a process that is already executing on this machine.
 */
export function isQueued(p: GateProgress): boolean {
	return p.status === "running" && p.run_state !== undefined && p.done === 0 && p.running.length === 0;
}

/** A wait, as a person reads one: `42s`, `4m12s`, `27m`. */
export function humanSecs(secs: number): string {
	if (secs < 60) return `${secs}s`;
	const m = Math.floor(secs / 60);
	const r = secs % 60;
	return r === 0 ? `${m}m` : `${m}m${r}s`;
}

function isoOf(ms?: number): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** The first REPORT_NAMES names, saying how many it kept back. Never silent. */
function named(names: string[]): string {
	if (names.length <= REPORT_NAMES) return names.join(", ");
	return `${names.slice(0, REPORT_NAMES).join(", ")} (+${names.length - REPORT_NAMES} more)`;
}

const REPORT_NAMES = 10;

/**
 * A run state, as the widget's four statuses.
 *
 * `canceled` is `nosummary`, not `fail`: a cancelled run reached no verdict, and
 * the widget's job in that state is to say so rather than to draw a red one.
 * Same rule as the vendored gate dying before its trailer.
 */
function runStatus(state: string): GateProgress["status"] {
	if (state === "succeeded") return "pass";
	if (state === "canceled") return "nosummary";
	if (TERMINAL_RUN.has(state)) return "fail";
	return "running";
}

/**
 * The text the MODEL reads when the run is over.
 *
 * Deliberately shaped like the vendored gate's report — the same verdict line,
 * the same "failed:" list — so an agent that has learned to read one reads the
 * other. The run URL is included because this gate, unlike the local one, has a
 * page with the full logs, and an agent that cannot find it re-runs instead.
 */
export function renderReport(p: GateProgress, opts: { logs?: { task: string; tail: string }[] } = {}): string {
	const out: string[] = [];
	const secs = p.duration_ms !== undefined ? ` in ${(p.duration_ms / 1000).toFixed(1)}s` : "";
	const advisory = p.advisories.length ? `, ${p.advisories.length} advisory` : "";
	const steps = p.total !== undefined ? `${p.total} step(s)` : "the run";
	const checked = p.checks.length ? `, ${p.checks.length} check(s)` : "";

	if (p.status === "pass") out.push(`PASS — ${steps}${checked}${advisory}${secs}`);
	else if (p.status === "nosummary") {
		out.push(
			`NO VERDICT — the run was canceled after ${p.done}/${p.total ?? "?"} step(s)${secs}. ` +
				`Nothing here says this code is clean; re-run the check.`,
		);
	} else if (p.status === "fail") {
		// Which denominator the failures belong to. On a run with substeps the
		// failing things are CHECKS and the steps are the containers — "2 failing
		// of 18 steps, 91 checks" (the first wording, on a real run) reads as two
		// failed steps, which is a different fact and the wrong one to act on.
		const of = p.checks.length > (p.total ?? 0) ? `${p.failures.length} of ${p.checks.length} check(s) across ${steps}` : `${p.failures.length} failing of ${steps}`;
		out.push(`FAIL — ${of}${advisory}${secs}`);
	}
	else if (isQueued(p)) {
		// Not the same fact as "still running". A queued run is waiting for a
		// fleet slot and has looked at nothing yet, and reporting that as work in
		// progress on this code is the kind of quiet mis-statement this widget
		// family exists to refuse — measured at 15 minutes behind a PR gate.
		// The elapsed wait, not just the state. Without it the line is identical
		// at 10 seconds and at 27 minutes, and only one of those is worth acting
		// on — see GateProgress.queued_secs.
		const waited = p.queued_secs !== undefined ? ` for ${humanSecs(p.queued_secs)}` : "";
		out.push(`QUEUED${waited} — the run has not started yet (waiting for a fleet slot)${secs}`);
	} else out.push(`STILL RUNNING — ${p.done}/${p.total ?? "?"} step(s) done${secs}`);

	// Capped, and the cap is REPORTED. One red step blocks every downstream one,
	// so a real run listed fifteen advisories that were all "blocked by failed
	// dependency: lint" — a wall of names above the two that matter.
	if (p.failures.length) out.push(`failed: ${named(p.failures)}`);
	if (p.advisories.length) out.push(`advisory (non-blocking): ${named(p.advisories)}`);
	if (p.url) out.push(`run: ${p.url}`);

	for (const log of opts.logs ?? []) {
		out.push("", `── ${log.task} ──`, log.tail);
	}
	return out.join("\n");
}

/**
 * `gate lint,test-1 · 1/2 · running ✗1` — the deck's collapsed line.
 *
 * A running gate says `running`, never `FAIL`, because it has reached no
 * verdict — but it does carry the count of checks that have ALREADY failed. That
 * is the one number worth interrupting for: it turns a twenty-minute wait into a
 * decision (stop and fix) the moment the first red lands.
 */
export function deckSummary(p: GateProgress): string {
	const head = p.total !== undefined ? `${p.done}/${p.total}` : `${p.done} steps`;
	const red = p.failures.length ? `✗${p.failures.length}` : "";
	const verdict =
		p.status === "pass"
			? "PASS"
			: p.status === "fail"
				? `FAIL ${p.failures.length}`
				: p.status === "nosummary"
					? "no verdict"
					: isQueued(p)
						? p.queued_secs !== undefined
							? `queued ${humanSecs(p.queued_secs)}`
							: "queued"
						: `running ${red}`.trim();
	return [`gate ${p.scope ?? ""}`.trim(), head, verdict].filter(Boolean).join(" · ");
}

/** The deck's expanded body: the meter, then the findings, then what is live. */
export function deckLines(p: GateProgress): string[] {
	const lines: string[] = [];
	if (p.total !== undefined && p.total > 0) {
		const filled = Math.round((Math.min(p.done, p.total) / p.total) * METER_WIDTH);
		lines.push(`${"▍".repeat(filled)}${"░".repeat(METER_WIDTH - filled)} ${p.done}/${p.total}`);
	}
	for (const f of p.failures.slice(0, 6)) lines.push(`✗ ${f}`);
	for (const a of p.advisories.slice(0, 3)) lines.push(`▲ ${a}`);
	if (p.running.length) lines.push(`… ${p.running.slice(0, 4).join(", ")}`);
	return lines;
}

const METER_WIDTH = 12;

/**
 * What to re-run when a dispatch was refused, and why — or null to report the
 * refusal verbatim.
 *
 * The whole decision in one place, because it is a decision and not a parse.
 * Three refusal shapes, three answers:
 *
 *   PRUNED   the pipeline declares the step and this diff dropped it. The
 *            server names the survivors; run them. (Measured 2026-08-17: six
 *            agents shipped unverified because we reported NO VERDICT instead.)
 *   ABSENT   the repo has no such step, and WE asked for it — the caller named
 *            nothing and got DEFAULT_STEPS. Our bug, and a permanent one in
 *            that repo. Run this run's plan, which the server just named.
 *   NAMED    the caller asked for the step. Theirs to correct; running
 *            something else is how `--step lint` becomes the whole gate.
 *
 * The `only` argument is what makes ABSENT safe: it is the difference between
 * a default we chose and a name someone typed, and nothing downstream can
 * recover that distinction from the message alone.
 */
export function recoveryFor(
	only: string | undefined,
	out: string,
): { steps: string[]; why: "pruned" | "absent" } | null {
	const pruned = prunedStepSurvivors(out);
	if (pruned) return { steps: pruned, why: "pruned" };
	if (namedSteps(only) !== null) return null;
	const inPlan = planStepsFromRefusal(out);
	return inPlan ? { steps: inPlan, why: "absent" } : null;
}
