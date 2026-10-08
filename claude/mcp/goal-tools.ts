/**
 * `goal_set`, `goal_status`, `goal_clear` — the goal the Stop hook's judge
 * reads, with agenda's own rules (`agenda/goal-tool.ts`) and readout
 * (`describeGoal`). `goal_clear` is `/goal clear`: the goal is kept, marked
 * `cleared`, so its spend stays on record.
 *
 * ONE DIFFERENCE FROM PI, and it is the budget. In pi, clearing is the user's
 * slash command; here `/hive:goal clear` runs AS THE MODEL through this tool,
 * so "clear, then set again" would hand the model a fresh iteration cap and
 * token budget whenever it liked. The budget is therefore session-scoped: a
 * goal set after the last one was cleared, capped or ran out of budget is a
 * REVISION of it (agenda's own `replace` path) — new condition, same ledger.
 * Only an achieved goal (or one that waits on a person) makes room for a
 * fresh budget.
 */

import { describeGoal, goalSetDecision, type GoalWording } from "../../extensions/agenda/goal-tool.ts";
import { withState, type GoalState } from "../../extensions/agenda/goal-state.ts";
import { readGoal, writeGoal } from "../agenda-state.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

/** A Claude session's names for the judge's trigger and the clear verb. */
const CLAUDE_GOAL_WORDING: GoalWording = {
	judgedWhen: "each time you stop (the Stop hook); it does not evaluate while tools are still running",
	// The USER's command — never a pointer at the tool as a way out.
	clear: "`/hive:goal clear`",
};

/** Stopped states whose ledger a new goal continues. */
const CARRY_LEDGER: ReadonlySet<GoalState> = new Set<GoalState>(["cleared", "capped", "budget_exhausted"]);

export const GOAL_TOOLS: ToolDefinition[] = [
	{
		name: "goal_set",
		description:
			"Set a machine-checkable finish condition for the current work. A cheap judge on another model family evaluates it " +
			"each time you stop, and re-drives you until it holds (bounded by caps and the budget). " +
			'Example condition: "PR created and `gh pr checks` reports all green".',
		inputSchema: {
			type: "object",
			properties: {
				condition: { type: "string", description: "The finish condition. Name something checkable: a command, a path, a count." },
				replace: {
					type: "boolean",
					description:
						"Revise the ACTIVE goal's condition instead of refusing. The previous condition is recorded and the budget keeps " +
						"counting — a revision buys no fresh iterations.",
				},
				budget: {
					type: "object",
					description: "Limits on the judge's spend. Default: 300000 evaluator tokens, no time limit.",
					properties: {
						tokens: { type: "integer", minimum: 1, description: "Evaluator token budget." },
						hours: { type: "number", exclusiveMinimum: 0, description: "Wall-clock budget in hours." },
					},
					additionalProperties: false,
				},
			},
			required: ["condition"],
			additionalProperties: false,
		},
	},
	{
		name: "goal_status",
		description: "Show the current goal: its state, continuations used, the judge's latest reason, budget spend and any judge errors.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "goal_clear",
		description:
			"Clear the current goal (the judge stops re-driving) — for the user's `/hive:goal clear`. Its record is kept as " +
			"`cleared`, and clearing does not reset this session's goal budget.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function goalSet(stateDir: string, args: Record<string, unknown>, now: number, modelUnavailable: string | null): ToolResult {
	// A goal nobody can judge is a goal that silently never closes.
	if (modelUnavailable) return { text: `goal_set refused: ${modelUnavailable}, so no judge could grade a goal.`, isError: true };
	if (typeof args.condition !== "string") return { text: "goal_set needs a condition (a string).", isError: true };
	const budget = (args.budget && typeof args.budget === "object" ? args.budget : {}) as { tokens?: unknown; hours?: unknown };
	const tokens = positive(budget.tokens);
	const hours = positive(budget.hours);
	const current = readGoal(stateDir);
	// Session-scoped budget (see the header): a stopped goal is revived and
	// REVISED, never replaced, so its spent iterations and tokens carry over.
	const carried = current !== null && CARRY_LEDGER.has(current.state);
	const decision = goalSetDecision(
		carried ? withState(current, "active", now) : current,
		{
			condition: args.condition,
			replace: carried || args.replace === true,
			...(tokens !== undefined ? { tokens: Math.round(tokens) } : {}),
			...(hours !== undefined ? { hours } : {}),
		},
		now,
		() => `goal-${now.toString(36)}-${process.pid.toString(36)}`,
		CLAUDE_GOAL_WORDING,
	);
	if (!decision.ok) return { text: decision.text, isError: true };
	writeGoal(stateDir, decision.goal);
	if (!carried) return { text: decision.text };
	const ledger = decision.goal.ledger;
	return {
		text:
			`The previous goal was ${current.state}; this session's goal budget carries over ` +
			`(${ledger.iterations}/${ledger.maxIterations} continuations, ${ledger.tokens} evaluator tokens spent).\n${decision.text}`,
	};
}

export function goalStatus(stateDir: string, now: number): ToolResult {
	return { text: describeGoal(readGoal(stateDir), now) };
}

export function goalClear(stateDir: string, now: number): ToolResult {
	const goal = readGoal(stateDir);
	if (!goal) return { text: "No goal set." };
	writeGoal(stateDir, withState(goal, "cleared", now));
	return { text: `Goal cleared: ${goal.condition}` };
}
