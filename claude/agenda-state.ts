/**
 * The agenda's per-session state, on disk.
 *
 * pi keeps these in the agenda extension's closure (and the goal in session
 * entries); the adapter's Stop hook is a fresh process per settle, so they
 * persist here. The shapes are pi's own: the goal is a `GoalItem` read back
 * through `validateGoal` — counters REHYDRATED, never zeroed, which is what
 * makes the budgets bind — and the ledger is the agenda `LedgerState`.
 */

import { join } from "node:path";
import { validateGoal, type GoalItem } from "../extensions/agenda/goal-state.ts";
import { emptyLedger, type LedgerState } from "../extensions/agenda/ledger.ts";
import { readJson, writeJsonAtomic } from "./state.ts";

export function goalPath(stateDir: string): string {
	return join(stateDir, "goal.json");
}

/** The session's goal, or null. A document that does not validate throws — it is not "no goal". */
export function readGoal(stateDir: string): GoalItem | null {
	const raw = readJson(goalPath(stateDir));
	if (raw === undefined) return null;
	const goal = validateGoal(raw);
	if (!goal) throw new Error(`${goalPath(stateDir)} is not a valid goal document`);
	return goal;
}

export function writeGoal(stateDir: string, goal: GoalItem): void {
	writeJsonAtomic(goalPath(stateDir), goal);
}

export interface AgendaState {
	/** Injection counts per item — the repo gate's and drift's caps. */
	ledger: LedgerState;
	/** Drift's cadence counter (settles since the last probe). */
	driftSettles: number;
	/** Gate-retry stamps by gate id: the tree a red gate last ran on. */
	gateStamps: Record<string, string>;
}

export function agendaPath(stateDir: string): string {
	return join(stateDir, "agenda.json");
}

export function readAgendaState(stateDir: string): AgendaState {
	const raw = readJson(agendaPath(stateDir));
	if (raw === undefined) return { ledger: emptyLedger, driftSettles: 0, gateStamps: {} };
	if (!raw || typeof raw !== "object") throw new Error(`${agendaPath(stateDir)} is not an object`);
	const doc = raw as { ledger?: { iterations?: unknown }; driftSettles?: unknown; gateStamps?: unknown };
	const iterations: Record<string, number> = {};
	const rawIterations = doc.ledger?.iterations;
	if (rawIterations && typeof rawIterations === "object") {
		for (const [id, count] of Object.entries(rawIterations as Record<string, unknown>)) {
			if (Number.isSafeInteger(count) && (count as number) >= 0) iterations[id] = count as number;
		}
	}
	const gateStamps: Record<string, string> = {};
	if (doc.gateStamps && typeof doc.gateStamps === "object") {
		for (const [id, stamp] of Object.entries(doc.gateStamps as Record<string, unknown>)) {
			if (typeof stamp === "string") gateStamps[id] = stamp;
		}
	}
	const driftSettles = Number.isSafeInteger(doc.driftSettles) && (doc.driftSettles as number) >= 0 ? (doc.driftSettles as number) : 0;
	return { ledger: { iterations }, driftSettles, gateStamps };
}

export function writeAgendaState(stateDir: string, state: AgendaState): void {
	writeJsonAtomic(agendaPath(stateDir), state);
}
