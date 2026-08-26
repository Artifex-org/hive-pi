/**
 * Turning trials into a verdict — and refusing to when the numbers cannot carry one.
 *
 * THE RULE THIS FILE EXISTS FOR: infrastructure configuration alone swings
 * Terminal-Bench 2.0 by 6pp (p<0.01, Anthropic). Our corpus is an order of
 * magnitude smaller and runs on one machine. So a small delta is noise, and the
 * discipline "distrust a delta this sample cannot carry" is worthless as a
 * sentence in a document — the moment a change shows +2pp, the sentence is what
 * gets forgotten.
 *
 * It is therefore code. `compare()` will not return "better" or "worse" unless
 * the delta is larger than the two-standard-error band of the trials that
 * produced it; otherwise it returns "inconclusive" and says how many more trials
 * would be needed. That is the whole point of building this rather than
 * eyeballing a pass count.
 *
 * Pure: trials in, report out.
 */

import { hasUsage, type TrialMetrics } from "./metrics.ts";

/**
 * Below this many graded trials per arm, no pass-rate verdict at any delta.
 *
 * The band in `passRateBandPp` is a NORMAL approximation, and three trials is
 * where that approximation starts lying outright: 0/3 vs 3/3 is the largest
 * delta a 3-trial arm can produce, the band would call it a verdict, and
 * Fisher's exact test puts it at p = 2/C(6,3) = 0.10. At four trials the same
 * total flip is 2/C(8,4) = 0.029, which is a real result. So four is where the
 * approximation stops overclaiming, and four is the floor.
 */
export const MIN_GRADED_TRIALS_PER_ARM = 4;

export interface Trial {
	taskId: string;
	/** Which arm this trial belongs to — "baseline", or the change under test. */
	arm: string;
	passed: boolean;
	/** Grader exit code; 0 is pass. Non-zero values distinguish failure modes. */
	exitCode: number;
	metrics: TrialMetrics;
	wallMs: number;
	/** Set when the trial never produced a verdict (timeout, container error). */
	error?: string;
}

export interface ArmSummary {
	arm: string;
	trials: number;
	passed: number;
	/** pass@1 as a percentage of trials that produced a verdict. */
	passRate: number;
	/** Tasks where EVERY repetition passed — the consistency the method calls pass^k. */
	consistentTasks: number;
	tasks: number;
	meanTurns: number;
	meanToolCalls: number;
	meanErrorTools: number;
	meanTokens: number;
	/** Share of PROMPT tokens (input + cacheRead) served from cache; a first-class harness metric. */
	cacheHitRate: number;
	totalCostUsd: number;
	meanWallMs: number;
	/** Trials that never returned a verdict. Excluded from passRate, reported loudly. */
	errored: number;
	/** Graded trials whose provider reported NO usage. Excluded from token/cost, reported loudly. */
	unmeasured: number;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarise(trials: readonly Trial[], arm: string): ArmSummary {
	const mine = trials.filter((trial) => trial.arm === arm);
	const graded = mine.filter((trial) => !trial.error);
	const byTask = new Map<string, Trial[]>();
	for (const trial of graded) byTask.set(trial.taskId, [...(byTask.get(trial.taskId) ?? []), trial]);

	// `cacheRead` is DISJOINT from `input` in pi's usage, not a subset of it:
	// a measured event reads `input 1249, output 18, cacheRead 256, totalTokens
	// 1523` — the three sum exactly. Dividing by `input` alone therefore yields
	// rates above 100%, which the first baseline duly reported as 223%. The
	// prompt is `input + cacheRead`.
	//
	// Token/cost statistics come ONLY from trials whose provider actually
	// reported usage. A trial with no usage object sums to zero, and averaging
	// that zero in understates the mean and shrinks the variance that
	// `compareEfficiency`'s band is built from — a harness change could be
	// declared a saving on the strength of trials that measured nothing.
	// Measured on `mistral-nemo`: 2 of 6 trials, across 4 and 8 turns of work.
	const measured = graded.filter((trial) => hasUsage(trial.metrics));
	const freshInput = measured.reduce((sum, trial) => sum + trial.metrics.inputTokens, 0);
	const cacheRead = measured.reduce((sum, trial) => sum + trial.metrics.cacheReadTokens, 0);
	const promptTokens = freshInput + cacheRead;

	return {
		arm,
		trials: mine.length,
		errored: mine.length - graded.length,
		unmeasured: graded.length - measured.length,
		passed: graded.filter((trial) => trial.passed).length,
		// Denominator is GRADED trials: a container that failed to start is not
		// evidence the harness is worse, and folding it in as a failure would let
		// infrastructure noise masquerade as a regression.
		passRate: graded.length === 0 ? 0 : (100 * graded.filter((trial) => trial.passed).length) / graded.length,
		tasks: byTask.size,
		consistentTasks: [...byTask.values()].filter((group) => group.length > 0 && group.every((trial) => trial.passed)).length,
		meanTurns: mean(graded.map((trial) => trial.metrics.turns)),
		meanToolCalls: mean(graded.map((trial) => trial.metrics.toolCalls)),
		meanErrorTools: mean(graded.map((trial) => trial.metrics.errorTools)),
		meanTokens: mean(measured.map((trial) => trial.metrics.totalTokens)),
		cacheHitRate: promptTokens === 0 ? 0 : (100 * cacheRead) / promptTokens,
		totalCostUsd: measured.reduce((sum, trial) => sum + trial.metrics.costUsd, 0),
		meanWallMs: mean(graded.map((trial) => trial.wallMs)),
	};
}

export type Verdict = "better" | "worse" | "inconclusive" | "unusable";

export interface Comparison {
	verdict: Verdict;
	deltaPp: number;
	/** 2 x the standard error of the pass-rate difference, in percentage points. */
	marginOfErrorPp: number;
	reason: string;
	baseline: ArmSummary;
	candidate: ArmSummary;
}

/**
 * Two standard errors on the difference of two pass rates, in percentage points.
 *
 * WHY THIS REPLACED A FIXED 3pp FLOOR (HIV-1708). The old rule was
 * `MIN_TRUSTWORTHY_DELTA_PP = 3`: any delta above 3pp could be a verdict. It duly
 * printed `PASS RATE: BETTER, +6.7pp` for a pi patch-pin bump measured at 25/30
 * against 27/30 — and +6.7pp on 30 trials is TWO FLIPPED TRIALS. A fixed
 * percentage-point floor is the wrong SHAPE, not merely the wrong number: two
 * flipped trials is 6.7pp at n=30 and 0.7pp at n=300, and those are not remotely
 * the same evidence, so no single pp constant can separate them. The number was
 * also wrong in the flattering direction — 3pp is HALF the 6pp swing that
 * infrastructure alone produces on a benchmark an order of magnitude larger,
 * i.e. more permissive exactly where the corpus is noisier.
 *
 * `compareEfficiency` in this same module already had this right: turns, tokens
 * and cost are held to a two-standard-error band on the difference of means.
 * Pass rate was being held to a weaker standard than turns were. This is
 * DELIBERATELY the same approach rather than a third statistical vocabulary in
 * one module — only the variance changes, from a sample variance to the
 * binomial's own p(1-p)/n.
 *
 * THE ARITHMETIC ON BOTH PUBLISHED RESULTS, which is the only reason to trust a
 * recalibration (a threshold can always be tuned until it agrees with you):
 *
 *   - pin bump, 25/30 vs 27/30:      band ±18.1pp, delta  +6.7pp → INCONCLUSIVE
 *   - negative control, 25/29 vs 15/30: band ±22.1pp, delta -36.2pp → WORSE
 *
 * Failing either would be disqualifying: the control is the only evidence this
 * corpus discriminates at all, and a floor that silences it would be a floor
 * that makes the instrument useless rather than honest.
 *
 * The +1/+1 is Agresti-Caffo, and it earns its place at the SATURATED end, which
 * is where this corpus actually sits. A plain Wald band takes ZERO variance from
 * an arm that passes everything, so the band for a 100% arm comes entirely from
 * the other arm and is too narrow — it understates the noise exactly where the
 * measurements are. The pair that separates the two, checked both ways:
 *
 *   30/30 vs 26/30, delta -13.3pp:  Wald          ±12.4pp → "WORSE"
 *                                   Agresti-Caffo ±14.2pp → inconclusive
 *
 * Fisher's exact test puts that table at p = 0.11 two-sided, so Wald is
 * overclaiming and the adjusted band is the honest call — the original bug
 * wearing the opposite sign. Note that 30/30 vs 29/30 does NOT separate them
 * (Wald ±6.6pp against a 3.3pp delta is inconclusive too), so that is not the
 * case to assert; the test file asserts the pair above.
 *
 * The adjustment moves each rate one notional trial toward 50%; the delta
 * REPORTED stays the observed one, so the number in the report still matches
 * pass counts a reader can add up by hand.
 */
export function passRateBandPp(baseline: ArmSummary, candidate: ArmSummary): number {
	const variance = (summary: ArmSummary) => {
		const graded = summary.trials - summary.errored;
		const adjusted = (summary.passed + 1) / (graded + 2);
		return (adjusted * (1 - adjusted)) / (graded + 2);
	};
	if (baseline.trials - baseline.errored === 0 || candidate.trials - candidate.errored === 0) {
		return Number.POSITIVE_INFINITY;
	}
	// x100 for percentage points, x2 for the two-standard-error band.
	return 200 * Math.sqrt(variance(baseline) + variance(candidate));
}

/**
 * Compare two arms, and REFUSE a verdict the sample cannot support.
 *
 * Four refusals, in order of how badly each would mislead:
 *
 *  - `unusable`  — one arm produced no graded trials at all, or the arms did not
 *                  run the same tasks. Comparing those is comparing nothing.
 *  - `inconclusive` below `MIN_GRADED_TRIALS_PER_ARM` — too few trials for the
 *    normal approximation the band is built on.
 *  - `inconclusive` inside the two-standard-error band — the delta is smaller
 *    than the sampling noise of the trials that produced it.
 *  - a verdict, quoting n, the delta and the band it cleared, so the reader can
 *    check the claim instead of trusting a constant that lives somewhere else.
 *
 * The old second refusal ("smaller than one flipped trial") is gone because the
 * band subsumes it: at n graded trials one trial is 100/n pp and the narrowest
 * possible band is ~283/(n+2) pp, which is wider for every n this corpus can
 * reach. Keeping both would have been two rules for one thing, with the weaker
 * one carrying the message a reader would quote.
 */
export function compare(baseline: ArmSummary, candidate: ArmSummary): Comparison {
	const deltaPp = candidate.passRate - baseline.passRate;
	const baselineGraded = baseline.trials - baseline.errored;
	const candidateGraded = candidate.trials - candidate.errored;
	const marginOfErrorPp = passRateBandPp(baseline, candidate);
	const base = { deltaPp, marginOfErrorPp, baseline, candidate };
	const signed = (pp: number) => `${pp > 0 ? "+" : ""}${pp.toFixed(1)}`;

	if (baselineGraded === 0 || candidateGraded === 0) {
		return { ...base, verdict: "unusable", reason: "one arm produced no graded trials — nothing to compare" };
	}
	if (baseline.tasks !== candidate.tasks) {
		return {
			...base,
			verdict: "unusable",
			reason: `arms ran different task counts (${baseline.tasks} vs ${candidate.tasks}) — a pass-rate difference here is a selection difference`,
		};
	}

	const gradedPerArm = Math.min(baselineGraded, candidateGraded);
	if (gradedPerArm < MIN_GRADED_TRIALS_PER_ARM) {
		return {
			...base,
			verdict: "inconclusive",
			reason:
				`${gradedPerArm} graded trials in an arm is below the ${MIN_GRADED_TRIALS_PER_ARM} this comparison needs — ` +
				`on that few trials the normal approximation calls even a total flip significant when an exact test does not`,
		};
	}
	if (Math.abs(deltaPp) <= marginOfErrorPp) {
		const needed = trialsNeededFor(deltaPp);
		return {
			...base,
			verdict: "inconclusive",
			reason:
				`${signed(deltaPp)}pp is ${(Math.abs(deltaPp) / (100 / gradedPerArm)).toFixed(1)} flipped trials over ` +
				`${baselineGraded}+${candidateGraded} graded trials, inside the ±${marginOfErrorPp.toFixed(1)}pp ` +
				`two-standard-error band — NO DETECTABLE DIFFERENCE, which is not the same as no difference. ` +
				(Number.isFinite(needed)
					? `A delta this size needs ~${needed} graded trials per arm before it means anything.`
					: `A 0pp delta cannot clear any band, at any sample size.`),
		};
	}
	return {
		...base,
		verdict: deltaPp > 0 ? "better" : "worse",
		reason:
			`${signed(deltaPp)}pp over ${baselineGraded}+${candidateGraded} graded trials, outside the ` +
			`±${marginOfErrorPp.toFixed(1)}pp two-standard-error band on the difference`,
	};
}

export interface EfficiencyComparison {
	metric: "turns" | "tokens" | "cost";
	baselineMean: number;
	candidateMean: number;
	deltaPct: number;
	/** 2 x the standard error of the difference, in the metric's own units. */
	marginOfError: number;
	verdict: "better" | "worse" | "inconclusive";
	reason: string;
}

function meanAndVariance(values: readonly number[]): { mean: number; variance: number; n: number } {
	const n = values.length;
	if (n === 0) return { mean: 0, variance: 0, n: 0 };
	const mean = values.reduce((sum, value) => sum + value, 0) / n;
	const variance = n < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
	return { mean, variance, n };
}

/**
 * Compare an efficiency metric — the axis that still has signal once pass rate saturates.
 *
 * MEASURED, which is why this exists: on the 2026-08-09 corpus every task passes
 * every repetition, so `compare()`'s pass-rate verdict is permanently
 * `inconclusive` and the eval looks useless. It is not — token spend varies with
 * an 11.4% coefficient of variation across the same trials. The method already
 * said so ("regressions in cost/turns at equal pass rate are real regressions");
 * there was simply nothing computing it.
 *
 * The discipline that applies to pass rate applies here too, and cannot be a
 * fixed percentage because these distributions are noisy and small. So the bar
 * is a Welch-style two-standard-error band on the difference of means: a change
 * counts only when it is larger than the spread of the trials that produced it.
 * With three reps per task that band is wide, and it SHOULD be — a 5% token
 * saving measured over six trials is not a saving.
 */
export function compareEfficiency(
	baseline: readonly Trial[],
	candidate: readonly Trial[],
	metric: "turns" | "tokens" | "cost" = "tokens",
): EfficiencyComparison {
	const pick = (trial: Trial) =>
		metric === "turns" ? trial.metrics.turns : metric === "cost" ? trial.metrics.costUsd : trial.metrics.totalTokens;
	// Turns are counted from `turn_end` events and stay valid whatever the
	// provider reported. Tokens and cost come from `message_end.usage`, so a
	// trial whose provider sent none must be EXCLUDED rather than folded in as a
	// zero — otherwise the arm with the flakier provider looks cheaper, and the
	// shrunken variance makes the two-standard-error band declare it significant.
	const usable = (trial: Trial) => !trial.error && (metric === "turns" || hasUsage(trial.metrics));
	const base = meanAndVariance(baseline.filter(usable).map(pick));
	const cand = meanAndVariance(candidate.filter(usable).map(pick));

	const deltaPct = base.mean === 0 ? 0 : (100 * (cand.mean - base.mean)) / base.mean;
	const shared = { metric, baselineMean: base.mean, candidateMean: cand.mean, deltaPct } as const;

	if (base.n < 2 || cand.n < 2) {
		return { ...shared, marginOfError: Number.POSITIVE_INFINITY, verdict: "inconclusive", reason: "fewer than 2 graded trials in an arm — no spread to compare against" };
	}
	const marginOfError = 2 * Math.sqrt(base.variance / base.n + cand.variance / cand.n);
	const difference = cand.mean - base.mean;
	if (Math.abs(difference) <= marginOfError) {
		return {
			...shared,
			marginOfError,
			verdict: "inconclusive",
			reason:
				`${difference > 0 ? "+" : ""}${difference.toFixed(1)} ${metric} is inside the ±${marginOfError.toFixed(1)} ` +
				`two-standard-error band of these ${base.n}+${cand.n} trials — the spread is larger than the change`,
		};
	}
	return {
		...shared,
		marginOfError,
		// Less is better for every metric here: fewer turns, fewer tokens, less cost.
		verdict: difference < 0 ? "better" : "worse",
		reason: `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}% ${metric} (±${marginOfError.toFixed(1)} band, ${base.n}+${cand.n} trials)`,
	};
}

/**
 * How many graded trials per arm a delta of this size would need to clear the band.
 *
 * Worst case on purpose. The band is widest when both arms sit at 50% — the
 * binomial's maximum variance — which gives band = 100·sqrt(2/(n+2)) pp, so the
 * delta clears it once n > 20000/delta² - 2. Arms far from 50% clear it with
 * roughly half as many trials (the pin bump's ~87% pair needs ~200 rather than
 * the ~450 this reports for its +6.7pp), so this is a planning number that can
 * be beaten — the right direction to be wrong in when the answer is "go spend
 * more money on trials".
 *
 * There is no delta too small to measure any more, only deltas too small to
 * measure HERE: 1pp is ~20,000 trials per arm, which is a far more useful
 * sentence than the old `Infinity`.
 */
export function trialsNeededFor(deltaPp: number): number {
	const delta = Math.abs(deltaPp);
	if (delta === 0) return Number.POSITIVE_INFINITY;
	// The 1e-9 is float slack, not a fudge factor: the pin bump's 6.666…pp puts
	// `20000/delta² - 2` at 447.99999999999994 for a true 448, and rounding a
	// bound DOWN is the wrong side of a number whose only job is to be honest.
	return Math.max(MIN_GRADED_TRIALS_PER_ARM, Math.floor(20000 / delta ** 2 - 2 + 1e-9) + 1);
}

export function renderSummary(summary: ArmSummary): string {
	const rows: [string, string][] = [
		["pass@1", `${summary.passRate.toFixed(1)}% (${summary.passed}/${summary.trials - summary.errored})`],
		["consistent tasks", `${summary.consistentTasks}/${summary.tasks} passed every repetition`],
		["mean turns", summary.meanTurns.toFixed(2)],
		["mean tool calls", summary.meanToolCalls.toFixed(2)],
		["mean error results", summary.meanErrorTools.toFixed(2)],
		["mean tokens", Math.round(summary.meanTokens).toLocaleString()],
		["cache hit rate", `${summary.cacheHitRate.toFixed(1)}% of prompt tokens`],
		["total cost", `$${summary.totalCostUsd.toFixed(4)}`],
		["mean wall clock", `${(summary.meanWallMs / 1000).toFixed(1)}s`],
	];
	if (summary.errored > 0) rows.push(["ERRORED trials", `${summary.errored} produced no verdict — excluded from pass@1`]);
	// Loud, not a footnote: an unmeasured trial means the token and cost rows
	// above are computed from FEWER trials than pass@1, and a reader comparing
	// two arms needs to know the denominators differ.
	if (summary.unmeasured > 0)
		rows.push([
			"UNMEASURED trials",
			`${summary.unmeasured} reported no usage — excluded from tokens/cost (the provider sent none)`,
		]);
	const width = Math.max(...rows.map(([label]) => label.length));
	return [`arm: ${summary.arm}`, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join("\n");
}
