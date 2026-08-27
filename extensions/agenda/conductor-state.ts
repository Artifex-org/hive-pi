import { repoNamePattern } from "../profile-common/profile.ts";
/**
 * The conductor item and its stage machine — pure folds over an immutable
 * record, mirroring `goal-state.ts` in shape and persistence discipline.
 *
 * The conductor walks a session through the task lifecycle:
 *
 *   idle → frame → plan → execute → verify → consolidate → done
 *
 * with `plan` skipped for simple tasks, `verify` skipped when the repo
 * declares no `prCheck`, and `consolidate` (memory formation into the Hive
 * knowledge brain) skipped when Hive is unreachable. It shares the `"agenda"` entry type with goals and
 * loops — `validateGoal`/`validateLoop` both discriminate on `kind`, so a
 * conductor entry is invisible to their rehydration and vice versa.
 *
 * Counters and stage are REHYDRATED across resume, never zeroed, for the same
 * reason goals are: a stage machine that restarts at `idle` on every `/reload`
 * re-runs its one-shot injections, and "once per session" quietly becomes
 * "once per process".
 */

export type ConductorStage = "idle" | "frame" | "plan" | "execute" | "verify" | "consolidate" | "done";

export type Complexity = "unassessed" | "simple" | "complex";

export interface ConductorItem {
	schemaVersion: 1;
	kind: "conductor";
	id: string;
	stage: ConductorStage;
	complexity: Complexity;
	createdAt: number;
	updatedAt: number;
}

const VALID_STAGES: readonly ConductorStage[] = [
	"idle",
	"frame",
	"plan",
	"execute",
	"verify",
	"consolidate",
	"done",
];
const VALID_COMPLEXITY: readonly Complexity[] = ["unassessed", "simple", "complex"];

export function createConductor(id: string, now: number): ConductorItem {
	return {
		schemaVersion: 1,
		kind: "conductor",
		id,
		stage: "idle",
		complexity: "unassessed",
		createdAt: now,
		updatedAt: now,
	};
}

export function withStage(item: ConductorItem, stage: ConductorStage, now: number): ConductorItem {
	return { ...item, stage, updatedAt: now };
}

export function withComplexity(item: ConductorItem, complexity: Complexity, now: number): ConductorItem {
	return { ...item, complexity, updatedAt: now };
}

/**
 * Recover the newest conductor from persisted session entries. Same backwards
 * scan as `rehydrateGoal`; every field re-validated rather than trusted.
 */
export function rehydrateConductor(entries: readonly unknown[]): ConductorItem | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== "agenda") continue;
		const item = validateConductor(entry.data);
		if (item) return item;
	}
	return null;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function validateConductor(data: unknown): ConductorItem | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "conductor") return null;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.stage !== "string" || !VALID_STAGES.includes(record.stage as ConductorStage)) return null;

	return {
		schemaVersion: 1,
		kind: "conductor",
		id: record.id,
		stage: record.stage as ConductorStage,
		complexity: VALID_COMPLEXITY.includes(record.complexity as Complexity)
			? (record.complexity as Complexity)
			: "unassessed",
		createdAt: positiveInt(record.createdAt, 0),
		updatedAt: positiveInt(record.updatedAt, 0),
	};
}

/* ------------------------------------------------------------------------- */
/* Complexity heuristic                                                       */
/* ------------------------------------------------------------------------- */

const IMPLEMENTATION_VERBS =
	/\b(implement|refactor|migrate|build|create|add|fix|extend|integrate|rewrite|redesign|ship|wire|automate)\b/gi;

const LINEAR_KEY = /\b[A-Z]{2,5}-\d+\b/;

/** Path-like tokens: `a/b.ts`, `src/foo`, `extensions/agenda/driver.ts`. */
const PATH_TOKEN = /\b[\w.-]+\/[\w./-]+\b/g;

/**
 * This organisation's repository names, from the house profile. `null` when
 * none are configured, in which case the "names two repos" weak signal never
 * fires and the heuristic decides on its other evidence — a slightly more
 * conservative complexity call, never a wrong one.
 */
const REPO_NAMES = repoNamePattern();

/**
 * Is this prompt asking a question rather than requesting work?
 *
 * Interrogative-shaped prompts never trigger the lifecycle: the deliverable of
 * a question is an answer, and marching it through todos and plan mode is the
 * over-triggering failure the design brief names first.
 */
export function looksLikeQuestion(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.endsWith("?")) return true;
	return /^(what|why|how|where|when|which|who|is|are|does|do|can|could|should|would|explain|describe|tell me)\b/i.test(
		trimmed,
	);
}

/**
 * Assess whether a prompt describes complex work, from evidence that costs no
 * model call: the prompt text plus the todo count.
 *
 * Strong signals fire alone; weak signals need two. Thresholds are deliberately
 * conservative — a missed complex task costs one manual `/plan`, an
 * over-triggered simple one costs an unwanted read-only mode.
 */
export function assessComplexity(prompt: string, tasksTotal: number): Complexity {
	const trimmed = prompt.trim();
	if (looksLikeQuestion(trimmed)) return "simple";

	const verbs = trimmed.match(IMPLEMENTATION_VERBS) ?? [];
	const distinctVerbs = new Set(verbs.map((verb) => verb.toLowerCase())).size;

	if (trimmed.length < 80 && distinctVerbs === 0) return "simple";

	// Strong signals — any one is enough.
	if (tasksTotal >= 4) return "complex";
	if (LINEAR_KEY.test(trimmed) && distinctVerbs >= 1) return "complex";
	if (trimmed.length > 400 && distinctVerbs >= 2) return "complex";

	// Weak signals — two together.
	let weak = 0;
	const paths = trimmed.match(PATH_TOKEN) ?? [];
	if (paths.length >= 3) weak++;
	if (/\b(PR|pull request|CI|checks?)\b/i.test(trimmed)) weak++;
	if (REPO_NAMES) {
		const repos = new Set((trimmed.match(REPO_NAMES) ?? []).map((name) => name.toLowerCase()));
		if (repos.size >= 2) weak++;
	}
	if (weak >= 2) return "complex";

	return "simple";
}
