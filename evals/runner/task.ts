/**
 * What an eval task is, and what makes one admissible (HIV-1035).
 *
 * A task is a directory:
 *
 *   evals/tasks/<id>/task.json     the contract below
 *   evals/tasks/<id>/fixture/      copied into the container as the cwd
 *   evals/tasks/<id>/grade.sh      run after the agent settles; EXIT CODE is the verdict
 *
 * Two rules are enforced here rather than written down, because the eval method
 * says both are how eval suites rot:
 *
 * 1. **`provenance` is required.** The corpus is supposed to be harvested from
 *    real failures, and the difference between "derived from a measured failure"
 *    and "a puzzle I invented that felt hard" is invisible six weeks later. It
 *    must name where the failure was observed.
 *
 * 2. **A task is DERIVED, never replayed.** The file as it stood at the moment
 *    of a real failure is gone — transcripts record the anchor the model sent,
 *    not the tree it sent it against. So a task reproduces the SHAPE of a
 *    failure, and `provenance` says so. Calling a derived task a replay would
 *    make the corpus look stronger evidence than it is.
 *
 * Graders are code only. The method allows model graders solely where calibrated
 * against a human pass first, and none has been, so `grade.sh` is a script whose
 * exit code decides. That also keeps a trial's verdict independent of the model
 * being measured.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Split = "dev" | "test";

export interface Task {
	id: string;
	/** What the agent is asked. Verbatim; no per-run templating in v1. */
	prompt: string;
	/** dev = iterate freely. test = touched once per milestone, behind --test. */
	split: Split;
	/** Where the real failure was observed. Required — see the header. */
	provenance: string;
	/** Tools the agent gets, as pi's `--tools`. Absent = pi's default set. */
	tools?: string[];
	/** Per-trial wall clock ceiling. */
	timeoutMs: number;
	/** Directory holding this task, resolved at load. */
	dir: string;
	/** What this task is actually measuring, for the report. */
	measures: string;
}

const REQUIRED = ["id", "prompt", "split", "provenance", "measures"] as const;

export function loadTask(dir: string): Task {
	const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
	for (const key of REQUIRED) {
		if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) {
			throw new Error(`${dir}/task.json: "${key}" is required and must be a non-empty string`);
		}
	}
	if (raw.split !== "dev" && raw.split !== "test") {
		throw new Error(`${dir}/task.json: "split" must be "dev" or "test", got ${JSON.stringify(raw.split)}`);
	}
	if (!existsSync(join(dir, "grade.sh"))) {
		throw new Error(`${dir}: no grade.sh — a task without a grader always "passes", which is worse than no task`);
	}
	if (!existsSync(join(dir, "fixture"))) {
		throw new Error(`${dir}: no fixture/ directory — the agent needs a tree to work in`);
	}
	const tools = raw.tools;
	return {
		id: raw.id as string,
		prompt: raw.prompt as string,
		split: raw.split,
		provenance: raw.provenance as string,
		measures: raw.measures as string,
		tools: Array.isArray(tools) ? tools.map(String) : undefined,
		timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 300_000,
		dir,
	};
}

export function loadCorpus(tasksRoot: string): Task[] {
	if (!existsSync(tasksRoot)) return [];
	return readdirSync(tasksRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => loadTask(join(tasksRoot, entry.name)))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The tasks a run is allowed to touch.
 *
 * The held-out set is gated on an explicit flag rather than a config value,
 * because the failure mode is not malice — it is running the full corpus while
 * iterating, and quietly burning the only unbiased measurement available. The
 * method says touch it once per milestone; this makes doing so a deliberate act.
 */
export function selectTasks(corpus: readonly Task[], options: { includeTest?: boolean; only?: readonly string[] }): Task[] {
	const chosen = corpus.filter((task) => (task.split === "test" ? options.includeTest === true : true));
	if (!options.only || options.only.length === 0) return chosen;
	const wanted = new Set(options.only);
	return chosen.filter((task) => wanted.has(task.id));
}
