/**
 * The task list and its fold — pure functions over an immutable snapshot.
 *
 * Persistence is `pi.appendEntry("tasks", snapshot)` on every mutation, the
 * same idiom `agenda/goal-state.ts` uses, chosen for four verified properties
 * of that API (`session-manager.js:820-831, :166-189`):
 *
 *   - written to the session JSONL as `{type:"custom"}`
 *   - `sessionEntryToContextMessages` returns `[]` for custom entries, so the
 *     list is STRUCTURALLY invisible to the LLM rather than merely omitted
 *   - compaction only ever appends, so it survives
 *   - copied into a fork when on the root→leaf path
 *
 * That structural invisibility is the point of the storage choice AND the
 * obstacle it creates: the model cannot see the list unless something shows it.
 * The answer is the TOOL RESULT — every mutating call returns the whole list —
 * never a `context` handler, which switches on a transform path pi otherwise
 * bypasses entirely and is a prompt-cache hazard (see the repo README).
 *
 * Append-only: an "update" is a new entry and "current" is the newest one.
 */

export const TASKS_ENTRY_TYPE = "tasks";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

export type TaskStatus = "pending" | "in_progress" | "completed";

const VALID_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];

export interface TaskItem {
	id: string;
	subject: string;
	description?: string;
	/** Present-continuous form, shown while the task is in progress. */
	activeForm?: string;
	status: TaskStatus;
	/** Ids this task waits on. ADVISORY — see `applyWrites`. */
	blockedBy?: string[];
	/** Worker id, once HIV-1106 lands. Written and displayed here; nothing populates it yet. */
	owner?: string;
	/** Linear issue this task mirrors, e.g. "TES-1234". Set by `/tasks linear <KEY>`. */
	linearKey?: string;
	createdAt: number;
	updatedAt: number;
}

export interface TaskListState {
	tasks: readonly TaskItem[];
	/**
	 * Monotonic id source, persisted alongside the tasks.
	 *
	 * It has to be persisted rather than derived from `tasks.length` or from the
	 * maximum live id: both reuse a deleted task's id, and a reused id silently
	 * re-points every `blockedBy` edge that still names it at the wrong task.
	 */
	nextId: number;
}

export const emptyTasks: TaskListState = { tasks: [], nextId: 1 };

/** A single create-or-update. `id` absent means create. */
export interface TaskWrite {
	id?: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	/** `"deleted"` removes the task; it is an input verb, never a stored state. */
	status?: TaskStatus | "deleted";
	blockedBy?: string[];
	/** `null` clears the owner. */
	owner?: string | null;
	/** Linear issue key. `null` unlinks. */
	linearKey?: string | null;
}

export interface WriteResult {
	state: TaskListState;
	created: string[];
	updated: string[];
	removed: string[];
	/**
	 * Everything the caller got wrong, reported rather than thrown.
	 *
	 * A rejected batch teaches nothing: the model retries the whole thing and
	 * usually reproduces the same mistake. A partial apply plus a precise
	 * complaint lets it fix only what failed.
	 */
	problems: string[];
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function cleanIdList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.map((v) => cleanString(v)).filter((v): v is string => v !== undefined);
	return ids.length > 0 ? ids : [];
}

/**
 * Apply a batch of writes.
 *
 * Batch rather than one-task-per-call because a supervisor re-planning mid-run
 * would otherwise need one round trip per task, and a plan that arrives in six
 * pieces is six chances to be interrupted halfway into an inconsistent list.
 *
 * `blockedBy` is recorded but NOT enforced: nothing here refuses to let a
 * blocked task move to `in_progress`. A harness that enforces its own dependency
 * edges turns a bad edge into a deadlock the model cannot argue its way out of.
 * Dangling edges are reported by `danglingBlockers` and left in place.
 */
export function applyWrites(state: TaskListState, writes: readonly TaskWrite[], now: number): WriteResult {
	const tasks = [...state.tasks];
	let nextId = state.nextId;
	const created: string[] = [];
	const updated: string[] = [];
	const removed: string[] = [];
	const problems: string[] = [];

	writes.forEach((write, index) => {
		const label = `write #${index + 1}`;
		const id = cleanString(write.id);
		const status = write.status;

		if (status !== undefined && status !== "deleted" && !VALID_STATUSES.includes(status as TaskStatus)) {
			problems.push(`${label}: unknown status "${String(status)}"`);
			return;
		}

		if (id === undefined) {
			if (status === "deleted") {
				problems.push(`${label}: cannot delete without an id`);
				return;
			}
			const subject = cleanString(write.subject);
			if (subject === undefined) {
				problems.push(`${label}: a new task needs a subject`);
				return;
			}
			const newId = String(nextId++);
			tasks.push({
				id: newId,
				subject,
				description: cleanString(write.description),
				activeForm: cleanString(write.activeForm),
				status: (status as TaskStatus | undefined) ?? "pending",
				blockedBy: cleanIdList(write.blockedBy),
				owner: typeof write.owner === "string" ? cleanString(write.owner) : undefined,
				linearKey: typeof write.linearKey === "string" ? cleanString(write.linearKey) : undefined,
				createdAt: now,
				updatedAt: now,
			});
			created.push(newId);
			return;
		}

		const at = tasks.findIndex((task) => task.id === id);
		if (at === -1) {
			// Deliberately NOT "create it anyway". A mistyped id that silently
			// creates a task leaves the real one untouched and the list holding two
			// entries for one piece of work, which reads as progress and is not.
			problems.push(`${label}: unknown task id "${id}"`);
			return;
		}

		if (status === "deleted") {
			tasks.splice(at, 1);
			removed.push(id);
			return;
		}

		const current = tasks[at];
		const subject = cleanString(write.subject);
		const description = write.description === undefined ? undefined : cleanString(write.description);
		const activeForm = write.activeForm === undefined ? undefined : cleanString(write.activeForm);
		const blockedBy = write.blockedBy === undefined ? undefined : cleanIdList(write.blockedBy);

		let owner = current.owner;
		if (write.owner === null) owner = undefined;
		else if (typeof write.owner === "string") owner = cleanString(write.owner);

		let linearKey = current.linearKey;
		if (write.linearKey === null) linearKey = undefined;
		else if (typeof write.linearKey === "string") linearKey = cleanString(write.linearKey);

		tasks[at] = {
			...current,
			subject: subject ?? current.subject,
			description: write.description === undefined ? current.description : description,
			activeForm: write.activeForm === undefined ? current.activeForm : activeForm,
			status: (status as TaskStatus | undefined) ?? current.status,
			blockedBy: blockedBy === undefined ? current.blockedBy : blockedBy,
			owner,
			linearKey,
			updatedAt: now,
		};
		updated.push(id);
	});

	return { state: { tasks, nextId }, created, updated, removed, problems };
}

/** `blockedBy` edges naming a task that no longer exists. Advisory; never repaired automatically. */
export function danglingBlockers(state: TaskListState): { id: string; missing: string[] }[] {
	const live = new Set(state.tasks.map((task) => task.id));
	const dangling: { id: string; missing: string[] }[] = [];
	for (const task of state.tasks) {
		const missing = (task.blockedBy ?? []).filter((blocker) => !live.has(blocker));
		if (missing.length > 0) dangling.push({ id: task.id, missing });
	}
	return dangling;
}

export function findTask(state: TaskListState, id: string): TaskItem | undefined {
	return state.tasks.find((task) => task.id === id);
}

export function counts(state: TaskListState): { pending: number; inProgress: number; completed: number } {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const task of state.tasks) {
		if (task.status === "completed") completed++;
		else if (task.status === "in_progress") inProgress++;
		else pending++;
	}
	return { pending, inProgress, completed };
}

/** The persisted shape. Whole-snapshot, because "current" must be readable from one entry. */
export function toEntry(state: TaskListState): Record<string, unknown> {
	return { kind: "tasks", schemaVersion: SCHEMA_VERSION, nextId: state.nextId, tasks: state.tasks };
}

export function validateSnapshot(data: unknown): TaskListState | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "tasks") return null;
	// A newer writer's shape is not ours to guess at: an unknown version rehydrates
	// as "no list" rather than as a partially-understood one.
	if (record.schemaVersion !== SCHEMA_VERSION) return null;
	if (!Array.isArray(record.tasks)) return null;

	const tasks: TaskItem[] = [];
	for (const raw of record.tasks) {
		if (typeof raw !== "object" || raw === null) continue;
		const item = raw as Record<string, unknown>;
		const id = cleanString(item.id);
		const subject = cleanString(item.subject);
		const status = item.status;
		if (id === undefined || subject === undefined) continue;
		if (typeof status !== "string" || !VALID_STATUSES.includes(status as TaskStatus)) continue;
		tasks.push({
			id,
			subject,
			description: cleanString(item.description),
			activeForm: cleanString(item.activeForm),
			status: status as TaskStatus,
			blockedBy: cleanIdList(item.blockedBy),
			owner: cleanString(item.owner),
			linearKey: cleanString(item.linearKey),
			createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
			updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
		});
	}

	// Repair rather than trust: a persisted `nextId` behind the live maximum
	// would hand the next created task an id that already exists.
	const highest = tasks.reduce((max, task) => {
		const numeric = Number(task.id);
		return Number.isSafeInteger(numeric) && numeric > max ? numeric : max;
	}, 0);
	const stored = typeof record.nextId === "number" && Number.isSafeInteger(record.nextId) ? record.nextId : 1;

	return { tasks, nextId: Math.max(stored, highest + 1) };
}

/**
 * Newest snapshot wins. Scans backwards and stops at the first valid one, so
 * the cost is bounded by recency rather than by session length.
 */
export function rehydrateTasks(entries: readonly unknown[]): TaskListState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== TASKS_ENTRY_TYPE) continue;
		const state = validateSnapshot(entry.data);
		if (state) return state;
	}
	return null;
}
