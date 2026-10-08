/**
 * Stop (synchronous) — the agenda chain, as the pi driver runs it.
 *
 * Chain, in pi's order restricted to what applies to a Claude session:
 *   repo gate (`.pi/harness.json`) → drift probe (every 5th settle with an
 *   active goal) → goal judge (active goal).
 * pi's `ask` and `advisor-watch` policies are not here: the first converts a
 * prose question into a pi question card, the second rides pi's own model
 * registry.
 *
 * Everything that decides is pi's: the walk (`agenda/chain.ts`, at most ONE
 * continuation per settle), the policies (`createGatePolicy`,
 * `createDriftPolicy`, `createGoalPolicy`), the goal's state machine and its
 * budgets, the hand-back guard (`classifyHandback`) and the turn-failure check
 * (`turnFailureOf`). What the hook adds is persistence (each settle is a fresh
 * process), accounting, and a wall clock.
 *
 * `stop_hook_active` (Claude is already continuing because of a Stop hook) is
 * deliberately NOT a reason to stand down. A goal loop IS a chain of such
 * continuations — standing down would give a goal exactly one continuation
 * per user prompt, which is not pi's semantics. What stops a runaway loop is
 * what stops it in pi: the goal's iteration cap, no-progress and pending
 * streaks, token/wall-clock budget and three-judge-errors pause, the gate's
 * `maxInjections`, and drift's per-goal realignment cap — all persisted, and
 * every charge is written BEFORE the block is printed.
 */

import { classifyHandback, handbackClass } from "../../extensions/hive-common/handback.ts";
import { walkChain } from "../../extensions/agenda/chain.ts";
import { createDriftPolicy } from "../../extensions/agenda/drift.ts";
import { createGatePolicy } from "../../extensions/agenda/gate.ts";
import { createGoalPolicy } from "../../extensions/agenda/goal.ts";
import { applyJudgeError, type GoalItem } from "../../extensions/agenda/goal-state.ts";
import type { MetricOutcome, Policy } from "../../extensions/agenda/policy.ts";
import { recapTranscript } from "../../extensions/agenda/recap.ts";
import { turnFailureOf } from "../../extensions/agenda/turn-outcome.ts";
import { readAgendaState, readGoal, writeAgendaState, writeGoal } from "../agenda-state.ts";
import type { ModelResolution } from "../models.ts";
import { accountedOneShot, type OneShot } from "../oneshot.ts";
import type { GateOutcome, Spool } from "../spool.ts";
import { readClaudeTranscript, withFinalAssistant, type PiEntry } from "../transcript.ts";
import { blockStop, type HookInput, type HookOutput } from "./io.ts";

/** The hook's own wall clock. The plugin's timeout is 180 s; this ends well inside 120 s. */
export const STOP_BUDGET_MS = 110_000;
/** Below this much time left a drift probe is skipped, so the goal judge (the one that can continue) keeps its time. */
export const DRIFT_MIN_REMAINING_MS = 100_000;
/** The driver's transcript excerpt for policies (driver.ts uses the same 16k). */
const POLICY_TRANSCRIPT_CHARS = 16_000;
/**
 * The confirming judge pass's level when the evaluator's catalog mode names
 * none. pi lets that pass inherit the store's default; the adapter never
 * inherits (oneshot.ts), and `low` keeps the reasoning the confirmation exists
 * for while staying inside the judge's 60 s.
 */
export const CONFIRM_THINKING_FALLBACK = "low";

export interface StopDeps {
	stateDir: string;
	spool: Spool;
	/** Why model-backed policies cannot run, or null. */
	modelUnavailable: string | null;
	/** The evaluator, resolved lazily (only when a goal is active). */
	resolveEvaluator(): Promise<ModelResolution>;
	/** Fallback transcript path ($HIVE_CLAUDE_TRANSCRIPT) when the event carries none. */
	transcriptPath?: string;
	stderr(line: string): void;
	now?: () => number;
	budgetMs?: number;
	/** The spawner under the accounting wrapper — a test seam; runOneShot in production. */
	spawn?: OneShot;
}

const GATE_OUTCOME: Record<MetricOutcome, GateOutcome> = { pass: "passed", fail: "failed", timeout: "timed_out", skip: "skipped" };

function readEntries(input: HookInput, deps: StopDeps): PiEntry[] {
	const path = input.transcript_path || deps.transcriptPath;
	if (!path) throw new Error("the Stop event carries no transcript_path and HIVE_CLAUDE_TRANSCRIPT is unset");
	return withFinalAssistant(readClaudeTranscript(path), input.last_assistant_message);
}

export async function stopDecision(input: HookInput, deps: StopDeps): Promise<HookOutput> {
	const now = deps.now ?? Date.now;
	const deadline = now() + (deps.budgetMs ?? STOP_BUDGET_MS);
	const left = () => deadline - now();
	const cwd = input.cwd || process.cwd();

	const entries = readEntries(input, deps);
	// A turn that did not RUN is not evidence (turn-outcome.ts), and a turn
	// handed back to a person is not a stop to re-drive (handback.ts) — the
	// driver's two pre-conditions, in its order.
	if (turnFailureOf(entries)) return null;
	const held = handbackClass(classifyHandback(entries));

	const agenda = readAgendaState(deps.stateDir);
	let goal: GoalItem | null = readGoal(deps.stateDir);
	const commitGoal = (next: GoalItem) => {
		goal = next;
		writeGoal(deps.stateDir, next);
	};

	const policies: Policy[] = [
		createGatePolicy(
			{
				get: (id) => agenda.gateStamps[id],
				set: (id, stamp) => {
					if (stamp === undefined) delete agenda.gateStamps[id];
					else agenda.gateStamps[id] = stamp;
				},
			},
			{ timeoutCapMs: left },
		),
	];

	if (goal?.state === "active") {
		const activeGoal: GoalItem = goal;
		const evaluator = deps.modelUnavailable ? null : await deps.resolveEvaluator();
		if (deps.modelUnavailable) {
			deps.stderr(`hive-pi: goal not judged — ${deps.modelUnavailable}`);
		} else if (evaluator && !evaluator.ok) {
			// No model resolves: the judge could not run. That is a JUDGE ERROR —
			// recorded on the goal (goal_status shows it; three pause the goal),
			// never a verdict and never silently nothing.
			deps.stderr(`hive-pi: goal not judged — no evaluator model: ${evaluator.reason}`);
			const applied = applyJudgeError(activeGoal, `no evaluator model: ${evaluator.reason}`, now(), 0);
			commitGoal(applied.goal);
			deps.spool.gate("goal", "skipped", 0);
		} else if (evaluator?.ok) {
			const pick = evaluator.pick;
			const spawn = deps.spawn;
			const drift = createDriftPolicy({
				goal: () => goal,
				evaluatorModel: () => pick.spec,
				oneShot: accountedOneShot(deps.spool, "drift", () => deadline, spawn),
				thinking: () => "off",
				settles: {
					get: () => agenda.driftSettles,
					set: (value) => {
						agenda.driftSettles = value;
					},
				},
			});
			policies.push({
				name: drift.name,
				// Skipped outright when the goal judge would be left without time; the
				// cadence counter is not advanced, so the probe runs on a later settle.
				decide: (context) => (left() < DRIFT_MIN_REMAINING_MS ? null : drift.decide(context)),
			});
			policies.push(
				createGoalPolicy({
					current: () => goal,
					commit: (next) => commitGoal(next),
					evaluatorModel: () => pick.spec,
					oneShot: accountedOneShot(deps.spool, "goal-judge", () => deadline, spawn),
					confirmThinking: () => pick.thinking ?? CONFIRM_THINKING_FALLBACK,
				}),
			);
		}
	}

	// The driver's hand-back filter: a turn handed to a person (or to the
	// agent's own running job) is re-driven only by a policy that says so.
	const eligible = policies.filter(
		(policy) => held === "none" || (held !== "gate" && policy.proceedsDespite?.includes(held) === true),
	);
	if (eligible.length === 0) {
		writeAgendaState(deps.stateDir, agenda);
		return null;
	}

	const lastAssistant = [...entries].reverse().find((e) => e.message.role === "assistant");
	const lastAssistantText = lastAssistant
		? lastAssistant.message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") || undefined
		: undefined;

	const injection = await walkChain(
		eligible,
		{ cwd, lastAssistantText, transcript: recapTranscript(entries, POLICY_TRANSCRIPT_CHARS) },
		{
			stillCurrent: () => true,
			mayInject: () => true,
			onMetric: (name, outcome, value) => {
				if (name === "goal" || name === "drift") deps.spool.gate(name, GATE_OUTCOME[outcome], value);
			},
			ledger: () => agenda.ledger,
			setLedger: (next) => {
				agenda.ledger = next;
			},
		},
	);
	// Persist every charge BEFORE the block reaches Claude.
	writeAgendaState(deps.stateDir, agenda);
	return injection ? blockStop(injection.text) : null;
}
