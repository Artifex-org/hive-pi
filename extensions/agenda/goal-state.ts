/**
 * The goal item and its state machine — pure folds over an immutable record.
 *
 * Persistence is `pi.appendEntry("agenda", item)` on every mutation. Verified
 * properties of that API (`session-manager.js:820-831`, `:166-189`):
 *   - written to the session JSONL as `{type:"custom"}`
 *   - `sessionEntryToContextMessages` returns `[]` for custom entries, so the
 *     goal is **structurally** invisible to the LLM rather than merely omitted
 *   - compaction only ever appends, so it survives
 *   - copied into a fork when on the root→leaf path
 * Append-only: an "update" is a new entry, and "current" is the newest one.
 *
 * THE COUNTER-RESET DIVERGENCE. Claude Code resets a goal's turn count, timer
 * and token baseline on resume, and that is right for it — CC enforces no
 * budget at all, telling you instead to write "or stop after 20 turns" into the
 * condition and letting the evaluator judge it. We add real budgets, and a
 * persisted budget with a resetting spend counter is refreshed on every resume
 * and can never bind. So counters are REHYDRATED here, not zeroed. A goal that
 * hit its cap stays capped across `/reload`.
 */

import { branchEntries, type BranchCtxLike } from "../session-branch/branch.ts";

export type GoalState =
	| "active"
	| "paused"
	| "achieved"
	| "capped"
	| "blocked_user"
	| "budget_exhausted"
	| "cleared";

/** States from which nothing further will happen without the user acting. */
const TERMINAL: ReadonlySet<GoalState> = new Set<GoalState>([
	"achieved",
	"capped",
	"blocked_user",
	"budget_exhausted",
	"cleared",
]);

export function isTerminal(state: GoalState): boolean {
	return TERMINAL.has(state);
}

export interface GoalBudget {
	tokens?: number;
	wallClockMs?: number;
}

export interface GoalLedger {
	/** Automatic continuations injected for this goal. */
	iterations: number;
	maxIterations: number;
	/** Evaluations that produced a real verdict (not an error). */
	turnsEvaluated: number;
	/** Consecutive evaluator failures. Never counted as unmet conditions. */
	judgeErrors: number;
	/**
	 * How many consecutive unmet verdicts have carried the CURRENT reason,
	 * counting the first one. So `MAX_NO_PROGRESS` of 3 means three identical
	 * assessments in a row, not three repeats of a fourth.
	 */
	noProgressStreak: number;
	/**
	 * Consecutive verdicts that could not be graded because the work the
	 * condition names was still in flight.
	 *
	 * Its own counter, beside `judgeErrors`, and for the same reason: neither is
	 * evidence about the goal, so neither may spend an iteration. It is bounded
	 * rather than free (`MAX_PENDING`) because "still running" is exactly what a
	 * job that will NEVER finish also reports, and an unbounded wait would turn
	 * a hung CI run into an immortal goal.
	 */
	pendingStreak: number;
	/** Tokens spent by the EVALUATOR, which is the cost this feature adds. */
	tokens: number;
	budget?: GoalBudget;
}

export interface GoalItem {
	schemaVersion: 1;
	kind: "goal";
	id: string;
	state: GoalState;
	condition: string;
	createdAt: number;
	updatedAt: number;
	lastReason?: string;
	ledger: GoalLedger;
	/**
	 * Conditions this goal has had before, oldest first.
	 *
	 * A revision is legitimate — work moves and a finish line written at turn
	 * three can name a commit that no longer exists — but it is also the shape
	 * of grading yourself against something easier, so it is RECORDED rather
	 * than merely allowed. Absent on a goal that was never revised.
	 */
	revisions?: GoalRevision[];
}

export interface GoalRevision {
	at: number;
	/** The condition being left behind. */
	from: string;
}

export const GOAL_ENTRY_TYPE = "agenda";
export const MAX_CONDITION_CHARS = 4000;
export const DEFAULT_MAX_ITERATIONS = 8;
export const MAX_JUDGE_ERRORS = 3;
export const MAX_NO_PROGRESS = 3;
/**
 * How many consecutive "still in flight" verdicts to wait through.
 *
 * Larger than the other two caps on purpose. A judge error and a repeated
 * reason are both signs something is WRONG, and three is the right patience for
 * a fault; waiting is not a fault, and the thing most often waited on here is a
 * CI run measured in tens of minutes against a settle measured in seconds.
 * Twelve keeps a genuinely stuck goal bounded while covering the case the
 * measurement found. The token and wall-clock budget still apply underneath, so
 * this is a backstop rather than the only limit.
 */
export const MAX_PENDING = 12;

export function createGoal(
	id: string,
	condition: string,
	now: number,
	options: { maxIterations?: number; budget?: GoalBudget } = {},
): GoalItem {
	return {
		schemaVersion: 1,
		kind: "goal",
		id,
		state: "active",
		condition,
		createdAt: now,
		updatedAt: now,
		ledger: {
			iterations: 0,
			maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			turnsEvaluated: 0,
			judgeErrors: 0,
			noProgressStreak: 0,
			pendingStreak: 0,
			tokens: 0,
			budget: options.budget,
		},
	};
}

/** Why an evaluation cycle ended. Drives both the injection and the metric. */
export type GoalOutcome =
	| { kind: "achieved"; reason: string }
	| { kind: "continue"; reason: string; remaining: number }
	| { kind: "capped"; reason: string }
	| { kind: "blocked_user"; reason: string }
	| { kind: "budget_exhausted"; reason: string }
	| { kind: "pending"; reason: string; waited: number }
	| { kind: "judge_error"; message: string; paused: boolean };

/**
 * Fold a successful verdict into the goal. Pure — the caller persists.
 *
 * Order matters and is deliberate: achievement is checked before every limit,
 * so a goal that is genuinely done on its last allowed iteration closes as
 * `achieved` rather than `capped`.
 */
export function applyVerdict(
	goal: GoalItem,
	verdict: { ok: boolean; reason: string; pending?: boolean },
	now: number,
	spentTokens: number,
): { goal: GoalItem; outcome: GoalOutcome } {
	const sameReason = goal.lastReason !== undefined && goal.lastReason === verdict.reason;
	const ledger: GoalLedger = {
		...goal.ledger,
		turnsEvaluated: goal.ledger.turnsEvaluated + 1,
		judgeErrors: 0, // a real verdict clears the error streak
		// A gradeable verdict means the wait is over, whichever way it went.
		pendingStreak: verdict.pending && !verdict.ok ? goal.ledger.pendingStreak : 0,
		tokens: goal.ledger.tokens + spentTokens,
		// Counts occurrences of the current reason, so the first unmet verdict is
		// already a streak of 1 and three identical ones in a row trip the check.
		noProgressStreak: verdict.ok ? 0 : sameReason ? goal.ledger.noProgressStreak + 1 : 1,
	};

	const base = { ...goal, lastReason: verdict.reason, updatedAt: now, ledger };

	// PENDING is handled before every limit except achievement, and spends no
	// iteration. The order mirrors `applyJudgeError`: an answer that is not
	// evidence about the goal must not be charged as though it were.
	//
	// It deliberately does NOT clear on a changing reason the way
	// `noProgressStreak` does. A pending reason names live counts ("1 of 10
	// succeeded") that differ on every poll, so a streak that reset on a changed
	// reason would never reach its cap — which is precisely how the binary
	// verdict let these goals run to the iteration cap instead.
	if (verdict.pending && !verdict.ok) {
		const pendingStreak = goal.ledger.pendingStreak + 1;
		const waiting: GoalItem = { ...base, ledger: { ...ledger, pendingStreak } };
		if (pendingStreak < MAX_PENDING && !isBudgetExhausted(waiting.ledger, base.createdAt, now)) {
			return { goal: waiting, outcome: { kind: "pending", reason: verdict.reason, waited: pendingStreak } };
		}
		// Out of patience: fall through and charge it as an ordinary unmet
		// verdict, so a goal waiting on something that never lands still
		// terminates through the paths that already exist.
	}

	if (verdict.ok) {
		return { goal: { ...base, state: "achieved" }, outcome: { kind: "achieved", reason: verdict.reason } };
	}

	// The convergence check. Without it a review-shaped condition ("no
	// remaining issues") never terminates: the critic manufactures a new
	// objection every turn, or repeats the same one forever.
	if (ledger.noProgressStreak >= MAX_NO_PROGRESS) {
		return {
			goal: { ...base, state: "blocked_user" },
			outcome: { kind: "blocked_user", reason: verdict.reason },
		};
	}

	if (isBudgetExhausted(ledger, base.createdAt, now)) {
		return {
			goal: { ...base, state: "budget_exhausted" },
			outcome: { kind: "budget_exhausted", reason: verdict.reason },
		};
	}

	const iterations = ledger.iterations + 1;
	const withIteration: GoalItem = { ...base, ledger: { ...ledger, iterations } };

	if (iterations >= ledger.maxIterations) {
		return { goal: { ...withIteration, state: "capped" }, outcome: { kind: "capped", reason: verdict.reason } };
	}

	return {
		goal: withIteration,
		outcome: { kind: "continue", reason: verdict.reason, remaining: ledger.maxIterations - iterations },
	};
}

/** Fold an evaluator failure. Never a "condition not met"; never injects. */
export function applyJudgeError(
	goal: GoalItem,
	message: string,
	now: number,
	spentTokens: number,
): { goal: GoalItem; outcome: GoalOutcome } {
	const judgeErrors = goal.ledger.judgeErrors + 1;
	const paused = judgeErrors >= MAX_JUDGE_ERRORS;
	const ledger: GoalLedger = { ...goal.ledger, judgeErrors, tokens: goal.ledger.tokens + spentTokens };
	return {
		goal: { ...goal, updatedAt: now, ledger, state: paused ? "paused" : goal.state },
		outcome: { kind: "judge_error", message, paused },
	};
}

export function isBudgetExhausted(ledger: GoalLedger, createdAt: number, now: number): boolean {
	const budget = ledger.budget;
	if (!budget) return false;
	if (budget.tokens !== undefined && ledger.tokens >= budget.tokens) return true;
	if (budget.wallClockMs !== undefined && now - createdAt >= budget.wallClockMs) return true;
	return false;
}

export function withState(goal: GoalItem, state: GoalState, now: number): GoalItem {
	return { ...goal, state, updatedAt: now };
}

/**
 * Recover the newest goal from persisted session entries.
 *
 * Scans BACKWARDS and stops at the first match, because the log is append-only
 * and the newest entry wins. Every field is re-validated rather than trusted:
 * these entries survive pin bumps and hand-edited session files, and a
 * malformed `maxIterations` would otherwise become an unbounded budget.
 */
export function rehydrateGoal(entries: readonly unknown[]): GoalItem | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== GOAL_ENTRY_TYPE) continue;
		const item = validateGoal(entry.data);
		if (item) return item;
	}
	return null;
}

/**
 * The same recovery, scoped to the ACTIVE BRANCH — which is what a caller
 * holding a live `ctx` should use.
 *
 * `rehydrateGoal(getEntries())` reads every entry the session file has ever
 * held, so on a tree it can restore a goal that belongs to a branch this
 * session abandoned. A goal is the worst of the branch-scoped documents to get
 * wrong: it does not merely display, it drives the driver's injections, so the
 * agent goes on pursuing a condition written for work the operator walked away
 * from — and the ledger it enforces the budget against is that other branch's.
 *
 * Kept HERE rather than at the call site so the entries-taking fold stays pure
 * and separately testable, and so the sibling recoveries in `loop-state.ts` and
 * `conductor-state.ts` have one obvious thing to copy.
 */
export function rehydrateGoalFromBranch(ctx: BranchCtxLike | null | undefined): GoalItem | null {
	return rehydrateGoal(branchEntries(ctx));
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function validateGoal(data: unknown): GoalItem | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "goal") return null;
	if (record.schemaVersion !== 1) return null; // a newer writer's shape is not ours to guess at
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.condition !== "string" || record.condition.length === 0) return null;

	const state = record.state;
	const validStates: GoalState[] = [
		"active",
		"paused",
		"achieved",
		"capped",
		"blocked_user",
		"budget_exhausted",
		"cleared",
	];
	if (typeof state !== "string" || !validStates.includes(state as GoalState)) return null;

	const rawLedger = (record.ledger ?? {}) as Record<string, unknown>;
	const rawBudget = rawLedger.budget as Record<string, unknown> | undefined;
	const budget: GoalBudget | undefined =
		rawBudget && typeof rawBudget === "object"
			? {
					tokens: typeof rawBudget.tokens === "number" ? rawBudget.tokens : undefined,
					wallClockMs: typeof rawBudget.wallClockMs === "number" ? rawBudget.wallClockMs : undefined,
				}
			: undefined;

	return {
		schemaVersion: 1,
		kind: "goal",
		id: record.id,
		state: state as GoalState,
		condition: record.condition,
		createdAt: positiveInt(record.createdAt, 0),
		updatedAt: positiveInt(record.updatedAt, 0),
		lastReason: typeof record.lastReason === "string" ? record.lastReason : undefined,
		ledger: {
			// Rehydrated, NOT zeroed — see the header. A resetting spend counter
			// makes a persisted budget unenforceable.
			iterations: positiveInt(rawLedger.iterations, 0),
			maxIterations: Math.max(1, positiveInt(rawLedger.maxIterations, DEFAULT_MAX_ITERATIONS)),
			turnsEvaluated: positiveInt(rawLedger.turnsEvaluated, 0),
			judgeErrors: positiveInt(rawLedger.judgeErrors, 0),
			noProgressStreak: positiveInt(rawLedger.noProgressStreak, 0),
			pendingStreak: positiveInt(rawLedger.pendingStreak, 0),
			tokens: positiveInt(rawLedger.tokens, 0),
			budget,
		},
	};
}

/**
 * reviseGoal replaces an active goal's condition, keeping everything it has
 * spent.
 *
 * THE LEDGER IS CARRIED ON PURPOSE. A revision that reset iterations, tokens or
 * the wall-clock budget would turn "restate the condition" into an unbounded
 * loop with extra steps — the cap is what makes an automatic driver safe, and a
 * verb that clears it is a bypass whoever added it did not mean to add.
 *
 * The old condition is appended to `revisions`, so the trail is in the goal
 * itself and survives into the ledger and the Hive workspace.
 */
export function reviseGoal(goal: GoalItem, condition: string, now: number): GoalItem {
	return {
		...goal,
		condition,
		updatedAt: now,
		revisions: [...(goal.revisions ?? []), { at: now, from: goal.condition }],
	};
}
