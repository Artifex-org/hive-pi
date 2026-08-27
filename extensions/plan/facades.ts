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

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { normalizeStatus, type ItemInput, type PlanDoc, type PlanOp, type WorkItemStatus } from "./state.ts";
import { lanesOf, targetLane } from "./lanes.ts";

/* -------------------------------------------------------------------------- */
/* TodoWrite                                                                   */
/* -------------------------------------------------------------------------- */

/** One `TodoWrite` entry, exactly as the tool has always accepted it. */
export interface TaskWrite {
	id?: string;
	subject?: string;
	/** The Linear issue this item mirrors. Null unlinks it. */
	linearKey?: string | null;
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
			...(typeof write.linearKey === "string" ? { linearKey: write.linearKey } : {}),
			...(typeof write.owner === "string" ? { owner: write.owner } : {}),
		};

		// An explicit CLEAR cannot ride the item patch: `writeItem` keeps what an
		// item has already earned, dropping undefined fields so a reword does not
		// wipe a status or a link. So `null` — the vocabulary's "unset this" —
		// goes through `set_step`, which has always had the null-clearing path
		// and is tested for it.
		if (id !== undefined && (write.linearKey === null || write.owner === null)) {
			ops.push({
				op: "set_step",
				id,
				...(write.linearKey === null ? { linearKey: null } : {}),
				...(write.owner === null ? { owner: null } : {}),
			});
		}

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
	linearKey?: string;
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
		...(item.linearKey !== undefined ? { linearKey: item.linearKey } : {}),
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


/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a façade needs from the extension that owns the document.
 *
 * Deliberately three functions rather than the document itself: a façade that
 * held a `PlanDoc` would hold a STALE one the moment anything else wrote, which
 * is the race this whole arrangement exists to avoid. `apply` is the only way
 * in, and it goes through the same `persistOps` every other writer uses.
 */
export interface FacadeHost {
	/** The document as of right now. Call it, never cache it. */
	doc: () => PlanDoc;
	/** Apply ops, persist, repaint. Returns what to tell the caller. */
	apply: (ops: readonly PlanOp[]) => { doc: PlanDoc; problems: string[] };
}

/** The status words the todo tools have always accepted. */
const TODO_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;

/**
 * Render a task list the way the task tools always have.
 *
 * Their contract is that the returned TEXT is the view of the list, and the
 * model plans against it, so this shape must not drift under existing callers.
 */
function renderTaskRows(rows: readonly TaskRow[], problems: readonly string[]): string {
	if (rows.length === 0 && problems.length === 0) return "No tasks.";
	const glyph = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
	const lines = rows.map((row) => {
		const blocked = row.blockedBy && row.blockedBy.length > 0 ? ` (waits on ${row.blockedBy.join(", ")})` : "";
		const owner = row.owner ? ` @${row.owner}` : "";
		const shown = row.status === "in_progress" && row.activeForm ? row.activeForm : row.subject;
		return `${glyph[row.status]} ${row.id}  ${shown}${owner}${blocked}`;
	});
    if (problems.length > 0) {
		lines.push("", "Not applied:", ...problems.map((problem) => `  - ${problem}`));
	}
	return lines.join("\n");
}

/**
 * Register `TodoWrite`, its four compatibility aliases, and `workflow_write`.
 *
 * TOOL NAMING, carried over verbatim from the extensions these replace.
 * `TodoWrite` is the primary and the only one carrying a `promptSnippet`; the
 * four `Task*` names are compatibility aliases registered because the skill
 * corpus references them heavily (186 `TodoWrite`, 112 `TaskCreate`/
 * `TaskUpdate`, 62 `TaskList`/`TaskGet`) and a skill naming a tool pi does not
 * have produces a failed call, not a graceful degradation. The aliases carry no
 * `promptSnippet` on purpose: pi omits custom tools from the prompt's tool
 * section when that field is absent, so they are callable when a skill names one
 * and invisible when nothing does. Six tools in the schema, two in the prompt.
 */
export function registerFacadeTools(
	pi: {
		registerTool: (definition: Record<string, unknown>) => void;
	},
	host: FacadeHost,
): void {
	const reply = (result: { doc: PlanDoc; problems: string[] }, laneId?: string) => {
		const rows = taskRowsOf(result.doc, laneId);
		return {
			content: [{ type: "text" as const, text: renderTaskRows(rows, result.problems) }],
			// The RESULTING list, not the writes that produced it (HIV-1146):
			// a row saying "3 tasks written" tells a reader nothing, while the
			// current list and the agent's position in it is the single most
			// informative thing a transcript can show. Hive's `tasks` widget keys
			// on this shape.
			details: { tasks: rows, ...(result.problems.length > 0 ? { problems: result.problems } : {}) },
		};
	};

	const TaskWriteSchema = Type.Object({
		id: Type.Optional(Type.String({ description: "Existing task id. Omit to create a new task." })),
		subject: Type.Optional(Type.String({ description: "Short imperative title. Required when creating." })),
		description: Type.Optional(Type.String({ description: "What needs to be done." })),
		activeForm: Type.Optional(Type.String({ description: 'Present-continuous form, e.g. "Running tests".' })),
		status: Type.Optional(StringEnum(TODO_STATUSES, { description: 'Task status. "deleted" removes the task.' })),
		blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids this one waits on." })),
		owner: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Worker id. Null clears it." })),
	});

	const writeTodos = (writes: readonly TaskWrite[]) => {
		const before = host.doc();
		const result = host.apply(todoWritesToOps(before, writes));
		return reply(result);
	};

	pi.registerTool({
		name: "TodoWrite",
		label: "Tasks",
		description: [
			"Create, update and complete the session's task list. Returns the resulting list, which IS the view",
			"of it — plan against what comes back rather than against what you sent.",
		].join(" "),
		promptSnippet: "Track multi-step work as a task list the user can see",
		parameters: Type.Object({
			todos: Type.Array(TaskWriteSchema, { description: "Tasks to create or update, applied in order." }),
		}),
		execute: async (_id: string, params: { todos?: TaskWrite[] }) => writeTodos(params.todos ?? []),
	});

	// --- compatibility aliases: no promptSnippet, so they stay out of the prompt ---

	pi.registerTool({
		name: "TaskCreate",
		label: "Task create",
		description: "Add one task to the session task list. Returns the full resulting list.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short imperative title." }),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, params: { subject: string; description?: string; activeForm?: string }) =>
			writeTodos([params]),
	});

	pi.registerTool({
		name: "TaskUpdate",
		label: "Task update",
		description: "Update one task by id. Returns the full resulting list.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Id of the task to update." }),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			status: Type.Optional(StringEnum(TODO_STATUSES)),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must finish first." })),
			owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		execute: async (
			_id: string,
			params: { taskId: string; addBlockedBy?: string[] } & Omit<TaskWrite, "id" | "blockedBy">,
		) => {
			const { taskId, addBlockedBy, ...rest } = params;
			return writeTodos([{ id: taskId, ...rest, ...(addBlockedBy ? { blockedBy: addBlockedBy } : {}) }]);
		},
	});

	pi.registerTool({
		name: "TaskList",
		label: "Task list",
		description: "Show the current session task list.",
		parameters: Type.Object({}),
		execute: async () => reply({ doc: host.doc(), problems: [] }),
	});

	pi.registerTool({
		name: "workflow_write",
		label: "Workflow",
		description: [
			"Declare the shape of the work — lanes, the items in them, their dependencies and iteration.",
			"Lanes and their items live in the plan document; this is the same document `plan_write` edits,",
			"under the vocabulary this tool has always used.",
		].join(" "),
		promptSnippet: "Build the shape of the work — stages, dependencies, and orchestration waves",
		parameters: Type.Object({
			ops: Type.Array(Type.Object({}, { additionalProperties: true }), {
				minItems: 1,
				description: "Operations, applied in order.",
			}),
		}),
		execute: async (_id: string, params: { ops?: WorkflowToolOp[] }) => {
			const before = host.doc();
			const mapped = workflowOpsToPlanOps(before, params.ops ?? []);
			const result = host.apply(mapped.ops);
			const problems = [...mapped.notes, ...result.problems];
			const rows = taskRowsOf(result.doc);
			const summary = `${rows.length} item(s) in the current lane`;
			return {
				content: [
					{
						type: "text" as const,
						text:
							problems.length > 0
								? `${summary}\n\nNot applied:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`
								: summary,
					},
				],
				details: { tasks: rows, ...(problems.length > 0 ? { problems } : {}) },
			};
		},
	});

	pi.registerTool({
		name: "TaskGet",
		label: "Task detail",
		description: "Show one task's full detail by id.",
		parameters: Type.Object({ taskId: Type.String({ description: "Id of the task to read." }) }),
		execute: async (_id: string, params: { taskId: string }) => {
			const row = taskRowsOf(host.doc()).find((candidate) => candidate.id === params.taskId);
			return {
				content: [
					{
						type: "text" as const,
						text: row
							? [
									`${row.id}  ${row.subject}`,
									`status: ${row.status}`,
									...(row.description ? [`detail: ${row.description}`] : []),
									...(row.owner ? [`owner: ${row.owner}`] : []),
									...(row.blockedBy?.length ? [`waits on: ${row.blockedBy.join(", ")}`] : []),
								].join("\n")
							: `No task ${params.taskId}.`,
					},
				],
				details: { tasks: row ? [row] : [] },
			};
		},
	});
}
