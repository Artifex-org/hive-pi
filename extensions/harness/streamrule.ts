/**
 * Stream rules — hold-back interception of a model's own output (HIV-1568).
 *
 * SPIKE ARTIFACT. The mechanism is proven and tested; it is not wired to a
 * provider. Read the ceiling below before wiring it, because the ceiling is the
 * finding.
 *
 * oh-my-pi advertises "a regex match aborts the stream mid-token, injects the
 * rule as a system reminder, and retries from the same point". The appeal for
 * us is that EVERY steering instrument we own is post-hoc — the agenda driver
 * injects at `agent_settled`, the gate runs after a change, drift grades every
 * 5th settle, held-out scanning runs at verify. All of them pay for a completed
 * wrong turn before correcting it. Catching `# type: ignore` as it is emitted
 * costs a few tokens instead.
 *
 * ## What the spike found
 *
 * It is extension-reachable, with a hard limit. `Provider.streamSimple(model,
 * context, options): AssistantMessageEventStream` means a decorating provider
 * can consume the inner stream and emit its own — so interception needs no core
 * change (which is what `registerProvider` was already known to allow for
 * failover).
 *
 * But **a decorator cannot retract a delta pi has already consumed.** Once a
 * chunk is emitted downstream it is folded into the message. So "abort
 * mid-token" is only achievable for text still inside a HOLD-BACK BUFFER: emit
 * N characters behind the stream, and any pattern that completes within the
 * last N characters can be suppressed before anyone sees it.
 *
 * That makes the honest description **window-limited enforcement**, not
 * mid-token retry. A rule whose match completes further back than the window is
 * already public and can only be corrected the way we correct things today.
 * True retract-and-retry needs the agent loop, i.e. core → an upstream PR, per
 * HIV-1070's revisit criteria.
 *
 * ## Why the window is not a formality
 *
 * The patterns we would actually enforce are short — `# type: ignore`, `noqa`,
 * `eslint-disable`, `as unknown as`. A 200-character window covers them many
 * times over. The window only fails for long-range patterns, which regex is a
 * poor detector for anyway.
 *
 * ## Costs, for whoever wires this up
 *
 * - **Latency**: holding back N characters delays visible output by however
 *   long the model takes to produce N more. At streaming speeds this is tens of
 *   milliseconds, but it is not zero and it is felt in the TUI.
 * - **Cache**: re-issuing a request after a suppression re-sends the prefix.
 *   Our cache-stability contract (technique #1, the 22%→84% swing) makes that a
 *   real cost, not a rounding error — so suppression must be rare.
 * - **False positives are worse than the disease.** A rule that fires on the
 *   model *discussing* `# type: ignore` in prose, or inside a thinking block,
 *   taxes good turns invisibly. Hence `skipInThinking` and the requirement that
 *   every rule be anchored to code-shaped context.
 */

export interface StreamRule {
	/** Stable name, for the reminder and for metrics. */
	name: string;
	/** What to catch. Kept anchored and short — see the false-positive note. */
	pattern: RegExp;
	/** The system reminder injected when this fires. */
	reminder: string;
}

/** Characters held back. Must exceed the longest pattern's match by a margin. */
export const DEFAULT_WINDOW = 200;

export interface HoldBackResult {
	/** Safe to emit downstream now. */
	emit: string;
	/** Still inside the window, not yet emitted. */
	held: string;
	/** The rule that matched inside the held region, if any. */
	violation?: StreamRule;
}

/**
 * The core operation: given everything buffered but unemitted, decide how much
 * is safe to release.
 *
 * A match is only actionable while it is still held — that is the entire
 * property this function exists to provide, and the reason `emit` never
 * includes text that a rule matched.
 */
export function holdBack(buffered: string, rules: StreamRule[], window = DEFAULT_WINDOW): HoldBackResult {
	for (const rule of rules) {
		// `lastIndex` is per-RegExp state; a global rule reused across calls
		// would skip matches. Test against a fresh, non-global copy.
		const probe = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/g/g, ""));
		if (probe.test(buffered)) {
			return { emit: "", held: buffered, violation: rule };
		}
	}
	if (buffered.length <= window) return { emit: "", held: buffered };
	return { emit: buffered.slice(0, buffered.length - window), held: buffered.slice(buffered.length - window) };
}

/** The reminder text handed back to the model on re-issue. */
export function buildReminder(rule: StreamRule, suppressed: string): string {
	const excerpt = suppressed.length > 200 ? `…${suppressed.slice(-200)}` : suppressed;
	return [
		`<system-reminder rule="${rule.name}">`,
		rule.reminder,
		"",
		"You were about to write:",
		"```",
		excerpt.trim(),
		"```",
		"That output was discarded before it was shown. Continue from where you left off, without it.",
		"</system-reminder>",
	].join("\n");
}

export interface StreamChunk {
	text: string;
}

export interface InterceptOutcome {
	/** Everything actually released downstream. */
	emitted: string;
	/** Fired rules, in order. */
	violations: { rule: StreamRule; suppressed: string }[];
	/** How many times the stream was re-issued. */
	reissues: number;
}

/**
 * Drive a stream through the rules, re-issuing on a violation.
 *
 * `open(reminders)` produces a fresh stream; on a violation the caller's
 * reminders grow and the stream is re-opened, which is the closest an extension
 * can get to "retry from the same point". Bounded by `maxReissues`, because a
 * model that keeps producing the same forbidden text would otherwise loop
 * forever burning a full request each time.
 */
export async function interceptStream(
	open: (reminders: string[]) => AsyncIterable<StreamChunk>,
	rules: StreamRule[],
	options: { window?: number; maxReissues?: number } = {},
): Promise<InterceptOutcome> {
	const window = options.window ?? DEFAULT_WINDOW;
	const maxReissues = options.maxReissues ?? 2;
	const reminders: string[] = [];
	const violations: { rule: StreamRule; suppressed: string }[] = [];
	let emitted = "";
	let reissues = 0;

	for (;;) {
		let buffered = "";
		let violated = false;
		for await (const chunk of open(reminders)) {
			buffered += chunk.text;
			const result = holdBack(buffered, rules, window);
			if (result.violation) {
				violations.push({ rule: result.violation, suppressed: result.held });
				reminders.push(buildReminder(result.violation, result.held));
				violated = true;
				// Abandon the rest of this stream: everything after the match is
				// downstream of a decision we are rejecting.
				break;
			}
			emitted += result.emit;
			buffered = result.held;
		}
		if (!violated) {
			// Flush the window — the stream ended, so nothing more can match.
			emitted += buffered;
			return { emitted, violations, reissues };
		}
		reissues++;
		if (reissues > maxReissues) return { emitted, violations, reissues };
	}
}

/** The rules we would actually ship, all from house lessons. Anchored short. */
export const HOUSE_RULES: StreamRule[] = [
	{
		name: "suppression-directive",
		pattern: /#\s*type:\s*ignore|#\s*noqa|eslint-disable|@ts-(ignore|expect-error)/,
		reminder:
			"House rule: do not silence a type or lint error with a suppression directive. Fix the contract, " +
			"or say explicitly why the error is wrong. This is the evasion class an autofix already shipped once.",
	},
	{
		name: "unsafe-cast",
		pattern: /as\s+unknown\s+as\s/,
		reminder:
			"House rule: `as unknown as` is a cast through the type system, not a fix. Model the real shape, " +
			"or narrow with a type guard.",
	},
	{
		name: "sleep-poll",
		pattern: /\bsleep\s+\d+\s*;\s*(?!\s*done)\S/,
		reminder:
			"House rule: `sleep N; <command>` is guard-blocked. Poll external state with a Monitor until-loop " +
			"(the sleep goes INSIDE the loop body), or use the tool that waits properly.",
	},
];
