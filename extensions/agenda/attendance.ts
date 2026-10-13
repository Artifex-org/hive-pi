/**
 * Operator attendance — what the agenda does when a PERSON speaks to a
 * Hive-launched session (hive-common/channels.ts OPERATOR_INPUT_CHANNEL).
 *
 * Two consequences, both pure folds here so they are testable without a
 * session:
 *
 *   1. The session is ATTENDED from then on, and an attended session never
 *      closes itself at completion (auto-shutdown.ts says why). Persisted as
 *      its own entry so a `/reload` or resume cannot silently re-arm closure
 *      under the person who is steering it.
 *   2. A FINISHED lifecycle reopens for the new instruction. Measured on
 *      f2ead622 (2026-10-13): the operator asked for "a proper multi hour deep
 *      research run" while the conductor sat in `consolidate`; the stage was
 *      never revisited, so an hour later the session consolidated the OLD task,
 *      reported `completed` and closed. A new instruction is new work: the
 *      conductor goes back to `idle`, where it re-assesses the new prompt like
 *      any other, and the achieved goal is retired so the session stops
 *      reporting the previous task's completion as its state.
 */

import { type ConductorItem, withStage } from "./conductor-state.ts";
import { type GoalItem, withState } from "./goal-state.ts";

export const ATTENDED_ENTRY_TYPE = "agenda-attended";

export interface AttendedEntry {
	kind: "agenda-attended";
	at: number;
	source: string;
}

/** True when any persisted entry records a person steering this session. */
export function rehydrateAttended(entries: readonly unknown[]): boolean {
	return entries.some((raw) => {
		const entry = raw as { customType?: string; data?: { kind?: unknown } } | undefined;
		return entry?.customType === ATTENDED_ENTRY_TYPE && entry.data?.kind === "agenda-attended";
	});
}

/**
 * Stages that mean "the previous task is finished". `verify` counts only with
 * an achieved goal: advice can enter verify while a goal is still active, and
 * a steer during that delivery is part of the same task, not a new one.
 */
const FINISHED_STAGES: readonly ConductorItem["stage"][] = ["consolidate", "done"];

export interface Reopened {
	conductor?: ConductorItem;
	goal?: GoalItem;
}

/**
 * The reopen fold. Returns only what changes; `{}` when the lifecycle is not
 * finished and the instruction is simply part of the work in progress.
 *
 * `idle` rather than `execute`: execute completes on the goal verdict or a
 * closed todo list, and both still describe the OLD task — reopened into
 * execute, the next settle would walk it straight back through verify to
 * done. From idle the conductor reads the new prompt; a bare "continue" is
 * simple and stays out of the lifecycle, a real task re-enters it.
 */
export function reopenForInstruction(
	conductor: ConductorItem | null,
	goal: GoalItem | null,
	now: number,
): Reopened {
	const goalAchieved = goal?.state === "achieved";
	const stageFinished = conductor !== null && FINISHED_STAGES.includes(conductor.stage);
	const verifiedDone = conductor?.stage === "verify" && goalAchieved;
	if (!stageFinished && !verifiedDone && !goalAchieved) return {};
	const out: Reopened = {};
	if (conductor && (stageFinished || verifiedDone)) out.conductor = withStage(conductor, "idle", now);
	if (goal && goalAchieved) out.goal = withState(goal, "cleared", now);
	return out;
}
