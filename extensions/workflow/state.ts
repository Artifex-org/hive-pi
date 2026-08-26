/**
 * The workflow document — stages containing steps.
 *
 * WHY A SECOND DOCUMENT, next to `plan`. They answer different questions and
 * change on different clocks:
 *
 *   plan      what the agent INTENDS. Written once, approved, then patched
 *             when the intent changes. Its `phase` drives the approval
 *             machinery, and a revision re-arms the handsfree timer.
 *   workflow  HOW the work is being executed. The lifecycle stage it is in,
 *             and the delivery lane inside it. Revised on every step tick.
 *
 * Folding the second into the first would mean a checkbox re-arming an approval
 * timer, which is why Hive stores them in separate columns too.
 *
 * WHY STAGES CONTAINING STEPS rather than the plan's flat block list. A plan is
 * a document — prose, tables, charts, a step list — and flatness is what makes
 * one block patchable. A workflow is a GRAPH, and the two-level shape is the
 * information: "which stage is this session in" is the glance an operator wants,
 * and it is not derivable from a flat list of steps.
 *
 * AND THE STEPS THEMSELVES ARE A TREE, over a DAG. A step carries `parentId`
 * (decomposition — a step that turned out to be four) and `dependsOn` (ordering,
 * across stages). Both live in `graph.ts`, which owns the rules that keep them
 * navigable: a depth cap, cycle refusal on both, and cascade on delete. The
 * stored `steps` array stays FLAT and in insertion order — that is what keeps a
 * patch-by-id cheap — and reading order is derived (`treeOrder`).
 *
 * NOTHING IS SEEDED. There used to be a template that opened every workflow with
 * frame/plan/execute/verify/deliver/consolidate and a five-step delivery lane.
 * It assumed one shape of session, and most sessions are not that shape: an
 * orchestration run, an infra investigation and a research sweep all got a PR
 * lane they would never walk, then reported themselves as blocked on a merge
 * that was never going to happen. Stages now appear when something ENTERS them —
 * the conductor creates the lifecycle stage it is walking into, the task mirror
 * creates the one it is mirroring into, and the model authors the rest. The
 * delivery VOCABULARY survives (DELIVERY_STEPS, and Hive resolves those kinds
 * wherever they appear); only the assumption that every session needs it is gone.
 *
 * THE STATUS SPLIT, which is the load-bearing part of the design. A step
 * declares a `kind`. For a kind naming something Hive can observe — a PR, a
 * run, a merge — the browser DISCARDS the status written here and resolves it
 * from Hive's own rows. That is deliberate and this file must not fight it: an
 * agent cannot mark its own gate green by writing `done`, and the honest thing
 * for a delivery step is to leave its status alone and let the observation
 * speak. Only `task` steps carry a status that is actually read.
 *
 * Persistence is `pi.appendEntry("workflow", snapshot)` — the idiom
 * `plan/state.ts`, `tasks/state.ts` and `agenda/goal-state.ts` all use, for the
 * same verified reasons: custom entries are structurally invisible to the LLM,
 * survive compaction, and are copied into a fork.
 */

import { dependsWouldCycle, depthOf, descendants, MAX_DEPTH, parentWouldCycle } from "./graph.ts";

export const WORKFLOW_ENTRY_TYPE = "workflow";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

export type WorkflowStatus = "pending" | "running" | "done" | "failed" | "skipped" | "blocked";

const VALID_STATUSES: readonly WorkflowStatus[] = [
	"pending",
	"running",
	"done",
	"failed",
	"skipped",
	"blocked",
];

/**
 * Step kinds whose truth lives in Hive.
 *
 * Written down here as well as in the browser so the TOOL can refuse to let a
 * model set a status that would be thrown away — a tool that silently ignores
 * half its argument teaches the model nothing. See `applyOps`.
 */
export const OBSERVED_KINDS: readonly string[] = [
	"push",
	"branch.push",
	"pr.open",
	"ci.running",
	"ci.green",
	"ci.red",
	"review",
	"merged",
];

/** The kind of a step only the agent knows the state of. */
export const TASK_KIND = "task";

export const MAX_STAGES = 20;
export const MAX_STEPS_PER_STAGE = 40;
export const MAX_STEPS_TOTAL = 200;
/** A loop body cannot name more steps than its stage can contain. */
export const MAX_LOOP_STEPS = MAX_STEPS_PER_STAGE;
export const MAX_LOOP_UNTIL_LENGTH = 120;
export const MAX_LOOP_ITERATION = Number.MAX_SAFE_INTEGER;

/**
 * Canonical order of the stage kinds this file has an opinion about.
 *
 * Lives here rather than in `template.ts` because it is not a template: it is
 * the rule that PLACES a stage, and both the machine paths and the model's own
 * `{op:"stage"}` need it. The dependency runs template → state, so putting it
 * the other way round was not available.
 *
 * `research` earns a rank from measurement, not taste. Across 21 live sessions
 * every one of the 11 that grew a research/triage lane put it AFTER the execute
 * lane the task mirror had already created on turn one — 11 out of 11, a diagram
 * claiming the investigation happened after the work it informed. The tool
 * documents `before` for exactly this and no session used it once. A guideline
 * that is never followed is not a mechanism; a rank is.
 *
 * Kinds absent from this list (`monitor`, `planning`, anything a model invents)
 * are appended where the model put them. Ranking what we know beats normalising
 * a model's vocabulary into a house one it did not choose.
 */
const STAGE_ORDER: readonly string[] = [
	"frame",
	"research",
	"plan",
	"execute",
	"verify",
	"deliver",
	"consolidate",
];

/** Where a stage belongs, or -1 for one this file has no opinion about. */
function stageRank(kind: string): number {
	return STAGE_ORDER.indexOf(kind);
}

/**
 * The stage a newly-created stage should be inserted BEFORE, by rank.
 *
 * A stage with a known position is placed against the first stage that ranks
 * after it, and appended only when there is none. Stages with no rank are never
 * used as an anchor — the model put them where it wanted them, and a ranked
 * stage has no opinion about where it sits relative to "Triage the flake".
 */
export function stageAnchor(doc: WorkflowDoc, kind: string): string | undefined {
	const rank = stageRank(kind);
	if (rank < 0) return undefined;
	for (const stage of doc.stages) {
		const other = stageRank(stage.kind);
		if (other >= 0 && other > rank) return stage.id;
	}
	return undefined;
}

export interface WorkflowStep {
	id: string;
	title: string;
	/** Open vocabulary. `task` (or anything unknown) keeps its own status. */
	kind: string;
	status: WorkflowStatus;
	detail?: string;
	/**
	 * The step this one is part of — decomposition, within the same stage.
	 *
	 * Absent for a root step. Depth is capped at `MAX_DEPTH` and a parent that
	 * would close a loop is refused; see graph.ts.
	 */
	parentId?: string;
	/**
	 * Step ids this waits on. May name a step in another stage.
	 *
	 * Load-bearing, not advisory: an edge that would close a cycle is REFUSED
	 * (graph.ts §dependsWouldCycle), because a cyclic dependency has no
	 * topological order and a layered layout can only respond to one by looping
	 * or by quietly dropping an edge and drawing a lie. An edge naming a step
	 * that does not exist yet is still fine — that is a forward reference in a
	 * document being written top-down, and the renderer drops what it cannot
	 * resolve.
	 */
	dependsOn?: string[];
	/** ms epoch — also what attaches a delegation to this step in the diagram. */
	startedAt?: number;
	endedAt?: number;
	/** The `tasks` extension item this mirrors. */
	taskId?: string;
	/** The `plan` document step this implements. */
	planStepId?: string;
	linearKey?: string;
	files?: string[];
	/**
	 * What ACTUALLY happened, when it diverged from what was planned.
	 *
	 * Borrowed from the plan's step for the same reason it exists there: a
	 * record that says where reality went differently stays honest, where one
	 * that silently absorbs the change reads as though it predicted it.
	 */
	note?: string;
}

export interface WorkflowLoop {
	/** Step ids in this stage, in their body order; this is an annotation, not edges. */
	steps: string[];
	/** Human-readable exit condition. */
	until?: string;
	/** 1-based wave counter. */
	iteration?: number;
	/** False when the loop has exited. */
	active?: boolean;
}

export interface WorkflowStage {
	id: string;
	title: string;
	/** "frame" | "plan" | "execute" | "verify" | "deliver" | "consolidate" | custom. */
	kind: string;
	status: WorkflowStatus;
	steps: WorkflowStep[];
	/** One optional iteration annotation; never a dependency edge. */
	loop?: WorkflowLoop;
	startedAt?: number;
	endedAt?: number;
	/**
	 * Set while this lane exists only because a MACHINE made it — the conductor
	 * walking in, or the task mirror needing somewhere to mirror to — and cleared
	 * the moment the model claims it.
	 *
	 * It exists to settle one race, which was the single most damaging defect in
	 * the measured corpus: the task mirror writes its `execute` lane on turn one,
	 * before the model has called `workflow_write` at all, so by the time the
	 * model declares its own "Implement"/"Fix"/"Triage" execute stage there is
	 * already a populated lane of the same kind. 13 of the 15 model-authored
	 * sessions carried TWO "Execute" lanes because of it — an empty-ish box the
	 * conductor drives beside a populated one nobody drives.
	 *
	 * Adoption keyed on this rather than on emptiness (the mirrored lane has
	 * steps, which is precisely why the old empty-only guard never fired) and
	 * rather than on title (the mirror's "Execute" is not reliably
	 * distinguishable from a model's). Cleared on adoption, so a model that
	 * genuinely wants a SECOND execute pass later — a revisit after verify — gets
	 * one instead of silently merging into its own earlier lane.
	 */
	origin?: "machine";
}

export interface WorkflowDoc {
	title: string;
	goal: string;
	/**
	 * Counts every change, unlike the plan's, which counts intent changes only.
	 *
	 * Hive's upsert refuses a revision behind the stored one, so this has to
	 * move on every write the server should accept — including a status tick.
	 */
	revision: number;
	stages: WorkflowStage[];
	nextId: number;
	createdAt: number;
	updatedAt: number;
}

export function emptyWorkflow(now: number): WorkflowDoc {
	return {
		title: "",
		goal: "",
		revision: 0,
		stages: [],
		nextId: 1,
		createdAt: now,
		updatedAt: now,
	};
}

export function isEmpty(doc: WorkflowDoc): boolean {
	return doc.stages.length === 0;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export type WorkflowOp =
	| { op: "meta"; title?: string; goal?: string }
	| {
			op: "stage";
			/**
			 * Re-state an id to PATCH that stage; omit to create one.
			 *
			 * An id that names nothing CREATES with that id rather than failing.
			 * Models use this field as a client-supplied key — `{op:"stage",
			 * id:"discover"}` and then `{op:"step", stageId:"discover"}` — and the
			 * old read ("patch, or report `no stage`") rejected the stage and then
			 * every step that named it. Two sessions in the measured corpus lost
			 * their entire opening declaration that way, 18 ops in all, and had to
			 * rewrite it from the notes. Meeting the model where it already is
			 * costs nothing and makes its follow-up ops resolve.
			 */
			id?: string;
			title?: string;
			kind?: string;
			status?: WorkflowStatus;
			/**
			 * Insert immediately BEFORE this stage instead of appending.
			 *
			 * The reason this exists: stages used to land in the order they were
			 * created, full stop. A session that discovered a triage phase after the
			 * delivery lane already existed got `… deliver · consolidate · triage`,
			 * with the diagram claiming triage happens after the merge. Position is
			 * information, and a document that can only append cannot express it.
			 *
			 * Omitting it does NOT mean "append" for a stage whose kind has a rank
			 * — see `stageAnchor`. It means "put it where it belongs", which is what
			 * a caller that did not express a position actually wants.
			 */
			before?: string;
			/**
			 * Internal. Marks a lane the machine created on the model's behalf, and
			 * is deliberately absent from the tool schema — a model op can never set
			 * it, which is what makes "did a machine make this" answerable.
			 */
			origin?: "machine";
	  }
	| {
			op: "loop";
			/** Stage id, or its kind when the id is not known. */
			stage: string;
			steps: string[];
			until?: string;
			active?: boolean;
	  }
	| {
			op: "loop_tick";
			/** Stage id, or its kind when the id is not known. */
			stage: string;
	  }
	| {
			op: "step";
			/** The stage this belongs to. Defaults to the parent's, else the last stage. */
			stageId?: string;
			id?: string;
			title?: string;
			kind?: string;
			status?: WorkflowStatus;
			detail?: string;
			/** Make this a sub-step of that step. Same stage, depth-capped. */
			parentId?: string;
			dependsOn?: string[];
			taskId?: string;
			planStepId?: string;
			linearKey?: string;
			files?: string[];
			note?: string;
			/** Insert immediately before this sibling instead of appending. */
			before?: string;
	  }
	/** Reorder a stage. `before` omitted means "to the end". */
	| { op: "moveStage"; id: string; before?: string }
	/**
	 * Move a step: to another stage, under another parent, or just elsewhere
	 * among its siblings. Every field but `id` is optional, and an omitted one
	 * means "leave that alone" — `{op:"moveStep", id, before}` is a pure reorder,
	 * `{op:"moveStep", id, parentId}` a pure reparent.
	 */
	| { op: "moveStep"; id: string; stageId?: string; parentId?: string | null; before?: string }
	| { op: "removeStage"; id: string }
	| { op: "removeStep"; id: string };

export interface OpResult {
	doc: WorkflowDoc;
	/** One line per op, for the tool result. Failures are reported, never silent. */
	notes: string[];
	/**
	 * The subset of `notes` this batch REFUSED — the lines that must reach the
	 * model, because each one is something it believes it recorded and did not.
	 *
	 * Stated at the push site rather than recovered from the prose downstream.
	 * The renderer used to sort `notes` with `!/^(stage|step) /`, on the theory
	 * that a success line always starts with its noun — which silently swallowed
	 * every refusal that happens to open the same way (`stage limit reached`,
	 * `step limit reached for s1`, `stage s1 already carries the delivery lane`)
	 * and, once `workflow_write` gained an alias notice, printed "Applied
	 * set_step → step" under the heading **Not applied**. One channel carrying
	 * three meanings cannot be sorted by its first word.
	 */
	refused: string[];
	/** True when anything actually changed — a no-op must not bump the revision. */
	changed: boolean;
}

function nextStageId(doc: WorkflowDoc): string {
	return `s${doc.nextId}`;
}

/**
 * The shape `nextStageId` and the step-id builder mint.
 *
 * A caller-supplied id is honoured on create, but not one that looks generated:
 * accepting `"s4"` would hand out an id the counter is free to mint again later,
 * and the collision would land as a silent patch of somebody else's stage.
 */
const GENERATED_STAGE_ID = /^s\d+$/;
const GENERATED_STEP_ID = /^s\d+\.\d+$/;

/**
 * A minted step id nothing is using yet.
 *
 * The `GENERATED_STEP_ID` guard only protects the `s<n>.<n>` shape, and steps
 * are minted as `${stage.id}.${nextId}` — so in a stage the caller NAMED, the
 * mint is `discover.7`, which that pattern does not match and a caller is
 * therefore free to supply. Supplying it before the counter reaches 7 sets up a
 * duplicate id later, and a duplicate id is not a cosmetic problem: every patch,
 * move and remove resolves a step by scanning for the first match, so the second
 * one becomes unreachable and the first one absorbs edits meant for it.
 *
 * Bounded by the number of steps in the document, which `MAX_STEPS_TOTAL` caps.
 */
function freeStepId(doc: WorkflowDoc, stage: WorkflowStage, from: number): string {
	const taken = new Set(doc.stages.flatMap((s) => s.steps.map((step) => step.id)));
	let n = from;
	while (taken.has(`${stage.id}.${n}`)) n++;
	return `${stage.id}.${n}`;
}

function findStage(doc: WorkflowDoc, id: string): WorkflowStage | undefined {
	return doc.stages.find((s) => s.id === id);
}

/** An explicit id wins; a kind is a convenience for an already-known lane. */
function findStageOrKind(doc: WorkflowDoc, idOrKind: string): WorkflowStage | undefined {
	return findStage(doc, idOrKind) ?? doc.stages.find((s) => s.kind === idOrKind);
}

function normalizeLoop(value: unknown, steps: readonly WorkflowStep[]): WorkflowLoop | undefined {
	if (typeof value !== "object" || value === null || !Array.isArray((value as WorkflowLoop).steps)) return undefined;
	const source = value as Partial<WorkflowLoop>;
	const requested = new Set((source.steps ?? []).filter((id): id is string => typeof id === "string"));
	const body = steps.filter((step) => requested.has(step.id)).map((step) => step.id).slice(0, MAX_LOOP_STEPS);
	const until = typeof source.until === "string" ? source.until.replace(/\s+/g, " ").trim().slice(0, MAX_LOOP_UNTIL_LENGTH) : undefined;
	return {
		steps: body,
		...(until ? { until } : {}),
		iteration: Number.isSafeInteger(source.iteration) && (source.iteration as number) >= 1 ? source.iteration : 1,
		active: typeof source.active === "boolean" ? source.active : true,
	};
}

function sameLoop(a: WorkflowLoop | undefined, b: WorkflowLoop): boolean {
	return (
		a !== undefined &&
		a.until === b.until &&
		a.iteration === b.iteration &&
		a.active === b.active &&
		a.steps.length === b.steps.length &&
		a.steps.every((step, index) => step === b.steps[index])
	);
}

function findStepStage(doc: WorkflowDoc, stepId: string): WorkflowStage | undefined {
	return doc.stages.find((s) => s.steps.some((step) => step.id === stepId));
}

function totalSteps(doc: WorkflowDoc): number {
	return doc.stages.reduce((n, s) => n + s.steps.length, 0);
}

/**
 * Place `item` immediately before the element with id `beforeId`, else at the end.
 *
 * An unknown `beforeId` appends rather than refusing: it is a position hint, and
 * losing the position is a far smaller failure than losing the step.
 */
function insertBefore<T extends { id: string }>(list: T[], item: T, beforeId: string | undefined): void {
	const at = beforeId ? list.findIndex((e) => e.id === beforeId) : -1;
	if (at < 0) list.push(item);
	else list.splice(at, 0, item);
}

/**
 * applyOps folds a batch of patches into a new document.
 *
 * Immutable and total: it never throws, and anything it refuses is REPORTED in
 * `notes` rather than dropped. A tool that silently ignores an argument teaches
 * the model to keep sending it.
 *
 * `dependsOn` is advisory here as `blockedBy` is in the plan: an edge naming a
 * step that does not exist yet is legitimate while a workflow is being written
 * top-down, and the renderer drops an unresolvable edge rather than drawing it
 * to nowhere.
 */
export function applyOps(doc: WorkflowDoc, ops: readonly WorkflowOp[], now: number): OpResult {
	let next: WorkflowDoc = {
		...doc,
		stages: doc.stages.map((s) => ({ ...s, steps: [...s.steps], ...(s.loop ? { loop: { ...s.loop, steps: [...s.loop.steps] } } : {}) })),
	};
	const notes: string[] = [];
	const refused: string[] = [];
	/**
	 * Record a refusal: something the caller asked for that did NOT happen.
	 *
	 * It goes in both lists — `notes` stays the full per-op account several
	 * tests and callers already read, and `refused` is the half the renderer
	 * must show. Classifying here, where the code knows which branch it took,
	 * is the whole point: downstream all it has is a sentence.
	 */
	const refuse = (text: string): void => {
		notes.push(text);
		refused.push(text);
	};
	let changed = false;
	/**
	 * The stage this batch most recently created or addressed — what a step with
	 * no `stageId` belongs to.
	 *
	 * It used to be `stages[length - 1]`, which was only ever right because
	 * stages were appended. Now that a ranked stage is INSERTED, "the last stage
	 * in the array" and "the stage I just made" are different stages, and the
	 * interleaved shape every measured session writes — stage, its steps, next
	 * stage, its steps — would post each stage's steps into whatever sorts last.
	 * The same latent bug was already reachable through `opsForTasks`, whose
	 * mirrored todos would have landed in `consolidate` on any session that
	 * reached the wrap-up before the todo list existed.
	 */
	let lastStage: WorkflowStage | undefined;

	for (const op of ops) {
		switch (op.op) {
			case "meta": {
				if (op.title !== undefined) next.title = op.title;
				if (op.goal !== undefined) next.goal = op.goal;
				changed = true;
				break;
			}

			case "stage": {
				const existing = op.id ? findStage(next, op.id) : undefined;
				if (existing) {
					if (op.title !== undefined) existing.title = op.title;
					if (op.kind !== undefined) existing.kind = op.kind;
					if (op.status !== undefined) {
						applyStageStatus(existing, op.status, now);
					}
					// Any op that names a stage explicitly claims it, the same as
					// adoption does — otherwise a model that patched the mirrored
					// lane by id would still get a second one when it later
					// declared the same kind.
					if (!op.origin) delete existing.origin;
					lastStage = existing;
					changed = true;
					break;
				}
				// ADOPT the machine's lane of the same kind rather than growing a
				// second one beside it.
				//
				// Stages are created lazily — the conductor makes the stage it is
				// walking into, the task mirror makes the one it mirrors into — so
				// an `execute` lane usually exists, WITH STEPS IN IT, before the
				// model has said a word. This guard used to require the lane be
				// empty and pending, which meant it never fired on the one case
				// that actually occurs: measured across the live corpus, 13 of the
				// 15 model-authored sessions carried two "Execute" lanes.
				//
				// Keyed on `origin` (see WorkflowStage) rather than on emptiness or
				// title, and only against an EXPLICIT kind. A stage op with no kind
				// defaults to "stage", which every generic stage shares — matching
				// on that would make the second undifferentiated stage adopt the
				// first, so a caller adding N of them would get one. (Caught by the
				// MAX_STAGES test, which adds exactly that in a loop.)
				//
				// A machine op never adopts: the conductor and the mirror find
				// their own lane by kind before they ever emit a create.
				const adoptable =
					op.kind && !op.origin
						? next.stages.find((s) => s.kind === op.kind && s.origin === "machine")
						: undefined;
				if (adoptable) {
					if (op.title !== undefined) adoptable.title = op.title;
					if (op.status !== undefined) applyStageStatus(adoptable, op.status, now);
					// The caller NAMED it, so the adopted lane takes that name.
					//
					// Without this, adoption silently defeats the caller-supplied id
					// it sits above: `{op:"stage", id:"implement", kind:"execute"}`
					// merges into the machine's `s1` lane, `"implement"` never comes
					// into existence, and every following `{stageId:"implement"}` is
					// dropped with `no stage "implement"`. Measured on a live 53-turn
					// Borealis session — the model declared its two real implementation
					// steps, both were discarded, and the `gate` step it had pointed
					// at one of them was left depending on a step that does not exist.
					// The lane it got back held only the mirrored todos, so the
					// document looked plausible and was missing the actual work.
					//
					// Renaming is safe: step ids are opaque strings, already minted,
					// and nothing keys off a stage id matching its steps' prefix.
					if (op.id && !GENERATED_STAGE_ID.test(op.id) && !findStage(next, op.id)) {
						adoptable.id = op.id;
					}
					// Claimed. A LATER stage op of the same kind will not adopt this
					// one, so a deliberate second pass still gets its own lane.
					delete adoptable.origin;
					notes.push(`stage ${adoptable.id} (adopted the ${adoptable.kind} lane)`);
					lastStage = adoptable;
					changed = true;
					break;
				}
				if (next.stages.length >= MAX_STAGES) {
					refuse(`stage limit reached (${MAX_STAGES})`);
					break;
				}
				// A caller-supplied id that names nothing CREATES with that id —
				// except when it collides with the generated `s<n>` space, where
				// honouring it would hand out an id `nextStageId` may later mint
				// again.
				const id = op.id && !GENERATED_STAGE_ID.test(op.id) ? op.id : nextStageId(next);
				const created: WorkflowStage = {
					id,
					title: op.title ?? id,
					kind: op.kind ?? "stage",
					status: op.status ?? "pending",
					steps: [],
					startedAt: op.status === "running" ? now : undefined,
				};
				if (op.origin) created.origin = op.origin;
				// `before` when the caller expressed a position, rank when it did
				// not. Appending was what put every measured research lane after
				// the execute lane it precedes.
				insertBefore(next.stages, created, op.before ?? stageAnchor(next, created.kind));
				next.nextId += 1;
				notes.push(`stage ${id}`);
				lastStage = created;
				changed = true;
				break;
			}

			case "loop": {
				const stage = findStageOrKind(next, op.stage);
				if (!stage) {
					refuse(`no stage or kind "${op.stage}"`);
					break;
				}
				const loop = normalizeLoop(
					{ steps: op.steps, until: op.until, active: op.active, iteration: stage.loop?.iteration },
					stage.steps,
				);
				if (!loop) {
					refuse(`${stage.id}: invalid loop`);
					break;
				}
				if (!sameLoop(stage.loop, loop)) {
					stage.loop = loop;
					changed = true;
				}
				break;
			}

			case "loop_tick": {
				const stage = findStageOrKind(next, op.stage);
				if (!stage) {
					refuse(`no stage or kind "${op.stage}"`);
					break;
				}
				if (!stage.loop) {
					refuse(`${stage.id}: no loop to tick`);
					break;
				}
				if ((stage.loop.iteration ?? 1) >= MAX_LOOP_ITERATION) {
					refuse(`${stage.id}: loop iteration limit reached`);
					break;
				}
				stage.loop.iteration = (stage.loop.iteration ?? 1) + 1;
				changed = true;
				break;
			}

			case "step": {
				const owning = op.id ? findStepStage(next, op.id) : undefined;
				const existing = owning?.steps.find((s) => s.id === op.id);
				if (existing) {
					lastStage = owning;
					// Reparenting an existing step is `moveStep`, which is the op that
					// carries the subtree and checks the cycle. Silently honouring
					// `parentId` here would move a step without its children.
					if (op.parentId !== undefined && op.parentId !== existing.parentId) {
						refuse(`${existing.id}: use moveStep to change a step's parent`);
					}
					patchStep(existing, op, next, now, refuse);
					changed = true;
					break;
				}
				// A sub-step lives in its parent's stage. Taking the stage from the
				// parent rather than from `stageId` means the model can say "this is
				// part of that" without also having to remember where that was, and
				// removes the contradiction case entirely.
				const parentStage = op.parentId ? findStepStage(next, op.parentId) : undefined;
				if (op.parentId && !parentStage) {
					refuse(`no step "${op.parentId}" to nest under`);
					break;
				}
				const stage =
					parentStage ??
					(op.stageId
						? findStage(next, op.stageId)
						: (lastStage ?? next.stages[next.stages.length - 1]));
				if (!stage) {
					refuse(op.stageId ? `no stage "${op.stageId}"` : "no stage to add a step to");
					break;
				}
				if (stage.steps.length >= MAX_STEPS_PER_STAGE || totalSteps(next) >= MAX_STEPS_TOTAL) {
					refuse(`step limit reached for ${stage.id}`);
					break;
				}
				if (!op.title) {
					refuse("a new step needs a title");
					break;
				}
				if (op.parentId && depthOf(stage, op.parentId) >= MAX_DEPTH) {
					refuse(`${op.parentId}: already at the ${MAX_DEPTH}-level nesting limit`);
					break;
				}
				// Same upsert rule as a stage: a caller-supplied id that names
				// nothing creates with that id, unless it collides with the
				// generated space.
				const id =
					op.id && !GENERATED_STEP_ID.test(op.id)
						? op.id
						: freeStepId(next, stage, next.nextId);
				const step: WorkflowStep = {
					id,
					title: op.title,
					kind: op.kind ?? TASK_KIND,
					status: "pending",
					parentId: op.parentId,
				};
				patchStep(step, op, next, now, refuse);
				insertBefore(stage.steps, step, op.before);
				next.nextId += 1;
				notes.push(`step ${id}`);
				lastStage = stage;
				changed = true;
				break;
			}

			case "moveStage": {
				const from = next.stages.findIndex((s) => s.id === op.id);
				if (from < 0) {
					refuse(`no stage "${op.id}"`);
					break;
				}
				if (op.before === op.id) {
					refuse(`${op.id}: cannot move a stage before itself`);
					break;
				}
				const [stage] = next.stages.splice(from, 1);
				insertBefore(next.stages, stage, op.before);
				notes.push(`stage ${op.id} moved`);
				changed = true;
				break;
			}

			case "moveStep": {
				const from = findStepStage(next, op.id);
				const step = from?.steps.find((s) => s.id === op.id);
				if (!from || !step) {
					refuse(`no step "${op.id}"`);
					break;
				}

				// Resolve the destination first, and refuse the whole op if any part
				// of it is bad — a half-applied move leaves a step somewhere neither
				// the model nor the operator asked for.
				const target = op.stageId ? findStage(next, op.stageId) : from;
				if (!target) {
					refuse(`no stage "${op.stageId}"`);
					break;
				}
				// `null` clears the parent (promote to a root step); `undefined`
				// leaves it alone. That distinction is the whole reason the field is
				// typed `string | null` rather than optional.
				const parentId = op.parentId === undefined ? step.parentId : (op.parentId ?? undefined);
				if (parentId) {
					const parentStage = findStepStage(next, parentId);
					if (!parentStage) {
						refuse(`no step "${parentId}" to nest under`);
						break;
					}
					if (parentStage.id !== target.id) {
						refuse(`${op.id}: a sub-step must live in its parent's stage (${parentStage.id})`);
						break;
					}
					if (parentWouldCycle(parentStage, op.id, parentId)) {
						refuse(`${op.id}: cannot nest under ${parentId} — that is its own descendant`);
						break;
					}
					if (depthOf(parentStage, parentId) >= MAX_DEPTH) {
						refuse(`${parentId}: already at the ${MAX_DEPTH}-level nesting limit`);
						break;
					}
				}

				// The subtree travels with the step. Leaving children behind would
				// orphan them into steps present in the tally and absent from every
				// renderer, which walks roots and then their children.
				const moving = [step, ...descendants(from, op.id)];
				const movingIds = new Set(moving.map((s) => s.id));
				from.steps = from.steps.filter((s) => !movingIds.has(s.id));
				step.parentId = parentId;
				insertBefore(target.steps, step, op.before);
				for (const child of moving.slice(1)) target.steps.push(child);
				notes.push(`step ${op.id} moved`);
				changed = true;
				break;
			}

			case "removeStage": {
				const before = next.stages.length;
				next.stages = next.stages.filter((s) => s.id !== op.id);
				if (next.stages.length === before) refuse(`no stage "${op.id}"`);
				else changed = true;
				break;
			}

			case "removeStep": {
				const stage = findStepStage(next, op.id);
				if (!stage) {
					refuse(`no step "${op.id}"`);
					break;
				}
				// Cascade. A child whose parent is gone is unreachable to every
				// renderer (they walk roots, then children) but still counted by
				// `stepCounts` — a step that exists in the tally and nowhere on
				// screen, which reads as a workflow that will not finish.
				const doomed = descendants(stage, op.id);
				const ids = new Set([op.id, ...doomed.map((s) => s.id)]);
				stage.steps = stage.steps.filter((s) => !ids.has(s.id));
				if (doomed.length > 0) notes.push(`step ${op.id} (and ${doomed.length} sub-step(s))`);
				changed = true;
				break;
			}
		}
	}

	if (!changed) return { doc, notes, refused, changed: false };

	for (const stage of next.stages) {
		const loop = normalizeLoop(stage.loop, stage.steps);
		if (loop) stage.loop = loop;
		else delete stage.loop;
	}
	next = { ...next, revision: next.revision + 1, updatedAt: now };
	return { doc: next, notes, refused, changed: true };
}

/**
 * Stage status, with its own timestamps.
 *
 * The stamps are what the diagram uses to attach a delegation to the step that
 * was open when it ran, so they are set HERE rather than left to the caller —
 * a stage whose status moved without a stamp is a stage the diagram cannot
 * place anything inside.
 */
function applyStageStatus(stage: WorkflowStage, status: WorkflowStatus, now: number): void {
	stage.status = status;
	if (status === "running" && stage.startedAt === undefined) stage.startedAt = now;
	if (status !== "running" && status !== "pending" && stage.endedAt === undefined) {
		stage.endedAt = now;
	}
}

function patchStep(
	step: WorkflowStep,
	op: Extract<WorkflowOp, { op: "step" }>,
	doc: WorkflowDoc,
	now: number,
	refuse: (text: string) => void,
): void {
	if (op.title !== undefined) step.title = op.title;
	if (op.kind !== undefined) step.kind = op.kind;
	if (op.detail !== undefined) step.detail = op.detail;
	if (op.dependsOn !== undefined) {
		// Enforced, not stored-and-hoped-for. A self-edge is the common typo and a
		// longer loop is the interesting one; both make the step unschedulable and
		// the layout undefined, so both are refused with the edge named.
		const cyclic = op.dependsOn.filter(
			(d) => d === step.id || dependsWouldCycle(doc, step.id, [d]),
		);
		const clean = op.dependsOn.filter((d) => !cyclic.includes(d));
		if (cyclic.length > 0) {
			refuse(`${step.id}: dependency on ${cyclic.join(", ")} refused — it would close a cycle`);
		}
		step.dependsOn = clean.length > 0 ? clean : undefined;
	}
	if (op.taskId !== undefined) step.taskId = op.taskId;
	if (op.planStepId !== undefined) step.planStepId = op.planStepId;
	if (op.linearKey !== undefined) step.linearKey = op.linearKey;
	if (op.files !== undefined) step.files = op.files;
	if (op.note !== undefined) step.note = op.note;

	if (op.status !== undefined) {
		// The status split, enforced rather than documented. Hive resolves an
		// observed step from its own rows and throws this value away, so setting
		// it is not wrong-but-harmless — it is an instruction the model will
		// repeat forever because nothing ever told it the value went nowhere.
		if (OBSERVED_KINDS.includes(step.kind)) {
			refuse(`${step.id}: status ignored — "${step.kind}" is resolved from Hive's own runs`);
		} else {
			step.status = op.status;
			if (op.status === "running" && step.startedAt === undefined) step.startedAt = now;
			if (op.status !== "running" && op.status !== "pending" && step.endedAt === undefined) {
				step.endedAt = now;
			}
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export function allSteps(doc: WorkflowDoc): WorkflowStep[] {
	return doc.stages.flatMap((s) => s.steps);
}

/**
 * Step counts, over the steps whose status is actually READ.
 *
 * Observed steps are excluded on purpose: their status here is a placeholder
 * Hive overwrites, so counting them would produce a tally the browser disagrees
 * with — and the browser's is the true one.
 */
export function stepCounts(doc: WorkflowDoc): Record<WorkflowStatus, number> & { total: number } {
	const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, blocked: 0, total: 0 };
	for (const step of allSteps(doc)) {
		if (OBSERVED_KINDS.includes(step.kind)) continue;
		counts[step.status] += 1;
		counts.total += 1;
	}
	return counts;
}

/** The stage the session is in, for a one-line summary. */
export function currentStage(doc: WorkflowDoc): WorkflowStage | undefined {
	return doc.stages.find((s) => s.status === "running") ?? doc.stages.find((s) => s.status === "pending");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/** The persisted shape. Whole-snapshot, so "current" is readable from one entry. */
export function toEntry(doc: WorkflowDoc): Record<string, unknown> {
	return { kind: "workflow", schemaVersion: SCHEMA_VERSION, doc };
}

export function validateSnapshot(data: unknown): WorkflowDoc | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "workflow") return null;
	// A newer writer's shape is not ours to guess at: an unknown version
	// rehydrates as "no workflow" rather than as a partially-understood one.
	if (record.schemaVersion !== SCHEMA_VERSION) return null;

	const doc = record.doc as Partial<WorkflowDoc> | undefined;
	if (typeof doc !== "object" || doc === null || !Array.isArray(doc.stages)) return null;

	const stages = doc.stages
		.filter((stage): stage is WorkflowStage => {
			if (typeof stage !== "object" || stage === null) return false;
			const candidate = stage as Partial<WorkflowStage>;
			return typeof candidate.id === "string" && typeof candidate.title === "string";
		})
		.map((stage) => {
			const steps = (Array.isArray(stage.steps) ? stage.steps : []).filter(
				(step): step is WorkflowStep =>
					typeof step === "object" &&
					step !== null &&
					typeof (step as WorkflowStep).id === "string" &&
					typeof (step as WorkflowStep).title === "string",
			);
			const loop = normalizeLoop(stage.loop, steps);
			const { loop: _rawLoop, ...rest } = stage;
			return {
				...rest,
				kind: typeof stage.kind === "string" ? stage.kind : "stage",
				status: VALID_STATUSES.includes(stage.status) ? stage.status : "pending",
			// Stated rather than left to the spread. `origin` decides whether the
			// model's stage op ADOPTS this lane or raises a second one beside it,
			// and rehydration is not a rare path — it runs on every session restore
			// and every branch move. A later rewrite of this mapping into explicit
			// field construction (the shape Hive's own reader uses) would drop the
			// marker and quietly restore the duplicate-lane defect for exactly the
			// sessions that reloaded. The round-trip test is the other half.
				origin: stage.origin === "machine" ? ("machine" as const) : undefined,
				steps,
				...(loop ? { loop } : {}),
			};
		});

	// Repair rather than trust: a persisted `nextId` behind the live maximum
	// would hand the next stage an id that already exists.
	const highest = stages.reduce((max, stage) => {
		const numeric = Number(stage.id.replace(/^s/, ""));
		return Number.isSafeInteger(numeric) && numeric > max ? numeric : max;
	}, 0);
	const stored = typeof doc.nextId === "number" && Number.isSafeInteger(doc.nextId) ? doc.nextId : 1;

	return {
		title: typeof doc.title === "string" ? doc.title : "",
		goal: typeof doc.goal === "string" ? doc.goal : "",
		revision: typeof doc.revision === "number" && Number.isSafeInteger(doc.revision) ? doc.revision : 0,
		stages,
		nextId: Math.max(stored, highest + 1),
		createdAt: typeof doc.createdAt === "number" ? doc.createdAt : 0,
		updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : 0,
	};
}

/**
 * Newest snapshot wins. Scans backwards and stops at the first valid one, so
 * the cost is bounded by recency rather than by session length.
 */
export function rehydrateWorkflow(entries: readonly unknown[]): WorkflowDoc | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== WORKFLOW_ENTRY_TYPE) continue;
		const doc = validateSnapshot(entry.data);
		if (doc) return doc;
	}
	return null;
}
