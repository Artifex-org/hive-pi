/**
 * The eval harness's own folds, and the refusals that make it worth running.
 *
 * An eval suite is measurement equipment. Untested equipment does not produce a
 * weaker answer — it produces a confident wrong one, which is worse than no
 * answer at all, because a number gets quoted long after its provenance is
 * forgotten. So the parts that decide anything are pure and asserted here; the
 * container is the only thing left unmocked, and it does no arithmetic.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { EMPTY_METRICS, foldEvent, foldToolResult, hasUsage, parseRun } from "../evals/runner/metrics.ts";
import {
	compare,
	compareEfficiency,
	MIN_GRADED_TRIALS_PER_ARM,
	passRateBandPp,
	renderSummary,
	summarise,
	trialsNeededFor,
	type Trial,
} from "../evals/runner/report.ts";
import { loadCorpus, selectTasks } from "../evals/runner/task.ts";
import { assertOpenRouterModel, containerScript, harnessLabel, harnessMode, harnessRevision, parseArgs } from "../evals/runner/run.ts";

const REPO = join(import.meta.dirname, "..");
const TASKS_ROOT = join(REPO, "evals", "tasks");

const assistantEnd = (usage: Record<string, unknown>, content: unknown[] = []) => ({
	type: "message_end",
	message: { role: "assistant", content, usage },
});

describe("metrics — the fold three throwaway scripts each did differently", () => {
	it("sums usage from message_end only, never double-counting turn_end", () => {
		// turn_end carries a message too. Folding usage there as well silently
		// doubles every token figure — and a doubled cost still looks plausible.
		let m = EMPTY_METRICS;
		m = foldEvent(m, assistantEnd({ input: 100, output: 10, totalTokens: 110, cost: { total: 0.5 } }));
		m = foldEvent(m, { type: "turn_end", message: { role: "assistant", usage: { input: 100, totalTokens: 110 } } });
		expect(m.totalTokens).toBe(110);
		expect(m.costUsd).toBe(0.5);
		expect(m.turns).toBe(1);
	});

	it("counts tool calls and keeps their names in order", () => {
		let m = EMPTY_METRICS;
		m = foldEvent(m, assistantEnd({}, [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "edit" }]));
		expect(m.toolCalls).toBe(2);
		expect(m.toolNames).toEqual(["read", "edit"]);
	});

	it("counts error tool results — thrashing to a pass is not the same as a pass", () => {
		let m = EMPTY_METRICS;
		m = foldToolResult(m, { message: { role: "toolResult", isError: true } });
		m = foldToolResult(m, { message: { role: "toolResult", isError: false } });
		expect(m.errorTools).toBe(1);
	});

	it("tracks cacheRead, which the method calls a first-class harness metric", () => {
		const m = foldEvent(EMPTY_METRICS, assistantEnd({ input: 1000, cacheRead: 250, totalTokens: 1000 }));
		expect(m.cacheReadTokens).toBe(250);
	});

	it("ignores unknown event types instead of throwing", () => {
		// pi adds event types between releases. Throwing here would turn a pi
		// upgrade into a corpus-wide failure that reads as a harness regression.
		expect(() => foldEvent(EMPTY_METRICS, { type: "some_future_event", message: {} })).not.toThrow();
		expect(foldEvent(EMPTY_METRICS, { type: "some_future_event" })).toEqual(EMPTY_METRICS);
	});

	it("survives the non-JSON lines that share the stream", () => {
		const stdout = [
			"npm notice New major version of npm available!",
			JSON.stringify(assistantEnd({ input: 5, totalTokens: 5, cost: { total: 0.01 } }, [{ type: "text", text: "done" }])),
			"not json at all {",
			JSON.stringify({ type: "agent_settled" }),
		].join("\n");
		const m = parseRun(stdout);
		expect(m.totalTokens).toBe(5);
		expect(m.finalText).toBe("done");
		expect(m.settled).toBe(true);
	});

	it("reports a run that never settled, rather than treating it as slow", () => {
		expect(parseRun(JSON.stringify({ type: "turn_end", message: {} })).settled).toBe(false);
	});
});

describe("report — refusing verdicts the sample cannot support", () => {
	const trial = (arm: string, taskId: string, passed: boolean): Trial => ({
		taskId,
		arm,
		passed,
		exitCode: passed ? 0 : 1,
		metrics: { ...EMPTY_METRICS, usageSamples: 1, inputTokens: 1000, cacheReadTokens: 400, totalTokens: 1000 },
		wallMs: 1000,
	});

	/** n tasks x reps, with `passes` of them passing, spread across tasks. */
	const arm = (name: string, tasks: number, reps: number, passes: number): Trial[] => {
		const out: Trial[] = [];
		let left = passes;
		for (let t = 0; t < tasks; t++) {
			for (let r = 0; r < reps; r++) {
				out.push(trial(name, `task-${t}`, left-- > 0));
			}
		}
		return out;
	};

	it("computes pass@1 over GRADED trials, excluding infrastructure errors", () => {
		const trials = [...arm("a", 2, 1, 1), { ...trial("a", "task-9", false), error: "container: no such image" }];
		const summary = summarise(trials, "a");
		expect(summary.errored).toBe(1);
		// 1 of 2 graded, not 1 of 3: a container that never started is not evidence.
		expect(summary.passRate).toBe(50);
	});

	it("counts consistency separately from pass rate", () => {
		// One task passing twice and another failing twice is 50% pass@1 — and one
		// consistent task. A harness that is right half the time on every task is a
		// different animal from one that is reliably right on half of them.
		const trials = [
			trial("a", "t1", true),
			trial("a", "t1", true),
			trial("a", "t2", false),
			trial("a", "t2", false),
		];
		const summary = summarise(trials, "a");
		expect(summary.passRate).toBe(50);
		expect(summary.consistentTasks).toBe(1);
		expect(summary.tasks).toBe(2);
	});

	it("reports the cache hit rate as a share of PROMPT tokens, never above 100%", () => {
		// `cacheRead` is disjoint from `input` in pi's usage — a measured event reads
		// input 1249 / output 18 / cacheRead 256 / totalTokens 1523, summing exactly.
		// Dividing by `input` alone gave the first real baseline a 223% hit rate.
		// 1000 fresh input + 400 cached = 400/1400.
		expect(summarise(arm("a", 1, 1, 1), "a").cacheHitRate).toBeCloseTo(28.571, 3);
	});

	it("keeps the cache hit rate in range for any usage split — the property, not one case", () => {
		for (const [input, cached] of [[0, 0], [1000, 0], [0, 500], [1, 9999], [12345, 6789]]) {
			const t: Trial = {
				taskId: "t", arm: "a", passed: true, exitCode: 0, wallMs: 1,
				metrics: { ...EMPTY_METRICS, usageSamples: 1, inputTokens: input, cacheReadTokens: cached },
			};
			const rate = summarise([t], "a").cacheHitRate;
			expect(rate, `input=${input} cached=${cached}`).toBeGreaterThanOrEqual(0);
			expect(rate, `input=${input} cached=${cached}`).toBeLessThanOrEqual(100);
		}
	});

	it("REFUSES a verdict inside the sampling band", () => {
		// 100 trials, 2pp apart: statistically tidy, and still not evidence — infra
		// config alone swings a mature benchmark by 6pp.
		const result = compare(summarise(arm("base", 50, 2, 50), "base"), summarise(arm("cand", 50, 2, 52), "cand"));
		expect(result.deltaPp).toBeCloseTo(2, 5);
		expect(result.verdict).toBe("inconclusive");
		// The message must carry the arithmetic — n, delta and band — because a
		// reader who cannot check the claim will quote the verdict instead.
		expect(result.reason).toContain("two-standard-error band");
		expect(result.reason).toContain("100+100 graded trials");
		expect(result.reason).toContain(`±${result.marginOfErrorPp.toFixed(1)}pp`);
	});

	it("REFUSES a delta that is one flipped trial", () => {
		// 8 tasks x 3 reps = 24 trials; one trial is 4.2pp, which cleared the old
		// fixed 3pp floor and needed a second rule of its own to catch. The band
		// subsumes that rule: at 24 trials it is ±27.7pp.
		const result = compare(summarise(arm("base", 8, 3, 12), "base"), summarise(arm("cand", 8, 3, 13), "cand"));
		expect(result.deltaPp).toBeCloseTo(4.17, 1);
		expect(result.verdict).toBe("inconclusive");
		expect(result.reason).toContain("1.0 flipped trials");
	});

	it("REFUSES to compare arms that ran different task sets", () => {
		const result = compare(summarise(arm("base", 8, 3, 12), "base"), summarise(arm("cand", 4, 3, 6), "cand"));
		expect(result.verdict).toBe("unusable");
		expect(result.reason).toContain("selection difference");
	});

	it("REFUSES to compare when an arm produced nothing", () => {
		expect(compare(summarise([], "base"), summarise(arm("cand", 2, 1, 1), "cand")).verdict).toBe("unusable");
	});

	it("does return a verdict when the evidence supports one", () => {
		const result = compare(summarise(arm("base", 20, 3, 30), "base"), summarise(arm("cand", 20, 3, 42), "cand"));
		expect(result.verdict).toBe("better");
		expect(result.deltaPp).toBeCloseTo(20, 5);
	});

	it("finds a large, consistent token saving", () => {
		// The axis that still has signal once pass rate saturates — which it has,
		// on the whole current corpus.
		const mk = (values: number[]): Trial[] =>
			values.map((tokens) => ({
				taskId: "t", arm: "a", passed: true, exitCode: 0, wallMs: 1,
				metrics: { ...EMPTY_METRICS, usageSamples: 1, totalTokens: tokens },
			}));
		const result = compareEfficiency(mk([20000, 20500, 19800, 20200]), mk([12000, 12300, 11900, 12100]));
		expect(result.verdict).toBe("better");
		expect(result.deltaPct).toBeLessThan(-35);
	});

	it("REFUSES an efficiency verdict when the spread exceeds the change", () => {
		// 11.4% coefficient of variation was measured on real trials, so a 5%
		// 'saving' over a handful of runs is the shape of a wrong conclusion.
		const mk = (values: number[]): Trial[] =>
			values.map((tokens) => ({
				taskId: "t", arm: "a", passed: true, exitCode: 0, wallMs: 1,
				metrics: { ...EMPTY_METRICS, usageSamples: 1, totalTokens: tokens },
			}));
		const result = compareEfficiency(mk([14000, 19000, 16000, 17500]), mk([15000, 18000, 15500, 16000]));
		expect(result.verdict).toBe("inconclusive");
		expect(result.reason).toContain("spread is larger than the change");
	});

	it("calls MORE tokens worse, not merely different", () => {
		const mk = (values: number[]): Trial[] =>
			values.map((tokens) => ({
				taskId: "t", arm: "a", passed: true, exitCode: 0, wallMs: 1,
				metrics: { ...EMPTY_METRICS, usageSamples: 1, totalTokens: tokens },
			}));
		expect(compareEfficiency(mk([10000, 10100, 9900]), mk([20000, 20100, 19900])).verdict).toBe("worse");
	});

	it("refuses when an arm has too few trials to have a spread at all", () => {
		const one: Trial[] = [{ taskId: "t", arm: "a", passed: true, exitCode: 0, wallMs: 1, metrics: { ...EMPTY_METRICS, usageSamples: 1, totalTokens: 5 } }];
		expect(compareEfficiency(one, one).verdict).toBe("inconclusive");
	});

	it("says how many trials a delta would need, and the answer is a number, not a shrug", () => {
		// Worst case, both arms at 50%: n > 20000/delta² - 2.
		expect(trialsNeededFor(10)).toBe(199);
		// The old rule returned Infinity for anything under its 3pp floor, which
		// said "never" when the truth is "not on a corpus you can afford". ~20k
		// trials per arm is the honest, and far more useful, answer.
		expect(trialsNeededFor(1)).toBe(19999);
		expect(trialsNeededFor(0)).toBe(Number.POSITIVE_INFINITY);
		// Never below the floor where the approximation itself stops holding.
		expect(trialsNeededFor(100)).toBe(MIN_GRADED_TRIALS_PER_ARM);
	});
});

/**
 * The calibration, restated: a pp threshold is the wrong SHAPE (HIV-1708).
 *
 * The instrument printed `PASS RATE: BETTER, +6.7pp` for the 0.84.0 → 0.84.1 pin
 * bump — 25/30 against 27/30, which is TWO FLIPPED TRIALS. It cleared a fixed
 * 3pp floor that had been set at half the 6pp swing infrastructure alone
 * produces on a benchmark an order of magnitude LARGER than this corpus.
 *
 * These tests are the calibration itself, so they name the two published results
 * by their real numbers. A future change to the threshold that cannot keep both
 * — the pin bump inconclusive AND the negative control a regression — is a
 * change that has broken the instrument, whichever way it moved it.
 */
describe("the pass-rate band, calibrated against the two results already published", () => {
	const trial = (arm: string, taskId: string, passed: boolean): Trial => ({
		taskId,
		arm,
		passed,
		exitCode: passed ? 0 : 1,
		metrics: { ...EMPTY_METRICS, usageSamples: 1, inputTokens: 1000, totalTokens: 1000 },
		wallMs: 1000,
	});

	/** `tasks` x `reps` trials, `passes` of them passing. */
	const arm = (name: string, tasks: number, reps: number, passes: number): Trial[] => {
		const out: Trial[] = [];
		let left = passes;
		for (let t = 0; t < tasks; t++) for (let r = 0; r < reps; r++) out.push(trial(name, `task-${t}`, left-- > 0));
		return out;
	};

	it("calls the +6.7pp pin bump INCONCLUSIVE — the exact result that fooled it", () => {
		// HIV-1625, measured: pi 0.84.0 at 25/30, pi 0.84.1 at 27/30.
		const result = compare(summarise(arm("pi-0840", 10, 3, 25), "pi-0840"), summarise(arm("pi-0841", 10, 3, 27), "pi-0841"));
		expect(result.deltaPp).toBeCloseTo(6.67, 1);
		expect(result.verdict).toBe("inconclusive");
		// ±18.1pp: two flipped trials is nowhere near the noise of 30 trials.
		expect(result.marginOfErrorPp).toBeCloseTo(18.1, 1);
		expect(result.reason).toContain("2.0 flipped trials");
		// The number `evals/README.md` now publishes for this run. A delta this
		// small is not unmeasurable — it is unmeasurable at 30 trials, and saying
		// how many it would take is the difference between a refusal and a shrug.
		expect(result.reason).toContain("~449 graded trials per arm");
	});

	it("still calls the -36.2pp negative control a REGRESSION — the fix must not deafen the instrument", () => {
		// 2026-08-10, measured: control-baseline 25/29 graded (one trial errored),
		// control-regressed 15/30. This is the only evidence the corpus
		// discriminates at all; a floor that silenced it would be worse than the
		// bug being fixed.
		const baseline = arm("control-baseline", 10, 3, 25);
		// Index 29 is a FAILING trial, so erroring it moves the denominator to 29
		// without touching the pass count.
		baseline[29] = { ...baseline[29], error: "container: exited 125" };
		const result = compare(summarise(baseline, "control-baseline"), summarise(arm("control-regressed", 10, 3, 15), "control-regressed"));
		expect(result.baseline.passRate).toBeCloseTo(86.2, 1);
		expect(result.deltaPp).toBeCloseTo(-36.2, 1);
		expect(result.marginOfErrorPp).toBeCloseTo(22.1, 1);
		expect(result.verdict).toBe("worse");
		expect(result.reason).toContain("29+30 graded trials");
	});

	it("is n-aware: the SAME delta is noise at n=30 and a result at n=1000", () => {
		// The whole point of the shape change. 83.3% → 90.0% is +6.7pp either way;
		// only the sample size decides whether it can be read.
		const small = compare(summarise(arm("a", 10, 3, 25), "a"), summarise(arm("b", 10, 3, 27), "b"));
		const large = compare(summarise(arm("a", 100, 10, 833), "a"), summarise(arm("b", 100, 10, 900), "b"));
		expect(small.deltaPp).toBeCloseTo(large.deltaPp, 0);
		expect(small.verdict).toBe("inconclusive");
		expect(large.verdict).toBe("better");
		expect(large.marginOfErrorPp).toBeLessThan(small.marginOfErrorPp);
	});

	it("still finds a large delta on a large sample — the fix is not 'never conclude'", () => {
		const result = compare(summarise(arm("a", 100, 3, 150), "a"), summarise(arm("b", 100, 3, 240), "b"));
		expect(result.deltaPp).toBeCloseTo(30, 5);
		expect(result.verdict).toBe("better");
	});

	it("does not let a SATURATED arm narrow the band — the case where Agresti-Caffo earns its place", () => {
		// A plain Wald band takes zero variance from an arm that passes everything,
		// so its band comes entirely from the other arm and is too narrow exactly
		// where this corpus sits. 30/30 vs 26/30 is the pair where the two bands
		// DISAGREE: Wald ±12.4pp calls -13.3pp "worse"; the Agresti-Caffo ±14.2pp
		// does not, and Fisher's exact test puts that table at p=0.11 two-sided —
		// so Wald is overclaiming, the original bug with the sign flipped.
		//
		// Asserted instead of 30/30 vs 29/30, which BOTH bands call inconclusive
		// (Wald is ±6.6pp against a 3.3pp delta): that pair cannot fail if the
		// +1/+1 is deleted, so it proves nothing about the adjustment. The band
		// VALUES are asserted for the same reason — a verdict alone would survive.
		const result = compare(summarise(arm("a", 10, 3, 30), "a"), summarise(arm("b", 10, 3, 26), "b"));
		expect(result.deltaPp).toBeCloseTo(-13.33, 1);
		expect(result.marginOfErrorPp).toBeCloseTo(14.235, 2);
		expect(result.verdict).toBe("inconclusive");
		// And one flipped trial against a perfect arm stays a non-event.
		const oneTrial = compare(summarise(arm("a", 10, 3, 30), "a"), summarise(arm("b", 10, 3, 29), "b"));
		expect(oneTrial.marginOfErrorPp).toBeCloseTo(10.54, 2);
		expect(oneTrial.verdict).toBe("inconclusive");
	});

	it("refuses any verdict on a sample too small for the approximation", () => {
		// 0/3 vs 3/3 is the largest delta three trials can produce, and Fisher's
		// exact test puts it at p=0.10. The band alone would call it a verdict.
		const result = compare(summarise(arm("a", 3, 1, 0), "a"), summarise(arm("b", 3, 1, 3), "b"));
		expect(result.deltaPp).toBe(100);
		expect(result.verdict).toBe("inconclusive");
		expect(result.reason).toContain(`below the ${MIN_GRADED_TRIALS_PER_ARM}`);
	});

	it("does conclude on a total flip once the sample can carry one", () => {
		// 0/5 vs 5/5 is p=0.008 exact. Refusing this would be an instrument that
		// never says anything, which is a different way to be useless.
		expect(compare(summarise(arm("a", 5, 1, 0), "a"), summarise(arm("b", 5, 1, 5), "b")).verdict).toBe("better");
	});

	it("computes the band from the pass counts, not from a constant", () => {
		// The arithmetic on its own, so the two calibration cases above are
		// checking a formula rather than a coincidence.
		const at = (passes: number, tasks: number, reps: number) => summarise(arm("x", tasks, reps, passes), "x");
		expect(passRateBandPp(at(25, 10, 3), at(27, 10, 3))).toBeCloseTo(18.087, 2);
		expect(passRateBandPp(at(15, 10, 3), at(25, 10, 3))).toBeCloseTo(22.426, 2);
		// More trials, same rates → a narrower band. Monotone, or it is not a band.
		expect(passRateBandPp(at(250, 100, 3), at(270, 100, 3))).toBeLessThan(
			passRateBandPp(at(25, 10, 3), at(27, 10, 3)),
		);
	});

	it("never lets an inconclusive result read as a win", () => {
		// The failure was vocabulary as much as arithmetic: `BETTER` on two flipped
		// trials is what got quoted. An inconclusive verdict must not contain a
		// word that survives being quoted out of context.
		const result = compare(summarise(arm("a", 10, 3, 25), "a"), summarise(arm("b", 10, 3, 27), "b"));
		expect(result.verdict).toBe("inconclusive");
		expect(result.reason.toLowerCase()).not.toMatch(/\b(better|worse|improve\w*|win|gain)\b/);
		expect(result.reason).toContain("NO DETECTABLE DIFFERENCE");
	});
});

describe("the ToS guard, which is the reason evals run in a container", () => {
	it("refuses any model that is not OpenRouter's", () => {
		// Unattended batch runs on a subscription OAuth credential are a ToS
		// violation. The container carries no OAuth at all, so this is the second
		// belt — but it is the one that fires BEFORE spending anything.
		expect(() => assertOpenRouterModel("gpt-5.6-sol")).toThrow(/OpenRouter/);
		expect(() => assertOpenRouterModel("openai-codex/gpt-5.6-sol")).toThrow();
		expect(() => assertOpenRouterModel("openrouter/deepseek/deepseek-v4-flash")).not.toThrow();
	});
});

describe("argv and the container entrypoint", () => {
	it("defaults to the dev split and an OpenRouter model", () => {
		const options = parseArgs([]);
		expect(options.includeTest).toBe(false);
		expect(options.model.startsWith("openrouter/")).toBe(true);
		expect(options.arm).toBe("baseline");
	});

	it("takes env overrides, which is how an A/B arm is expressed", () => {
		const options = parseArgs(["--arm", "diagnosis-off", "--env", "PI_HOUSE_X=0", "--reps", "5"]);
		expect(options.arm).toBe("diagnosis-off");
		expect(options.env).toEqual({ PI_HOUSE_X: "0" });
		expect(options.reps).toBe(5);
	});

	it("puts the agent's stdout where the parser reads it, and the grader's elsewhere", () => {
		// A chatty grader writing to the event stream would be parsed as agent
		// events; a grader whose verdict landed in the stream would be parsed as
		// nothing. Both are silent corruption of the measurement.
		const [task] = loadCorpus(TASKS_ROOT);
		const script = containerScript(task, "openrouter/x/y", true);
		expect(script).toContain("> /eval/events.jsonl");
		expect(script).toContain("bash /eval/grade.sh >/eval/grade.log");
		expect(script).toContain("__EVAL_GRADE__");
	});

	// The container held bare pi and the fixture and nothing else, so every
	// `--env PI_HOUSE_*` arm was inert and every harness A/B compared two
	// identical containers — returning `inconclusive` by construction, which
	// reads as "no regression" rather than "not measured" (HIV-1629).
	it("installs the harness under test, and says so when it cannot", () => {
		const [task] = loadCorpus(TASKS_ROOT);
		const withHarness = containerScript(task, "openrouter/x/y", true);
		expect(withHarness).toContain("pi install /hive-pi");
		// Fatal, not a warning: an eval that silently measures bare pi while its
		// report says "harness" is worse than no eval at all.
		expect(withHarness).toContain("__EVAL_HARNESS_FAILED__");

		expect(containerScript(task, "openrouter/x/y", false)).not.toContain("pi install /hive-pi");
	});

	// `spawnSync`'s timeout kills the docker CLI, but the container inherits the
	// stdout pipe — so spawnSync does not RETURN until the container exits, and
	// the container is exactly what is stuck. Measured: 57 minutes past a
	// 6-minute deadline, freed only by killing it from outside. The bound has to
	// live somewhere that does not depend on the thing being bounded.
	it("bounds the agent INSIDE the container, under the host deadline", () => {
		const [task] = loadCorpus(TASKS_ROOT);
		const script = containerScript(task, "openrouter/x/y", true);
		const inner = /timeout -k 10 (\d+) pi /.exec(script);
		expect(inner).not.toBeNull();
		const seconds = Number(inner?.[1]);
		// Strictly under the host timeout, so the container dies first and the
		// host bound stays a backstop rather than the mechanism.
		expect(seconds).toBeLessThan(task.timeoutMs / 1000);
		expect(seconds).toBeGreaterThan(0);
	});

	it("marks an agent timeout instead of grading a half-finished workspace", () => {
		const [task] = loadCorpus(TASKS_ROOT);
		const script = containerScript(task, "openrouter/x/y", true);
		// Otherwise a harness change that merely slowed things down scores as one
		// that broke correctness.
		expect(script).toContain("__EVAL_AGENT_TIMEOUT__");
		expect(script).toContain('"$__rc" = "124"');
	});

	it("defaults to measuring WITH the harness; bare pi must be asked for by name", () => {
		expect(parseArgs([]).harness).toBe(true);
		expect(parseArgs(["--no-harness"]).harness).toBe(false);
	});

	// pi has no package resource type for the system context file, so `pi install`
	// cannot carry it — a second lever is not a design preference. This is the one
	// HIV-1629 step 4 names by name ("any PR touching AGENTS.md").
	it("accepts a context file, and defaults to not injecting one", () => {
		expect(parseArgs([]).contextFile).toBeNull();
		expect(parseArgs(["--context", "evals/control/regressed-AGENTS.md"]).contextFile).toBe(
			"evals/control/regressed-AGENTS.md",
		);
	});

	// Comparability is NOT identity. Two arms that differ by revision are the
	// normal, intended experiment — a harness A/B is two revisions by definition —
	// so gating the confound banner on the full label fired on every legitimate
	// comparison, and told the reader to "re-run one side", which would destroy
	// the experiment. A check that cries wolf on the happy path is worse than no
	// check: it trains the reader to skip the banner that matters.
	it("does NOT flag two revisions of an installed harness — that IS the experiment", () => {
		const a = { enabled: true, revision: "aaa1111" };
		const b = { enabled: true, revision: "bbb2222" };
		expect(harnessLabel(a)).not.toBe(harnessLabel(b)); // identity differs...
		expect(harnessMode(a)).toBe(harnessMode(b)); // ...comparability does not
	});

	it("flags the comparisons that genuinely are not comparable", () => {
		expect(harnessMode({ enabled: true, revision: "abc" })).not.toBe(harnessMode({ enabled: false, revision: null }));
		expect(harnessMode(undefined)).not.toBe(harnessMode({ enabled: false, revision: null }));
		expect(harnessMode(undefined)).not.toBe(harnessMode({ enabled: true, revision: "abc" }));
	});

	// Three states, not two. Comparing a pre-HIV-1629 artefact against a new one
	// silently differences "bare pi" against "with harness" and blames the arm
	// name for it.
	it("treats a missing harness record as UNKNOWN, never as false", () => {
		expect(harnessLabel(undefined)).toContain("unknown");
		expect(harnessLabel({ enabled: false, revision: null })).toContain("bare pi");
		expect(harnessLabel({ enabled: true, revision: "abc1234" })).toContain("abc1234");
		// The three must be mutually distinguishable, or the mismatch banner
		// cannot fire on the case it exists for.
		const labels = [harnessLabel(undefined), harnessLabel({ enabled: false, revision: null })];
		expect(new Set(labels).size).toBe(2);
	});

	it("stamps a revision so an arm stays identifiable after the repo moves", () => {
		// Once arms can differ by repo CONTENT, "baseline" alone identifies
		// nothing — the same label a commit later is a different measurement.
		const rev = harnessRevision();
		expect(rev).toMatch(/^([0-9a-f]{7,}(-dirty)?|unknown)$/);
	});
});

describe("the corpus", () => {
	const corpus = loadCorpus(TASKS_ROOT);

	it("loads, and is big enough to be worth running", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(8);
	});

	it("holds the test split back unless it is explicitly asked for", () => {
		// The held-out set is the only unbiased measurement available, and the way
		// it gets burned is not malice — it is running everything while iterating.
		expect(selectTasks(corpus, {}).every((task) => task.split === "dev")).toBe(true);
		expect(selectTasks(corpus, { includeTest: true }).some((task) => task.split === "test")).toBe(true);
	});

	it("has both splits — a corpus with no held-out set cannot gate a milestone", () => {
		expect(corpus.some((task) => task.split === "test")).toBe(true);
		expect(corpus.some((task) => task.split === "dev")).toBe(true);
	});

	it("makes every task say where its failure was really observed", () => {
		for (const task of corpus) {
			expect(task.provenance.length, `${task.id} needs real provenance`).toBeGreaterThan(40);
			expect(task.measures.length, `${task.id} must say what it measures`).toBeGreaterThan(20);
		}
	});

	it("never calls a derived task a replay", () => {
		// The tree as it stood at the moment of a real failure is not recorded —
		// transcripts hold the anchor the model sent, not what it was sent against.
		// A corpus that blurred that would look like stronger evidence than it is.
		for (const task of corpus) {
			expect(/DERIVED|derived/.test(task.provenance), `${task.id} must state that it is derived, not replayed`).toBe(true);
			// The negation has to be stripped first, or "DERIVED, not replayed" —
			// the exact phrasing this rule wants — fails the rule. Caught by the
			// check firing on its own corpus, which is the cheapest possible place.
			const affirmative = task.provenance.replace(/\b(not|never|rather than)\s+replay(ed)?\b/gi, "");
			expect(/\breplay(ed)?\b/i.test(affirmative), `${task.id} claims to be a replay`).toBe(false);
		}
	});

	it("has every fixture file actually TRACKED by git, not merely present on disk", () => {
		// How this test earned its place: `edit-anchor-absent`'s only fixture was
		// named `config.json`, which the repo ignores as a credential-safety belt.
		// Git took neither the file nor its now-empty directory, so the task loaded
		// perfectly on the machine that wrote it and CI died with "no fixture/".
		//
		// Every environment-drift failure this repo has hit reduces to the same
		// shape: something present locally that the other machine never receives.
		const tracked = new Set(
			execSync("git ls-files evals/tasks", { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean),
		);
		const missing: string[] = [];
		for (const task of corpus) {
			const fixture = join(task.dir, "fixture");
			const walk = (dir: string): void => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					// Interpreter droppings, not fixtures. Named narrowly and on purpose:
					// the hole that caused this test was a BROAD ignore rule swallowing a
					// real fixture, so anything excluded here has to be something no task
					// could ever legitimately ship.
					if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
					const full = join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (!tracked.has(relative(REPO, full))) missing.push(relative(REPO, full));
				}
			};
			walk(fixture);
			// An empty fixture dir is the same bug wearing a different face: git does
			// not track directories, so it simply would not arrive.
			if (readdirSync(fixture).length === 0) missing.push(`${relative(REPO, fixture)}/ (empty — git cannot carry it)`);
		}
		expect(
			missing.sort(),
			"these fixture paths exist locally but are not in git — check .gitignore; the task will load here and " +
				"fail everywhere else",
		).toEqual([]);
	});

	it("gives every task a grader that can actually fail it", () => {
		for (const task of corpus) {
			const grader = readFileSync(join(task.dir, "grade.sh"), "utf8");
			expect(existsSync(join(task.dir, "fixture")), `${task.id} has no fixture`).toBe(true);
			// A grader with no non-zero exit is a task that always passes.
			expect(/exit [1-9]|sys\.exit\([1-9]/.test(grader), `${task.id}'s grader can never fail`).toBe(true);
		}
	});

	it("distinguishes failure modes rather than returning a bare 1", () => {
		// A grader that only says "failed" cannot tell "did nothing" from "broke
		// the file", and those are opposite harness problems.
		const multi = corpus.filter((task) => {
			const grader = readFileSync(join(task.dir, "grade.sh"), "utf8");
			return new Set([...grader.matchAll(/(?:exit|sys\.exit\()\s*([1-9])/g)].map((m) => m[1])).size >= 2;
		});
		expect(multi.length, "most graders should separate failure modes").toBeGreaterThanOrEqual(corpus.length - 1);
	});
});

/**
 * An unmeasured trial is not a free one.
 *
 * MEASURED 2026-08-09 on `openrouter/mistralai/mistral-nemo`: 2 of 6 trials
 * reported **0 tokens** across 4 and 8 turns of real work — the provider simply
 * returned no usage object. `usage ?? {}` summed those to zero, and a zero is
 * indistinguishable from "the model did nothing".
 *
 * The damage is in the flattering direction, which is why it needs a test
 * rather than a comment: those zeros were averaged into `meanTokens`, dragging
 * the mean down AND shrinking the variance that `compareEfficiency`'s
 * two-standard-error band is computed from. A harness change could be declared
 * a token saving on the strength of trials that measured nothing at all.
 */
describe("trials whose provider reported no usage", () => {
	const measured = (tokens: number, task = "t"): Trial => ({
		taskId: task,
		arm: "a",
		passed: true,
		exitCode: 0,
		wallMs: 1,
		metrics: { ...EMPTY_METRICS, usageSamples: 1, totalTokens: tokens, inputTokens: tokens },
	});
	const unmeasured = (task = "t"): Trial => ({
		taskId: task,
		arm: "a",
		passed: true,
		exitCode: 0,
		wallMs: 1,
		// Real work happened — turns and tool calls prove it — but no usage came back.
		metrics: { ...EMPTY_METRICS, turns: 8, toolCalls: 3 },
	});

	it("is recognised by hasUsage, and a usage object with no numbers is NOT usage", () => {
		expect(hasUsage({ usageSamples: 0 })).toBe(false);
		expect(hasUsage({ usageSamples: 2 })).toBe(true);
		// Some providers send `{}` — counting it as a sample restores exactly the
		// false confidence this exists to remove.
		expect(foldEvent(EMPTY_METRICS, assistantEnd({})).usageSamples).toBe(0);
		expect(foldEvent(EMPTY_METRICS, assistantEnd({ input: 10 })).usageSamples).toBe(1);
	});

	it("does NOT drag the token mean toward zero", () => {
		const summary = summarise([measured(1000), measured(1000), unmeasured()], "a");
		// The honest mean of what was actually measured — not 666.
		expect(summary.meanTokens).toBe(1000);
		expect(summary.unmeasured).toBe(1);
		// pass@1 still counts it: the grader's verdict is valid regardless of
		// whether the provider bothered to report tokens.
		expect(summary.passRate).toBe(100);
		expect(summary.trials).toBe(3);
	});

	it("keeps turns, which are counted from events and never depend on the provider", () => {
		const summary = summarise([measured(1000), unmeasured()], "a");
		expect(summary.meanTurns).toBe(4); // (0 + 8) / 2 — both trials count
	});

	it("does not let a flaky-provider arm look cheaper than it is", () => {
		// The failure this prevents: arm B's provider drops usage on half its
		// trials, so its zeros pull the mean down and the spread collapses. With
		// the zeros folded in, B reads as a large, confident saving over A.
		const armA = [measured(1000, "t1"), measured(1000, "t2"), measured(1000, "t3")];
		const armB = [
			{ ...measured(1000, "t1"), arm: "b" },
			{ ...unmeasured("t2"), arm: "b" },
			{ ...unmeasured("t3"), arm: "b" },
		];
		const verdict = compareEfficiency(armA, armB, "tokens");
		// B measured exactly the same 1000 tokens where it measured anything.
		expect(verdict.candidateMean).toBe(1000);
		expect(verdict.deltaPct).toBe(0);
		expect(verdict.verdict).not.toBe("better");
	});

	it("refuses an efficiency verdict when too few trials were measured", () => {
		const armA = [measured(1000, "t1"), measured(1200, "t2")];
		const armB = [{ ...measured(500, "t1"), arm: "b" }, { ...unmeasured("t2"), arm: "b" }];
		// One measured trial in B — no spread to compare against, so no verdict.
		expect(compareEfficiency(armA, armB, "tokens").verdict).toBe("inconclusive");
	});

	it("says so loudly in the rendered summary", () => {
		const rendered = renderSummary(summarise([measured(1000), unmeasured()], "a"));
		expect(rendered).toContain("UNMEASURED");
		expect(rendered).toContain("provider sent none");
	});
});

// The negative control is the only thing that turns "we believe this corpus
// discriminates" into "we measured that it does". An eval that has never been
// shown to catch a known regression is a number generator whose failure mode —
// a green "no significant change" on a change that broke something — looks
// exactly like success (HIV-1629).
describe("the negative control arm", () => {
	const CONTROL = join(REPO, "evals", "control", "regressed-AGENTS.md");

	it("exists, and is never applied by default", () => {
		expect(existsSync(CONTROL)).toBe(true);
		// It is opt-in through --context and nothing else. A control that could be
		// picked up by a default path would poison a real measurement.
		expect(parseArgs([]).contextFile).toBeNull();
	});

	it("says what it is, loudly enough that it cannot be mistaken for guidance", () => {
		const text = readFileSync(CONTROL, "utf8");
		expect(text).toContain("NEGATIVE CONTROL");
		expect(text).toContain("NEVER STOW OR INSTALL");
	});

	// It has to be PLAUSIBLE, not obvious nonsense: the realistic failure is a
	// well-meaning house rule that quietly forbids the thing the task requires.
	// It also has to target pass rate, because HIV-1629's acceptance names
	// compare() and not compareEfficiency().
	it("forbids the actions every task in this corpus requires", () => {
		const text = readFileSync(CONTROL, "utf8");
		expect(text).toMatch(/Do not modify existing source files/i);
		expect(text).toMatch(/task is complete when/i);
	});
});
