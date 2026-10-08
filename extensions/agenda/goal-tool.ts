/**
 * The goal's model-facing surface — `goal_set`'s decision and the goal
 * readout — as pure functions.
 *
 * Lifted out of `index.ts` so the pi tool and the Claude adapter's MCP
 * `goal_set`/`goal_status`/`goal_clear` answer with the same rules and the same
 * words: an active goal is never silently replaced (`replace` REVISES it and
 * the budget keeps counting), an unverifiable condition is bounced, and a new
 * goal gets the default 300k evaluator-token budget.
 */

import { looksUnverifiable } from "./goal-command.ts";
import { createGoal, isTerminal, reviseGoal, type GoalItem } from "./goal-state.ts";

/** The evaluator token budget a goal gets when the caller names none. */
export const DEFAULT_GOAL_TOKENS = 300_000;

export interface GoalSetParams {
	condition: string;
	/** Revise the ACTIVE goal's condition instead of refusing. */
	replace?: boolean;
	/** Evaluator token budget. */
	tokens?: number;
	/** Wall-clock budget in hours. */
	hours?: number;
}

export type GoalSetDecision = { ok: true; goal: GoalItem; text: string } | { ok: false; text: string };

/**
 * What `goal_set` does with `params` given the `current` goal. Pure: the
 * caller persists `goal`. `mintId` is called only when a NEW goal is created.
 *
 * Both shaping behaviours are ERRORS rather than warnings (tool errors change
 * model behaviour; description prose does not).
 */
export function goalSetDecision(current: GoalItem | null, params: GoalSetParams, now: number, mintId: () => string): GoalSetDecision {
	const condition = params.condition.trim();
	if (!condition) return { ok: false, text: "goal_set needs a condition." };
	if (current && !isTerminal(current.state) && !params.replace) {
		return {
			ok: false,
			text:
				`A goal is already active: "${current.condition}". If this is the SAME task and the ` +
				`condition has simply moved on — a new sha, a renamed check — call goal_set again with ` +
				`\`replace: true\`: the old condition is recorded and the budget keeps counting. ` +
				`If it is different work, finish this one or ask the user for \`/goal clear\`.`,
		};
	}
	if (looksUnverifiable(condition)) {
		return {
			ok: false,
			text:
				"This condition names nothing machine-checkable, so the judge could only grade your own " +
				"self-report. Restate it with a command, a path, or a count — e.g. " +
				'"PR created and `gh pr checks` exits 0" or "0 errors from the repo gate".',
		};
	}
	// A REVISION, not a new goal: same id, same ledger, one more entry in the
	// trail. Clearing and re-setting would reset the budget — exactly the
	// escape hatch this must not open.
	if (current && !isTerminal(current.state) && params.replace) {
		const revised = reviseGoal(current, condition, now);
		return {
			ok: true,
			goal: revised,
			text: `Goal revised: ${condition}\nWas: ${current.condition}\nIterations and budget carry over — a revision does not buy fresh ones.`,
		};
	}
	const goal = createGoal(mintId(), condition, now, {
		budget: {
			tokens: params.tokens ?? DEFAULT_GOAL_TOKENS,
			...(params.hours ? { wallClockMs: Math.round(params.hours * 3_600_000) } : {}),
		},
	});
	return {
		ok: true,
		goal,
		text:
			`Goal set: ${condition}\nThe evaluator runs only when Pi becomes idle (agent_settled); ` +
			"it does not evaluate active or interrupted tool chains. The user can stop it with /goal clear.",
	};
}

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * The `/goal` readout. Pure so its wording is testable.
 *
 * Reports `turnsEvaluated` alongside the state, because an ACTIVE goal that has
 * evaluated zero turns is the "success-shaped nothing" failure — armed,
 * reporting healthy, and doing nothing — and it must not look like a goal that
 * is working.
 */
export function describeGoal(goal: GoalItem | null, now: number): string {
	if (!goal) return "No goal set.";

	const lines = [
		`Goal (${goal.state}): ${goal.condition}`,
		`  elapsed ${formatElapsed(now - goal.createdAt)} · continuations ${goal.ledger.iterations}/${goal.ledger.maxIterations} · evaluated ${goal.ledger.turnsEvaluated} turn(s) · evaluator spend ${goal.ledger.tokens} tokens`,
	];

	if (goal.ledger.budget?.tokens !== undefined) {
		lines.push(`  token budget ${goal.ledger.tokens}/${goal.ledger.budget.tokens}`);
	}
	if (goal.ledger.budget?.wallClockMs !== undefined) {
		lines.push(
			`  time budget ${formatElapsed(now - goal.createdAt)}/${formatElapsed(goal.ledger.budget.wallClockMs)}`,
		);
	}
	if (goal.lastReason) lines.push(`  latest: ${goal.lastReason}`);
	if (goal.ledger.judgeErrors > 0) lines.push(`  evaluator errors: ${goal.ledger.judgeErrors} consecutive`);
	if (goal.lastJudgeError) {
		lines.push(`  last evaluator error (${new Date(goal.lastJudgeError.at).toISOString()}): ${goal.lastJudgeError.message}`);
	}

	if (goal.state === "active" && goal.ledger.turnsEvaluated === 0) {
		lines.push("  ⚠ armed but has evaluated nothing yet");
	}
	if (isTerminal(goal.state)) lines.push("  (finished — `/goal <condition>` to set a new one)");

	return lines.join("\n");
}
