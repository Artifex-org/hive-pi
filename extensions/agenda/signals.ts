/**
 * Session signals — cheap synchronous derivations the driver hands to policies.
 *
 * The driver reads everything off `ctx` before its first await (ctx throws once
 * the session is replaced), so these are pure functions over the raw entry
 * arrays it already holds. A policy must never reach for `ctx` itself; giving
 * the conductor a precomputed snapshot is what keeps its `decide()` inside the
 * "synchronous, cheap, no I/O" contract in policy.ts.
 *
 * Only the shapes consumers actually read are modelled. The tasks and plan
 * extensions persist their state as custom session entries (`customType:
 * "tasks"` / `"plan"`, newest wins) — the same append-only idiom
 * `goal-state.ts` documents — so a backwards scan for the newest entry of each
 * type is the whole read.
 */

import { PLAN_ENTRY_TYPE, rehydratePlan, type PlanPhase } from "../plan/state.ts";

export interface TasksSignal {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export interface PlanSignal {
	/** Null when no plan entry exists in this session. */
	phase: PlanPhase | null;
	revision: number;
	stepCount: number;
	/** The plan header's one-sentence goal, if authored. */
	goal: string;
}

export interface SessionSignals {
	tasks: TasksSignal;
	plan: PlanSignal;
	/**
	 * The newest user prompt, as plain text. The conductor grades THIS —
	 * complexity is a property of what was most recently asked, not of the
	 * first thing the session ever saw.
	 */
	lastUserPrompt: string;
	/** How many user turns exist. Zero means nothing has been asked yet. */
	userTurns: number;
}

export const emptySignals: SessionSignals = {
	tasks: { total: 0, pending: 0, inProgress: 0, completed: 0 },
	plan: { phase: null, revision: 0, stepCount: 0, goal: "" },
	lastUserPrompt: "",
	userTurns: 0,
};

type RawEntry = {
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

/** Plain text of a message's content, whatever shape it uses. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const p = part as { type?: string; text?: unknown };
			return p?.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

/** Newest entry of a custom type, or null. Backwards scan — the log is append-only. */
function newestCustom(entries: readonly unknown[], customType: string): unknown {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as RawEntry | undefined;
		if (entry?.customType === customType) return entry.data;
	}
	return null;
}

/**
 * The task counts, read from the plan document's LANES since HIV-2904.
 *
 * There is no `tasks` entry any more — a todo IS a work item in a lane — so the
 * signal folds the plan instead. It stays a count of the agent's own work:
 * items whose kind Hive resolves are excluded by `stepCounts`, because a
 * delivery lane's five pending observations are not five things the conductor
 * should read as unfinished work.
 *
 * The fold is the full `rehydratePlan` rather than the newest snapshot, because
 * a status change now writes a tick — and the conductor reads this to decide
 * whether the work is DONE, which is precisely what a tick carries.
 */
export function tasksSignalOf(entries: readonly unknown[]): TasksSignal {
	const doc = rehydratePlan(entries);
	const list = doc
		? doc.blocks
				.filter((block) => block.type === "steps")
				.flatMap((block) => (block.type === "steps" ? block.steps : []))
				.filter((item) => item.kind === undefined || item.kind === "task")
				.map((item) => ({
					// The conductor speaks the todo vocabulary; translate on read so
					// its thresholds keep meaning what they meant.
					status:
						item.status === "done" || item.status === "skipped" || item.status === "failed"
							? "completed"
							: item.status === "in_progress"
								? "in_progress"
								: "pending",
				}))
		: [];
	const signal: TasksSignal = { total: 0, pending: 0, inProgress: 0, completed: 0 };
	for (const raw of list) {
		const status = (raw as { status?: unknown })?.status;
		if (typeof status !== "string") continue;
		signal.total++;
		if (status === "pending") signal.pending++;
		else if (status === "in_progress") signal.inProgress++;
		else if (status === "completed") signal.completed++;
	}
	return signal;
}

const VALID_PHASES: readonly PlanPhase[] = ["drafting", "ready", "approved", "abandoned"];

export function planSignalOf(entries: readonly unknown[]): PlanSignal {
	const data = newestCustom(entries, PLAN_ENTRY_TYPE) as
		| { phase?: unknown; revision?: unknown; goal?: unknown; blocks?: unknown }
		| null;
	if (!data) return { phase: null, revision: 0, stepCount: 0, goal: "" };

	let stepCount = 0;
	if (Array.isArray(data.blocks)) {
		for (const block of data.blocks) {
			const b = block as { type?: unknown; steps?: unknown };
			if (b?.type === "steps" && Array.isArray(b.steps)) stepCount += b.steps.length;
		}
	}

	return {
		phase: VALID_PHASES.includes(data.phase as PlanPhase) ? (data.phase as PlanPhase) : null,
		revision: typeof data.revision === "number" ? data.revision : 0,
		stepCount,
		goal: typeof data.goal === "string" ? data.goal : "",
	};
}

/**
 * Derive everything from the session entries in ONE pass over each array.
 *
 * `branch` carries the conversation (user/assistant turns); `entries` carries
 * the full log including custom entries. In practice the fake and pi both
 * return supersets — reading user turns from `branch` and custom state from
 * `entries` matches what each is authoritative for.
 */
export function deriveSignals(entries: readonly unknown[], branch: readonly unknown[]): SessionSignals {
	let lastUserPrompt = "";
	let userTurns = 0;
	for (const raw of branch) {
		const entry = raw as RawEntry;
		if (entry?.message?.role !== "user") continue;
		const text = contentText(entry.message.content);
		if (!text.trim()) continue;
		userTurns++;
		lastUserPrompt = text;
	}

	return {
		tasks: tasksSignalOf(entries),
		plan: planSignalOf(entries),
		lastUserPrompt,
		userTurns,
	};
}
