/**
 * The conductor policy — walks a session through the task lifecycle.
 *
 *   idle → frame (todos) → plan (read-only plan mode) → execute → verify → consolidate → done
 *
 * It is the automation that connects features which already exist and are
 * individually manual: TodoWrite, `/plan`, `/goal`, `orchestrate`, the repo
 * gate. The conductor itself makes ZERO model calls — every decision is a
 * synchronous fold over the precomputed session signals — and it steers by
 * injecting stage guidance at exactly the settle where the model is in the
 * wrong state. Model judgment stays where it already lives (the goal judge);
 * deterministic verification stays where it already lives (the gate), plus the
 * one delivery-level check the gate cannot express: `prCheck`.
 *
 * Simple tasks never leave `idle`: the complexity heuristic
 * (`conductor-state.ts`) gates the whole machine, and an interrogative prompt
 * or a one-liner costs nothing beyond the fold itself.
 *
 * Injection budget: one per stage (`conductor:frame`, `conductor:plan`), two
 * for verify (`conductor:verify`) — all charged to the shared driver ledger,
 * so they compose with the gate's and the goal's caps rather than multiplying.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareFailures, distillFailure } from "../harness/distill.ts";
import { hasFindings, renderFindings, runHeldOutScan } from "../harness/heldout.ts";
import { bashAvailable, loadHarnessConfig, repoRoot, runCheck } from "./gate.ts";
import type { GoalItem } from "./goal-state.ts";
import { atCap, count, record, remaining } from "./ledger.ts";
import { decideConsolidate } from "./consolidate.ts";
import type { Policy, PolicyContext, PolicyWork } from "./policy.ts";
import {
	assessComplexity,
	type ConductorItem,
	createConductor,
	withComplexity,
	withStage,
} from "./conductor-state.ts";
import type { SessionSignals } from "./signals.ts";

export const FRAME_LEDGER_ID = "conductor:frame";
export const PLAN_LEDGER_ID = "conductor:plan";
export const VERIFY_LEDGER_ID = "conductor:verify";

export const MAX_VERIFY_INJECTIONS = 2;
const PR_CHECK_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4000;

export const FRAME_INJECTION = [
	"Conductor: before continuing, capture this work as a todo list with the TodoWrite tool —",
	"one entry per concrete step, exactly one in_progress at a time.",
	"If steps need design decisions, note that in the entry; planning comes next.",
	"For context gathering, fan out `retriever` subagents (fast, returns file:line references) rather than searching yourself.",
].join(" ");

export const PLAN_INJECTION = [
	"Conductor: this task crossed the complexity threshold, so the session is now in read-only plan mode.",
	"Explore first, then build the plan with plan_write — include a `steps` block and a one-sentence",
	'machine-checkable goal in the header (e.g. "PR created and its Hive checks green").',
	"Use plan_ask for decisions only the user can make. If an `advisor` tool is available, call it",
	"once before plan_ready — it forwards the whole conversation to a stronger model for review.",
	"When the plan is decision-complete, call plan_ready to present it for approval.",
].join(" ");

export const ADVISE_LEDGER_ID = "conductor:advise";

export const ADVISE_INJECTION = [
	"Conductor: the work looks complete. Before delivery checks, review any advisory composition lint returned by plan_ready;",
	"this is the one execute→verify reminder, charged to the existing conductor:advise ledger.",
	"If an `advisor` tool is available, call it once for a final review of this work — then address anything real it raises.",
].join(" ");

export interface ConductorHooks {
	/** The live conductor, or null when none has been created this session. */
	current(): ConductorItem | null;
	/** Persist a mutation. */
	commit(item: ConductorItem): void;
	/** The live goal, so verify can key off `achieved`. */
	goal(): GoalItem | null;
	/** Ring the plan-mode doorbell (PLAN_CONTROL_CHANNEL). Called from run(), never decide(). */
	requestPlanMode(): void;
	/** Session-level enablement — `/conductor off` and the settings default. */
	enabled(): boolean;
	/**
	 * The previous verify failure's distilled note, for red-vs-red comparison
	 * (HIV-1232) — session-scoped closure state owned by the index. Optional so
	 * hand-built test hooks without an opinion on it stay valid.
	 */
	lastVerifyNote?(): string | null;
	recordVerifyNote?(note: string): void;
}

/** Fresh-or-current item for a fold. Creation is committed by run(), not here. */
function itemFor(hooks: ConductorHooks, now: number): ConductorItem {
	return hooks.current() ?? createConductor(`conductor-${now.toString(36)}`, now);
}

/** Every step of every task list done, and at least one task exists. */
function allTasksDone(signals: SessionSignals): boolean {
	return signals.tasks.total >= 1 && signals.tasks.completed === signals.tasks.total;
}

export function createConductorPolicy(hooks: ConductorHooks): Policy {
	return {
		name: "conductor",

		decide(context: PolicyContext): PolicyWork | null {
			if (!hooks.enabled()) return null;
			const signals = context.signals;
			if (!signals || signals.userTurns === 0) return null;

			const item = hooks.current();
			const stage = item?.stage ?? "idle";

			switch (stage) {
				case "idle":
					return decideIdle(hooks, context, signals);
				case "frame":
					return decideFrame(hooks, context, signals);
				case "plan":
					return decidePlan(hooks, signals);
				case "execute":
					return decideExecute(hooks, context, signals);
				case "verify":
					return decideVerify(hooks, context);
				case "consolidate":
					return decideConsolidate(hooks, context);
				case "done":
					return null;
			}
		},
	};
}

function decideIdle(hooks: ConductorHooks, context: PolicyContext, signals: SessionSignals): PolicyWork | null {
	const prompt = signals.lastUserPrompt;
	if (!prompt.trim()) return null;

	const complexity = assessComplexity(prompt, signals.tasks.total);
	// Simple work stays out of the lifecycle entirely — no item is even
	// created, so an all-day session of quick asks costs nothing but this fold.
	if (complexity !== "complex") return null;

	// Todos already exist → skip frame, go straight to planning.
	if (signals.tasks.total > 0) return planTransition(hooks, context);

	if (atCap(context.ledger, FRAME_LEDGER_ID, 1)) {
		// Frame budget already spent (rehydrated session) — move on rather than
		// re-nagging; the todo step is advisory.
		return planTransition(hooks, context);
	}

	return {
		name: "conductor",
		status: "conductor: framing task",
		run: async () => {
			const now = Date.now();
			hooks.commit(withComplexity(withStage(itemFor(hooks, now), "frame", now), "complex", now));
			return {
				metric: { outcome: "pass" as const, value: 0 },
				inject: FRAME_INJECTION,
				ledger: (state) => record(state, FRAME_LEDGER_ID),
			};
		},
	};
}

function decideFrame(hooks: ConductorHooks, context: PolicyContext, signals: SessionSignals): PolicyWork | null {
	// Waiting for todos. Once they exist — or once the model settled again
	// without writing any (the nudge is advisory, cap 1) — advance to planning.
	if (signals.tasks.total === 0 && count(context.ledger, FRAME_LEDGER_ID) === 0) return null;
	return planTransition(hooks, context);
}

/** The frame→plan / idle→plan transition: doorbell + one guidance injection. */
function planTransition(hooks: ConductorHooks, context: PolicyContext): PolicyWork | null {
	if (atCap(context.ledger, PLAN_LEDGER_ID, 1)) {
		// Plan guidance already delivered (rehydrated session) — just advance.
		return silentAdvance(hooks, "plan");
	}
	return {
		name: "conductor",
		status: "conductor: entering plan mode",
		run: async () => {
			const now = Date.now();
			hooks.requestPlanMode();
			hooks.commit(withComplexity(withStage(itemFor(hooks, now), "plan", now), "complex", now));
			return {
				metric: { outcome: "pass" as const, value: 0 },
				inject: PLAN_INJECTION,
				ledger: (state) => record(state, PLAN_LEDGER_ID),
			};
		},
	};
}

function silentAdvance(hooks: ConductorHooks, stage: ConductorItem["stage"]): PolicyWork {
	return {
		name: "conductor",
		status: "",
		run: async () => {
			const now = Date.now();
			hooks.commit(withStage(itemFor(hooks, now), stage, now));
			return { metric: { outcome: "pass" as const, value: 0 } };
		},
	};
}

function decidePlan(hooks: ConductorHooks, signals: SessionSignals): PolicyWork | null {
	// The plan extension owns this stage. Approval arrives via the bus (the
	// index wires PLAN_APPROVED to a stage commit and the execute kick), so the
	// policy only needs the fallback: a plan already approved when we settle.
	if (signals.plan.phase === "approved") return silentAdvance(hooks, "execute");
	if (signals.plan.phase === "abandoned") return silentAdvance(hooks, "execute");
	return null;
}

function decideExecute(hooks: ConductorHooks, context: PolicyContext, signals: SessionSignals): PolicyWork | null {
	const goal = hooks.goal();
	const goalDone = goal?.state === "achieved";
	// With no goal, completion is "every todo closed". With a goal, the judge's
	// verdict is the completion signal and todo state is advisory.
	const done = goal ? goalDone : allTasksDone(signals);
	if (!done) return null;
	// The execute→verify seam is the last settle where advice can still change
	// the outcome cheaply — after verify the work is being judged, not shaped.
	// One nudge, ever (HIV-1247); a rehydrated session at cap advances silently
	// exactly as before.
	if (atCap(context.ledger, ADVISE_LEDGER_ID, 1)) {
		return silentAdvance(hooks, "verify");
	}
	return {
		name: "conductor",
		status: "conductor: entering verify stage",
		run: async () => {
			const now = Date.now();
			hooks.commit(withStage(itemFor(hooks, now), "verify", now));
			return {
				metric: { outcome: "pass" as const, value: 0 },
				inject: ADVISE_INJECTION,
				ledger: (state) => record(state, ADVISE_LEDGER_ID),
			};
		},
	};
}

/**
 * Verify: the delivery-level checks the per-settle gate deliberately does not
 * run. Two tiers, cheapest first:
 *
 *   0. the HELD-OUT scan (harness/heldout.ts) — evasion tells and test damage
 *      in this work's diff, checked with patterns the agent's context never
 *      contained (HIV-1230). Findings inject as errors and block `done`.
 *   1. `prCheck` from `.pi/harness.json` (e.g. `gh pr checks --fail-level
 *      all`) — red injects the tail plus a red-vs-red comparison against the
 *      previous attempt's distilled note (HIV-1232), green closes silently.
 *
 * Both tiers share the verify ledger, so the MAX_VERIFY_INJECTIONS cap bounds
 * the stage as a whole. Repos without `.pi/harness.json` have opted into no
 * harness checking at all, and get neither tier.
 */
function decideVerify(hooks: ConductorHooks, context: PolicyContext): PolicyWork | null {
	const loaded = loadHarnessConfig(context.cwd);
	const prCheck = loaded?.config.prCheck?.trim();
	if (!loaded) {
		// Nothing to verify with — hand over to consolidate. Reported as skip
		// so a lifecycle that never verified is distinguishable from one that
		// did.
		return {
			name: "conductor",
			status: "",
			run: async () => {
				const now = Date.now();
				hooks.commit(withStage(itemFor(hooks, now), "consolidate", now));
				return { metric: { outcome: "skip" as const, value: 0 } };
			},
		};
	}

	if (atCap(context.ledger, VERIFY_LEDGER_ID, MAX_VERIFY_INJECTIONS)) {
		return {
			name: "conductor",
			status: "",
			run: async () => {
				const now = Date.now();
				hooks.commit(withStage(itemFor(hooks, now), "consolidate", now));
				return { metric: { outcome: "skip" as const, value: 0 } };
			},
		};
	}

	const root = loaded.root;
	const timeoutMs = loaded.config.prCheckTimeoutMs ?? PR_CHECK_TIMEOUT_MS;
	const runPrCheck = Boolean(prCheck) && bashAvailable();

	return {
		name: "conductor",
		status: runPrCheck ? `conductor: verifying — ${prCheck}` : "conductor: verifying",
		run: async () => {
			// Tier 0 — held-out scan. A scan that cannot run (no git) is null and
			// skips itself; findings are charged to the shared verify budget.
			const scan = await runHeldOutScan(root);
			if (scan && hasFindings(scan)) {
				return {
					metric: { outcome: "fail" as const, value: 0 },
					inject: renderFindings(scan),
					ledger: (state) => record(state, VERIFY_LEDGER_ID),
				};
			}

			if (!runPrCheck) {
				const now = Date.now();
				hooks.commit(withStage(itemFor(hooks, now), "consolidate", now));
				return { metric: { outcome: "skip" as const, value: 0 } };
			}
			const command = prCheck as string;

			const startedAt = Date.now();
			const result = await runCheck(command, root, timeoutMs);
			const elapsed = Date.now() - startedAt;
			const now = Date.now();

			if (result.ok) {
				hooks.commit(withStage(itemFor(hooks, now), "consolidate", now));
				// Silent advance, mirroring the goal's achieved behaviour: announcing
				// "verified" would spend a turn telling the model what it just saw.
				return { metric: { outcome: "pass" as const, value: elapsed } };
			}

			const charged = record(context.ledger, VERIFY_LEDGER_ID);
			const left = remaining(charged, VERIFY_LEDGER_ID, MAX_VERIFY_INJECTIONS);
			const header = result.timedOut
				? `Conductor verify: \`${command}\` TIMED OUT.`
				: `Conductor verify: \`${command}\` FAILED.`;
			const footer =
				left > 0
					? `Fix the cause and settle again (${left} verify attempt(s) left).`
					: "This was the final verify attempt — summarize what is still red and hand back to the user.";

			// Red-vs-red drift: distill this failure and compare with the previous
			// attempt's note. "The failure moved" is progress; "identical" is the
			// strongest signal the last fix changed nothing (HIV-1232).
			const note = distillFailure({ attempted: command, output: result.output, timedOut: result.timedOut });
			const previous = hooks.lastVerifyNote?.() ?? null;
			hooks.recordVerifyNote?.(note);
			const comparison = previous ? `\n\n${compareFailures(previous, note)}` : "";

			return {
				metric: { outcome: result.timedOut ? ("timeout" as const) : ("fail" as const), value: elapsed },
				inject: `${header}\n\nOutput (tail):\n\`\`\`\n${result.output.trim().slice(-OUTPUT_TAIL_CHARS)}\n\`\`\`${comparison}\n\n${footer}`,
				ledger: (state) => record(state, VERIFY_LEDGER_ID),
			};
		},
	};
}

/** Lifecycle stages in walk order, for the widget strip. */
export const STAGE_STRIP: readonly ConductorItem["stage"][] = ["frame", "plan", "execute", "verify", "consolidate"];

/**
 * The browser widget envelope for a lifecycle snapshot.
 *
 * The Hive agents workspace routes `details.hive_widget` of `type:
 * "lifecycle"` (v1) to a dedicated widget; anything older falls back to the
 * generic JSON card, harmlessly. Emitted from tool results only — the
 * terminal keeps rendering from the tools' own text, per the envelope's
 * "additional view, never a replacement" contract.
 */
export function lifecycleEnvelope(
	stage: ConductorItem["stage"],
	goal: GoalItem | null,
	note?: string,
): { hive_widget: { v: 1; type: "lifecycle"; spec: Record<string, unknown> } } {
	return {
		hive_widget: {
			v: 1,
			type: "lifecycle",
			spec: {
				stage,
				stages: [...STAGE_STRIP],
				...(goal
					? {
							goal: {
								condition: goal.condition,
								state: goal.state,
								iterations: goal.ledger.iterations,
								maxIterations: goal.ledger.maxIterations,
							},
						}
					: {}),
				...(note ? { note } : {}),
			},
		},
	};
}

/**
 * The conductor's TUI widget — a one-glance stage strip plus the goal line.
 *
 * Pure over (item, goal, enabled) so the rendering is testable; the index
 * paints it through `ctx.ui.setWidget`. Returns null when there is nothing
 * worth a widget row (idle, done, or disabled) — a lifecycle indicator that is
 * always on screen is one nobody reads.
 */
export function renderConductorLines(
	item: ConductorItem | null,
	goal: GoalItem | null,
	enabled: boolean,
): string[] | null {
	if (!enabled || !item || item.stage === "idle" || item.stage === "done") return null;

	const strip = STAGE_STRIP.map((stage) => (stage === item.stage ? `[${stage}]` : stage)).join(" ▸ ");
	const lines = [`◈ CONDUCTOR  ${strip}`];

	if (goal && goal.state === "active") {
		const condition = goal.condition.length > 70 ? `${goal.condition.slice(0, 70)}…` : goal.condition;
		lines.push(`  goal: ${condition} (${goal.ledger.iterations}/${goal.ledger.maxIterations} continuations)`);
	}
	if (item.stage === "plan") lines.push("  awaiting plan approval — plan_ready / /plan approve");
	if (item.stage === "verify") lines.push("  running delivery checks (prCheck)");
	if (item.stage === "consolidate") lines.push("  capturing learnings → memory/ (knowledge_write)");
	return lines;
}

/**
 * The `/conductor` readout. Pure so its wording is testable.
 */
export function describeConductor(item: ConductorItem | null, enabled: boolean): string {
	if (!enabled) return "Conductor: off for this session. `/conductor on` to enable.";
	if (!item) return "Conductor: idle — no complex task detected yet.";
	const stageLine = `Conductor (${item.stage}): lifecycle ${item.stage === "done" ? "complete" : "in progress"}, complexity ${item.complexity}.`;
	const hint =
		item.stage === "plan"
			? " Waiting on plan approval (plan_ready / `/plan approve`)."
			: item.stage === "frame"
				? " Waiting on a TodoWrite list."
				: item.stage === "consolidate"
					? " Capturing durable learnings into memory/ (knowledge_write)."
					: "";
	return stageLine + hint;
}

/**
 * Derive the auto-goal condition from an approved plan.
 *
 * The plan's own goal sentence leads; mechanical clauses are appended only
 * when the repo declares the machinery to check them (`.pi/harness.json`), so
 * a goal never promises evidence the harness cannot produce. Every clause
 * carries a token `looksUnverifiable()` recognises — a derived condition must
 * never trip the very warning this feature exists to avoid.
 */
export function deriveGoalCondition(planGoal: string, cwd: string): string {
	const parts = [planGoal.trim() || "Every step of the approved plan is done"];
	const loaded = loadHarnessConfig(cwd);
	if (loaded?.config.check) {
		parts.push(`the repo gate \`${loaded.config.check}\` passes`);
	}
	if (loaded?.config.prCheck && repoUsesPRs(cwd)) {
		parts.push(
			"a PR exists for this work with all its checks green (evidence: `gh pr checks` output in the transcript)",
		);
	}
	return parts.join(" AND ");
}

/**
 * Does this repo look like it delivers via PRs? Used when deriving the
 * auto-goal's PR clause — presence of a git checkout plus a GitHub remote.
 * Cheap file reads only; never spawns.
 */
export function repoUsesPRs(cwd: string): boolean {
	const root = repoRoot(cwd);
	if (!root) return false;
	try {
		const gitPath = join(root, ".git");
		if (!existsSync(gitPath)) return false;
		// A worktree's .git is a file pointing at the real gitdir; the config
		// lives beside the common dir. Reading the checkout's config covers the
		// normal case; worktrees inherit the remote from the parent repo, so
		// fall back to "true" when a .git exists but the config is elsewhere.
		const configPath = join(gitPath, "config");
		if (!existsSync(configPath)) return true;
		return readFileSync(configPath, "utf8").includes("github.com");
	} catch {
		return false;
	}
}
