/**
 * plan — a read-only planning mode whose artifact is a live block document.
 *
 * Replaces `npm:@narumitw/pi-plan-mode` (MIT), which this borrows its shell
 * classifier from and diverges from in one structural way: that package's plan
 * is a single string and its own prompt requires "a complete replacement, not a
 * delta" on every revision. Here the plan is a list of id-addressed blocks and
 * every update is a patch, which is what makes it possible to keep the plan
 * current *while* working rather than leaving a stale document behind.
 *
 * FOUR MECHANICAL CONSTRAINTS, all learned the hard way in this repo:
 *
 *  1. No `context` / `before_provider_request` / `before_provider_headers`
 *     handler. pi skips those transform paths when nothing subscribes;
 *     registering one switches on work pi would otherwise bypass, on every LLM
 *     call. `test/no-forbidden-events.test.ts` fails the build on it. The
 *     supported seam for prompt injection is `before_agent_start`.
 *  2. `setActiveTools` is advisory, never enforcement — pi re-activates every
 *     registered tool on session build AND on `/reload`, so a mode that gated
 *     only that way reopens every write tool the first time someone reloads.
 *     `tool_call` is the enforcement.
 *  3. Nothing mutable at module scope: pi builds a fresh jiti per extension
 *     entry with `moduleCache:false`, so state lives in the factory closure.
 *  4. Nothing here injects a turn or re-enters the agent loop, so the
 *     one-injector invariant in `agenda/driver.ts` is untouched.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	HIVE_PLAN_CHANNEL,
	PLAN_APPROVED_CHANNEL,
	PLAN_CONTROL_CHANNEL,
	PLAN_GRILL_CHANNEL,
	PLAN_MODE_STATE_CHANNEL,
	QUESTION_ANSWER_CHANNEL,
	QUESTION_LISTENER_CHANNEL,
	QUESTION_REMOTE_CHANNEL,
	type HivePlanEvent,
	type PlanApprovedEvent,
	type PlanControlEvent,
	type PlanGrillEvent,
	type PlanModeStateEvent,
	type QuestionListenerEvent,
	type QuestionRemoteEvent,
} from "../hive-common/channels.ts";
import { PLAN_ASK_KEY, PLAN_ASK_WAIT_MS, waitForAnswer, type Answers } from "../hive-common/remoteAnswer.ts";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { isUnattendedHiveLaunch } from "../hive-common/launch.ts";
import { branchEntries, createBranchWatch } from "../session-branch/branch.ts";
import { classifyCommand, classifyTool } from "./policy.ts";
import { buildGrillKick, buildPlanPrompt } from "./prompt.ts";
import { planToMarkdown, renderOpResult, renderStepList, summaryLine } from "./render.ts";
import { TEMPLATE_NAMES_TUPLE } from "./templates.ts";
import {
	applyOps,
	emptyPlan,
	isEmpty,
	isLanesOnly,
	PLAN_ENTRY_TYPE,
	PLAN_TICK_ENTRY_TYPE,
	tickEntry,
	rehydratePlan,
	stepCounts,
	toEntry,
	type PlanDoc,
	type PlanOp,
} from "./state.ts";

/** Tools this extension owns, kept active even while the mode narrows the set. */
const PLAN_TOOLS = ["plan_write", "plan_ask", "plan_ready"] as const;

/**
 * How long a presented plan waits for a decision before handing the turn back.
 *
 * Longer than `plan_ask`'s ten minutes because the two are asking for different
 * things: a question interrupts an operator, an approval waits for one to come
 * and look. Bounded all the same — and unlike the wait it replaces, elapsing
 * costs only the waiting: the gate stays up, so nothing is released by anyone
 * failing to click.
 */
const PLAN_DECISION_WAIT_MS = 30 * 60_000;

const StepStatusSchema = StringEnum(
	["pending", "in_progress", "done", "failed", "skipped", "blocked", "completed", "running"] as const,
	{
		description:
			"Item status. `completed` and `running` are accepted as synonyms of `done` and `in_progress`, " +
			"because the todo and workflow tools have always spelled them that way.",
	},
);

const ItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable item id. Re-state it to preserve status across a reword." })),
	title: Type.Optional(Type.String({ description: "Short imperative title. Required when creating." })),
	activeForm: Type.Optional(Type.String({ description: 'Present-continuous form, e.g. "Running the migration".' })),
	detail: Type.Optional(Type.String()),
	kind: Type.Optional(
		Type.String({
			description:
				'What kind of work this is. Omit (or "task") for your own work. Use push, pr.open, ci.green, ' +
				"review or merged for delivery steps — Hive resolves those from its own runs and pull requests, " +
				"and this tool refuses a status on them.",
		}),
	),
	status: Type.Optional(StepStatusSchema),
	files: Type.Optional(Type.Array(Type.String(), { description: "Files this item touches." })),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description: "Item ids this waits on; may name an item in another lane. Refused if it would close a cycle.",
		}),
	),
	parentId: Type.Optional(
		Type.String({ description: "The item this one decomposes, within the same lane. Up to three levels." }),
	),
	linearKey: Type.Optional(Type.String()),
	owner: Type.Optional(Type.String({ description: "Worker id, when the item is delegated." })),
	note: Type.Optional(Type.String()),
});

/** @deprecated The pre-merge name. */
const StepSchema = ItemSchema;

/**
 * The block union, as the model supplies it.
 *
 * Every variant carries its `type` as a literal so the provider's structured
 * output can discriminate. `additionalProperties` is deliberately NOT set to
 * false anywhere: pi forwards the schema to the provider unmodified and
 * constrained sampling has its own requirements, so the tasks/agenda house rule
 * about not importing Claude Code's validator constraints applies here too.
 */
const BlockSchema = Type.Union([
	Type.Object({
		type: Type.Literal("text"),
		title: Type.Optional(Type.String()),
		markdown: Type.String({ description: "Markdown prose." }),
	}),
	Type.Object({
		type: Type.Literal("steps"),
		title: Type.Optional(Type.String()),
		steps: Type.Array(ItemSchema, { minItems: 1 }),
	}),
	Type.Object({
		type: Type.Literal("chart"),
		title: Type.Optional(Type.String()),
		chart: StringEnum(["bar", "line", "pie", "progress"] as const),
		series: Type.Array(Type.Object({ label: Type.String(), value: Type.Number() }), { minItems: 1 }),
		unit: Type.Optional(Type.String()),
		caption: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("diagram"),
		title: Type.Optional(Type.String()),
		mermaid: Type.String({ description: "Mermaid source, without the fence." }),
		caption: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("refs"),
		title: Type.Optional(Type.String()),
		refs: Type.Array(
			Type.Object({
				label: Type.String(),
				url: Type.Optional(Type.String()),
				kind: Type.Optional(StringEnum(["linear", "pr", "file", "doc", "url"] as const)),
				note: Type.Optional(Type.String()),
			}),
			{ minItems: 1 },
		),
	}),
	Type.Object({
		type: Type.Literal("table"),
		title: Type.Optional(Type.String()),
		columns: Type.Array(Type.String(), { minItems: 1 }),
		rows: Type.Array(Type.Array(Type.String()), { minItems: 1 }),
	}),
	Type.Object({
		type: Type.Literal("metrics"),
		title: Type.Optional(Type.String()),
		metrics: Type.Array(
			Type.Object({ label: Type.String(), value: Type.String(), delta: Type.Optional(Type.String()) }),
			{ minItems: 1 },
		),
	}),
	Type.Object({
		type: Type.Literal("callout"),
		title: Type.Optional(Type.String()),
		tone: StringEnum(["info", "warn", "risk", "success"] as const),
		markdown: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("code"),
		title: Type.Optional(Type.String()),
		language: Type.Optional(Type.String({ description: "Fence tag, extension or path. Omit to autodetect." })),
		code: Type.String({ description: "Source, without the fence. Indentation is preserved." }),
		caption: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("artifact"),
		title: Type.Optional(Type.String()),
		html: Type.String({
			description:
				"A COMPLETE, SELF-CONTAINED HTML document — inline <style> and <script> only, no external " +
				"stylesheets, scripts, fonts or images, and no network access of any kind (a CSP inside the " +
				"frame denies it). Rendered in a sandboxed frame with no access to the surrounding page. Use " +
				"it to SHOW a proposed interface or an illustration the typed blocks cannot express; prefer a " +
				"typed block whenever one fits.",
		}),
		height: Type.Optional(Type.Number({ description: "Requested frame height in px. Clamped by the viewer." })),
		caption: Type.Optional(Type.String()),
	}),
]);

const OpSchema = Type.Union([
	Type.Object({
		op: Type.Literal("header"),
		title: Type.Optional(Type.String()),
		goal: Type.Optional(Type.String({ description: "One sentence." })),
		phase: Type.Optional(StringEnum(["none", "drafting", "ready", "approved", "abandoned"] as const)),
		stage: Type.Optional(
			Type.String({ description: "The lifecycle stage the session is in. A tick, never a re-plan." }),
		),
		label: Type.Optional(Type.String({ description: "A name for THIS revision, shown in the version picker." })),
		tickets: Type.Optional(
			Type.Array(
				Type.Object({
					key: Type.String({ description: 'Linear issue key, e.g. "HIV-2904".' }),
					url: Type.Optional(Type.String()),
					role: Type.Optional(StringEnum(["primary", "related"] as const)),
				}),
			),
		),
		milestone: Type.Optional(
			Type.Union([Type.Object({ goalId: Type.String(), stepId: Type.Optional(Type.String()) }), Type.Null()]),
		),
	}),
	Type.Object({
		op: Type.Literal("upsert"),
		id: Type.Optional(
			Type.String({
				description:
					"Block id. Choose a short stable name — `approach`, `steps`, `risks`. Creates the block if the " +
					"id is new, replaces it if it exists. Omit to append with a generated id.",
			}),
		),
		after: Type.Optional(Type.String({ description: "Insert after this block id. Omit to append." })),
		block: BlockSchema,
	}),
	Type.Object({ op: Type.Literal("remove"), id: Type.String() }),
	Type.Object({ op: Type.Literal("move"), id: Type.String(), after: Type.Optional(Type.String()) }),
	Type.Object({
		op: Type.Literal("set_step"),
		id: Type.String({ description: "Item id. The containing lane is found for you." }),
		status: Type.Optional(StepStatusSchema),
		note: Type.Optional(Type.String({ description: "What actually happened, when it differed from the plan." })),
		owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		linearKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	}),
	Type.Object({
		op: Type.Literal("lane"),
		id: Type.Optional(Type.String({ description: "Lane block id. Omit to address by kind." })),
		kind: Type.Optional(
			Type.String({
				description:
					"Which phase of the work this lane holds — frame, research, plan, execute, verify, deliver, " +
					"consolidate, or a name of your own. Addressing by kind reaches the lane whoever created it, " +
					"which is how your lane and any the harness already made become ONE lane rather than two.",
			}),
		),
		title: Type.Optional(Type.String()),
		before: Type.Optional(Type.String({ description: "Place before this lane. Omit — known kinds are ranked for you." })),
		items: Type.Optional(Type.Array(ItemSchema, { description: "Items to create or update, applied in order." })),
	}),
	Type.Object({
		op: Type.Literal("item"),
		lane: Type.Optional(
			Type.String({ description: "Lane id or kind for a NEW item. Omit to use the lane you are working in." }),
		),
		item: ItemSchema,
	}),
	Type.Object({
		op: Type.Literal("move_item"),
		id: Type.String(),
		lane: Type.Optional(Type.String({ description: "Destination lane id or kind. Children travel with it." })),
		parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	}),
	Type.Object({
		op: Type.Literal("loop"),
		lane: Type.String({ description: "Lane id or kind." }),
		steps: Type.Optional(Type.Array(Type.String(), { description: "Item ids forming the loop body, in body order." })),
		until: Type.Optional(Type.String({ description: "The exit condition, in words." })),
		active: Type.Optional(Type.Boolean()),
	}),
	Type.Object({ op: Type.Literal("loop_tick"), lane: Type.String({ description: "Lane id or kind." }) }),
	Type.Object({
		op: Type.Literal("template"),
		name: StringEnum(TEMPLATE_NAMES_TUPLE, {
			description: "A recognisable lane shape. Idempotent: asking twice is a no-op, never a second lane.",
		}),
		title: Type.Optional(Type.String()),
	}),
]);

function text(body: string) {
	return { content: [{ type: "text" as const, text: body }], details: {} };
}

export default function (pi: ExtensionAPI) {
	let doc: PlanDoc = emptyPlan(Date.now());
	let active = false;
	/** Tool names captured before the mode narrowed them, so exit can restore. */
	let toolsBeforePlanMode: string[] | null = null;
	/**
	 * The most recent ctx, so a bus-triggered mode entry has one to paint and
	 * notify through. Goes stale on session replacement; every use is guarded.
	 */
	let heldCtx: ExtensionContext | null = null;
	/** Which branch the document in `doc` was built from — see the re-derive handler. */
	const branchWatch = createBranchWatch();

	/**
	 * The grill stage (HIV-2080): how many times this plan has been sent back
	 * with "ask me things first", and whether the agent still owes questions.
	 *
	 * `grillOwesQuestions` is what makes "requires" a fact rather than a request.
	 * A kick prompt on its own lets the model call `plan_ready` straight back
	 * with the same document and a friendlier sentence — the plan was already
	 * decision-complete in ITS reading, which is precisely the disagreement the
	 * user clicked the button about. So the gate closes on the decline and only
	 * an actual `ask_user_question` call reopens it.
	 *
	 * Cleared by the `tool_call` hook, which sees the call BEFORE it executes.
	 * Deliberately: a question the user dismissed was still asked, and the agent
	 * must not be trapped in the mode because the person who asked for it
	 * changed their mind about answering.
	 */
	let grillRound = 0;
	let grillOwesQuestions = false;

	/**
	 * Whether a browser can answer a `plan_ask` right now (HIV-1765).
	 *
	 * Reported by hive-remote from its attach lifecycle, never inferred from
	 * config or from `HIVE_LAUNCH_ID`: this flag decides whether the tool BLOCKS,
	 * and a false positive costs a wedged session at a prompt nobody can see —
	 * the failure `plan_ready` already paid for once (HIV-1449). Defaults false,
	 * so a process without hive-remote behaves exactly as it did before.
	 */
	let remoteAnswersAvailable = false;

	/**
	 * THE GATE: a plan is presented and no one has decided yet.
	 *
	 * Distinct from `active` (pi's plan op-mode) on purpose, because the sessions
	 * that most need a gate are the ones that are not in it. A Hive-launched
	 * agent runs `pi --op-mode build`, so `active` is false, `plan_ready` took the
	 * "there is no approval gate to open — go ahead and execute it" branch, and
	 * the operator watched an agent present a plan and implement it in the same
	 * turn while the card said `ready`. That branch was right about the MODE and
	 * wrong about the intent: calling `plan_ready` IS the request for a gate.
	 *
	 * While this is set the `tool_call` hook denies writes exactly as plan mode
	 * does. That is what makes it a stop rather than a suggestion — a message the
	 * model may reason its way past is not a gate, and this one it cannot.
	 *
	 * Cleared ONLY by a decision — approve, grill, or an operator leaving plan
	 * mode. Notably NOT by the wait elapsing: a `plan_ready` that gives up
	 * waiting returns the turn without returning permission.
	 */
	let awaitingDecision = false;

	/**
	 * Callers of `plan_ready` parked on that decision.
	 *
	 * A list rather than one slot because a model that re-calls `plan_ready`
	 * while parked must join the same gate instead of opening a second one, and
	 * every waiter has to be released by the single decision that arrives.
	 */
	let decisionWaiters: Array<(decision: "approve" | "grill") => void> = [];

	/**
	 * Hand the decision to everyone parked on the gate.
	 *
	 * Releasing the WAITERS and opening the GATE are deliberately two things. An
	 * approval is both: the plan is accepted and the agent may write. A decline
	 * is only the first — the plan went back to drafting and the agent owes
	 * questions, so a grill that also dropped the write ban would be an approval
	 * with extra steps, which is the rule the grill stage already holds inside
	 * plan mode and which this keeps true outside it.
	 */
	const releaseWaiters = (decision: "approve" | "grill") => {
		if (decision === "approve") awaitingDecision = false;
		const waiters = decisionWaiters;
		decisionWaiters = [];
		for (const resolve of waiters) resolve(decision);
	};

	/**
	 * Park until someone decides, or until `ms` elapses.
	 *
	 * Bounded, because an unbounded await is the HIV-1449 failure (68 minutes at
	 * a prompt nobody could see). Bounded is safe HERE in a way it was not there:
	 * this holds no stdin, so steering still lands, the browser card can decide
	 * it, and the handsfree judge's verdict arrives through the same channel as
	 * a click. On elapse the GATE STAYS — only the waiting stops.
	 */
	const waitForDecision = (ms: number): Promise<"approve" | "grill" | "timeout"> =>
		new Promise((resolve) => {
			let done = false;
			const finish = (value: "approve" | "grill" | "timeout") => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => finish("timeout"), ms);
			// Unref'ing would let the process exit under a parked tool; pi's own
			// loop is what keeps this alive, and the timer must fire.
			decisionWaiters.push((decision) => finish(decision));
		});

	pi.events.on(QUESTION_REMOTE_CHANNEL, (data: unknown) => {
		const next = (data as QuestionRemoteEvent | undefined)?.available;
		if (typeof next === "boolean") remoteAnswersAvailable = next;
	});

	// Announce that plan_ask can be answered remotely. hive-remote declares the
	// capability from listeners, so without this the browser draws no answer form
	// for a plan question — which is the correct rendering of a build that could
	// not consume one.
	//
	// ON session_start, NOT at registration: extension factories run in load
	// order, and an announcement made before hive-remote subscribes reaches
	// nobody. Deferred for the same reason `--plan` is, a few handlers below.
	pi.on("session_start", () => {
		try {
			pi.events.emit(QUESTION_LISTENER_CHANNEL, { tool: "plan_ask" } satisfies QuestionListenerEvent);
		} catch {
			/* no bus, or hive-remote is not loaded */
		}
	});

	/**
	 * Wait for a browser answer to one `plan_ask`, or give up.
	 *
	 * Resolves null on timeout rather than throwing: a tool that throws is a turn
	 * the model cannot recover from, and "nobody answered" is an ordinary outcome
	 * with a perfectly good fallback (return the question as text).
	 */
	async function awaitRemoteAnswer(callID: string): Promise<Answers | null> {
		const waiter = waitForAnswer(pi.events, QUESTION_ANSWER_CHANNEL, callID);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				waiter.answered,
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), PLAN_ASK_WAIT_MS);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			waiter.dispose();
		}
	}

	// Without a flag, plan mode can only be reached by typing `/plan` — which
	// makes it unreachable in exactly the runs that most want it: `-p`, the Hive
	// factory, and anything dispatched rather than driven by a human at a TUI.
	pi.registerFlag("plan", {
		description: "Start in read-only plan mode",
		type: "boolean",
		default: false,
	});

	/**
	 * Write the document, and ring the doorbell.
	 *
	 * A TICK IS NOT A SNAPSHOT. Before the merge, both this document and the
	 * workflow re-emitted their whole selves on every mutation, a ticked
	 * checkbox included: measured across 594 sessions, 10.2 plan snapshots
	 * (37.8 KB) plus 12.6 workflow snapshots (42.4 KB) per session, 34.7 MB of
	 * transcript across the corpus. Now a revision bump writes the full
	 * snapshot — it is a new version of the document, and HIV-2906 stores one
	 * row per revision — while a bare progress bump writes only what moved.
	 *
	 * `rehydratePlan` folds the ticks over the newest snapshot, so a resumed
	 * session sees the same document either way. The ordering that makes that
	 * safe is the session log's own: entries are append-only and read in order.
	 */
	/**
	 * Apply and persist in one step.
	 *
	 * It exists so the PREVIOUS document is never forgotten: `persist` decides
	 * between a snapshot and a tick by comparing the two counters, and a caller
	 * that applied first and persisted second would hand it a document to
	 * compare against itself. Every internal mutation goes through here.
	 */
	const persistOps = (base: PlanDoc, ops: readonly PlanOp[], now: number): PlanDoc => {
		const result = applyOps(base, ops, now);
		persist(result.doc, base);
		return result.doc;
	};

	const persist = (next: PlanDoc, previous?: PlanDoc) => {
		const tickOnly =
			previous !== undefined && next.revision === previous.revision && next.progress !== previous.progress;
		doc = next;
		try {
			if (tickOnly) pi.appendEntry(PLAN_TICK_ENTRY_TYPE, tickEntry(next));
			else pi.appendEntry(PLAN_ENTRY_TYPE, toEntry(next));
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
		try {
			// A doorbell, not a delivery: the counters only. Anything that wants
			// the document reads it from the session entries under its own
			// consent — see hive-common/channels.ts. This extension deliberately
			// does not know whether Hive is configured.
			//
			// BOTH counters ride, because a viewer has to refetch when either
			// moves and the two mean different things: a revision change is a new
			// version of the document, a progress change is the same document
			// further along. A doorbell carrying only the revision would leave
			// every open tab showing a plan whose checkboxes never move.
			pi.events.emit(HIVE_PLAN_CHANNEL, {
				revision: next.revision,
				progress: next.progress,
			} satisfies HivePlanEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/**
	 * Cosmetic by definition — never fail a tool call because a widget could
	 * not draw. The deck extension owns the widget slot (HIV-1219); this only
	 * states what the plan currently is.
	 */
	const paint = () => {
		try {
			const line = summaryLine(doc);
			const label = line ? (active ? `${line} · read-only` : line) : undefined;
			pi.events.emit(DECK_SECTION_CHANNEL, {
				section: "plan",
				state: label ? { kind: "lines", summary: label, lines: [label] } : null,
			} satisfies DeckSectionEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	pi.events.on(DECK_SYNC_CHANNEL, () => paint());

	/**
	 * Report whether the mode is actually on.
	 *
	 * The feedback half of PLAN_CONTROL_CHANNEL. `opmode` delegates its `plan`
	 * posture here instead of running a second read-only gate, so it has no way
	 * to know that a user typed `/plan exit` — and would go on telling the Hive
	 * workspace the session is read-only while nothing denied its writes. Called
	 * at every `active` transition; a boolean and nothing else.
	 */
	const announceMode = () => {
		try {
			pi.events.emit(PLAN_MODE_STATE_CHANNEL, { active } satisfies PlanModeStateEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/**
	 * Narrow the active tool set to what plan mode permits.
	 *
	 * Advisory only — see the header. Its real job is keeping write tools out of
	 * the system prompt so the model does not build a plan around calling them
	 * and then hit a wall of denials.
	 */
	const narrowTools = () => {
		try {
			const all = pi.getAllTools().map((tool) => tool.name);
			// Snapshot the ACTIVE set, not the registry: restoring from
			// `getAllTools()` resurrects tools other extensions keep deliberately
			// inactive — agenda's consent-gated `orchestrate` re-appeared on every
			// plan-mode exit until this read the live set.
			if (toolsBeforePlanMode === null) toolsBeforePlanMode = pi.getActiveTools();
			const permitted = all.filter((name) => classifyTool(name).allowed);
			pi.setActiveTools([...new Set([...permitted, ...PLAN_TOOLS])]);
		} catch {
			/* tool introspection unavailable; the deny hook still enforces */
		}
	};

	const restoreTools = () => {
		try {
			if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
		} catch {
			/* nothing to restore into */
		} finally {
			toolsBeforePlanMode = null;
		}
	};

	/* ---------------------------------------------------------------------- */
	/* Tools                                                                   */
	/* ---------------------------------------------------------------------- */

	pi.registerTool({
		name: "plan_write",
		label: "Plan write",
		description:
			"Create or patch the plan document. The plan is a list of typed blocks addressed by id; every call is a " +
			"patch, never a whole-document replacement. Use it to build the plan while exploring, and to keep step " +
			"status and notes current while executing.",
		promptSnippet:
			"Plan: build and patch it with plan_write (blocks addressed by id — never re-send the whole plan). " +
			"While executing, keep step status current and record divergences with `note`.",
		parameters: Type.Object({
			ops: Type.Array(OpSchema, { minItems: 1, description: "Operations, applied in order." }),
		}),
		// `ctx` is the FIFTH parameter of execute, after signal and onUpdate.
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const ops = (params as { ops?: PlanOp[] }).ops ?? [];
			// The grill gate has to cover this tool too, not just `plan_ready`.
			// The mode prompt teaches `plan_write({ops:[{op:"header",phase:"ready"}]})`
			// as the way to hand a plan over, so a gate that only guarded
			// `plan_ready` would be one documented line away from being bypassed —
			// and bypassed silently, since the phase alone is what the Hive plan
			// view reads. The rest of the patch still applies: the user asked for
			// a better plan, and refusing the edits that improve it would be the
			// opposite of what they clicked.
			const held = grillOwesQuestions && ops.some((op) => op.op === "header" && op.phase === "ready");
			const applied = held
				? ops.map((op) => (op.op === "header" && op.phase === "ready" ? { ...op, phase: undefined } : op))
				: ops;
			const result = applyOps(doc, applied, Date.now());
			persist(result.doc);
			paint();
			const body = renderOpResult(result, result.doc);
			return text(
				held
					? `${body}\n\nThe phase stayed \`drafting\`: the user asked to be grilled and no questions have ` +
							`been asked yet. Ask them with ask_user_question, fold the answers in, then present the ` +
							`plan with plan_ready.`
					: body,
			);
		},
	});

	/**
	 * Send the plan back for questioning, and say so on the bus.
	 *
	 * The phase falls to `drafting` rather than to anything new: a declined plan
	 * IS a draft again, every reader already understands that word, and inventing
	 * a `grilling` phase would have meant a schema change in three places
	 * (the op union, the Hive plan view, the browser's phase chip) to express
	 * something the existing vocabulary says correctly.
	 *
	 * Read-only mode deliberately stays ON. The user declined; a decline that
	 * handed back the write tools would be an approval with extra steps.
	 */
	/**
	 * Forget the grill. Called wherever a plan STOPS being the thing under
	 * discussion — approval, a fresh session, `/plan clear`.
	 *
	 * Not merely tidy: `grillOwesQuestions` outliving its plan would make
	 * `plan_ready` refuse the NEXT plan, in a session where nobody ever clicked
	 * anything, citing a decline that happened to a document that no longer
	 * exists. A gate that fires without a cause is worse than no gate.
	 */
	const clearGrill = () => {
		grillRound = 0;
		grillOwesQuestions = false;
	};

	const beginGrill = (): PlanGrillEvent | null => {
		if (!active || doc.phase !== "ready") return null;
		persistOps(doc, [{ op: "header", phase: "drafting" }], Date.now());
		grillRound++;
		grillOwesQuestions = true;
		paint();
		return { revision: doc.revision, stepCount: stepCounts(doc).total, round: grillRound };
	};

	/** Emit the grill doorbell. Counters only — see hive-common/channels.ts. */
	const emitGrill = (event: PlanGrillEvent) => {
		try {
			pi.events.emit(PLAN_GRILL_CHANNEL, event satisfies PlanGrillEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/** Emit the approval doorbell. Counters only — see hive-common/channels.ts. */
	const emitApproved = (approved: PlanDoc) => {
		try {
			const counts = stepCounts(approved);
			pi.events.emit(PLAN_APPROVED_CHANNEL, {
				revision: approved.revision,
				stepCount: counts.total,
				orchestrationConsented: counts.total > 1,
			} satisfies PlanApprovedEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/**
	 * The plan, as the approval card reads it.
	 *
	 * `web/src/lib/planReady.ts` parses these exact lines — title, `Goal:`,
	 * `N step(s).`, the orchestration sentence — so this is a SERIALISATION, not
	 * prose, and its line order is a contract with the card. Shared by both
	 * unattended branches, because the branch that never produced it is the
	 * branch whose sessions never got a card.
	 */
	const readySummary = (): string => {
		const counts = stepCounts(doc);
		return [
			doc.title || "Untitled plan",
			doc.goal ? `Goal: ${doc.goal}` : "",
			`${counts.total} step(s).`,
			counts.total > 1 ? `Approving also enables multi-agent orchestration (orchestrate tool).` : "",
		]
			.filter(Boolean)
			.join("\n");
	};

	/**
	 * Present the plan and PARK the turn on the decision.
	 *
	 * The first line is the card's discriminator and must stay first. Then the
	 * gate goes up — writes denied from here — and the tool waits: for the
	 * operator's click, for `plan_grill`, or for the handsfree judge, all three
	 * of which arrive as the same `PLAN_CONTROL_CHANNEL` event.
	 *
	 * ON TIMEOUT THE GATE DOES NOT LIFT. The tool stops waiting and hands back a
	 * turn, because a turn held forever is the failure this feature already paid
	 * for once (HIV-1449) — but it hands back no permission, and the deny hook is
	 * still in force. The model can re-call `plan_ready` to keep waiting, or do
	 * read-only work; what it cannot do is start implementing.
	 */
	const presentAndWait = async (summary: string) => {
		const header = `Plan is ready and awaiting approval:\n\n${summary}\n\nThe user approves with /plan approve.`;
		awaitingDecision = true;
		narrowTools();
		announceMode();
		paint();

		const decision = await waitForDecision(PLAN_DECISION_WAIT_MS);
		if (decision === "approve") {
			return text(`${header}\n\nApproved. Plan mode is released — execute it, keeping step status current with plan_write.`);
		}
		if (decision === "grill") {
			return text(`${header}\n\n${buildGrillKick(grillRound)}`);
		}
		return text(
			`${header}\n\nNo decision yet after ${Math.round(PLAN_DECISION_WAIT_MS / 60_000)} minutes. ` +
				`The plan stays ready and WRITES STAY DENIED — this is a gate, not a reminder. ` +
				`Call plan_ready again to keep waiting, or use the time for read-only work ` +
				`(reading, searching, asking the operator with ask_user_question).`,
		);
	};

	/**
	 * Why a tool was denied, when the reason is the gate rather than the mode.
	 *
	 * The classifier's own sentence explains plan mode, which an agent in build
	 * mode has no reason to believe it is in — and a denial whose stated cause
	 * the reader knows to be false reads as a broken harness rather than a rule.
	 */
	const gateReason = (reason: string): string =>
		active ? reason : `${reason}\n\nA plan is presented and awaiting approval; that is what is denying this.`;

	pi.registerTool({
		name: "plan_ready",
		label: "Plan ready",
		description:
			"Present the finished plan for user approval. Marks the plan ready, shows an approval dialog, and — " +
			"when approved — exits read-only mode so execution can begin. Call it once the plan is decision-complete; " +
			"an approved multi-step plan also enables the orchestrate tool.",
		promptSnippet: "Plan mode: when the plan is decision-complete, call plan_ready to present it for approval.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			// NOT IN PLAN MODE IS AN ANSWER, NOT A DEAD END (HIV-1967).
			//
			// `plan_write` has no mode guard — deliberately, it is the document
			// tool and is meant to be used while exploring and while executing.
			// `plan_ready` is a MODE TRANSITION, so it needs one. The asymmetry is
			// correct and the old message stated it correctly; what it did not do
			// is tell the caller what state it is actually in.
			//
			// Two Hive-launched agents hit this on 2026-08-16, both immediately
			// after a successful `plan_write`, and both stopped:
			//
			//   `plan_write` successfully created a drafting plan, but `plan_ready`
			//   returned `Not in plan mode — nothing to present`, leaving no
			//   approval path despite a multi-step fix plan.
			//
			// They were looking for permission to proceed. The truth is that they
			// already had it — plan mode is what WITHHOLDS the write tools, so
			// outside it nothing was ever withheld and there is no gate to open.
			// One of them logged the refusal and executed anyway; the other spent
			// the turn hunting for a way in. Saying so costs one sentence.
			if (!active) {
				if (isEmpty(doc)) {
					return text(
						"Not in plan mode, and the plan is empty — there is nothing to present and nothing " +
							"gating you. Plan mode is what denies the write tools; outside it you can execute " +
							"directly. `/plan` enters it if you want an approval gate.",
					);
				}
				// An UNATTENDED session is the exception, and it is the case this
				// tool exists for. A Hive-launched agent runs `--op-mode build`, so
				// it always lands here — and was told, correctly by the letter of
				// the mode and wrongly by every other measure, to go and execute
				// the plan it had just put up for approval. Nothing drew the card
				// either: the card is discriminated on the OTHER branch's first
				// line. Calling `plan_ready` is the request for a gate; honour it.
				if (isUnattendedHiveLaunch(process.env.HIVE_LAUNCH_ID) && remoteAnswersAvailable) {
					persistOps(doc, [{ op: "header", phase: "ready" }], Date.now());
					paint();
					return await presentAndWait(readySummary());
				}
				return text(
					`Not in plan mode, so there is no approval gate to open — plan mode is what denies the ` +
						`write tools, and outside it nothing was withheld. Your plan is saved (${stepCounts(doc).total} ` +
						`step(s), revision ${doc.revision}) and stays visible; go ahead and execute it, keeping step ` +
						`status current with plan_write. If you specifically want it approved first, \`/plan\` enters ` +
						`plan mode and \`plan_ready\` will then present it.`,
				);
			}
			if (isEmpty(doc)) return text("The plan is empty. Build it with plan_write before presenting it.");

			// The grill gate. Refuses to re-present a plan the user sent back until
			// they have actually been asked something — see `grillOwesQuestions`.
			// Phrased as the next action rather than as a denial, because the model
			// arriving here believes the plan is finished and a bare refusal reads
			// as a broken tool (the HIV-1967 failure, from the other side).
			if (grillOwesQuestions) {
				return text(
					`Not presenting it yet — the user declined this plan and asked to be grilled, and no ` +
						`questions have been asked since.\n\n${buildGrillKick(grillRound)}`,
				);
			}

			persistOps(doc, [{ op: "header", phase: "ready" }], Date.now());
			paint();

			const summary = readySummary();

			// Nobody to answer the modal — return the summary as the tool result and
			// leave `/plan approve` as the gate, the same unattended-worker
			// reasoning plan_ask documents.
			//
			// Two ways to have no one there, and `ctx.mode` only catches the first.
			// A Hive-launched session runs pi as a real TUI inside a tmux pane, so
			// `ctx.mode === "tui"` while the pane is unattended by construction —
			// the operator drives it through Hive, not by sitting in the terminal.
			// `ctx.ui.confirm` then blocks forever on a question no one will see:
			// the modal owns stdin, so queued steering never lands either, and the
			// session burns cache re-bills until someone kills it. Measured
			// 2026-08-09: 68 minutes, 40 turns, $1.16, on a plan whose work had
			// already merged (HIV-1449).
			if (ctx.mode !== "tui" || isUnattendedHiveLaunch(process.env.HIVE_LAUNCH_ID)) {
				// PARK only where a decision can actually arrive. `remoteAnswersAvailable`
				// is hive-remote reporting a live attach — the same predicate `plan_ask`
				// uses to decide whether it may block, and for the same reason: a gate
				// nobody can open is not a gate, it is a wedge (HIV-1449). Without it
				// this behaves exactly as it did: present, and leave `/plan approve`.
				if (remoteAnswersAvailable) return await presentAndWait(summary);
				return text(`Plan is ready and awaiting approval:\n\n${summary}\n\nThe user approves with /plan approve.`);
			}

			const approved = await ctx.ui.confirm(
				"Approve plan?",
				`${summary}\n\nApproving exits read-only mode and starts execution.`,
			);
			if (!approved) {
				// A decline is TWO different answers, and collapsing them was the
				// gap the grill stage fills (HIV-2080). "No" can mean "you have
				// misunderstood, go away and think again" — or, far more often, "this
				// is nearly right, but you made calls that were mine to make". The
				// second one wants a conversation, and the agent has no way to know
				// which it got unless the user is offered both.
				//
				// Asked here rather than as a third option on the dialog above
				// because `ui.select` has no message body: the summary of what is
				// being approved would have had to go, and approving a plan whose
				// goal you could not read is the mistake this whole gate exists to
				// prevent.
				const GRILL = "Grill me — ask me questions, then re-present";
				const REVISE = "Just revise it yourself";
				const choice = await ctx.ui.select("Plan declined — what next?", [GRILL, REVISE]);
				if (choice === GRILL) {
					// Deliberately NOT emitting PLAN_GRILL_CHANNEL: this branch is
					// inside the tool call, so the instruction rides back as the tool
					// RESULT. Emitting as well would have agenda inject the same
					// instruction a second time, as a separate turn, on top of this one.
					const grill = beginGrill();
					return text(buildGrillKick(grill?.round ?? 1));
				}
				return text(
					"The user declined the plan. Revise it with plan_write — or use plan_ask to find out what to change.",
				);
			}

			persistOps(doc, [{ op: "header", phase: "approved" }], Date.now());
			active = false;
			clearGrill();
			restoreTools();
			paint();
			announceMode();
			emitApproved(doc);
			const approvedCounts = stepCounts(doc);
			// The lifecycle envelope makes the transition legible in the Hive
			// agents workspace; the terminal renders from the text alone.
			return {
				content: [
					{
						type: "text" as const,
						text: "Plan approved; read-only mode left. Execute the plan, keeping step status current via plan_write.",
					},
				],
				details: {
					hive_widget: {
						v: 1,
						type: "lifecycle",
						spec: {
							stage: "execute",
							stages: ["frame", "plan", "execute", "verify"],
							note: `plan approved — ${approvedCounts.total} step(s)${approvedCounts.total > 1 ? ", orchestration enabled" : ""}`,
						},
					},
				},
			};
		},
	});

	pi.registerTool({
		name: "plan_ask",
		label: "Plan question",
		description:
			"Ask the user a decision question that repository truth cannot settle — a product decision or a genuine " +
			"preference between defensible designs. Never use it for anything you could discover by reading.",
		promptSnippet: "Plan mode: use plan_ask for decisions only the user can make; explore first, ask second.",
		parameters: Type.Object({
			question: Type.String({ description: "One concise question." }),
			options: Type.Optional(
				Type.Array(Type.Object({ label: Type.String(), detail: Type.Optional(Type.String()) }), {
					description: "2-4 meaningful options. No filler.",
				}),
			),
			recommendation: Type.Optional(Type.String({ description: "Which option you would pick, and why." })),
		}),
		execute: async (callID, params) => {
			const { question, options, recommendation } = params as {
				question: string;
				options?: { label: string; detail?: string }[];
				recommendation?: string;
			};
			const out = [question];
			if (options?.length) {
				out.push("");
				options.forEach((option, i) => {
					out.push(`${i + 1}. ${option.label}${option.detail ? ` — ${option.detail}` : ""}`);
				});
			}
			if (recommendation) out.push("", `Recommended: ${recommendation}`);

			// The question is returned as the tool result rather than pushed through
			// a UI prompt: an unattended worker has no one to answer, and a modal
			// that blocks forever is worse than a question the user reads in the
			// transcript and replies to in their own time.
			//
			// That argument turns on a premise — nobody can answer — which stops
			// holding the moment a Hive session is attached (HIV-1765): the question
			// is rendered in the browser with these same options, and an operator can
			// answer it there. So when, and ONLY when, hive-remote says a browser can
			// reach us, wait for one. The wait is bounded and its expiry returns
			// exactly the text above, so the worst case is today's behaviour arriving
			// late rather than a session wedged at a prompt nobody can see.
			if (!remoteAnswersAvailable) return text(out.join("\n"));

			const answered = await awaitRemoteAnswer(callID);
			if (!answered) {
				return text(
					`${out.join("\n")}\n\n(No answer arrived from the Hive workspace within the wait window. ` +
						`The user can still answer in chat.)`,
				);
			}
			const chosen = answered[PLAN_ASK_KEY] ?? Object.values(answered)[0] ?? [];
			return text(`The user answered: ${chosen.join("; ")}`);
		},
	});

	/* ---------------------------------------------------------------------- */
	/* Enforcement                                                             */
	/* ---------------------------------------------------------------------- */

	pi.on("tool_call", async (event) => {
		// The gate holds outside plan mode too. `active` is pi's op-mode; a
		// launched agent runs in build mode and would otherwise walk straight
		// through its own approval request. See `awaitingDecision`.
		if (!active && !awaitingDecision) return;

		// The grill debt is paid the moment the agent actually asks. Observed on
		// the call rather than on its result because that is the only hook this
		// extension has — and because a dismissed question was still asked: the
		// user who wanted to be grilled is allowed to stop answering without
		// stranding the session in a mode it cannot leave.
		if (grillOwesQuestions && event.toolName === "ask_user_question") grillOwesQuestions = false;

		const verdict = classifyTool(event.toolName);
		if (!verdict.allowed) return { block: true, reason: gateReason(verdict.reason) };

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			const shell = classifyCommand(typeof command === "string" ? command : "");
			if (!shell.allowed) return { block: true, reason: gateReason(shell.reason) };
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanPrompt()}` };
	});

	/* ---------------------------------------------------------------------- */
	/* Lifecycle                                                               */
	/* ---------------------------------------------------------------------- */

	// The conductor's doorbell: enter plan mode without a typed command. A
	// no-op when the mode is already active, so a user-typed `/plan` and a
	// conductor request cannot fight.
	pi.events.on(PLAN_CONTROL_CHANNEL, (payload) => {
		const event = payload as PlanControlEvent | undefined;
		// `exit` arrives when the operating-mode axis leaves the plan posture
		// (opmode delegates that posture here rather than running a second
		// read-only gate). A no-op when the mode is already off, symmetrically
		// with `enter`, so the two extensions cannot fight.
		if (event?.action === "exit") {
			if (!active && !awaitingDecision) return;
			// Leaving the mode releases the gate: the operator has taken the
			// decision out of the plan's hands, and a parked tool must not survive
			// the mode it belongs to.
			if (awaitingDecision) releaseWaiters("approve");
			active = false;
			restoreTools();
			paint();
			announceMode();
			return;
		}
		if (event?.action === "grill") {
			// Release a parked `plan_ready` first: the decision has been made, and
			// the tool that is holding the turn is the thing that has to hear it.
			if (awaitingDecision) releaseWaiters("grill");
			// Hive asks; it cannot force a plan state — the `approve` rule, applied
			// to the other verb. Only a pending ready gate can be declined, so a
			// stale click on an old card in the transcript (every card stays
			// clickable forever — they are historical rows) lands on nothing
			// instead of dragging a session back out of execution.
			const grill = beginGrill();
			if (grill) emitGrill(grill);
			return;
		}
		if (event?.action === "approve") {
			// Hive asks; it cannot force a plan state. Only a pending ready gate may
			// accept — but "pending" now includes a gate raised in build mode, which
			// is where launched agents live, so this no longer requires `active`.
			if (doc.phase !== "ready" || (!active && !awaitingDecision)) return;
			releaseWaiters("approve");
			persistOps(doc, [{ op: "header", phase: "approved" }], Date.now());
			active = false;
			clearGrill();
			restoreTools();
			paint();
			announceMode();
			emitApproved(doc);
			return;
		}
		if (event?.action !== "enter" || active) return;
		active = true;
		narrowTools();
		announceMode();
		const ctx = heldCtx;
		if (ctx) {
			try {
				paint();
				ctx.ui.notify(
					"Plan mode (conductor): this task looks complex, so writes are denied until the plan is approved. " +
						"`/plan exit` to opt out.",
					"info",
				);
			} catch {
				/* session replaced — the mode is still on; the banner is cosmetic */
			}
		}
	});

	pi.on("session_start", (event, ctx) => {
		heldCtx = ctx;
		const reason = (event as { reason?: string }).reason;
		if (reason === "new") {
			// A fresh session inherits nothing — including the mode. Waking up
			// read-only with no plan and no explanation is the worse failure.
			doc = emptyPlan(Date.now());
			active = false;
			clearGrill();
			paint();
			return;
		}
		// From the ACTIVE BRANCH, not from every entry the file holds. A plan
		// written on a branch the operator abandoned is NEWER than the live one,
		// so an all-entries read restores it onto the sibling they came back to —
		// the plan resurfacing on a branch that never agreed to it
		// (session-branch/branch.ts).
		try {
			doc = rehydratePlan(branchEntries(ctx)) ?? emptyPlan(Date.now());
			branchWatch.mark(ctx);
		} catch {
			doc = emptyPlan(Date.now());
		}
		// A restored plan does NOT restore the mode. Being silently read-only
		// after a reload, with no banner and no memory of typing /plan, reads as
		// a broken harness rather than as a mode.
		active = false;
		// And a restored plan does not restore a grill debt either: the mode that
		// made it enforceable is gone, so keeping it would only surface later as
		// an unexplained refusal.
		clearGrill();
		paint();
	});

	/**
	 * Re-derive when the leaf moved, because `/tree` emits no `session_start`.
	 *
	 * The MODE is deliberately not touched here. `active` is a posture the human
	 * or the conductor put this session into; a leaf move is navigation, and
	 * silently dropping read-only enforcement — or imposing it — because someone
	 * looked at another branch would be a policy change disguised as a redraw.
	 * Only the document follows the branch. A `null` poll (unchanged, or a stale
	 * ctx) leaves both alone; returns undefined, so it adds no system prompt
	 * beside the mode handler above.
	 */
	pi.on("before_agent_start", (_event, ctx) => {
		const entries = branchWatch.poll(ctx);
		if (!entries) return;
		doc = rehydratePlan(entries) ?? emptyPlan(Date.now());
		paint();
	});

	// `--plan` is honoured once, on the first session build. Doing it here rather
	// than in the factory means `pi.getAllTools()` sees the full registry —
	// including tools other extensions register after us.
	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag("plan") !== true || active) return;
		active = true;
		narrowTools();
		paint();
		announceMode();
	});

	/* ---------------------------------------------------------------------- */
	/* Command                                                                 */
	/* ---------------------------------------------------------------------- */

	pi.registerCommand("plan", {
		description: "Read-only planning mode (`/plan`, `/plan exit`, `/plan show`, `/plan grill`, `/plan export [path]`)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			switch (verb) {
				case "":
				case "start": {
					if (active) {
						ctx.ui.notify("Already in plan mode. `/plan exit` to leave.", "info");
						return;
					}
					active = true;
					narrowTools();
					paint();
					announceMode();
					ctx.ui.notify(
						"Plan mode: writes and mutating shell commands are denied. Build the plan with plan_write; " +
							"`/plan exit` to leave.",
						"info",
					);
					return;
				}

				case "exit":
				case "stop": {
					if (!active) {
						ctx.ui.notify("Not in plan mode.", "info");
						return;
					}
					active = false;
					restoreTools();
					paint();
					announceMode();
					ctx.ui.notify("Left plan mode. Write tools are available again.", "info");
					return;
				}

				case "show":
				case "status": {
					if (isEmpty(doc)) {
						ctx.ui.notify("No plan yet.", "info");
						return;
					}
					const counts = stepCounts(doc);
					ctx.ui.notify(
						`${doc.title || "Untitled plan"} — ${doc.phase}, revision ${doc.revision}, ` +
							`${counts.done}/${counts.total} steps done\n\n${renderStepList(doc)}`,
						"info",
					);
					return;
				}

				case "approve": {
					if (isEmpty(doc)) {
						ctx.ui.notify("No plan to approve.", "warning");
						return;
					}
					// The typed verb releases a parked `plan_ready` exactly as the
					// browser's button does. It is the same decision arriving by the
					// other door, and a gate that only one of them could open would
					// leave an operator typing `/plan approve` at a session that went
					// on waiting.
					releaseWaiters("approve");
					persistOps(doc, [{ op: "header", phase: "approved" }], Date.now());
					active = false;
					clearGrill();
					restoreTools();
					paint();
					announceMode();
					emitApproved(doc);
					ctx.ui.notify("Plan approved; plan mode left. Step status stays live as you work.", "info");
					return;
				}

				case "grill": {
					// The typed twin of the browser's button, and the only way to reach
					// the stage from a terminal without waiting for the next
					// `plan_ready` dialog — an operator who has just read the plan in
					// `/plan show` should not have to.
					//
					// Releases a parked `plan_ready` for the same reason `approve`
					// does, and like the browser's decline it leaves the write ban in
					// place: the plan went back to drafting, it was not accepted.
					if (awaitingDecision) releaseWaiters("grill");
					const grill = beginGrill();
					if (!grill) {
						ctx.ui.notify(
							active
								? `Nothing to send back: the plan is ${doc.phase}, not awaiting approval.`
								: "Not in plan mode, so there is no approval to decline.",
							"warning",
						);
						return;
					}
					// Emitted, unlike the `plan_ready` branch: nothing is holding a turn
					// open here, so the doorbell is the only thing that will tell the
					// agent it has been asked for questions.
					emitGrill(grill);
					ctx.ui.notify(
						"Sent back for questions. The agent stays read-only and must ask before it can present again.",
						"info",
					);
					return;
				}

				case "export": {
					if (isEmpty(doc)) {
						ctx.ui.notify("No plan to export.", "warning");
						return;
					}
					const markdown = planToMarkdown(doc, { includeIds: false });
					const target = rest.join(" ").trim();
					if (!target) {
						ctx.ui.notify(markdown, "info");
						return;
					}
					try {
						const { writeFile } = await import("node:fs/promises");
						// Refuse to clobber: an export that silently overwrites a file is
						// a mutation, and this mode's whole promise is that it does not
						// make surprising ones.
						await writeFile(target, markdown, { flag: "wx" });
						ctx.ui.notify(`Plan written to ${target}.`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Could not write ${target}: ${message}`, "warning");
					}
					return;
				}

				case "clear": {
					doc = emptyPlan(Date.now());
					clearGrill();
					persist(doc);
					paint();
					ctx.ui.notify("Plan cleared.", "info");
					return;
				}

				default:
					ctx.ui.notify(
						`Unknown: /plan ${verb}. Use start, exit, show, approve, grill, export [path], clear.`,
						"warning",
					);
			}
		},
	});
}
