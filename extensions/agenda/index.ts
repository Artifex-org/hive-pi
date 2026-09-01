/**
 * agenda — the substrate that automatic re-entry into the agent loop runs on.
 *
 * Two policies now, in fixed priority: the repo gate (absorbed from
 * `verification-loop.ts`), then `/goal`. The gate goes first because it is
 * deterministic and cheap relative to a model call, and because a goal must
 * never be judged against a transcript whose build is broken.
 *
 * `/loop` lands as a third policy on the same driver rather than as its own
 * extension: two extensions injecting follow-up turns cannot share a cap, since
 * pi builds a fresh jiti per extension entry (`moduleCache:false`), so their
 * budgets multiply instead of composing.
 *
 * pi's extension discovery is one level deep, so this directory is ONE
 * extension and the modules beside this file are plain imports, not siblings.
 *
 * Still deliberately absent: **timers**. Nothing here re-enters the loop except
 * in response to a settle. The tick arrives with `/loop`, behind the spike that
 * confirms a timer-driven `sendMessage` actually starts a turn while idle.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installDriver } from "./driver.ts";
import {
	ADVISOR_WATCH_EVERY,
	ADVISOR_WATCH_LEDGER_ID,
	advisorWatchEnabled,
	createAdvisorWatchPolicy,
	MAX_ADVISOR_INJECTIONS,
} from "./advisor-watch.ts";
import { createDriftPolicy } from "./drift.ts";
import { createGatePolicy } from "./gate.ts";
import { looksUnverifiable, parseGoalCommand } from "./goal-command.ts";
import { buildHandoffSeed, writeHandoff } from "./handoff.ts";
import {
	createGoal,
	reviseGoal,
	GOAL_ENTRY_TYPE,
	type GoalItem,
	type GoalOutcome,
	isTerminal,
	rehydrateGoal,
	withState,
} from "./goal-state.ts";
import { branchEntries } from "../session-branch/branch.ts";
import { createGoalPolicy } from "./goal.ts";
import { count } from "./ledger.ts";
import {
	DEFAULT_LOOP_PROMPT,
	MAX_LOOP_FILE_BYTES,
	parseLoopCommand,
	truncateLoopFile,
} from "./loop-command.ts";
import {
	createLoop,
	isTerminal as isLoopTerminal,
	type LoopItem,
	MIN_DELAY_MS,
	rehydrateLoop,
	stopLoop,
	applyWake,
	isDue,
} from "./loop-state.ts";
import { createLoopPolicy, startTick } from "./loop.ts";
import { runPlan } from "./executor.ts";
import { applyRunEvent, emptyRunView, renderRunLines, type RunView } from "./run-view.ts";
import { estimateAgents, suggestCaps } from "./plan-graph.ts";
import {
	type ConductorItem,
	rehydrateConductor,
	withStage as withConductorStage,
} from "./conductor-state.ts";
import {
	createConductorPolicy,
	deriveGoalCondition,
	describeConductor,
	lifecycleEnvelope,
	renderConductorLines,
} from "./conductor.ts";
import {
	AGENT_STATUS_CHANNEL,
	CONDUCTOR_CHANNEL,
	PLAN_APPROVED_CHANNEL,
	PLAN_CONTROL_CHANNEL,
	PLAN_GRILL_CHANNEL,
	type AgentStatusEvent,
	type ConductorStageEvent,
	type PlanApprovedEvent,
	type PlanControlEvent,
	type PlanGrillEvent,
} from "../hive-common/channels.ts";
import { buildGrillKick } from "../plan/prompt.ts";
import {
	AGENT_STATUS_ENTRY_TYPE,
	buildRecapPrompt,
	lastAssistantTextOf,
	mechanicalTaskState,
	MIN_TRANSCRIPT_CHARS,
	sanitizeRecap,
	type AgentStatusItem,
} from "./recap.ts";
import { blocksReentry } from "./question-guard.ts";
import { runOneShot } from "./spawn.ts";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { PlanSchema, type Plan, resolveCaps, validatePlan } from "./plan-schema.ts";
import { discoverAgents } from "../harness/roles.ts";
import { diffStamp } from "../harness/verify.ts";
import { type ContextSignal, contextSignalOf, deriveSignals, emptySignals } from "./signals.ts";
import { shouldAutoShutdown } from "./auto-shutdown.ts";
import { compactInstructions, fetchRecapPayload, handoffRecapSections } from "./session-recap.ts";
import { rehydratePlan } from "../plan/state.ts";
import { isUnattendedHiveLaunch } from "../hive-common/launch.ts";
import { makeSpawn } from "./worker.ts";
import { makeDurableSpawn, WorkerRegistry } from "./rpc-worker.ts";
import { latestReport, REPORT_STATUSES, REPORT_TOOL } from "./rpc-protocol.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatCost } from "../harness/usage.ts";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { randomUUID } from "node:crypto";
import { DurableRunRegistry, type DurableRunResult } from "./run-registry.ts";

/**
 * Set in a spawned worker so a child never re-enters its own loop. Read once at
 * factory time and captured — a child cannot change its own nature mid-process.
 */
const IS_WORKER = process.env.PI_AGENDA_WORKER === "1";

/** Cheap by default: the evaluator runs after every single turn. */
const DEFAULT_EVALUATOR_MODEL = "openrouter/deepseek/deepseek-v4-flash";

/** Model-callable, and active only while a self-paced loop is running. */
const WAKE_TOOL = "agenda_wake";

/** Model-callable, and active only under `/ultracode on`. */
const ORCHESTRATE_TOOL = "orchestrate";

/** Model-callable, and active only alongside `orchestrate`. */
const WORKER_SEND_TOOL = "worker_send";

/** Pull status or retained output for a background durable run. */
const ORCHESTRATE_RESULT_TOOL = "orchestrate_result";

/** Above this, a run asks before it starts. */
const CONFIRM_ABOVE_AGENTS = 25;

export default function (pi: ExtensionAPI) {
	const hiveLaunched = isUnattendedHiveLaunch(process.env.HIVE_LAUNCH_ID);
	let goal: GoalItem | null = null;
	let idCounter = 0;

	const persist = (next: GoalItem) => {
		goal = next;
		try {
			pi.appendEntry(GOAL_ENTRY_TYPE, next);
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
		// The lifecycle widget carries the goal line, so a goal change repaints it.
		paintConductor();
	};

	const goalPolicy = createGoalPolicy({
		current: () => goal,
		commit: (next: GoalItem, _outcome: GoalOutcome) => persist(next),
		evaluatorModel: () => process.env.PI_AGENDA_EVALUATOR_MODEL || DEFAULT_EVALUATOR_MODEL,
	});

	let loop: LoopItem | null = null;

	const persistLoop = (next: LoopItem) => {
		loop = next;
		try {
			pi.appendEntry(GOAL_ENTRY_TYPE, next);
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
	};

	/**
	 * Keep `agenda_wake` in the active set exactly while a self-paced loop runs.
	 *
	 * Read-modify-write against the LIVE set, never a stored snapshot:
	 * `@narumitw/pi-plan-mode` replaces the whole active-tool list wholesale
	 * (`plan-mode.ts:821-829`), so anything holding its own copy loses.
	 */
	const syncWakeTool = () => {
		const wanted = loop?.state === "active" && loop.mode === "self-paced";
		try {
			const active = pi.getActiveTools();
			const has = active.includes(WAKE_TOOL);
			if (wanted && !has) pi.setActiveTools([...active, WAKE_TOOL]);
			if (!wanted && has) pi.setActiveTools(active.filter((name) => name !== WAKE_TOOL));
		} catch {
			/* tool sets are best-effort; never fail a loop for one */
		}
	};

	const loopPolicy = createLoopPolicy({
		current: () => loop,
		commit: persistLoop,
		// Injected turns never emit `before_agent_start`, so the tool set has to
		// be re-asserted on THIS path rather than from that event.
		beforeInject: syncWakeTool,
	});

	let conductor: ConductorItem | null = null;
	let conductorEnabled = true;
	/**
	 * The newest context-pressure reading, for the lifecycle widget (HIV-3173).
	 *
	 * Held rather than read at paint time because `paintConductor` is a closure
	 * with no `ctx` — it is called from goal commits, bus syncs and command
	 * handlers alike. Refreshed on settle, where a live `ctx` exists.
	 */
	let latestContext: ContextSignal | null = null;

	/**
	 * The lifecycle widget. Cosmetic by definition — the deck extension owns
	 * the widget slot (HIV-1219); this states what the lifecycle currently is.
	 * Cleared (null) whenever there is nothing in flight.
	 */
	const paintConductor = () => {
		try {
			const lines = renderConductorLines(conductor, goal, conductorEnabled, latestContext);
			pi.events.emit(DECK_SECTION_CHANNEL, {
				section: "conductor",
				state: lines
					? { kind: "lines", summary: `conductor ▸ ${conductor?.stage ?? "?"}`, lines }
					: null,
			} satisfies DeckSectionEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	pi.events.on(DECK_SYNC_CHANNEL, () => paintConductor());

	const persistConductor = (next: ConductorItem) => {
		const prevStage = conductor?.stage;
		conductor = next;
		try {
			pi.appendEntry(GOAL_ENTRY_TYPE, next);
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
		if (next.stage !== prevStage) {
			// Stage name only — the doorbell that lets hive-remote show the
			// lifecycle moving in the agents workspace. See hive-common/channels.ts.
			try {
				pi.events.emit(CONDUCTOR_CHANNEL, { stage: next.stage } satisfies ConductorStageEvent);
			} catch {
				/* no bus, or nothing listening */
			}
		}
		paintConductor();
	};

	/** Red-vs-red comparison note for the conductor's verify stage (HIV-1232). */
	let verifyNote: string | null = null;

	const conductorPolicy = createConductorPolicy({
		current: () => conductor,
		commit: persistConductor,
		goal: () => goal,
		requestPlanMode: () => {
			try {
				pi.events.emit(PLAN_CONTROL_CHANNEL, { action: "enter" } satisfies PlanControlEvent);
			} catch {
				/* no bus — the injection still tells the model to plan */
			}
		},
		enabled: () => conductorEnabled,
		lastVerifyNote: () => verifyNote,
		recordVerifyNote: (note: string) => {
			verifyNote = note;
		},
	});

	/**
	 * Gate-retry stamps (HIV-1229): after a red gate, the gate is skipped until
	 * the tree's content actually changes. Session-scoped and cleared with the
	 * ledger — a stamp surviving into a fresh session could skip the first gate
	 * run against state the check may no longer reflect.
	 */
	const gateStamps = new Map<string, string>();
	const gatePolicy = createGatePolicy({
		get: (id) => gateStamps.get(id),
		set: (id, stamp) => {
			if (stamp === undefined) gateStamps.delete(id);
			else gateStamps.set(id, stamp);
		},
	});

	const driftPolicy = createDriftPolicy({
		goal: () => goal,
		evaluatorModel: () => process.env.PI_AGENDA_EVALUATOR_MODEL || DEFAULT_EVALUATOR_MODEL,
	});

	// Enabled state lives here, not behind a factory-time check, so
	// `/advisor-watch on` takes effect in the session that runs it. HIV-1052's
	// lesson: a feature gate evaluated once at construction cannot be flipped at
	// runtime, and "enabled" that lies is worse than a feature that is off.
	let advisorWatch = advisorWatchEnabled();
	const advisorWatchPolicy = createAdvisorWatchPolicy({
		enabled: () => advisorWatch && !IS_WORKER,
		modelOverride: () => process.env.PI_ADVISOR_MODEL?.trim() || undefined,
		currentSpec: () => {
			const model = heldCtx?.model;
			return model ? `${model.provider}/${model.id}` : undefined;
		},
	});

	// Chain order is load-bearing: build health first (gate), then the drift
	// probe, then the passive advisor — both must sit BEFORE the goal policy,
	// whose per-settle continue injection would starve everything behind it —
	// then the goal verdict (the conductor's execute→verify transition keys off
	// it), then the conductor, then the timer loop. Pinned by
	// test/agenda-conductor.test.ts.
	const driver = installDriver(pi, {
		policies: [gatePolicy, driftPolicy, advisorWatchPolicy, goalPolicy, conductorPolicy, loopPolicy],
		isWorker: IS_WORKER,
	});

	// Rehydrate from persisted entries. Counters are RESTORED, not zeroed: we
	// add real budgets (Claude Code does not), and a persisted budget with a
	// resetting spend counter is refreshed on every resume and never binds.
	// The most recent ctx, so the plan-approved bus handler can read the plan
	// document off the session entries. Stale after session replacement; every
	// read is guarded.
	let heldCtx: ExtensionContext | null = null;

	pi.on("session_start", (event, ctx) => {
		if (IS_WORKER) return;
		sessionGeneration++;
		autoShutdownScheduled = false;
		heldCtx = ctx;
		// Ephemeral per-session state — unlike goals, deliberately NOT persisted:
		// a gate stamp or verify note from another session describes checks that
		// may no longer reflect anything.
		gateStamps.clear();
		verifyNote = null;
		const reason = (event as { reason?: string }).reason;
		if (reason === "new") {
			// A fresh session inherits nothing — including the ultracode opt-in.
			// A real `/reload` re-runs this factory and resets it anyway, but
			// relying on closure lifetime for a consent flag is not a contract;
			// stating it here is.
			goal = null;
			loop = null;
			conductor = null;
			ultracodeOn = hiveLaunched;
			syncWakeTool();
			syncOrchestrateTool();
			return;
		}
		try {
			// The ACTIVE BRANCH, not every entry the file has ever held (HIV-1972).
			// A session is a tree: `/tree` moves the leaf and `/fork` starts a new
			// file, so a newest-wins scan over all entries can restore the goal,
			// loop or conductor stage that an ABANDONED branch wrote. All three
			// are branch-scoped state by the same argument the plan and workflow
			// documents make, and were left on the old read when those moved.
			const entries = branchEntries(ctx);
			goal = rehydrateGoal(entries);
			loop = rehydrateLoop(entries);
			conductor = rehydrateConductor(entries);
		} catch {
			goal = null;
			loop = null;
			conductor = null;
		}
		// pi force-activates every registered extension tool at session build and
		// again on /reload, so the wake tool has to be removed AFTER the registry
		// exists. This handler is that point.
		syncWakeTool();
		syncOrchestrateTool();
		paintConductor();
	});

	/**
	 * The recap + task-state observer (HIV-1240) — a passive `agent_settled`
	 * subscriber beside the driver, never an injector.
	 *
	 * The STATE is mechanical and synchronous: the question guard already knows
	 * a settle ended waiting on the operator, and the goal/conductor already
	 * know done. Only the PROSE costs a model call, and that call is gated (a
	 * changed, non-trivial transcript tail), detached (a handler must never
	 * await — it IS the agent loop), and runs on the cheap evaluator. The entry
	 * is invisible to the LLM; the bus carries a revision and nothing else, and
	 * hive-remote reads the prose from the entries under its own consent.
	 */
	let statusRevision = 0;
	let lastRecapTail = "";
	let recapInFlight = false;
	let sessionGeneration = 0;
	const autoShutdownEnabled = process.env.PI_AGENDA_AUTO_SHUTDOWN === "1";
	const unattendedHiveLaunch = isUnattendedHiveLaunch(process.env.HIVE_LAUNCH_ID);
	let autoShutdownScheduled = false;
	// Context pressure for the lifecycle widget. Its own handler rather than a
	// branch inside the recap one below, because that handler returns early for
	// non-interactive modes and for a stale ctx — and this reading is cheap,
	// independent, and must not inherit either exit.
	pi.on("agent_settled", (_event, ctx) => {
		if (IS_WORKER) return;
		let next: ContextSignal | null = null;
		try {
			next = contextSignalOf(ctx.getContextUsage());
		} catch {
			// ctx already stale. Keep the previous reading rather than blanking it:
			// a missing number would silently retract a suggestion that is still
			// true, and the widget is repainted on the next settle anyway.
			return;
		}
		const changed = next.percent !== latestContext?.percent;
		latestContext = next;
		if (changed) paintConductor();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (IS_WORKER) return;
		let transcript = "";
		let asksQuestion = false;
		try {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
			const branch = ctx.sessionManager.getBranch() as readonly unknown[];
			asksQuestion = blocksReentry({ lastAssistantText: lastAssistantTextOf(branch), automatic: true });
			transcript = recapTranscript(branch);
		} catch {
			return; // ctx already stale — nothing to classify
		}

		const taskState = mechanicalTaskState({
			asksQuestion,
			goalAchieved: goal?.state === "achieved",
			conductorDone: conductor?.stage === "done",
		});

		const wantRecap =
			!recapInFlight && transcript.length >= MIN_TRANSCRIPT_CHARS && transcript !== lastRecapTail;

		const persistStatus = (recap: string) => {
			statusRevision++;
			const item: AgentStatusItem = {
				kind: "agent-status",
				revision: statusRevision,
				taskState,
				recap,
				at: Date.now(),
			};
			try {
				pi.appendEntry(AGENT_STATUS_ENTRY_TYPE, item);
			} catch {
				return; // session gone — a status for it helps nobody
			}
			try {
				pi.events.emit(AGENT_STATUS_CHANNEL, { revision: statusRevision } satisfies AgentStatusEvent);
			} catch {
				/* no bus, or nothing listening */
			}
		};

		if (!wantRecap) {
			// The state is still news (needs_input drives the workspace triage);
			// an empty recap never blanks a previous one — the server and the
			// entry reader both preserve on empty.
			persistStatus("");
			scheduleAutoShutdown(ctx, asksQuestion);
			return;
		}

		recapInFlight = true;
		lastRecapTail = transcript;
		// Detached, like every network call in hive-remote: pi awaits handlers
		// serially, and a model call in a settle handler would BE the agent loop.
		setTimeout(() => {
			void runOneShot({
				prompt: buildRecapPrompt(transcript),
				model: process.env.PI_AGENDA_EVALUATOR_MODEL || DEFAULT_EVALUATOR_MODEL,
				cwd: process.cwd(),
				timeoutMs: 60_000,
				env: { PI_AGENDA_WORKER: "1" },
			})
				.then((result) => {
					const recap = result.exitCode === 0 && !result.timedOut ? sanitizeRecap(result.text) : "";
					persistStatus(recap);
				})
				.catch(() => persistStatus(""))
				.finally(() => {
					recapInFlight = false;
					// The recap is part of the completion barrier: only after its
					// status entry has been attempted may the session close.
					scheduleAutoShutdown(ctx, asksQuestion);
				});
		}, 0);
	});

	/**
	 * Close only a finished, unattended session. The final conductor transition
	 * is committed by the settle observer; defer one turn of the event loop so
	 * all settle subscribers (especially telemetry) have returned first. The
	 * generation, mode, idle state and terminal state are rechecked in the
	 * callback, so an operator action or session replacement cancels the close.
	 */
	const scheduleAutoShutdown = (ctx: ExtensionContext, asksQuestion: boolean) => {
		if (
			autoShutdownScheduled ||
			!shouldAutoShutdown({
				enabled: autoShutdownEnabled,
				mode: ctx.mode,
				unattendedHiveLaunch,
				conductorDone: conductor?.stage === "done",
				asksQuestion: asksQuestion,
			})
		) {
			return;
		}
		autoShutdownScheduled = true;
		const generation = sessionGeneration;
		setTimeout(() => {
			autoShutdownScheduled = false;
			try {
				if (
					generation !== sessionGeneration ||
					!shouldAutoShutdown({
						enabled: autoShutdownEnabled,
						mode: ctx.mode,
						unattendedHiveLaunch,
						conductorDone: conductor?.stage === "done",
						asksQuestion: false,
					}) ||
					!ctx.isIdle() ||
					ctx.hasPendingMessages()
				) {
					return;
				}
				ctx.shutdown();
			} catch {
				/* The session was replaced or already shutting down. */
			}
		}, 0);
	};

	/**
	 * Agent-scheduled compaction (HIV-1241, prime-agent's `compact.run()`):
	 * the request is recorded here and honoured AT SETTLE, never mid-turn —
	 * compacting under an active turn would summarize the ground out from
	 * under it.
	 */
	let pendingCompact: { instructions?: string } | null = null;
	pi.on("agent_settled", (_event, ctx) => {
		if (IS_WORKER || !pendingCompact) return;
		const request = pendingCompact;
		pendingCompact = null;
		try {
			ctx.compact({ customInstructions: compactInstructions(request.instructions) });
		} catch {
			/* session replaced — the next explicit /compact still works */
		}
	});

	pi.registerTool({
		name: "compact_schedule",
		label: "Schedule compaction",
		description:
			"Schedule a context compaction to run when this turn ends. Use when context is filling up and " +
			"substantial work remains, so you keep working instead of stopping early. Optional instructions " +
			"tell the summarizer what to emphasize and what to preserve verbatim.",
		promptSnippet:
			"When context is filling and much work remains, call compact_schedule (turn-end compaction) instead of stopping.",
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({ description: "What the summary must emphasize or preserve verbatim." }),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			if (IS_WORKER) {
				return { content: [{ type: "text", text: "compact_schedule is inert inside a worker process." }], details: null };
			}
			pendingCompact = { instructions: params.instructions?.trim() || undefined };
			let usageNote = "";
			try {
				const usage = ctx.getContextUsage();
				if (usage && usage.percent !== null) {
					usageNote = ` Context is at ${Math.round(usage.percent)}%.`;
				}
			} catch {
				/* usage is decoration */
			}
			return {
				content: [
					{
						type: "text",
						text: `Compaction scheduled for the end of this turn.${usageNote} Repeated calls just update the instructions.`,
					},
				],
				details: null,
			};
		},
	});

	// One tick for the whole extension, `unref`'d so it can never hold the
	// process open. It does two synchronous things — a pure dueness check and a
	// pump — and never injects, never touches ctx, never awaits.
	const tick = startTick(
		() => loop !== null && loop.state === "active" && isDue(loop, Date.now()),
		() => driver.pump(),
	);
	pi.on("session_shutdown", () => {
		tick.stop();
		// Cancel run drivers before killing their workers, so an intentional
		// session shutdown cannot be reported as a correctness failure.
		runs.cancelAll();
		// An orphaned child outlives the session that made it and holds its
		// worktree lock invisibly to the next one.
		workers.stopAll();
	});

	// Re-arm the goal after compaction HERE, not via a `before_agent_start`
	// flag. Turns injected by this extension reach `_runAgentPrompt` directly
	// (agent-session.js:1085) and never emit `before_agent_start`, so in an
	// unattended run that flag would be set and never consumed — the condition
	// would silently stop being in front of the model.
	pi.on("session_compact", () => {
		if (IS_WORKER) return;
		if (goal && goal.state === "active") {
			try {
				pi.sendMessage(
					{
						customType: "agenda",
						content: `Active goal (restored after compaction): ${goal.condition}`,
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
			} catch {
				/* nothing to re-arm into */
			}
		}
		if (conductor && conductor.stage !== "idle" && conductor.stage !== "done") {
			try {
				pi.sendMessage(
					{
						customType: "agenda",
						content: `Conductor (restored after compaction): this session is in the "${conductor.stage}" stage of the task lifecycle.`,
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
			} catch {
				/* nothing to re-arm into */
			}
		}
	});

	/**
	 * Plan approval — the consent event the whole lifecycle pivots on.
	 *
	 * The event carries counters only (see hive-common/channels.ts), so the
	 * plan's goal sentence is read from the session entries under this
	 * extension's own access, the same pattern hive-remote uses. Everything
	 * here is user-initiated (the confirm dialog or `/plan approve`), so the
	 * sendMessage kick is the same class as `/goal set`'s — a command starting
	 * a turn, not a second injector.
	 */
	pi.events.on(PLAN_APPROVED_CHANNEL, (payload) => {
		if (IS_WORKER) return;
		const event = payload as PlanApprovedEvent | undefined;
		if (typeof event?.stepCount !== "number") return;

		let cwd = process.cwd();
		let planGoal = "";
		try {
			const ctx = heldCtx;
			if (ctx) {
				cwd = ctx.cwd;
				// Branch-scoped for the same reason the plan document itself is
				// (HIV-1972): this newest-wins scan feeds the goal the driver works
				// against, so an abandoned branch's plan would hand it the wrong one.
				const entries = branchEntries(ctx);
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
					if (entry?.customType !== "plan") continue;
					const goalField = (entry.data as { goal?: unknown } | undefined)?.goal;
					if (typeof goalField === "string") planGoal = goalField;
					break;
				}
			}
		} catch {
			/* stale ctx — derive from defaults */
		}

		// Auto-goal: never clobber a goal the user set themselves.
		if (!goal || isTerminal(goal.state)) {
			idCounter++;
			const now = Date.now();
			const condition = deriveGoalCondition(planGoal, cwd);
			persist(
				createGoal(`goal-${now.toString(36)}-${idCounter}`, condition, now, {
					budget: { tokens: 300_000 },
				}),
			);
		}

		// Orchestration consent: the approval dialog named it, the user approved.
		const orchestrate = event.orchestrationConsented === true && event.stepCount > 1;
		if (orchestrate && !ultracodeOn) {
			ultracodeOn = true;
			syncOrchestrateTool();
		}

		// Advance the conductor immediately rather than waiting a settle.
		if (conductor && (conductor.stage === "plan" || conductor.stage === "frame" || conductor.stage === "idle")) {
			persistConductor(withConductorStage(conductor, "execute", Date.now()));
		}

		const caps = suggestCaps(event.stepCount);
		const kick = [
			"The plan is approved — begin execution.",
			"",
			`Goal set: ${goal?.condition ?? "(none)"}`,
			"",
			orchestrate
				? `Orchestration is enabled: build a coordinated \`orchestrate\` plan for independent items ` +
					`(suggested caps: maxConcurrent ${caps.maxConcurrent}, maxAgents ${caps.maxAgents}). ` +
					"Use caps.durable=true when you may steer, add scope, stop redundant workers, or launch a follow-up wave while this one runs. " +
					"Fan out over ITEMS, never phases of one edit; finish wide waves with a barrier and one orchestration-reconciler pipeline stage."
				: "Delegate one bounded step with `subagent`; use its parallel mode when several read-only questions are already independent.",
			"Keep the workflow's worker children and supervise/resize/collect steps current. Verify reconciled findings before relying on them.",
		].join("\n");
		try {
			pi.sendMessage(
				{ customType: "agenda", content: kick, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* session went away between approval and the kick */
		}
	});

	/**
	 * The other answer to a plan gate: the user declined and asked to be grilled
	 * (HIV-2080).
	 *
	 * Injected HERE rather than in the `plan` extension for the reason the
	 * approval kick is: plan/index.ts constraint #4 is that nothing in it
	 * re-enters the agent loop, and this driver owns the one injector. The
	 * instruction itself comes from `plan/prompt.ts` so the two delivery paths —
	 * this turn, and the tool result a local TUI gets back from `plan_ready` —
	 * cannot drift apart.
	 *
	 * No goal is derived and the conductor is NOT advanced: nothing was approved,
	 * the session is still planning, and moving it to `execute` here would tell
	 * every reader the opposite of what just happened.
	 */
	pi.events.on(PLAN_GRILL_CHANNEL, (payload) => {
		if (IS_WORKER) return;
		const event = payload as PlanGrillEvent | undefined;
		if (typeof event?.round !== "number") return;
		try {
			pi.sendMessage(
				{ customType: "agenda", content: buildGrillKick(event.round), display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* session went away between the decline and the kick */
		}
	});

	// Registered UNCONDITIONALLY, then DEACTIVATED on every session_start.
	//
	// pi force-activates every registered extension tool when it builds the
	// session (agent-session.js:157/:2003) and does it AGAIN on /reload
	// (:2058-2062), so "registered but inactive by default" is not a thing that
	// exists. The only way to keep a tool out of the set is to take it out after
	// the registry is built — which is what session_start is, and what pi-lens
	// already does (dist/index.js:78620-78633).
	pi.registerTool({
		name: WAKE_TOOL,
		label: "Loop wake",
		description:
			"Schedule when to resume work in a self-paced /loop. Call this before ending your turn to keep the loop alive; call it with stop:true to end the loop.",
		promptSnippet: "Self-paced /loop: re-arm with agenda_wake before ending the turn, or the loop ends.",
		parameters: Type.Object({
			delaySeconds: Type.Optional(
				Type.Integer({ description: "Seconds until the next iteration. Clamped to [60, 3600]." }),
			),
			reason: Type.Optional(Type.String({ description: "One short sentence on why this delay." })),
			stop: Type.Optional(Type.Boolean({ description: "End the loop now." })),
			noop: Type.Optional(Type.Boolean({ description: "Nothing changed this iteration." })),
		}),
		execute: async (_id, params) => {
			if (!loop || loop.state !== "active") {
				return { content: [{ type: "text", text: "No loop is running." }], details: null };
			}
			const { loop: next, clamped, advisedStop } = applyWake(loop, params, Date.now());
			persistLoop(next);
			syncWakeTool();

			if (next.state === "stopped") {
				return { content: [{ type: "text", text: "Loop stopped." }], details: null };
			}
			const seconds = Math.round(((next.nextAt ?? Date.now()) - Date.now()) / 1000);
			const notes = [`Next iteration in ~${seconds}s.`];
			if (clamped) notes.push("(delay was clamped to the 60s–3600s range)");
			if (advisedStop) {
				notes.push(
					"This loop has reported nothing new several times running — consider calling agenda_wake with stop:true.",
				);
			}
			return { content: [{ type: "text", text: notes.join(" ") }], details: null };
		},
	});

	pi.registerCommand("goal", {
		description: "Keep working until a condition holds (`/goal <condition>`, `/goal clear`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (IS_WORKER) {
				ctx.ui.notify("/goal is inert inside a worker process.", "warning");
				return;
			}

			const command = parseGoalCommand(args);
			const now = Date.now();

			switch (command.kind) {
				case "error":
					ctx.ui.notify(`/goal: ${command.message}`, "warning");
					return;

				case "status":
					ctx.ui.notify(describeGoal(goal, now), "info");
					return;

				case "clear": {
					if (!goal) {
						ctx.ui.notify("No goal set.", "info");
						return;
					}
					const condition = goal.condition;
					persist(withState(goal, "cleared", now));
					goal = null;
					ctx.ui.notify(`Goal cleared: ${condition}`, "info");
					return;
				}

				case "pause": {
					if (!goal || goal.state !== "active") {
						ctx.ui.notify("No active goal to pause.", "info");
						return;
					}
					persist(withState(goal, "paused", now));
					ctx.ui.notify("Goal paused. `/goal resume` to continue.", "info");
					return;
				}

				case "resume": {
					if (!goal || goal.state !== "paused") {
						ctx.ui.notify("No paused goal to resume.", "info");
						return;
					}
					persist(withState(goal, "active", now));
					ctx.ui.notify("Goal resumed.", "info");
					return;
				}

				case "set": {
					idCounter++;
					const next = createGoal(`goal-${now.toString(36)}-${idCounter}`, command.condition, now, {
						budget: command.budget,
					});
					persist(next);

					const notes = [`Goal set: ${command.condition}`];
					if (looksUnverifiable(command.condition)) {
						notes.push(
							"Note: this names no machine-checkable check, so the evaluator can only grade what appears in the transcript.",
						);
					}
					notes.push("`/goal clear` to stop.");
					ctx.ui.notify(notes.join(" "), "info");

					// Setting a goal starts a turn immediately, with the condition
					// itself as the directive — matching Claude Code, and avoiding a
					// goal that sits inert until the user happens to say something.
					try {
						pi.sendMessage(
							{
								customType: "agenda",
								content: `Work toward this goal until it holds:\n\n${command.condition}`,
								display: true,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						/* session went away between the command and the injection */
					}
					return;
				}
			}
		},
	});

	/**
	 * Model-accessible goal setting — `/goal` is a slash command and the model
	 * cannot type those, so without this the lifecycle's "set a verifiable
	 * finish line" step is structurally impossible for the model to perform.
	 *
	 * Two shaping behaviours, both ERRORS rather than warnings (tool errors
	 * change model behaviour; description prose does not): an unverifiable
	 * condition is bounced with instructions to restate it, and an active goal
	 * is never silently replaced.
	 */
	pi.registerTool({
		name: "goal_set",
		label: "Set goal",
		description:
			"Set a machine-checkable finish condition for the current work. A cheap judge evaluates it only when Pi reaches " +
			"agent_settled (idle, with no pending tools or follow-ups), then re-drives you until it holds (bounded by caps). " +
			"Active or interrupted tool chains are not evaluated. " +
			'Example condition: "PR created and `gh pr checks` reports all green".',
		promptSnippet:
			"For multi-step work, set a machine-checkable finish line with goal_set (e.g. \"PR created and its checks green\").",
		parameters: Type.Object({
			condition: Type.String({ description: "The finish condition. Name something checkable: a command, a path, a count." }),
			replace: Type.Optional(
				Type.Boolean({
					description:
						"Revise the ACTIVE goal's condition instead of refusing. The previous condition is recorded and " +
						"the budget keeps counting — a revision buys no fresh iterations.",
				}),
			),
			tokens: Type.Optional(Type.Integer({ description: "Evaluator token budget (default 300000)." })),
			hours: Type.Optional(Type.Number({ description: "Wall-clock budget in hours." })),
		}),
		execute: async (_id, params) => {
			if (IS_WORKER) {
				return { content: [{ type: "text", text: "goal_set is inert inside a worker process." }], details: null };
			}
			const condition = params.condition.trim();
			if (!condition) {
				return { content: [{ type: "text", text: "goal_set needs a condition." }], details: null, isError: true };
			}
			if (goal && !isTerminal(goal.state) && !params.replace) {
				return {
					content: [
						{
							type: "text",
							text:
								`A goal is already active: "${goal.condition}". If this is the SAME task and the ` +
								`condition has simply moved on — a new sha, a renamed check — call goal_set again with ` +
								`\`replace: true\`: the old condition is recorded and the budget keeps counting. ` +
								`If it is different work, finish this one or ask the user for \`/goal clear\`.`,
						},
					],
					details: null,
					isError: true,
				};
			}
			if (looksUnverifiable(condition)) {
				return {
					content: [
						{
							type: "text",
							text:
								"This condition names nothing machine-checkable, so the judge could only grade your own " +
								"self-report. Restate it with a command, a path, or a count — e.g. " +
								'"PR created and `gh pr checks` exits 0" or "0 errors from the repo gate".',
						},
					],
					details: null,
					isError: true,
				};
			}
			const now = Date.now();
			// A REVISION, not a new goal: same id, same ledger, one more entry in
			// the trail. Handled here rather than by clearing and re-setting,
			// because clearing is what resets the budget and that is exactly the
			// escape hatch this must not open.
			if (goal && !isTerminal(goal.state) && params.replace) {
				// Captured BEFORE persist, which reassigns `goal` — without this the
				// "Was:" line prints the new condition and the message quietly
				// asserts that nothing changed. (A test caught exactly that.)
				const previous = goal.condition;
				const revised = reviseGoal(goal, condition, now);
				persist(revised);
				return {
					content: [
						{
							type: "text",
							text:
								`Goal revised: ${condition}\nWas: ${previous}\n` +
								`Iterations and budget carry over — a revision does not buy fresh ones.`,
						},
					],
					details: { condition, ...lifecycleEnvelope(conductor?.stage ?? "execute", revised) },
				};
			}
			idCounter++;
			const next = createGoal(`goal-${now.toString(36)}-${idCounter}`, condition, now, {
				budget: {
					tokens: params.tokens ?? 300_000,
					...(params.hours ? { wallClockMs: Math.round(params.hours * 3_600_000) } : {}),
				},
			});
			persist(next);
			// No sendMessage kick: the model is already mid-turn — it set the goal
			// itself and continues under it. The evaluator engages on settle.
			return {
				content: [
					{
						type: "text",
						text:
							`Goal set: ${condition}\nThe evaluator runs only when Pi becomes idle (agent_settled); ` +
							"it does not evaluate active or interrupted tool chains. The user can stop it with /goal clear.",
					},
				],
				// The envelope makes the goal legible in the Hive agents workspace;
				// the terminal renders from the text above, unchanged.
				details: { condition, ...lifecycleEnvelope(conductor?.stage ?? "execute", next) },
			};
		},
	});

	pi.registerCommand("conductor", {
		description: "Automatic task-lifecycle steering (`/conductor on|off|status`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (IS_WORKER) {
				ctx.ui.notify("/conductor is inert inside a worker process.", "warning");
				return;
			}
			const argument = args.trim().toLowerCase();
			if (argument === "off") {
				conductorEnabled = false;
				paintConductor();
				ctx.ui.notify("Conductor off for this session.", "info");
				return;
			}
			if (argument === "on") {
				conductorEnabled = true;
				paintConductor();
				ctx.ui.notify("Conductor on. Complex tasks get todos → plan mode → goal → verify automatically.", "info");
				return;
			}
			ctx.ui.notify(describeConductor(conductor, conductorEnabled), "info");
		},
	});

	/**
	 * `/advisor-watch on|off|status` — the passive advisor (HIV-1564).
	 *
	 * Separate from `/conductor` because it is the one policy that spends a
	 * HIGHER-class model on every probe: it should be a deliberate, visible
	 * choice, not something that rides along with lifecycle steering.
	 */
	pi.registerCommand("advisor-watch", {
		description: "A stronger model reads your turns and speaks up (`/advisor-watch on|off|status`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (IS_WORKER) {
				ctx.ui.notify("/advisor-watch is inert inside a worker process.", "warning");
				return;
			}
			const argument = args.trim().toLowerCase();
			if (argument === "off") {
				advisorWatch = false;
				ctx.ui.notify("Passive advisor off for this session.", "info");
				return;
			}
			if (argument === "on") {
				advisorWatch = true;
				ctx.ui.notify(
					`Passive advisor on: every ${ADVISOR_WATCH_EVERY} settles a stronger model reads the recent ` +
						`transcript and injects only for a concern or a blocker (max ${MAX_ADVISOR_INJECTIONS} per session). ` +
						"This spends a higher-class model — turn it off when you do not want that.",
					"info",
				);
				return;
			}
			const used = count(driver.ledger(), ADVISOR_WATCH_LEDGER_ID);
			ctx.ui.notify(
				advisorWatch
					? `Passive advisor ON — ${used}/${MAX_ADVISOR_INJECTIONS} injections used this session, probing every ${ADVISOR_WATCH_EVERY} settles.`
					: "Passive advisor OFF. `/advisor-watch on` enables it, or set PI_ADVISOR_WATCH=1.",
				"info",
			);
		},
	});

	/**
	 * `/handoff [objective]` — the clean break that replaces compaction at a
	 * phase boundary (HIV-1231). Writes a reviewable seed to `.pi/handoff.md`;
	 * the FILE is the review UI, and the next fresh interactive session in this
	 * cwd consumes it once (session-context.ts).
	 */
	pi.registerCommand("handoff", {
		description: "Seed the next session and end this one cleanly (`/handoff [objective]`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (IS_WORKER) {
				ctx.ui.notify("/handoff is inert inside a worker process.", "warning");
				return;
			}
			let signals = emptySignals;
			try {
				signals = deriveSignals(
					ctx.sessionManager.getEntries() as readonly unknown[],
					ctx.sessionManager.getBranch() as readonly unknown[],
				);
			} catch {
				/* unreadable session — the seed still carries goal/conductor/git state */
			}
			const cwd = ctx.cwd;

			// The open work items live only on this machine — Hive parses the plan
			// document for {phase, done, total} and stores no todos at all.
			//
			// From the ACTIVE BRANCH, not the whole file (HIV-1972): a session is a
			// tree, `/tree` moves the leaf, and the newest plan snapshot in the file
			// may belong to a branch the operator abandoned. Seeding the successor
			// from that is failure (a) of test/branch-scoped-state.test.ts, with the
			// abandoned work carried into a fresh session that cannot tell.
			let plan = null;
			try {
				plan = rehydratePlan(branchEntries(ctx));
			} catch {
				/* an unreadable plan degrades to the counts, not to a failed handoff */
			}

			// A command handler is the sanctioned place for this: `resolveAuth` does
			// blocking I/O and must never run inside an event handler, where pi
			// awaits serially. `null` means ABSENT — the seed says so rather than
			// letting the successor read silence as "no PR, no ticket, no team".
			let recap: ReturnType<typeof handoffRecapSections> | null = null;
			try {
				const payload = await fetchRecapPayload();
				if (payload !== null) recap = handoffRecapSections(payload);
			} catch {
				/* unreachable Hive is a thinner seed, never a failed handoff */
			}

			const seed = buildHandoffSeed({
				objective: args.trim(),
				goal,
				conductor,
				signals,
				gitStatus: await diffStamp(cwd),
				cwd,
				plan,
				recap,
			});
			try {
				const path = writeHandoff(cwd, seed);
				// Lineage: the outgoing session records that it handed off.
				try {
					pi.appendEntry(GOAL_ENTRY_TYPE, { kind: "handoff", path, createdAt: Date.now() });
				} catch {
					/* session going away is exactly when a handoff happens */
				}
				ctx.ui.notify(
					`Handoff seed written to ${path}. Review/edit it, then start a fresh session here — it will be injected once and consumed.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`/handoff: could not write the seed: ${String(err)}`, "warning");
			}
		},
	});

	// A Hive launch is already an operator-authorized coding-agent task. Exposing
	// orchestration lets task shape decide whether to use it; a human's own TUI
	// still opts in through plan approval or `/ultracode on`.
	let ultracodeOn = hiveLaunched;

	// Lives in the factory closure, never at module scope: pi builds a fresh jiti
	// per extension entry, so a module-level registry would fork silently and
	// each half would believe it owned every worker.
	const workers = new WorkerRegistry();
	const runs = new DurableRunRegistry();

	/** Keep `orchestrate` in the active set exactly while /ultracode is on. */
	const syncOrchestrateTool = () => {
		try {
			const active = pi.getActiveTools();
			// Both tools move together: worker_send addresses workers only an
			// orchestrate run creates, so offering it alone is a tool that can only
			// ever answer "no such worker".
			const gated = [ORCHESTRATE_TOOL, WORKER_SEND_TOOL, ORCHESTRATE_RESULT_TOOL];
			const without = active.filter((name) => !gated.includes(name));
			pi.setActiveTools(ultracodeOn ? [...without, ...gated] : without);
		} catch {
			/* tool sets are best-effort */
		}
	};

	/**
	 * The upward half of the channel, and it lives in the CHILD.
	 *
	 * There is no new transport: spike W2 confirmed `tool_execution_start`
	 * carries the tool name and its full arguments on the RPC stream, so the
	 * parent sees a report the moment it is CALLED rather than when the worker
	 * finishes. A worker that hits a blocker at minute two can say so at minute
	 * two instead of at minute twenty.
	 *
	 * The tool does essentially nothing locally — being called IS the message.
	 * It confirms receipt so the model does not retry, and nothing else.
	 */
	pi.registerTool({
		name: REPORT_TOOL,
		label: "Report",
		description: [
			"Tell the orchestrator how this task is going, without waiting to finish.",
			'Use status "blocked" the moment you are stuck — that is what lets the orchestrator help.',
			"Keep the note to one short line; it is a status line, not a summary.",
		].join(" "),
		promptSnippet: "Report progress or a blocker to the orchestrator mid-task",
		parameters: Type.Object({
			status: StringEnum(REPORT_STATUSES, { description: "progress | blocked | done" }),
			note: Type.String({ description: "One short line. Truncated past 200 characters." }),
			pct: Type.Optional(Type.Integer({ description: "Rough completion, 0-100." })),
		}),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `Reported: ${params.status}${params.note ? ` — ${params.note}` : ""}` }],
			details: null,
		}),
	});

	/**
	 * `report` belongs to workers ONLY, and the orchestrator must not carry it:
	 * a tool whose entire effect is "be observed by my parent" is noise in a
	 * session that has no parent, and the model will eventually call it.
	 *
	 * Done in a `session_start` handler because pi force-activates every
	 * registered extension tool at session build and again on `/reload` — the
	 * same reason `agenda_wake` is synced there rather than at registration.
	 */
	const syncReportTool = () => {
		try {
			const active = pi.getActiveTools();
			const has = active.includes(REPORT_TOOL);
			if (IS_WORKER && !has) pi.setActiveTools([...active, REPORT_TOOL]);
			if (!IS_WORKER && has) pi.setActiveTools(active.filter((name) => name !== REPORT_TOOL));
		} catch {
			/* tool sets are best-effort */
		}
	};
	pi.on("session_start", () => syncReportTool());

	pi.registerTool({
		name: WORKER_SEND_TOOL,
		label: "Send to worker",
		description: [
			"Supervise a durable worker that is still running (requires caps.durable on the plan).",
			'mode "steer" INTERRUPTS its current turn — use when the work in flight is now wrong.',
			'mode "follow_up" queues until the turn ends — use to add scope.',
			'mode "stop" intentionally terminates redundant or obsolete work; it is reported as stopped, not failed.',
			"Call with no id to list live workers.",
		].join(" "),
		promptSnippet: "List, correct, re-scope, or stop a running durable worker",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Worker id. Omit to list live workers." })),
			message: Type.Optional(Type.String({ description: "What to tell the worker." })),
			mode: Type.Optional(
				StringEnum(["steer", "follow_up", "stop"] as const, {
					description: 'steer interrupts; follow_up queues; stop terminates intentionally. Default "follow_up".',
				}),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, _ctx) => {
			// Depth 1: a worker addressing other workers is peer-to-peer, whose
			// race conditions scale as N(N-1)/2. One level, one supervisor.
			if (IS_WORKER) {
				return { content: [{ type: "text", text: "worker_send is not available inside a worker." }], details: null };
			}

			const live = workers.list();
			const describeLive = () =>
				live.length === 0
					? "No live workers."
					: live
							.map((worker) => {
								const state = worker.state();
								const report = latestReport(state);
								// The worker's own words come FIRST. "blocked" is the whole
								// reason this channel exists, and burying it behind token
								// counts is how it gets skimmed past.
								const said = report
									? ` · says ${report.status}${report.pct !== undefined ? ` ${report.pct}%` : ""}${report.note ? `: ${report.note}` : ""}`
									: "";
								// "never started" is its own word: an idle worker with 0 turns
								// used to read as one waiting for work, when it was one whose
								// dispatch had been accepted and dropped (see dispatchCommand).
								const phase = state.busy ? "working" : worker.startFailure?.() ? "never started" : "idle";
								return `  ${worker.id} (${worker.role})${said} — ${phase}, ${state.turns} turn(s), ${state.tokens} tokens${
									formatCost(state.usage.cost) ? `, ${formatCost(state.usage.cost)}` : ""
								}${state.lastTool ? `, last tool ${state.lastTool}` : ""}`;
							})
							.join("\n");

			if (!params.id) {
				return { content: [{ type: "text", text: `Live workers:\n${describeLive()}` }], details: { count: live.length } };
			}
			// Accepts the composite id the listing prints, or any unambiguous
			// segment of it. An exact-only lookup rejected the very id shown one
			// line above, leaving a supervisor unable to steer or stop its worker.
			const resolved = workers.resolve(params.id);
			if (resolved.ambiguous) {
				return {
					content: [
						{
							type: "text",
							text: `"${params.id}" matches ${resolved.ambiguous.length} live workers — name one exactly:\n${resolved.ambiguous
								.map((candidate) => `  ${candidate.id}`)
								.join("\n")}`,
						},
					],
					details: null,
					isError: true,
				};
			}
			const worker = resolved.worker;
			// An error, never a silent success. A supervisor that believes it
			// re-tasked a worker which had already exited waits forever for a
			// result that is not coming.
			if (!worker) {
				return {
					content: [{ type: "text", text: `No live worker "${params.id}".\nLive workers:\n${describeLive()}` }],
					details: null,
					isError: true,
				};
			}
			if (params.mode === "stop") {
				workers.stop(worker.id);
				return {
					content: [{ type: "text", text: `Stopped ${worker.id} (${worker.role}); its plan result will record stopped_by_orchestrator.` }],
					details: { id: worker.id, stopped: true },
				};
			}
			if (!params.message?.trim()) {
				return { content: [{ type: "text", text: "worker_send needs a message for steer or follow_up." }], details: null, isError: true };
			}

			try {
				await worker.send(params.message, params.mode === "steer" ? "steer" : "follow_up");
			} catch (err) {
				return {
					content: [{ type: "text", text: `Delivery to "${params.id}" failed: ${String(err)}` }],
					details: null,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Delivered to ${params.id} (${params.mode ?? "follow_up"}).` }],
				details: { id: params.id },
			};
		},
	});

	pi.registerTool({
		name: ORCHESTRATE_RESULT_TOOL,
		label: "Orchestration result",
		description: "List background durable orchestration runs, or retrieve one run's retained status and full result by id.",
		promptSnippet: "Read status or full output from a background durable orchestration run",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Run id returned by orchestrate; omit to list runs." })),
		}),
		execute: async (_id, params) => {
			if (IS_WORKER) {
				return { content: [{ type: "text", text: "orchestrate_result is not available inside a worker." }], details: null };
			}
			if (!params.id) {
				const records = runs.list();
				const text = records.length === 0
					? "No background orchestration runs."
					: records.map((run) => `${run.id} — ${run.status} — ${run.name}`).join("\n");
				return { content: [{ type: "text", text }], details: { runs: records } };
			}
			const run = runs.get(params.id);
			if (!run) {
				return { content: [{ type: "text", text: `No orchestration run "${params.id}".` }], details: null, isError: true };
			}
			if (run.result) {
				return { content: [{ type: "text", text: run.result.text }], details: run.result.details };
			}
			const text = run.error
				? `Run ${run.id} failed: ${run.error}`
				: `Run ${run.id} is ${run.status}. Call worker_send without an id to inspect its live workers.`;
			return { content: [{ type: "text", text }], details: { run } };
		},
	});

	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "each worker spawn guards its own cwd via guardWorkerCwd (agenda/worker.ts, agenda/rpc-worker.ts)" },
		name: ORCHESTRATE_TOOL,
		label: "Orchestrate",
		description:
			"Run a declarative multi-agent plan. Fan out over items, pipeline them through stages, reconcile results, and optionally keep workers steerable in the background with caps.durable=true. Available after approved multi-step planning, /ultracode, or automatically in a Hive-launched session.",
		promptSnippet:
			"Use orchestrate for coordinated fleets: prefer a useful bounded wave, caps.durable=true for live supervision, worker_send to steer/add scope/stop, another wave for new gaps, and one final orchestration-reconciler join.",
		parameters: PlanSchema,
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			if (IS_WORKER) {
				// Depth 1. Nesting multiplies every cap by the fan-out width.
				return { content: [{ type: "text", text: "orchestrate is not available inside a worker." }], details: null };
			}

			const plan = params as Plan;
			const roles = discoverAgents(ctx.cwd, "both").agents.map((role) => role.name);
			const issues = validatePlan(plan, roles);
			if (issues.length > 0) {
				const text = issues.map((issue) => (issue.nodeId ? `${issue.nodeId}: ${issue.message}` : issue.message)).join("\n");
				return { content: [{ type: "text", text: `Plan rejected:\n${text}` }], details: { issues } };
			}

			const estimate = estimateAgents(plan);
			if (estimate > CONFIRM_ABOVE_AGENTS) {
				const proceed = await ctx.ui.confirm(
					"Large orchestration run",
					`"${plan.name}" could spawn about ${estimate} agents. Continue?`,
				);
				if (!proceed) {
					return { content: [{ type: "text", text: "Run cancelled by the user." }], details: null };
				}
			}

			const runId = `run-${randomUUID()}`;
			const cwd = ctx.cwd; // capture before a detached run can outlive this tool ctx
			const caps = resolveCaps(plan.caps);
			const executeRun = async (runSignal: AbortSignal | undefined): Promise<DurableRunResult> => {
				const events: unknown[] = [];

				// Live view. Without it a multi-minute run is a frozen screen and a
				// healthy 12-way fan-out is indistinguishable from a wedged one.
				// Published to the deck (HIV-1219); `live: true` keeps it expanded.
				let view: RunView = emptyRunView(Date.now());
				// The deck protocol has a closed section vocabulary; overlapping runs
				// share this cosmetic panel while their ids remain distinct everywhere
				// operational (registry, workers, results).
				const section = "orchestrate" as const;
				const paint = () => {
					try {
						const done = view.nodes.filter((n) => n.state === "done").length;
						const failed = view.nodes.filter((n) => n.state === "failed").length;
						pi.events.emit(DECK_SECTION_CHANNEL, {
							section,
							state: {
								kind: "lines",
								summary: `orchestrate ${done + failed}/${view.nodes.length}${failed > 0 ? ` ✗${failed}` : ""}`,
								lines: renderRunLines(view, plan.name, Date.now()),
								live: true,
							},
						} satisfies DeckSectionEvent);
					} catch {
						/* no bus mid-run; the view is cosmetic */
					}
				};
				// Elapsed times must advance even while every worker is silent — that
				// is exactly the interval where the user needs to see something move.
				const repaint = setInterval(paint, 1_000);
				repaint.unref?.();

				let summary: Awaited<ReturnType<typeof runPlan>>;
				try {
					summary = await runPlan({
						plan,
						spawn: caps.durable ? makeDurableSpawn(cwd, runId, workers) : makeSpawn(cwd, runId),
						signal: runSignal,
						journal: (event) => {
							events.push(event);
							view = applyRunEvent(view, event);
							paint();
						},
					});
				} finally {
					clearInterval(repaint);
					try {
						pi.events.emit(DECK_SECTION_CHANNEL, { section, state: null } satisfies DeckSectionEvent);
					} catch {
						/* nothing to clear */
					}
				}

				const lines = [
					`Plan "${plan.name}" finished: ${summary.agentsSpawned} agent(s), ${summary.spentTokens} tokens${
						formatCost(summary.spentCost) ? `, ${formatCost(summary.spentCost)}` : ""
					}.`,
				];
				if (summary.halted) lines.push(`HALTED: ${summary.halted} (cap ${caps.maxAgents} agents / ${caps.budgetTokens ?? "no"} token budget).`);
				if (summary.failures.length > 0) {
					lines.push(`${summary.failures.length} node(s) failed:`);
					for (const failure of summary.failures.slice(0, 10)) lines.push(`  ${failure.nodeId}: ${failure.error}`);
				}
				lines.push("", "Results:", JSON.stringify(summary.results, null, 2).slice(0, 24_000));

				return {
					text: lines.join("\n"),
					summary,
					details: { summary, events, ...contextTreeEnvelope(view, summary.spentCost) },
				};
			};

			if (caps.durable) {
				const controller = new AbortController();
				runs.start(runId, plan.name, () => controller.abort());
				void executeRun(controller.signal)
					.then((result) => {
						const completed = runs.complete(runId, result);
						// Session shutdown marks the run canceled before its worker promises
						// unwind. Do not resurrect it as done or inject into a dead session.
						if (!completed || completed.status === "canceled") return;
						const notification = [
							`Background orchestration ${runId} finished.`,
							result.text.slice(0, 6_000),
							result.text.length > 6_000 ? `\nFull output: orchestrate_result({id:"${runId}"}).` : "",
						].filter(Boolean).join("\n");
						try {
							pi.sendMessage(
								{ customType: "orchestrate", content: notification, display: true, details: { run_id: runId, status: "done" } },
								{ deliverAs: "followUp", triggerTurn: true },
							);
							runs.markNotified(runId);
						} catch {
							/* retained behind orchestrate_result */
						}
					})
					.catch((error) => {
						const failed = runs.fail(runId, error);
						if (!failed || failed.status === "canceled") return;
						try {
							pi.sendMessage(
								{ customType: "orchestrate", content: `Background orchestration ${runId} failed: ${String(error)}`, display: true },
								{ deliverAs: "followUp", triggerTurn: true },
							);
							runs.markNotified(runId);
						} catch {
							/* retained behind orchestrate_result */
						}
					});
				return {
					content: [{ type: "text", text: `Background orchestration started: ${runId}. Keep working; use worker_send to inspect/steer/stop workers and orchestrate_result for retained output.` }],
					details: { run_id: runId, status: "running", durable: true },
				};
			}

			const result = await executeRun(signal);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("ultracode", {
		description: "Standing multi-agent orchestration for this session (`/ultracode on|off`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const argument = args.trim().toLowerCase();
			if (argument === "on") {
				ultracodeOn = true;
				syncOrchestrateTool();
				pi.sendMessage(
					{
						customType: "agenda",
						content: [
							"Ultracode is on for this session. Author a plan for the `orchestrate` tool rather than delegating turn by turn.",
							"",
							"Fan out over ITEMS, never phases of one edit. Give every leg an explicit non-overlap boundary; use a useful 4–8-worker first wave when the territory supports it.",
							"Set caps.durable=true when the fleet needs supervision: orchestrate returns immediately, worker_send lists/steers/follows-up/stops, and another orchestrate call adds a bounded wave.",
							"Use `pipeline` by default — it has no barrier between stages, so items advance independently.",
							"A `barrier` is for genuine cross-item dependency, never because you need to map or filter first (use `transform`). To reconcile a wide fanout, wrap its ordered result in a barrier, then run exactly one orchestration-reconciler pipeline stage over that item.",
							"Adversarially verify the reconciler's findings, and tell critics to report only correctness-affecting gaps.",
						].join("\n"),
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
				ctx.ui.notify("Ultracode on. `orchestrate` is available from your next turn.", "info");
				return;
			}
			if (argument === "off") {
				ultracodeOn = false;
				syncOrchestrateTool();
				ctx.ui.notify("Ultracode off.", "info");
				return;
			}
			ctx.ui.notify(ultracodeOn ? "Ultracode is ON." : "Ultracode is off. `/ultracode on` to enable.", "info");
		},
	});

	pi.registerCommand("loop", {
		description: "Re-enter the loop on a schedule (`/loop 30m <prompt>`, `/loop <prompt>`, `/loop stop`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (IS_WORKER) {
				ctx.ui.notify("/loop is inert inside a worker process.", "warning");
				return;
			}

			const command = parseLoopCommand(args);
			const now = Date.now();

			if (command.kind === "error") {
				ctx.ui.notify(`/loop: ${command.message}`, "warning");
				return;
			}

			if (command.kind === "status") {
				ctx.ui.notify(describeLoop(loop, now), "info");
				return;
			}

			if (command.kind === "stop") {
				if (!loop || isLoopTerminal(loop.state)) {
					ctx.ui.notify("No loop is running.", "info");
					return;
				}
				persistLoop(stopLoop(loop, now));
				syncWakeTool();
				ctx.ui.notify("Loop stopped.", "info");
				return;
			}

			const resolved =
				command.kind === "default"
					? loadDefaultPrompt(ctx.cwd)
					: { prompt: command.prompt, note: null as string | null };

			idCounter++;
			const mode = command.kind === "default" ? "self-paced" : command.mode;
			const next = createLoop(`loop-${now.toString(36)}-${idCounter}`, mode, resolved.prompt, now, {
				intervalMs: command.kind === "start" && command.mode === "fixed" ? command.intervalMs : undefined,
			});
			persistLoop(next);
			syncWakeTool();

			const notes: string[] = [];
			if (command.kind === "start" && command.mode === "fixed") {
				notes.push(`Loop armed every ${Math.round(command.intervalMs / 1000)}s.`);
				if (command.rounded) notes.push(`(rounded up to the ${MIN_DELAY_MS / 1000}s minimum)`);
			} else {
				notes.push("Loop armed, self-paced — the model re-arms it each turn with agenda_wake.");
			}
			if (resolved.note) notes.push(resolved.note);
			notes.push("Expires in 7 days. `/loop stop` to end it.");

			// The subscription-vs-automation boundary: an unattended loop is
			// automation. Warn, do not block — the user owns that call.
			if (isSubscriptionProvider(ctx)) {
				notes.push(
					"Note: this session is on a subscription seat; unattended loops are automation and belong on a metered key.",
				);
			}
			ctx.ui.notify(notes.join(" "), "info");

			// The first iteration is delivered directly, so a loop starts working
			// rather than waiting out its first interval.
			try {
				pi.sendMessage(
					{ customType: "agenda", content: resolved.prompt, display: true },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				/* session went away between the command and the injection */
			}
		},
	});

	pi.registerCommand("agenda", {
		description: "Show automatic re-entry state, or stop it (`/agenda stop`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const argument = args.trim().toLowerCase();

			if (argument === "stop" || argument === "clear" || argument === "off") {
				driver.reset();
				if (goal) {
					persist(withState(goal, "cleared", Date.now()));
					goal = null;
				}
				if (loop && !isLoopTerminal(loop.state)) persistLoop(stopLoop(loop, Date.now()));
				if (conductor && conductor.stage !== "done") persistConductor(withConductorStage(conductor, "done", Date.now()));
				conductorEnabled = false;
				syncWakeTool();
				ctx.ui.notify("agenda: automatic re-entry cleared for this session.", "info");
				return;
			}

			if (argument.length > 0) {
				ctx.ui.notify(`agenda: unknown argument "${args.trim()}" — try /agenda or /agenda stop.`, "warning");
				return;
			}

			const lines = [describe(driver.ledger().iterations, driver.blockedOnUser(), IS_WORKER)];
			if (goal) lines.push("", describeGoal(goal, Date.now()));
			if (loop) lines.push("", describeLoop(loop, Date.now()));
			if (conductor || !conductorEnabled) lines.push("", describeConductor(conductor, conductorEnabled));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerShortcut("ctrl+alt+.", {
		description: "agenda: stop automatic re-entry",
		handler: (ctx) => {
			driver.reset();
			if (goal) {
				persist(withState(goal, "cleared", Date.now()));
				goal = null;
			}
			if (loop && !isLoopTerminal(loop.state)) persistLoop(stopLoop(loop, Date.now()));
			if (conductor && conductor.stage !== "done") persistConductor(withConductorStage(conductor, "done", Date.now()));
			conductorEnabled = false;
			syncWakeTool();
			ctx.ui.notify("agenda: automatic re-entry cleared for this session.", "info");
		},
	});
}

/**
 * Resolve the bare-`/loop` prompt: the project's `.pi/loop.md`, then the user's
 * global one, then the built-in maintenance prompt.
 *
 * Re-read on every start rather than cached, so a task list can be edited while
 * the loop is running — which is the whole point of keeping it in a file.
 */
export function loadDefaultPrompt(cwd: string): { prompt: string; note: string | null } {
	const candidates = [
		join(cwd, ".pi", "loop.md"),
		join(process.env.HOME ?? "", ".pi", "agent", "loop.md"),
	];
	for (const path of candidates) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = readFileSync(path, "utf8");
			if (!raw.trim()) continue;
			const { text, truncated } = truncateLoopFile(raw);
			return {
				prompt: text,
				note: truncated ? `(${path} truncated to ${MAX_LOOP_FILE_BYTES} bytes)` : `(from ${path})`,
			};
		} catch {
			/* unreadable candidate — fall through to the next */
		}
	}
	return { prompt: DEFAULT_LOOP_PROMPT, note: "(built-in maintenance prompt)" };
}

/**
 * Is this session authenticated by a subscription seat rather than a metered
 * key? Best-effort and advisory: it drives a one-line warning, never a refusal.
 */
export function isSubscriptionProvider(ctx: { model?: { provider?: string } | undefined }): boolean {
	const provider = ctx.model?.provider ?? "";
	return provider.includes("codex") || provider.includes("anthropic-oauth") || provider.includes("cursor");
}

/** The `/loop` readout. Pure so its wording is testable. */
export function describeLoop(loop: LoopItem | null, now: number): string {
	if (!loop) return "No loop is running.";

	const lines = [
		`Loop (${loop.state}, ${loop.mode}): ${loop.prompt.split("\n")[0].slice(0, 80)}`,
		`  fired ${loop.fires}/${loop.maxFires} · tokens ${loop.tokens} · expires in ${formatElapsed(Math.max(0, loop.expiresAt - now))}`,
	];

	if (loop.state === "active" && loop.nextAt !== null) {
		const inMs = loop.nextAt - now;
		lines.push(
			inMs <= 0
				? "  next: due now"
				: `  next: in ${formatElapsed(inMs)}${loop.keepaliveArmed ? " (keepalive — the model did not re-arm)" : ""}`,
		);
	}
	if (loop.state === "active" && loop.mode === "self-paced" && loop.nextAt === null) {
		lines.push("  waiting for the model to call agenda_wake");
	}
	if (loop.noopStreak > 0) lines.push(`  ${loop.noopStreak} iteration(s) running with nothing to report`);
	if (loop.lastReason) lines.push(`  latest: ${loop.lastReason}`);
	if (loop.state === "dry") lines.push("  (ended: the model stopped re-arming it)");
	if (loop.state === "exhausted") lines.push("  (ended: fire or token budget spent)");
	if (loop.state === "expired") lines.push("  (ended: 7-day lifetime reached)");

	return lines.join("\n");
}

function formatElapsed(ms: number): string {
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

	if (goal.state === "active" && goal.ledger.turnsEvaluated === 0) {
		lines.push("  ⚠ armed but has evaluated nothing yet");
	}
	if (isTerminal(goal.state)) lines.push("  (finished — `/goal <condition>` to set a new one)");

	return lines.join("\n");
}

/** The `/agenda` readout. Pure, same reasoning as above. */
export function describe(
	iterations: Readonly<Record<string, number>>,
	blockedOnUser: boolean,
	isWorker: boolean,
): string {
	if (isWorker) return "agenda: inert (worker process).";

	const lines: string[] = [];
	const ids = Object.keys(iterations).sort();

	if (ids.length === 0) {
		lines.push("agenda: nothing has re-entered the loop this session.");
	} else {
		lines.push("agenda — automatic re-entries charged this session:");
		for (const id of ids) {
			lines.push(`  ${id}: ${iterations[id]}`);
		}
	}

	if (blockedOnUser) {
		lines.push("");
		lines.push("Waiting on you: the last turn ended with a question, so automatic re-entry is paused.");
	}

	return lines.join("\n");
}

/**
 * The `context-tree` hive_widget envelope for an orchestrate run (HIV-1243).
 *
 * Rows carry each worker's OWN tokens (the executor bills per node, so the
 * columns sum exactly); cost is only known in aggregate, so it rides the
 * total. Empty runs (a plan of pure transforms) emit nothing — a widget with
 * no rows is a box that says nothing.
 */
export function contextTreeEnvelope(
	view: RunView,
	totalCostUsd: number,
): { hive_widget: { v: 1; type: "context-tree"; spec: Record<string, unknown> } } | Record<string, never> {
	if (view.nodes.length === 0) return {};
	const rows = view.nodes.map((node) => ({
		name: node.workId === node.nodeId ? node.nodeId : `${node.nodeId} (${node.workId})`,
		depth: 1,
		tokens: node.tokens,
	}));
	return {
		hive_widget: {
			v: 1,
			type: "context-tree",
			spec: {
				rows,
				totalTokens: view.spentTokens,
				...(totalCostUsd > 0 ? { totalCostUsd } : {}),
			},
		},
	};
}

/**
 * Recent conversation text for the recap prompt, oldest first, capped from the
 * END. Mirrors the driver's transcript read — recency is what a one-line
 * summary is about.
 */
export function recapTranscript(branch: readonly unknown[], maxChars = 12_000): string {
	const lines: string[] = [];
	for (const raw of branch) {
		const entry = raw as { message?: { role?: string; content?: unknown } };
		const role = entry?.message?.role;
		if (role !== "assistant" && role !== "user" && role !== "toolResult") continue;
		const content = entry.message?.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((part): part is { type: string; text: string } => {
					const p = part as { type?: string; text?: unknown };
					return p?.type === "text" && typeof p.text === "string";
				})
				.map((part) => part.text)
				.join("\n");
		}
		if (text.trim()) lines.push(`[${role}] ${text}`);
	}
	const joined = lines.join("\n\n");
	return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** Re-exported for tests that assert on the ledger without reaching through the driver. */
export { count };
