/**
 * The closing-report check: one nudge when a run that opened a PR ends on a
 * receipt instead of a report.
 *
 * Measured in the harness evals (rounds 1-6, 2026-10): pi+Sol's last message
 * after opening a PR was 33-45 words (median 36) where the global
 * instructions ask for 200-400, while pi+Opus on the same tasks wrote about
 * 480. An instruction-only fix (artifex-pi #353, "the report is read in the
 * chat, not in the PR") moved a `pi -p` probe but not a real session (round 6:
 * 44 words), so the check runs at the settle instead, where the short message
 * is a fact rather than a prediction.
 *
 * It asks for the report only. The injection forbids tools, edits and pushes,
 * so a session told to stop at its PR does not start new work, and it is
 * charged once per session: a model that answers with another short message is
 * not asked again.
 */

import { atCap, record } from "./ledger.ts";
import type { Policy, PolicyContext, PolicyWork } from "./policy.ts";

export const REPORT_LEDGER_ID = "report:closing";

/**
 * Below this, a message after a PR opening is a receipt. The instructions ask
 * for 200-400 words; a third of the floor leaves room for a genuinely small
 * change, which the instructions allow "a line or two" only when no PR ships.
 */
export const REPORT_MIN_WORDS = 120;

export function wordCount(text: string | undefined): number {
	return (text ?? "").split(/\s+/).filter(Boolean).length;
}

export function reportInjection(words: number): string {
	return [
		`Report check: this run opened a PR, and your closing message is ${words} words.`,
		"The end-of-turn report is read in the chat, not in the PR description.",
		"Write it now as your reporting instructions describe: the outcome and PR link first, then what is unverified,",
		"what changed as behaviour, the tests that ran and those that did not, and your decisions.",
		"Do not run tools, change files or push: this turn is only the report.",
	].join(" ");
}

export function createReportPolicy(): Policy {
	return {
		name: "report",
		decide(context: PolicyContext): PolicyWork | null {
			if (!context.signals?.prOpenedSinceUser) return null;
			if (atCap(context.ledger, REPORT_LEDGER_ID, 1)) return null;
			const words = wordCount(context.lastAssistantText);
			if (words >= REPORT_MIN_WORDS) return null;
			return {
				name: "report",
				status: "report: asking for the end-of-turn report",
				run: async () => ({
					metric: { outcome: "pass" as const, value: words },
					inject: reportInjection(words),
					ledger: (state) => record(state, REPORT_LEDGER_ID),
				}),
			};
		},
	};
}
