/**
 * typesafe-common — the foldable half of the offline router replay.
 *
 * `scripts/typesafe-route-replay.ts` is argv, files and printing; everything
 * here is a function with a return value, so it is typechecked by
 * `npm run check` and unit-tested rather than merely executed once by hand.
 * The split matters more than usual: the replay's whole job is to produce a
 * NUMBER that decides whether the two-stage router ships, and a number produced
 * by untested code is not evidence.
 */

import { rankByAnyToken, type McpToolCorpus } from "../mcp-common/search.ts";
import {
	certaintyOf,
	choiceQuestion,
	type OutcomeKind,
	type TypesafeClient,
} from "./client.ts";
import { median } from "./liveness.ts";
import {
	categoryCriteria,
	lexicalTop1,
	stageTwoOptions,
	toolCriteria,
	type Categorisation,
} from "./router.ts";

// ---------------------------------------------------------------------------
// Frozen labels
// ---------------------------------------------------------------------------

export interface LabelRow {
	query: string;
	/** {server, name}, not the qualified name — qualification is machine-local. */
	expect: { server: string; name: string };
	/** file:line in this repo that pins the label. A label with no source is refused. */
	source: string;
	/** What the cited test actually asserts: "rank-1" or "containment". */
	pins?: string;
	why?: string;
}

export interface ResolvedLabel extends LabelRow {
	/** The expected tool as THIS machine's corpus qualifies it. */
	expectedQualifiedName: string;
}

export function parseLabels(raw: unknown): LabelRow[] {
	const doc = (raw ?? {}) as { queries?: unknown };
	if (!Array.isArray(doc.queries)) throw new Error("fixture has no `queries` array");
	return doc.queries.map((entry, i) => {
		const row = (entry ?? {}) as Partial<LabelRow>;
		const expect = (row.expect ?? {}) as Partial<LabelRow["expect"]>;
		if (typeof row.query !== "string" || row.query.trim() === "") throw new Error(`queries[${i}]: no query`);
		if (typeof expect.server !== "string" || typeof expect.name !== "string") {
			throw new Error(`queries[${i}]: expect needs {server, name}`);
		}
		// A benchmark row whose answer nobody can point at is a benchmark that
		// moves when it is inconvenient. The source is not decoration.
		if (typeof row.source !== "string" || row.source.trim() === "") throw new Error(`queries[${i}]: no source`);
		return {
			query: row.query,
			expect: { server: expect.server, name: expect.name },
			source: row.source,
			...(row.pins ? { pins: row.pins } : {}),
			...(row.why ? { why: row.why } : {}),
		};
	});
}

export interface ResolveResult {
	resolved: ResolvedLabel[];
	/** Labels whose tool is not in THIS machine's corpus. Reported, never dropped silently. */
	unresolved: LabelRow[];
}

export function resolveLabels(corpus: McpToolCorpus, labels: readonly LabelRow[]): ResolveResult {
	const resolved: ResolvedLabel[] = [];
	const unresolved: LabelRow[] = [];
	for (const label of labels) {
		const tool = corpus.tools.find((t) => t.server === label.expect.server && t.name === label.expect.name);
		if (tool) resolved.push({ ...label, expectedQualifiedName: tool.qualifiedName });
		else unresolved.push(label);
	}
	return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// The offline proof: floor coverage
// ---------------------------------------------------------------------------

export interface FloorCoverage {
	query: string;
	expectedQualifiedName: string;
	/** Lexical rank of the expected tool, 1-based; null when it does not rank at all. */
	lexicalRank: number | null;
	/** Categories whose stage-2 ballot would NOT contain the expected tool. */
	categoriesMissingExpected: string[];
	categoriesChecked: number;
	/** Largest stage-2 option set any category produced, for the 255/token caps. */
	maxOptions: number;
	/** True when at least one category's members were dropped by the token budget. */
	anyTruncated: boolean;
}

/**
 * The claim "structurally incapable of scoring below the lexical shortlist",
 * checked exhaustively and WITHOUT a network call.
 *
 * For every category stage 1 could possibly pick — including the wrong one, and
 * including no category at all — is the right answer on stage 2's ballot? If
 * any category answers no, the floor is not doing its job and the design is
 * dead; that is the "or kills" half of "proves or kills".
 */
export function floorCoverage(
	corpus: McpToolCorpus,
	categorisation: Categorisation,
	label: ResolvedLabel,
): FloorCoverage {
	const ranked = rankByAnyToken(corpus.tools, label.query, corpus.tools.length);
	const idx = ranked.findIndex((r) => r.tool.qualifiedName === label.expectedQualifiedName);

	const missing: string[] = [];
	let maxOptions = 0;
	let anyTruncated = false;
	const keys: (string | null)[] = [...categorisation.categories.map((c) => c.key), null];
	for (const key of keys) {
		const options = stageTwoOptions(corpus.tools, categorisation, key, label.query);
		maxOptions = Math.max(maxOptions, options.tools.length);
		anyTruncated = anyTruncated || options.truncated;
		if (!options.tools.some((t) => t.qualifiedName === label.expectedQualifiedName)) {
			missing.push(key ?? "<no category>");
		}
	}

	return {
		query: label.query,
		expectedQualifiedName: label.expectedQualifiedName,
		lexicalRank: idx < 0 ? null : idx + 1,
		categoriesMissingExpected: missing,
		categoriesChecked: keys.length,
		maxOptions,
		anyTruncated,
	};
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export interface Trial {
	query: string;
	top1: string | null;
	correct: boolean;
	latencyMs: number;
	inputTokens: number;
	/** Per-stage outcome kinds. `null` for a strategy that makes no call. */
	stage1: OutcomeKind | null;
	stage2: OutcomeKind | null;
	chosenCategory: string | null;
	/** True when stage 2 ran over the floor alone because stage 1 gave nothing. */
	floorOnly: boolean;
	/** Stage-2 confidence, via `certaintyOf`. Never read off `.confidence` directly. */
	certainty: number | null;
}

export interface StrategyReport {
	strategy: string;
	trials: Trial[];
	top1Accuracy: number;
	medianLatencyMs: number | null;
	medianInputTokens: number | null;
	outcomes: Record<string, number>;
}

export function summarise(strategy: string, trials: readonly Trial[]): StrategyReport {
	const outcomes: Record<string, number> = {};
	for (const trial of trials) {
		for (const kind of [trial.stage1, trial.stage2]) {
			if (kind === null) continue;
			outcomes[kind] = (outcomes[kind] ?? 0) + 1;
		}
	}
	return {
		strategy,
		trials: [...trials],
		top1Accuracy: trials.length === 0 ? 0 : trials.filter((t) => t.correct).length / trials.length,
		medianLatencyMs: median(trials.map((t) => t.latencyMs)),
		medianInputTokens: median(trials.map((t) => t.inputTokens)),
		outcomes,
	};
}

/**
 * The baseline: `rankByAnyToken`'s top hit. Zero input tokens, zero cost, and
 * the thing the two-stage router has to beat to be worth a single request.
 */
export function runLexical(corpus: McpToolCorpus, labels: readonly ResolvedLabel[], now: () => number): Trial[] {
	return labels.map((label) => {
		const started = now();
		const top1 = lexicalTop1(corpus.tools, label.query);
		return {
			query: label.query,
			top1,
			correct: top1 === label.expectedQualifiedName,
			latencyMs: now() - started,
			inputTokens: 0,
			stage1: null,
			stage2: null,
			chosenCategory: null,
			floorOnly: false,
			certainty: null,
		};
	});
}

const STAGE1_INSTRUCTIONS =
	"Which capability group most likely contains the tool that answers this request? " +
	"Pick the single best group key.";

const STAGE2_INSTRUCTIONS =
	"Which one of these tools answers this request? Pick the single best tool name.";

/**
 * One query through the two-stage router.
 *
 * ADVISORY ONLY. Every failure path here falls back to the lexical top-1 — the
 * router reorders, it never suppresses. The outcome kinds come back with the
 * trial so a run that quietly degraded to the baseline is VISIBLE in the report
 * instead of merely producing the baseline's number (HIV-712).
 *
 * State is the query string and nothing else: "large irrelevant state degrades
 * answers badly" is a measured property of this API, so the corpus, the
 * history and the machine's identity stay out of it.
 */
export async function routeOne(
	client: TypesafeClient,
	corpus: McpToolCorpus,
	categorisation: Categorisation,
	label: ResolvedLabel,
	now: () => number,
): Promise<Trial> {
	const started = now();
	let inputTokens = 0;

	const stage1 = await client.ask(label.query, {
		category: choiceQuestion(STAGE1_INSTRUCTIONS, categoryCriteria(categorisation.categories)),
	});
	let chosenCategory: string | null = null;
	if (stage1.kind === "ok") {
		inputTokens += stage1.usage.inputTokens;
		chosenCategory = stage1.answers.category.choice;
	}

	// A failed stage 1 does not end the route: stage 2 runs over the floor
	// alone, which is exactly the lexical shortlist. Worst case is "as good as
	// the ranker we replace", by construction.
	const options = stageTwoOptions(corpus.tools, categorisation, chosenCategory, label.query);
	const stage2 = await client.ask(label.query, {
		tool: choiceQuestion(STAGE2_INSTRUCTIONS, toolCriteria(options.tools)),
	});

	let top1 = lexicalTop1(corpus.tools, label.query);
	let certainty: number | null = null;
	if (stage2.kind === "ok") {
		inputTokens += stage2.usage.inputTokens;
		top1 = stage2.answers.tool.choice;
		certainty = certaintyOf(stage2.answers.tool);
	}

	return {
		query: label.query,
		top1,
		correct: top1 === label.expectedQualifiedName,
		latencyMs: now() - started,
		inputTokens,
		stage1: stage1.kind,
		stage2: stage2.kind,
		chosenCategory,
		floorOnly: chosenCategory === null,
		certainty,
	};
}

/** Percentage with one decimal, so 3/5 does not print as 0.6000000000000001. */
export function pct(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

export function formatReport(report: StrategyReport): string {
	const lines = [
		`  ${report.strategy}`,
		`    top-1 accuracy   ${pct(report.top1Accuracy)} (${report.trials.filter((t) => t.correct).length}/${report.trials.length})`,
		`    median latency   ${report.medianLatencyMs === null ? "n/a" : `${Math.round(report.medianLatencyMs)}ms`}`,
		`    median in-tokens ${report.medianInputTokens === null ? "n/a" : Math.round(report.medianInputTokens)}`,
	];
	const outcomes = Object.entries(report.outcomes);
	// Printed even when it is only "ok": the tally IS the liveness surface, and
	// an empty line here is how "never called" hides as "nothing to report".
	lines.push(`    outcomes         ${outcomes.length === 0 ? "none (no calls made)" : outcomes.map(([k, v]) => `${k} ${v}`).join(", ")}`);
	return lines.join("\n");
}

/** The tools a trial's misses point at, for a human reading the report. */
export function formatMisses(report: StrategyReport, labels: readonly ResolvedLabel[]): string[] {
	const expected = new Map(labels.map((l) => [l.query, l.expectedQualifiedName]));
	return report.trials
		.filter((t) => !t.correct)
		.map((t) => `      MISS "${t.query}" -> ${t.top1 ?? "<nothing>"} (wanted ${expected.get(t.query) ?? "?"})`);
}
