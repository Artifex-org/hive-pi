/**
 * `TodoWrite` and `workflow_write`, as translations rather than as stores.
 *
 * WHY THEY LIVE HERE AND NOT IN THEIR OWN EXTENSIONS. pi builds a fresh jiti
 * instance per extension with `moduleCache: false`, so module-level state does
 * not cross an extension boundary — `extensions/tasks` cannot read the plan
 * document out of `extensions/plan`'s closure. The obvious-looking alternative,
 * each extension keeping its tool and appending its own plan entries, is a
 * within-turn race: two holders of a stale copy, both writing. So the tools
 * move to the one extension that owns the document, and what stays behind is
 * the part that was never about state (Linear sync, the rendering helpers).
 *
 * WHY THE NAMES SURVIVE. `TodoWrite` appears 186 times across the skill corpus,
 * `TaskCreate`/`TaskUpdate` 112, `TaskList`/`TaskGet` 62, and `workflow_write`
 * is named directly in `prompts/team-lead.md`, `team-fixer.md` and
 * `team-reviewer.md`. A skill naming a tool pi does not have produces a failed
 * call, not a graceful degradation. Every schema below is the one those callers
 * already send; only where it lands changed.
 *
 * The mapping functions are pure and exported so the translation can be tested
 * without an extension, a bus or a session — which matters more than usual
 * here, because a wrong mapping does not fail, it silently writes the right
 * thing to the wrong place.
 */

import { normalizeStatus, type ItemInput, type PlanDoc, type PlanOp, type WorkItemStatus } from "./state.ts";
import { lanesOf, targetLane } from "./lanes.ts";

/* -------------------------------------------------------------------------- */
/* TodoWrite                                                                   */
/* -------------------------------------------------------------------------- */

/** One `TodoWrite` entry, exactly as the tool has always accepted it. */
export interface TaskWrite {
	id?: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: "pending" | "in_progress" | "completed" | "deleted";
	blockedBy?: string[];
	owner?: string | null;
}

/**
 * The lane a todo write belongs in, and whether we are about to invent it.
 *
 * `targetLane` answers the first half (the lane the session is in, else an
 * execute lane, else the first). The second half is the part that mattered
 * historically: a lane invented HERE is marked `mirror`, which makes it
 * claimable, so when the model later declares "Implement" its declaration
 * merges into this lane instead of appearing beside it. 13 of 15 measured
 * sessions ended with two Execute lanes before that rule existed.
 */
function laneForTodos(doc: PlanDoc): { lane?: string; creating: boolean } {
	const lane = targetLane(doc);
	return lane ? { lane: lane.id, creating: false } : { creating: true };
}

/**
 * Translate a `TodoWrite` batch into plan ops.
 *
 * Three shapes, and the middle one is the whole reason this is a function
 * rather than a loop at the call site:
 *
 *   - `status: "deleted"`     → `remove_item` (the todo vocabulary's delete)
 *   - an entry with an id     → `item`, patching in place
 *   - an entry without one    → `item`, created in the target lane
 *
 * `subject` becomes `title` and `description` becomes `detail`, because those
 * are the same fields under two vocabularies; `blockedBy` becomes `dependsOn`,
 * which is the merged document's name for the edge it always was.
 */
export function todoWritesToOps(doc: PlanDoc, writes: readonly TaskWrite[]): PlanOp[] {
	const { lane, creating } = laneForTodos(doc);
	const ops: PlanOp[] = [];
	let first = true;

	for (const write of writes) {
		const id = typeof write.id === "string" && write.id.trim() !== "" ? write.id.trim() : undefined;

		if (write.status === "deleted") {
			// A delete with no id names nothing; the tool result says so rather
			// than the op silently doing nothing.
			if (id !== undefined) ops.push({ op: "remove_item", id });
			continue;
		}

		const item: ItemInput = {
			...(id !== undefined ? { id } : {}),
			...(write.subject !== undefined ? { title: write.subject } : {}),
			...(write.description !== undefined ? { detail: write.description } : {}),
			...(write.activeForm !== undefined ? { activeForm: write.activeForm } : {}),
			...(write.status !== undefined ? { status: write.status as WorkItemStatus | "completed" } : {}),
			...(write.blockedBy !== undefined ? { dependsOn: write.blockedBy } : {}),
			...(typeof write.owner === "string" ? { owner: write.owner } : {}),
		};

		ops.push({
			op: "item",
			...(lane !== undefined ? { lane } : {}),
			// Only the op that may CREATE the lane carries the mark, and only
			// when there was no lane to write into. Marking every write would
			// re-mark a lane the model has already claimed.
			...(creating && first ? { origin: "mirror" as const } : {}),
			item,
		});
		first = false;
	}
	return ops;
}

/* -------------------------------------------------------------------------- */
/* workflow_write                                                              */
/* -------------------------------------------------------------------------- */

/** One `workflow_write` op, as the prompts already send them. */
export type WorkflowToolOp = {
	op: string;
	id?: string;
	stageId?: string;
	stage?: string;
	title?: string;
	goal?: string;
	kind?: string;
	status?: string;
	before?: string;
	detail?: string;
	files?: string[];
	note?: string;
	linearKey?: string;
	dependsOn?: string[];
	parentId?: string | null;
	steps?: string[];
	until?: string;
	active?: boolean;
	name?: string;
};

/**
 * Translate a `workflow_write` batch into plan ops.
 *
 * The vocabularies line up almost exactly, which is the evidence that these
 * were one document all along: a stage IS a lane, a step IS a work item, and
 * `loop`, `loop_tick` and `template` are the same ops under the same names.
 *
 * Two deliberate losses, both stated in the tool result rather than silent:
 *
 *   - **a lane's own `status`.** Lane status is now DERIVED from its items, so
 *     a lane cannot be marked done while holding pending work. Accepting the
 *     field and dropping it is exactly the silence this codebase refuses
 *     elsewhere, so the caller is told.
 *   - **`before` on a moveStage.** The plan's block ops address by `after`, and
 *     converting requires the document; `moveStage` therefore resolves to the
 *     block move with the preceding sibling, computed here.
 */
export function workflowOpsToPlanOps(doc: PlanDoc, ops: readonly WorkflowToolOp[]): { ops: PlanOp[]; notes: string[] } {
	const out: PlanOp[] = [];
	const notes: string[] = [];
	// `step` without a `stageId` means "the lane this batch last touched" — the
	// affordance the workflow tool documented, kept because the prompts use it.
	let lastLane: string | undefined;

	for (const op of ops) {
		switch (op.op) {
			case "meta":
				out.push({ op: "header", ...(op.title !== undefined ? { title: op.title } : {}), ...(op.goal !== undefined ? { goal: op.goal } : {}) });
				break;

			case "stage":
			case "set_stage": {
				if (op.status !== undefined) {
					notes.push(
						`a lane's status is derived from its items now, so "${op.status}" on ${op.id ?? op.kind ?? "that lane"} was not stored — set the items instead`,
					);
				}
				const laneId = op.id ?? op.kind;
				if (laneId !== undefined) lastLane = laneId;
				out.push({
					op: "lane",
					...(op.id !== undefined ? { id: op.id } : {}),
					...(op.kind !== undefined ? { kind: op.kind } : {}),
					...(op.title !== undefined ? { title: op.title } : {}),
					...(op.before !== undefined ? { before: op.before } : {}),
				});
				break;
			}

			case "step":
			case "set_step": {
				const lane = op.stageId ?? lastLane;
				if (op.stageId !== undefined) lastLane = op.stageId;
				out.push({
					op: "item",
					...(lane !== undefined ? { lane } : {}),
					item: {
						...(op.id !== undefined ? { id: op.id } : {}),
						...(op.title !== undefined ? { title: op.title } : {}),
						...(op.kind !== undefined ? { kind: op.kind } : {}),
						...(op.status !== undefined ? { status: op.status as WorkItemStatus } : {}),
						...(op.detail !== undefined ? { detail: op.detail } : {}),
						...(op.files !== undefined ? { files: op.files } : {}),
						...(op.note !== undefined ? { note: op.note } : {}),
						...(op.linearKey !== undefined ? { linearKey: op.linearKey } : {}),
						...(op.dependsOn !== undefined ? { dependsOn: op.dependsOn } : {}),
						...(typeof op.parentId === "string" ? { parentId: op.parentId } : {}),
					},
				});
				break;
			}

			case "loop":
				out.push({
					op: "loop",
					lane: op.stage ?? "",
					...(op.steps !== undefined ? { steps: op.steps } : {}),
					...(op.until !== undefined ? { until: op.until } : {}),
					...(op.active !== undefined ? { active: op.active } : {}),
				});
				break;

			case "loop_tick":
				out.push({ op: "loop_tick", lane: op.stage ?? "" });
				break;

			case "template":
				out.push({ op: "template", name: op.name ?? "", ...(op.title !== undefined ? { title: op.title } : {}) });
				break;

			// The original spelling, kept because sessions in flight still send it.
			case "delivery":
				out.push({ op: "template", name: "delivery", ...(op.title !== undefined ? { title: op.title } : {}) });
				break;

			case "moveStage": {
				// `before` → `after`: the block ops address by the sibling they
				// follow, so the target is whatever currently precedes `before`.
				const lanes = lanesOf(doc);
				const at = op.before === undefined ? -1 : lanes.findIndex((candidate) => candidate.id === op.before);
				const after = at > 0 ? lanes[at - 1].id : undefined;
				out.push({ op: "move", id: op.id ?? "", ...(after !== undefined ? { after } : {}) });
				break;
			}

			case "moveStep":
				out.push({
					op: "move_item",
					id: op.id ?? "",
					...(op.stageId !== undefined ? { lane: op.stageId } : {}),
					...(op.parentId !== undefined ? { parentId: op.parentId } : {}),
				});
				break;

			case "removeStage":
				out.push({ op: "remove", id: op.id ?? "" });
				break;

			case "removeStep":
				out.push({ op: "remove_item", id: op.id ?? "" });
				break;

			default:
				notes.push(`unknown workflow op "${op.op}" was ignored`);
		}
	}
	return { ops: out, notes };
}

/* -------------------------------------------------------------------------- */
/* What the façades report back                                                */
/* -------------------------------------------------------------------------- */

/** One row of the list a task tool returns, in the todo vocabulary. */
export interface TaskRow {
	id: string;
	subject: string;
	description?: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed";
	blockedBy?: string[];
	owner?: string;
}

/**
 * The lane the todo tools speak for, rendered back in their own vocabulary.
 *
 * The tools promise that the text they return IS the view of the list and the
 * model plans against it, so the shape it reads must not change under it. It
 * reports ONE lane rather than every item in the document: a todo list that
 * silently grew to include the delivery lane's five observations, or another
 * lane's finished research, would be a different list than the one the caller
 * wrote to.
 */
export function taskRowsOf(doc: PlanDoc, laneId?: string): TaskRow[] {
	const lanes = lanesOf(doc);
	const lane = (laneId !== undefined ? lanes.find((candidate) => candidate.id === laneId) : undefined) ?? targetLane(doc);
	if (!lane) return [];
	return lane.steps.map((item) => ({
		id: item.id,
		subject: item.title,
		...(item.detail !== undefined ? { description: item.detail } : {}),
		...(item.activeForm !== undefined ? { activeForm: item.activeForm } : {}),
		status: toTaskStatus(item.status),
		...(item.dependsOn && item.dependsOn.length > 0 ? { blockedBy: item.dependsOn } : {}),
		...(item.owner !== undefined ? { owner: item.owner } : {}),
	}));
}

/**
 * Six statuses down to the three the todo vocabulary has.
 *
 * `failed`, `skipped` and `blocked` have no todo spelling. They collapse to the
 * nearest true one rather than to `pending`: a failed item is finished being
 * attempted, and reporting it as "to do" would put it back on the list the
 * model works from. `blocked` stays `pending` because it genuinely is still to
 * be done.
 */
function toTaskStatus(status: WorkItemStatus): TaskRow["status"] {
	switch (status) {
		case "in_progress":
			return "in_progress";
		case "done":
		case "skipped":
		case "failed":
			return "completed";
		default:
			return "pending";
	}
}

/** Accepts the todo vocabulary's own status words. Exported for the tool schema. */
export function todoStatus(value: unknown): WorkItemStatus | undefined {
	return normalizeStatus(value);
}
