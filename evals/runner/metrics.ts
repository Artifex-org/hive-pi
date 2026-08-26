/**
 * A pi `--mode json` run, folded into the numbers an eval compares (HIV-1035).
 *
 * This is the fold three separate throwaway scripts computed this month —
 * `measure-edit-failures.py`, `anchor-forensics.py`, and two ad-hoc pipes — each
 * time slightly differently. Written once, tested, and shared: a metric that is
 * re-derived per question is a metric whose trend cannot be trusted.
 *
 * PURE. The process boundary is `run.ts`; everything here takes lines of text
 * and returns a record, so the whole surface is testable without a container,
 * a credential, or a model.
 *
 * WHAT IS COUNTED AND WHY
 *
 *   turns        `turn_end` events. The unit an operator waits through.
 *   toolCalls    assistant `toolCall` parts. Cheaper than turns and finer:
 *                a harness change that removes a wasted retry shows here first.
 *   tokens/cost  summed from `message_end.usage`, never estimated.
 *   cacheRead    first-class per the eval method: prompt-cache hit rate is a
 *                harness property, and a regression in it is a harness bug even
 *                when pass rate holds.
 *   errorTools   tool results flagged `isError`. A run that passes its grader
 *                while thrashing is a worse harness than one that does not.
 */

export interface TrialMetrics {
	turns: number;
	toolCalls: number;
	errorTools: number;
	/** Tool names in call order — the cheap way to see WHAT changed, not just how much. */
	toolNames: string[];
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	costUsd: number;
	/** The assistant's last text, which most graders do not need and some do. */
	finalText: string;
	/** True once pi reported the agent settled: a run that never settles is not a slow pass. */
	settled: boolean;
	/**
	 * How many assistant `message_end` events actually carried usage.
	 *
	 * MEASURED, and the reason this field exists: on
	 * `openrouter/mistralai/mistral-nemo`, 2 of 6 trials reported **0 tokens**
	 * across 4 and 8 turns of real work — the provider simply returned no usage
	 * object. `usage ?? {}` then summed to zero, and a zero is indistinguishable
	 * from "the model did nothing".
	 *
	 * That is not a rounding problem, it is a wrong number in the flattering
	 * direction: those trials were averaged into `meanTokens` as genuine zeros,
	 * dragging the mean down and shrinking the variance that
	 * `compareEfficiency`'s two-standard-error band is computed from. A harness
	 * change could be declared a token saving on the strength of trials that
	 * measured nothing at all.
	 *
	 * Zero here means **unmeasured**, and every consumer must exclude the trial
	 * from token/cost statistics rather than treat it as free.
	 */
	usageSamples: number;
}

/** Did this trial's provider report usage at all? */
export function hasUsage(metrics: Pick<TrialMetrics, "usageSamples">): boolean {
	return metrics.usageSamples > 0;
}

export const EMPTY_METRICS: TrialMetrics = {
	turns: 0,
	toolCalls: 0,
	errorTools: 0,
	toolNames: [],
	inputTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	cacheReadTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	finalText: "",
	settled: false,
	usageSamples: 0,
};

interface UsageLike {
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fold one event into the running metrics.
 *
 * Unknown event types are ignored rather than rejected: pi adds event types
 * between releases, and an eval that throws on an unrecognised line would turn
 * a pi upgrade into a corpus-wide failure that looks like a harness regression.
 */
export function foldEvent(metrics: TrialMetrics, event: unknown): TrialMetrics {
	if (typeof event !== "object" || event === null) return metrics;
	const record = event as { type?: string; message?: Record<string, unknown> };

	if (record.type === "agent_settled") return { ...metrics, settled: true };
	if (record.type === "turn_end") return { ...metrics, turns: metrics.turns + 1 };

	// `message_end` is the ONLY place usage is authoritative. `turn_end` carries a
	// message too and would double-count every token if folded here as well.
	if (record.type !== "message_end" || !record.message) return metrics;

	const message = record.message as { role?: string; content?: unknown[]; usage?: UsageLike };
	if (message.role !== "assistant") return metrics;

	const usage = message.usage ?? {};
	// A usage OBJECT that carries no numeric field is as unmeasured as a missing
	// one — some providers send `{}`. Counting it as a sample would restore
	// exactly the false confidence this field exists to remove.
	const reported =
		[usage.input, usage.output, usage.reasoning, usage.cacheRead, usage.totalTokens, usage.cost?.total].some(
			(value) => typeof value === "number" && Number.isFinite(value),
		);
	let next: TrialMetrics = {
		...metrics,
		usageSamples: metrics.usageSamples + (reported ? 1 : 0),
		inputTokens: metrics.inputTokens + num(usage.input),
		outputTokens: metrics.outputTokens + num(usage.output),
		reasoningTokens: metrics.reasoningTokens + num(usage.reasoning),
		cacheReadTokens: metrics.cacheReadTokens + num(usage.cacheRead),
		totalTokens: metrics.totalTokens + num(usage.totalTokens),
		costUsd: metrics.costUsd + num(usage.cost?.total),
	};

	const names: string[] = [];
	let text = "";
	for (const part of message.content ?? []) {
		if (typeof part !== "object" || part === null) continue;
		const item = part as { type?: string; name?: string; toolName?: string; text?: string };
		if (item.type === "toolCall") names.push(item.name ?? item.toolName ?? "(unnamed)");
		if (item.type === "text" && typeof item.text === "string") text = item.text;
	}
	next = {
		...next,
		toolCalls: next.toolCalls + names.length,
		toolNames: [...next.toolNames, ...names],
		finalText: text || next.finalText,
	};
	return next;
}

/** Tool results the model was handed as errors, folded separately from message_end. */
export function foldToolResult(metrics: TrialMetrics, event: unknown): TrialMetrics {
	if (typeof event !== "object" || event === null) return metrics;
	const message = (event as { message?: { role?: string; isError?: boolean } }).message;
	if (message?.role !== "toolResult" || !message.isError) return metrics;
	return { ...metrics, errorTools: metrics.errorTools + 1 };
}

/**
 * Every metric from a run's stdout.
 *
 * Non-JSON lines are skipped silently — npm notices, provider warnings and
 * container noise share the stream, and none of them is a reason to fail a
 * trial that otherwise produced a clean answer.
 */
export function parseRun(stdout: string): TrialMetrics {
	let metrics = EMPTY_METRICS;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		metrics = foldEvent(metrics, event);
		metrics = foldToolResult(metrics, event);
	}
	return metrics;
}
