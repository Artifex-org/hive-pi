/**
 * `/goal` argument grammar — pure, so the whole matrix is testable without pi.
 *
 * pi hands the command handler the raw remainder after the first space and does
 * no parsing of its own.
 *
 *   /goal <condition…>              set (replaces any existing)
 *   /goal --tokens 200k <cond…>     with a token budget
 *   /goal --hours 4 <cond…>         with a wall-clock budget
 *   /goal                           status
 *   /goal clear|stop|off|none|cancel|reset
 *   /goal pause|resume
 *
 * A subcommand keyword only counts when it is the WHOLE argument. `/goal stop
 * the nightly sync from double-running` is a goal, not a stop — the alternative
 * silently discards someone's condition because it happened to start with a
 * reserved word.
 */

import { MAX_CONDITION_CHARS, type GoalBudget } from "./goal-state.ts";

export type GoalCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "set"; condition: string; budget?: GoalBudget }
	| { kind: "error"; message: string };

const CLEAR_WORDS = new Set(["clear", "stop", "off", "none", "cancel", "reset"]);

/** `200k` → 200000, `1.5m` → 1500000, `50000` → 50000. */
export function parseTokenCount(raw: string): number | null {
	const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return null;
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.round(value * scale);
}

export function parseHours(raw: string): number | null {
	const value = Number.parseFloat(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return null;
	return Math.round(value * 3_600_000);
}

export function parseGoalCommand(args: string): GoalCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { kind: "status" };

	const lowered = trimmed.toLowerCase();
	if (CLEAR_WORDS.has(lowered)) return { kind: "clear" };
	if (lowered === "pause") return { kind: "pause" };
	if (lowered === "resume") return { kind: "resume" };

	// Flags must precede the condition; the first non-flag token ends them.
	let rest = trimmed;
	const budget: GoalBudget = {};
	let sawFlag = false;

	while (rest.startsWith("--")) {
		const match = rest.match(/^(--[a-z-]+)(?:\s+(\S+))?\s*([\s\S]*)$/i);
		if (!match) break;
		const [, flag, value, remainder] = match;

		if (flag === "--tokens") {
			if (!value) return { kind: "error", message: "--tokens needs a value, e.g. --tokens 200k" };
			const tokens = parseTokenCount(value);
			if (tokens === null) return { kind: "error", message: `not a token count: "${value}" (try 200k or 1.5m)` };
			budget.tokens = tokens;
		} else if (flag === "--hours") {
			if (!value) return { kind: "error", message: "--hours needs a value, e.g. --hours 4" };
			const ms = parseHours(value);
			if (ms === null) return { kind: "error", message: `not a number of hours: "${value}"` };
			budget.wallClockMs = ms;
		} else {
			return { kind: "error", message: `unknown flag "${flag}" — supported: --tokens, --hours` };
		}

		sawFlag = true;
		rest = remainder.trim();
	}

	if (rest.length === 0) {
		return {
			kind: "error",
			message: sawFlag ? "a budget flag needs a condition after it" : "a goal needs a condition",
		};
	}

	if (rest.length > MAX_CONDITION_CHARS) {
		return {
			kind: "error",
			message: `condition is ${rest.length} characters; the limit is ${MAX_CONDITION_CHARS}`,
		};
	}

	const hasBudget = budget.tokens !== undefined || budget.wallClockMs !== undefined;
	return { kind: "set", condition: rest, ...(hasBudget ? { budget } : {}) };
}

/**
 * Does this condition name anything a judge could actually check?
 *
 * Advisory only — warn, never refuse. A condition with no checkable token
 * ("make the code better") is graded purely on the model's self-report, which
 * is how a goal runs to its cap without ever converging. Saying so once at set
 * time costs nothing and is the difference between a user who knows that and
 * one who thinks the harness is broken.
 */
export function looksUnverifiable(condition: string): boolean {
	const signals = [
		/\bexits? 0\b/i,
		/\bpass(es|ing|ed)?\b/i,
		/\bgreen\b/i,
		/\bfail(s|ing)?\b/i,
		/`[^`]+`/, // a quoted command
		/\b[\w./-]+\.(ts|tsx|js|py|go|rs|json|md|yaml|yml)\b/i, // a path
		/\b\d+\s*(tests?|errors?|warnings?)\b/i,
	];
	return !signals.some((pattern) => pattern.test(condition));
}
