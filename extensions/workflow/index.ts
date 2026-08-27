/**
 * workflow — the session's execution graph: stages containing steps.
 *
 * The `plan` extension records what the agent INTENDS. This records how the
 * work is being executed, and it is the document the Hive agents workspace
 * draws as a diagram in place of the delegation list it used to call a
 * workflow.
 *
 * THREE THINGS MAINTAIN IT, and only one of them is the model:
 *
 *   the conductor  advances the lifecycle stage, CREATING it on the way in. A
 *                  stage transition is a bus event this extension already
 *                  receives, so the model is never asked "which stage are you
 *                  in" — a question it would answer from memory and get wrong.
 *   the task list  mirrors into the execute stage, creating that stage if the
 *                  conductor has not. The model keeps writing todos exactly as
 *                  it always has; asking it to maintain a second list is asking
 *                  for two lists that disagree.
 *   `workflow_write`  the task-specific stages and steps, which are the only
 *                  part nothing else can know — now including their SHAPE
 *                  (sub-steps, dependencies) and their PLACE (`before`).
 *
 * And a fourth thing maintains the delivery lane, when there is one: HIVE. Its
 * steps' statuses are resolved in the browser from Hive's own run and pull rows,
 * and whatever is written here is discarded (state.ts §THE STATUS SPLIT). The
 * tool says so out loud when a model tries — a tool that silently ignores an
 * argument teaches the model to keep sending it.
 *
 * NOTHING IS SEEDED (template.ts explains what that cost). A session that asks
 * one question has no workflow at all, and a session that never ships code never
 * grows a delivery lane. The document starts empty and everything in it got there
 * because something entered it.
 *
 * FOUR MECHANICAL CONSTRAINTS, the same ones `plan/index.ts` documents:
 *
 *  1. No `context` / `before_provider_request` / `before_provider_headers`
 *     handler. pi skips those transform paths when nothing subscribes;
 *     registering one switches on work pi would otherwise bypass, on every LLM
 *     call. `test/no-forbidden-events.test.ts` fails the build on it.
 *  2. `setActiveTools` is advisory, never enforcement. Nothing here gates tools,
 *     so this does not arise — noted so a later change does not assume it does.
 *  3. Nothing mutable at module scope: pi builds a fresh jiti per extension
 *     entry with `moduleCache:false`, so state lives in the factory closure.
 *  4. Nothing here injects a turn or re-enters the agent loop, so the
 *     one-injector invariant in `agenda/driver.ts` is untouched.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONDUCTOR_CHANNEL,
	HIVE_WORKFLOW_CHANNEL,
	type ConductorStageEvent,
} from "../hive-common/channels.ts";
import { DECK_SECTION_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { branchEntries, createBranchWatch } from "../session-branch/branch.ts";
import {
	LANE_TEMPLATES,
	opsForStage,
	opsForTasks,
	opsForWalkComplete,
	TEMPLATE_NAMES,
	templateLaneOps,
} from "./template.ts";
import { renderWorkflow, summaryLine } from "./render.ts";
import { MAX_DEPTH } from "./graph.ts";
import {
	applyOps,
	currentStage,
	emptyWorkflow,
	isEmpty,
	OBSERVED_KINDS,
	rehydrateWorkflow,
	stepCounts,
	toEntry,
	WORKFLOW_ENTRY_TYPE,
	type WorkflowDoc,
	type WorkflowOp,
} from "./state.ts";

/**
 * Built from the templates themselves, so a new lane cannot ship with the model
 * unable to find out what it is. The `summary` is the only prose about a
 * template the model ever sees.
 */
const TEMPLATE_DESCRIPTIONS = [
	"A ready-made lane for a recognisable shape of work. Ask for one when the session IS that shape:",
	...TEMPLATE_NAMES.map((n) => `"${n}" — ${LANE_TEMPLATES[n].summary}.`),
	"Steps are only chained where the order is real, so the fan-outs are drawn as parallel work.",
].join(" ");

const StatusSchema = StringEnum(["pending", "running", "done", "failed", "skipped", "blocked"] as const, {
	description: "Step or stage status. IGNORED for a step whose kind Hive observes — see `kind`.",
});

const StageOpSchema = Type.Object({
	op: Type.Literal("stage"),
	id: Type.Optional(
		Type.String({
			description:
				"Patches that stage if it exists, otherwise creates one WITH that id — so you can " +
				"name a stage yourself and refer to it from the same batch's steps. Omit to have " +
				"one generated.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Short label, e.g. \"Migrate the callers\"." })),
	kind: Type.Optional(Type.String({ description: "Free-form grouping, e.g. \"execute\" or \"research\"." })),
	status: Type.Optional(StatusSchema),
	before: Type.Optional(
		Type.String({
			description:
				"Insert immediately before this stage id instead of appending. Use it whenever the " +
				"new stage happens BEFORE something already in the document.",
		}),
	),
});

const LoopOpSchema = Type.Object({
	op: Type.Literal("loop"),
	stage: Type.String({ description: "Stage id or kind to annotate." }),
	steps: Type.Array(Type.String(), { description: "Loop body step ids in this stage." }),
	until: Type.Optional(Type.String({ description: "Exit condition (at most 120 characters)." })),
	active: Type.Optional(Type.Boolean({ description: "Defaults to true; set false after exiting the loop." })),
});

const LoopTickOpSchema = Type.Object({
	op: Type.Literal("loop_tick"),
	stage: Type.String({ description: "Stage id or kind whose wave to advance." }),
});

const StepOpSchema = Type.Object({
	op: Type.Literal("step"),
	stageId: Type.Optional(
		Type.String({ description: "Stage to append to. Defaults to the one this batch last touched." }),
	),
	id: Type.Optional(
		Type.String({ description: "Patches that step if it exists, otherwise creates one with that id." }),
	),
	title: Type.Optional(Type.String({ description: "Short imperative title." })),
	kind: Type.Optional(
		Type.String({
			description:
				'Defaults to "task", whose status you own. The kinds Hive OBSERVES — ' +
				`${OBSERVED_KINDS.join(", ")} — take their status from Hive's own runs and pull requests; ` +
				"declare that such a step exists and leave its status alone.",
		}),
	),
	status: Type.Optional(StatusSchema),
	detail: Type.Optional(Type.String()),
	parentId: Type.Optional(
		Type.String({
			description:
				"Make this a sub-step of that step — use it when one step turned out to be several. " +
				`Lives in the parent's stage; nesting is capped at ${MAX_DEPTH} levels.`,
		}),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Step ids this waits on. May name a step in another stage, or one you have not created " +
				"yet. Steps with no dependency between them are shown as PARALLEL, so leave it off when " +
				"the order genuinely does not matter. An edge that would close a cycle is refused.",
		}),
	),
	before: Type.Optional(Type.String({ description: "Insert before this sibling step id." })),
	linearKey: Type.Optional(Type.String({ description: 'e.g. "HIV-1234".' })),
	files: Type.Optional(Type.Array(Type.String(), { description: "Files this step touches." })),
	note: Type.Optional(Type.String({ description: "What ACTUALLY happened, when it diverged from the plan." })),
});

/**
 * `plan_write`'s spelling, accepted here (papercuts, 2026-08-17/18).
 *
 * The two tools sit side by side in the same session and their vocabularies
 * disagree: a plan is patched with `{op:"set_step"}`, a workflow with
 * `{op:"step"}`. Five agents in two days sent the plan spelling to
 * `workflow_write` and got a union-schema error — `ops.0.op: must be equal to
 * constant` — which names no accepted value and no other tool, so the workflow
 * simply went un-updated while the session carried on.
 *
 * Accepting the alias is the same call this file already made for `delivery`
 * ("the original spelling, kept because sessions in flight still send it"), and
 * it is the cheap side of the trade: a rejected batch costs the record the
 * workflow exists to keep, while an accepted alias costs one line of output
 * saying which spelling this tool uses. Built by spreading the real op's
 * properties so the alias cannot drift from what it aliases.
 */
const SetStepAliasSchema = Type.Object({ ...StepOpSchema.properties, op: Type.Literal("set_step") });
const SetStageAliasSchema = Type.Object({ ...StageOpSchema.properties, op: Type.Literal("set_stage") });

/** The plan-side spelling → this tool's, for normalisation and the note. */
const OP_ALIASES: Record<string, string> = { set_step: "step", set_stage: "stage" };

const OpSchema = Type.Union([
	SetStepAliasSchema,
	SetStageAliasSchema,
	Type.Object({
		op: Type.Literal("meta"),
		title: Type.Optional(Type.String()),
		goal: Type.Optional(Type.String()),
	}),
	StageOpSchema,
	LoopOpSchema,
	LoopTickOpSchema,
	StepOpSchema,
	Type.Object({
		op: Type.Literal("moveStage"),
		id: Type.String(),
		before: Type.Optional(Type.String({ description: "Stage id to sit in front of. Omit for last." })),
	}),
	Type.Object({
		op: Type.Literal("moveStep"),
		id: Type.String(),
		stageId: Type.Optional(Type.String({ description: "Move to this stage." })),
		parentId: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description: "Nest under this step, or null to promote it back to a top-level step.",
			}),
		),
		before: Type.Optional(Type.String({ description: "Sibling step id to sit in front of." })),
	}),
	// A convenience rather than a structure: each expands to the same lane every
	// time, which was the one genuinely good property of seeding — without the
	// assumption that every session wants the shipping one.
	Type.Object({
		op: Type.Literal("template"),
		name: StringEnum(TEMPLATE_NAMES as [string, ...string[]], {
			description: TEMPLATE_DESCRIPTIONS,
		}),
		title: Type.Optional(Type.String({ description: "Stage title. Defaults to the template's." })),
	}),
	// The original spelling, kept because sessions in flight still send it.
	Type.Object({
		op: Type.Literal("delivery"),
		title: Type.Optional(Type.String({ description: 'Stage title. Defaults to "Deliver".' })),
	}),
	Type.Object({ op: Type.Literal("removeStage"), id: Type.String() }),
	Type.Object({ op: Type.Literal("removeStep"), id: Type.String() }),
]);

/** Template ops are expanded here, not in `applyOps` — see execute(). */
type ToolOp = WorkflowOp | { op: "template"; name: string; title?: string } | { op: "delivery"; title?: string };

export default function (pi: ExtensionAPI) {
	// The whole of this extension's mutable state. There is no `seeded` flag any
	// more: with nothing to seed, "has this session got a workflow" is just
	// `isEmpty(doc)`, and a second variable tracking it was a second thing to get
	// out of sync across a branch move.
	let doc: WorkflowDoc = emptyWorkflow(Date.now());

	/**
	 * Persist and ring the doorbell.
	 *
	 * The bus event carries a REVISION and nothing else. hive-remote reads the
	 * document out of the session entries under its own consent — the split that
	 * keeps step titles, branch names and file paths off a process-local bus any
	 * loaded extension could subscribe to (hive-common/channels.ts).
	 */
	const persist = (next: WorkflowDoc) => {
		doc = next;
		try {
			pi.appendEntry(WORKFLOW_ENTRY_TYPE, toEntry(next));
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
		try {
			pi.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: next.revision });
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/**
	 * Apply ops, persisting only when something CHANGED.
	 *
	 * `applyOps` reports `changed: false` for a batch that matched what was
	 * already there, and honouring it is not an optimisation: every revision is
	 * a PUT to Hive, and the conductor and the task mirror both fire on beats
	 * that are usually no-ops.
	 */
	const apply = (ops: readonly WorkflowOp[]): readonly string[] => {
		if (ops.length === 0) return [];
		const result = applyOps(doc, ops, Date.now());
		if (result.changed) persist(result.doc);
		// Only the refusals travel. The per-op success lines are already in the
		// document this same call returns, and it is the refusals — the things
		// the caller believes it recorded and did not — that the result must
		// carry. See renderWorkflow for what sorting one list by its prose cost.
		return result.refused;
	};

	/**
	 * Add a template lane, once.
	 *
	 * ONE apply now. It used to take three — create the stage, name it from the
	 * steps, then chain them once their generated ids existed — and all three
	 * boundaries were the same missing feature: a caller could not choose an id.
	 * Now it can, so the lane is one batch whose `dependsOn` are forward
	 * references, which `applyOps` already allows for a document written
	 * top-down.
	 *
	 * Idempotent on the stage kind: asking twice is a no-op, not a second lane.
	 */
	const addTemplateLane = (name: string, title?: string): readonly string[] => {
		const template = LANE_TEMPLATES[name];
		if (!template) return [`no template "${name}"`];
		const already = doc.stages.find((s) => s.kind === template.kind);
		// A refusal that opens with "stage ", and so was invisible for as long as
		// the renderer sorted by first word: asking twice reported nothing at all.
		if (already) return [`stage ${already.id} already carries the ${name} lane`];
		return apply(templateLaneOps(doc, name, title));
	};

	/**
	 * Adopt the branch's own workflow.
	 *
	 * Never persists. The document being adopted is one this session already
	 * wrote; re-appending it would copy a snapshot per turn and, worse, replay a
	 * revision Hive's upsert has already stored — and its upsert refuses a
	 * revision behind the stored one, so the replay is not even harmless.
	 */
	const adopt = (entries: readonly unknown[]) => {
		doc = rehydrateWorkflow(entries) ?? emptyWorkflow(Date.now());
	};

	const branchWatch = createBranchWatch();

	pi.on("session_start", (event, ctx) => {
		const reason = (event as { reason?: string }).reason;
		if (reason === "new") {
			// A fresh session inherits nothing, exactly as the task list does not.
			doc = emptyWorkflow(Date.now());
			return;
		}
		// Every other reason RESTORES, from the ACTIVE BRANCH rather than from
		// every entry the file holds: the newest workflow snapshot may belong to a
		// branch this session abandoned, and restoring that one puts somebody
		// else's stages on the lane the operator came back to
		// (session-branch/branch.ts). A workflow that empties on `/reload` would
		// re-seed a second lane over work already half-delivered, and the stage
		// the conductor is in would restart at `frame`.
		try {
			adopt(branchEntries(ctx));
			branchWatch.mark(ctx);
		} catch {
			doc = emptyWorkflow(Date.now());
		}
	});

	/**
	 * Re-derive when the leaf moved, because `/tree` emits no `session_start`.
	 *
	 * Turn start is the moment that matters — it is the state this turn is about
	 * to be run against. The handler is a stamp comparison and nothing else until
	 * the branch actually moves; a `null` poll (unchanged, or a ctx that went
	 * stale) leaves the document alone rather than clearing it. Returns
	 * undefined, so it contributes neither a message nor a system prompt.
	 */
	pi.on("before_agent_start", (_event, ctx) => {
		const entries = branchWatch.poll(ctx);
		if (!entries) return;
		adopt(entries);
	});

	/**
	 * The conductor drives the lifecycle stages. No model involvement.
	 *
	 * `idle` and `done` are not stages in the document — the first is "has not
	 * started" and the second is "everything finished", neither of which is a
	 * box worth drawing — so they are ignored rather than mapped.
	 */
	pi.events.on(CONDUCTOR_CHANNEL, (data: unknown) => {
		const stage = (data as ConductorStageEvent | undefined)?.stage;
		if (typeof stage !== "string") return;
		// `idle` is "has not started" — not a box worth drawing, and not a reason
		// to bring a document into existence.
		if (stage === "idle") return;
		if (stage === "done") {
			// `done` has no stage of its own, so without this the last stage the
			// conductor entered stays `running` forever. It must not CREATE
			// anything: a session that never had a workflow does not acquire one by
			// finishing.
			if (!isEmpty(doc)) apply(opsForWalkComplete(doc));
			return;
		}
		// `opsForStage` creates the stage it is walking into when the document
		// lacks it, which is what replaced seeding — one box per stage actually
		// entered, rather than six up front.
		apply(opsForStage(doc, stage, Date.now()));
	});

	/**
	 * The task list mirrors into the execute stage.
	 *
	 * The deck event is a DOORBELL: it carries display rows without ids, so the
	 * list itself is read out of the session entries — the same read-under-own-
	 * consent split the plan document uses. Matching on `taskId` is what makes a
	 * reworded todo update its step instead of growing a second one.
	 */
	let latestCtx: ExtensionContext | null = null;
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.events.on(DECK_SECTION_CHANNEL, (data: unknown) => {
		const section = (data as DeckSectionEvent | undefined)?.section;
		if (section !== "tasks") return;
		const tasks = latestTasks(latestCtx);
		if (tasks.length === 0) return;
		// Re-derive FIRST, because this doorbell can beat our own turn hook.
		//
		// `tasks` repaints from its `before_agent_start` handler, and pi runs
		// extension handlers serially in LOAD order — so after a leaf move, this
		// listener can fire with the new branch's todos while `doc` is still the
		// old branch's workflow. Merging them would mirror the new list into the
		// abandoned document AND persist it, putting the old branch's stages onto
		// the new branch: the resurfacing bug this stream exists to remove,
		// arriving sideways through the bus. Polling the same watch makes the
		// merge order-independent — whichever handler runs first does the
		// re-derivation, and the other one sees `null` and skips it.
		const moved = branchWatch.poll(latestCtx);
		if (moved) adopt(moved);
		// `opsForTasks` creates the execute stage when there is none — a session
		// whose conductor never engaged (the complexity heuristic declines simple
		// work) has todos and, without this, nowhere to mirror them to.
		apply(opsForTasks(doc, tasks, Date.now()));
	});

	pi.registerTool({
		name: "workflow_write",
		label: "Workflow",
		description: [
			"Build and revise the shape of THIS session's work — the structure an operator",
			"watches it by. Nothing is pre-filled: the document starts empty and is whatever",
			"you make it. Stages are the lanes; steps are the work; `parentId` breaks a step",
			"into its parts; `dependsOn` says what waits on what, and steps with no dependency",
			"between them are drawn as running in PARALLEL. Build it as you go — add a stage",
			"when you discover one, `before` to put it in the right place, `moveStep` to",
			"restructure when the work turns out differently. The lifecycle stages the",
			"conductor walks and your task list are mirrored in for you. Omit `id` to create,",
			"pass `id` to patch. Returns the full resulting workflow.",
		].join(" "),
		promptSnippet: "Build the shape of the work — stages, dependencies, and orchestration waves",
		promptGuidelines: [
			"Write a workflow for any work with structure worth watching: a migration with a discovery pass and a per-caller pass, an incident with a triage and a fix, an orchestration with a fan-out and a synthesis. It does not have to be a coding task and it does not have to end in a PR.",
			"Build it INCREMENTALLY. A stage discovered on turn nine is normal; add it then, and use `before` so it lands where the work actually happens rather than at the end.",
			"When a step turns out to be bigger than one thing — you start it and find three files to change, or a fix needs its own investigation first — keep the step and add its parts under it with `parentId` instead of rewriting the title or adding siblings. The step stays as the thing you set out to do and the sub-steps show what it took, which is the record an operator reads to see where the time went.",
			"When you HAND a step to another agent, add that agent as a sub-step under it with `parentId`, titled with what it owns and which branch — one sub-step per teammate, added when you launch it. Delegation is the nesting the diagram is for: the parent stays the work, the children show who is carrying it, and an operator can see a fan-out of four agents as four things happening at once rather than one step that has been running for an hour. Keep their statuses current as you supervise them — you are reading the roster anyway.",
			"Leave `dependsOn` off steps that genuinely can happen in any order. It is the only way the diagram can show parallelism; chaining everything makes independent work look like a queue.",
			"For repeated orchestration waves, use `{op:\"loop\", stage, steps, until?}` and `{op:\"loop_tick\", stage}`. Loops annotate a stage; do not create dependency cycles, and re-open body steps explicitly for a new wave.",
			"Do not set a status on a step whose kind Hive observes (pr.open, ci.green, merged, …); its status comes from Hive's own runs and yours is discarded.",
			"When the session IS one of the recognisable shapes, `{op:\"template\", name}` gives you its lane in one call — `delivery` (shipping code), `orchestration` (running a team of agents), `audit` (infra or security), `incident`, `research`. Ask for it early, then edit it: the template is a starting shape, not a contract, and a step that turns out not to apply should be marked skipped rather than left pending.",
			"Only take `delivery` when there will really be a pull request. A session that ends in a report, a decision or a fixed cluster does not get one, and a permanently-pending merge step makes a finished session read as blocked.",
			"Record a `note` when a step went differently from how it was planned — that is what keeps the record honest.",
		],
		parameters: Type.Object({
			ops: Type.Array(OpSchema, { description: "Patches to apply, in order." }),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("dim", "⛭ workflow"), 0, 0),
		renderResult: (_result, _options, theme) => new Text(theme.fg("dim", summaryLine(doc)), 0, 0),
		async execute(_id, params) {
			// `delivery` expands here rather than inside `applyOps` because the lane
			// needs TWO applies (ids do not exist until the first one lands) and
			// because `state.ts` must not import the template — the dependency runs
			// the other way.
			// Two channels, because they make two different claims: what the batch
			// would not do, and what it did that is worth a word.
			const refused: string[] = [];
			const notices: string[] = [];
			// Normalise the plan-side spellings first, and report the substitution
			// ONCE per call rather than per op: the point is to teach the name, not
			// to bury the result under repetition.
			const aliasedFrom = new Set<string>();
			const incoming = (params.ops as ToolOp[]).map((op) => {
				const canonical = OP_ALIASES[op.op];
				if (!canonical) return op;
				aliasedFrom.add(op.op);
				return { ...op, op: canonical } as ToolOp;
			});
			if (aliasedFrom.size > 0) {
				const pairs = [...aliasedFrom].map((from) => `\`${from}\` → \`${OP_ALIASES[from]}\``).join(", ");
				// A NOTICE, not a refusal: the ops did land, under their canonical
				// name. It used to share the refusal channel and so was printed
				// under "Not applied:", telling the caller in one breath that the
				// edit was applied and that it was not (reported 2026-08-18).
				notices.push(`Applied ${pairs} — that is plan_write's spelling; workflow_write's own is the shorter one.`);
			}
			let batch: WorkflowOp[] = [];
			const flush = () => {
				if (batch.length > 0) refused.push(...apply(batch));
				batch = [];
			};
			for (const op of incoming) {
				if (op.op === "template" || op.op === "delivery") {
					// Flushed first so the lane is placed against everything the
					// batch has already built, not against the document as it was
					// when the call arrived.
					flush();
					refused.push(...addTemplateLane(op.op === "template" ? op.name : "delivery", op.title));
					continue;
				}
				batch.push(op);
			}
			flush();
			// Re-home the todo list against the structure that now exists.
			//
			// `opsForTasks` decides WHERE the todos live, and until this call it
			// only ever ran on a task-list beat. That is the wrong clock: the thing
			// that changes the answer is the model authoring stages, and in a
			// session whose todos do not change afterwards — which is most of them,
			// the list is usually written once up front — no beat ever followed.
			// Measured three times on three deployed builds: the mirror's lane sat
			// beside the model's structure restating it, with the code that folds
			// it away correct, deployed, and never called.
			//
			// Idempotent, so running it on every workflow_write is free: todos are
			// matched by `taskId` and patched in place, and once the fold has run
			// there is no stranded lane left to find.
			apply(opsForTasks(doc, latestTasks(latestCtx), Date.now()));
			const counts = stepCounts(doc);
			return {
				content: [{ type: "text" as const, text: renderWorkflow(doc, refused, notices) }],
				details: {
					stages: doc.stages.length,
					steps: counts.total,
					done: counts.done,
					stage: currentStage(doc)?.title,
				},
			};
		},
	});
}

/**
 * The newest `tasks` snapshot's items on the ACTIVE BRANCH, or an empty list.
 *
 * The branch scoping is the same fix as the rehydration above and matters for
 * the same reason: a task list written on an abandoned branch is newer than the
 * live one, so an all-entries read mirrors the wrong todos into the execute
 * stage — with the deck showing the right ones, because `tasks` publishes from
 * its own in-memory state.
 */
function latestTasks(ctx: ExtensionContext | null): { id: string; subject: string; status: string }[] {
	if (!ctx) return [];
	try {
		const entries = branchEntries(ctx) as readonly { customType?: string; data?: unknown }[];
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]?.customType !== "tasks") continue;
			const data = entries[i].data as { tasks?: unknown } | undefined;
			const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
			return tasks
				.filter(
					(t): t is { id: string; subject: string; status: string } =>
						typeof t === "object" &&
						t !== null &&
						typeof (t as { id?: unknown }).id === "string" &&
						typeof (t as { subject?: unknown }).subject === "string",
				)
				.map((t) => ({ id: t.id, subject: t.subject, status: String(t.status ?? "pending") }));
		}
	} catch {
		/* session replaced mid-read */
	}
	return [];
}
