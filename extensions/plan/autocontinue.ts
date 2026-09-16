/**
 * plan auto-continue — one bounded, deterministic "continue" turn when an
 * approved plan still has pending work and the agent stopped short.
 *
 * THE PROBLEM. A low-tier model (measured worst on `meta/muse-spark-1.3`) ends
 * a turn with a text-only "Wave done." summary and hands control back, while an
 * APPROVED plan still holds pending steps. Session 98f712a4 stopped this way on
 * 15 of 74 turns; the operator set `/goal keep going, dont stop` and it stopped
 * anyway. Each stop costs a human a manual "continue".
 *
 * WHY NOT JUST THE GOAL PATH. `agenda/conductor.ts` already derives an auto-goal
 * ("Every step of the approved plan is done …") from an approved plan, and the
 * goal policy re-drives when its LLM JUDGE reads the condition as unmet. That
 * path is the right one when it fires — but it depends on a per-settle verdict
 * call, and the evidence session had a goal armed and stopped 15 times anyway.
 * This is the cheap, deterministic complement: no judge, no LLM call. It reads
 * the plan document's own item counts (pure, instant) and injects a single
 * continuation only when there is provably pending work and the settle was a
 * short stop. When the goal path already injected on a settle, this backs off
 * (the driver's `isIdle` mutual exclusion — see `runAutoContinue`).
 *
 * NOTHING HERE READS `ctx`. This module is two pieces:
 *   - `decideAutoContinue` — a PURE function over already-derived facts, so the
 *     whole guard matrix is testable without a session; and
 *   - `runAutoContinue` — the thin driver that reads `ctx` ONCE (synchronously,
 *     no await, so there is no stale-ctx window), mirrors the agenda driver's
 *     early rejects, calls the pure function, and injects.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blocksReentry } from "../agenda/question-guard.ts";
import { turnFailureOf } from "../agenda/turn-outcome.ts";
import { itemCounts } from "./lanes.ts";
import type { PlanDoc, PlanPhase } from "./state.ts";

/** The custom-message type the injection rides on, mirrored in the driver's doorbell. */
export const AUTOCONTINUE_MESSAGE_TYPE = "plan-autocontinue" as const;

/** Env flag. Default ON: only an explicit `"0"` turns it off (brief/config.ts convention). */
export const AUTOCONTINUE_ENV = "PI_PLAN_AUTOCONTINUE";

/** True unless `PI_PLAN_AUTOCONTINUE` is exactly `"0"`. */
export function autoContinueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[AUTOCONTINUE_ENV] !== "0";
}

export interface AutoContinueConfig {
	/**
	 * Hard cap on total auto-continues in one session. The loop can never run
	 * longer than this many injected turns without a human, whatever else
	 * happens. Reset only by a real user message.
	 */
	cap: number;
	/**
	 * How many consecutive auto-continues may make NO new `done` before this
	 * stands down — the anti-spin guard. A model that is churning without
	 * closing a single step is not helped by being told to continue again.
	 */
	noProgressLimit: number;
}

export const DEFAULT_AUTOCONTINUE_CONFIG: AutoContinueConfig = {
	cap: 25,
	noProgressLimit: 3,
};

/**
 * Per-session state. Lives in the extension factory closure (pi builds a fresh
 * jiti per extension with `moduleCache:false`, so module scope is not
 * per-session), and is wiped on `session_start`.
 */
export interface AutoContinueState {
	/** Total auto-continues injected this session. Compared against `cap`. */
	used: number;
	/** Consecutive auto-continues that closed no new step. Compared against `noProgressLimit`. */
	noProgressStreak: number;
	/** The `done` count when the current no-progress streak began; the streak's baseline. */
	doneAtStreakStart: number;
	/**
	 * Whether the most recent turn issued a tool call. Recorded from `turn_end`.
	 * A settle whose last turn made NO tool call is the "stopped short" shape;
	 * one that ended mid-work (a tool call last) is not ours to re-drive.
	 */
	lastTurnMadeToolCall: boolean;
}

export function createAutoContinueState(): AutoContinueState {
	return { used: 0, noProgressStreak: 0, doneAtStreakStart: 0, lastTurnMadeToolCall: false };
}

/**
 * Facts the pure decision needs, all derived by the caller. `ctx`-shaped guards
 * (idle, turn failure, question) are handled in `runAutoContinue` as early
 * returns before this runs, exactly as the agenda driver orders them — so they
 * are deliberately NOT inputs here.
 */
export interface AutoContinueInput {
	enabled: boolean;
	phase: PlanPhase;
	/** Counts from `itemCounts(doc)` — observed-kind (Hive-resolved) items already excluded. */
	pending: number;
	inProgress: number;
	done: number;
	lastTurnMadeToolCall: boolean;
	/**
	 * Is a blocking user-facing UI/approval prompt open? (`ui_prompt_start`
	 * without a matching `ui_prompt_end`.) An open prompt is an approval-wait:
	 * injecting a turn under it answers the operator's prompt for them, which is
	 * the one thing this must never do. Distinct from `isIdle` — the agent run
	 * can be idle while a prompt is up.
	 */
	uiPromptOpen: boolean;
	state: AutoContinueState;
	config: AutoContinueConfig;
}

export type AutoContinueDecision =
	/** Not a settle this feature acts on. No injection, no charge, no state change. */
	| { action: "noop"; reason: string }
	/** A guard stood the loop down (cap or spin). No injection; state unchanged. */
	| { action: "stop"; reason: string }
	/** Inject one continuation, and advance to `nextState`. */
	| { action: "continue"; reason: string; nudge: string; nextState: AutoContinueState };

/**
 * The nudge. Deterministic and blunt on purpose: the model that produced the
 * "Wave done." summary is the one being told, in plain terms, that the plan is
 * not finished and a summary is not a stopping point.
 */
export function buildNudge(remaining: number): string {
	const steps = remaining === 1 ? "step remains" : "steps remain";
	return (
		"Continue with the next pending plan step now — do not stop to summarize or ask for confirmation. " +
		"Keep going until every step is `done`; if a step is genuinely blocked, mark it `blocked` and continue " +
		`with the others. (${remaining} ${steps}.)`
	);
}

/**
 * Decide whether to auto-continue. PURE — same inputs, same answer, no I/O.
 *
 * Order matters and mirrors the driver's doctrine:
 *   1. NO-OP conditions first — a settle this feature simply does not act on
 *      (disabled, no approved plan, no pending work, ended mid-tool-call). None
 *      charge the cap, because none is a burn.
 *   2. STOP conditions next — a guard that stands the loop down (cap reached,
 *      or the model is spinning without closing steps).
 *   3. Otherwise CONTINUE, and return the advanced state the caller must store.
 */
export function decideAutoContinue(input: AutoContinueInput): AutoContinueDecision {
	const { enabled, phase, pending, inProgress, done, lastTurnMadeToolCall, uiPromptOpen, state, config } = input;

	if (!enabled) return { action: "noop", reason: "disabled" };
	if (phase !== "approved") return { action: "noop", reason: `phase is ${phase}, not approved` };

	const remaining = pending + inProgress;
	if (remaining === 0) return { action: "noop", reason: "no pending or in-progress work" };

	// An open approval/UI prompt is an approval-wait: never inject under it.
	if (uiPromptOpen) return { action: "noop", reason: "a UI/approval prompt is open" };

	// Ended mid-work rather than on a short summary: not ours to re-drive.
	if (lastTurnMadeToolCall) return { action: "noop", reason: "last turn made a tool call" };

	// Terminal guards — the loop stands down until a human re-engages.
	if (state.used >= config.cap) {
		return { action: "stop", reason: `hit auto-continue cap (${config.cap})` };
	}
	const progressed = done > state.doneAtStreakStart;
	if (!progressed && state.noProgressStreak >= config.noProgressLimit) {
		return {
			action: "stop",
			reason: `no new step closed across ${config.noProgressLimit} auto-continues`,
		};
	}

	const nextState: AutoContinueState = {
		used: state.used + 1,
		// A closed step since the baseline resets the streak; otherwise this
		// continuation counts as one more with nothing to show for it.
		noProgressStreak: progressed ? 0 : state.noProgressStreak + 1,
		doneAtStreakStart: progressed ? done : state.doneAtStreakStart,
		lastTurnMadeToolCall,
	};
	return {
		action: "continue",
		reason: `approved plan has ${remaining} step(s) left; continuing (${nextState.used}/${config.cap})`,
		nudge: buildNudge(remaining),
		nextState,
	};
}

/**
 * Everything `runAutoContinue` needs from the outside, so the driver stays
 * testable and never reaches into the plan extension's private closure.
 */
export interface AutoContinueDeps {
	/** Current plan document for this session. */
	loadDoc: (ctx: ExtensionContext) => PlanDoc;
	/** Mutable per-session state, held in the factory closure. */
	state: AutoContinueState;
	/** Whether a blocking UI/approval prompt is currently open (tracked by the caller). */
	uiPromptOpen: boolean;
	config?: AutoContinueConfig;
	env?: NodeJS.ProcessEnv;
}

/** Plain text of the most recent assistant turn, for the question guard. Fails OPEN. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { message?: { role?: string; content?: unknown } };
			const message = entry?.message;
			if (!message || message.role !== "assistant") continue;
			const content = message.content;
			if (typeof content === "string") return content.length > 0 ? content : undefined;
			if (Array.isArray(content)) {
				const text = content
					.filter((part): part is { type: string; text: string } => {
						const p = part as { type?: string; text?: unknown };
						return p?.type === "text" && typeof p.text === "string";
					})
					.map((part) => part.text)
					.join("\n");
				return text.length > 0 ? text : undefined;
			}
			return undefined;
		}
	} catch {
		/* session replaced — the guard fails open, isIdle already gated us */
	}
	return undefined;
}

/**
 * The thin driver, called from the plan extension's ONE `agent_settled` handler.
 *
 * SYNCHRONOUS and cheap by contract: reads `ctx` once, up front, inside a
 * try/catch (ctx throws once the session is replaced), and never awaits — so
 * there is no window in which the session changes under it and no generation
 * counter to keep. The early rejects mirror `agenda/driver.ts` in the same
 * order, and for the same reasons documented there:
 *
 *   - worker process        → automatic re-entry is never wanted in a subagent
 *   - mode not tui/rpc       → a headless one-shot is replaced right after settle
 *   - not idle / pending msg → SOMEONE ELSE (the agenda driver, a goal, a
 *                              teammate message) already started a turn this
 *                              settle. `sendMessage({triggerTurn:true})` flips
 *                              `_isAgentRunActive` synchronously, so whoever ran
 *                              first in the serial handler chain wins and the
 *                              rest see `!isIdle()` — this is the SAME mutual
 *                              exclusion `@narumitw/pi-goal` uses to coexist with
 *                              agenda (driver.ts). At most one injection per settle.
 *   - turn failed/aborted    → a turn that never reached the provider is not
 *                              evidence; auto-continuing an error is a burn loop
 *                              and auto-continuing an abort overrides the human.
 *   - ended on a question    → re-entering answers the user's question for them.
 *
 * Returns the decision (for tests / callers that want it); side effect is the
 * injection and the state advance.
 */
export function runAutoContinue(pi: ExtensionAPI, ctx: ExtensionContext, deps: AutoContinueDeps): AutoContinueDecision {
	const config = deps.config ?? DEFAULT_AUTOCONTINUE_CONFIG;
	const env = deps.env ?? process.env;

	// Never re-enter a spawned worker's loop.
	if (env.PI_AGENDA_WORKER === "1") return { action: "noop", reason: "worker process" };

	let phase: PlanPhase;
	let counts: ReturnType<typeof itemCounts>;
	let idle: boolean;
	let turnFailed: boolean;
	let assistantText: string | undefined;
	try {
		const mode = ctx.mode;
		if (mode !== "tui" && mode !== "rpc") return { action: "noop", reason: `mode ${mode}` };
		// Read live, not captured — whether a turn is already running changes as
		// the serial chain runs. Fails CLOSED: an unreadable ctx means the session
		// is gone and injecting into it is never right.
		idle = ctx.isIdle() && !ctx.hasPendingMessages();
		const doc = deps.loadDoc(ctx);
		phase = doc.phase;
		counts = itemCounts(doc);
		turnFailed = turnFailureOf(ctx.sessionManager.getBranch() as readonly unknown[]) !== undefined;
		assistantText = lastAssistantText(ctx);
	} catch {
		return { action: "noop", reason: "ctx unreadable" };
	}

	if (!idle) return { action: "noop", reason: "not idle — another injector or a live turn" };
	// A failed/aborted turn is not evidence: skip WITHOUT charging the cap.
	if (turnFailed) return { action: "noop", reason: "last turn failed or was aborted" };
	// A turn that ended by asking the user must not be answered automatically.
	if (blocksReentry({ lastAssistantText: assistantText, automatic: true })) {
		return { action: "noop", reason: "assistant ended on a question" };
	}

	const decision = decideAutoContinue({
		enabled: autoContinueEnabled(env),
		phase,
		pending: counts.pending,
		inProgress: counts.in_progress,
		done: counts.done,
		lastTurnMadeToolCall: deps.state.lastTurnMadeToolCall,
		uiPromptOpen: deps.uiPromptOpen,
		state: deps.state,
		config,
	});

	if (decision.action !== "continue") return decision;

	try {
		pi.sendMessage(
			{ customType: AUTOCONTINUE_MESSAGE_TYPE, content: decision.nudge, display: true },
			// The proven idle-wake shape: `agmsg/index.ts:106`, `background`,
			// `credential-recovery`, and the agenda driver (`driver.ts:333`) all
			// inject with exactly this. `followUp` so it never cuts between a tool
			// call and its result; `triggerTurn` so an IDLE session actually runs.
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch {
		// Session went away between the idle check and the send — nothing to
		// inject into. Do NOT advance state: no turn was started.
		return { action: "noop", reason: "session replaced before inject" };
	}

	// Only NOW is the continuation real; commit the advanced state.
	deps.state.used = decision.nextState.used;
	deps.state.noProgressStreak = decision.nextState.noProgressStreak;
	deps.state.doneAtStreakStart = decision.nextState.doneAtStreakStart;
	return decision;
}
