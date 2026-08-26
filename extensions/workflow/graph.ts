/**
 * The two structures a workflow is made of, and the rules that keep them sane.
 *
 * A workflow used to be two flat arrays: stages, each holding an ordered list of
 * steps. That shape can only ever say "and then", so every session came out
 * looking like the same march down the same lane regardless of what the work
 * actually was. Real work has two other shapes in it, and this file is both of
 * them:
 *
 *   the TREE   `parentId` — decomposition. "Trace the root cause" is not one
 *              action, it is four, and discovering that mid-run is the normal
 *              case rather than a planning failure. A child is a step like any
 *              other (same id space, same patch path); the only thing `parentId`
 *              adds is who it belongs under.
 *
 *   the DAG    `dependsOn` — ordering, across the tree and across stages. This
 *              used to be advisory: stored verbatim, validated by nothing,
 *              consumed by nothing. Advisory is fine for an annotation and wrong
 *              for a structure people navigate by, so it is enforced here.
 *
 * WHY DEPTH IS CAPPED. Nesting is the cheapest thing in the world for a model to
 * do too much of, and a nine-deep tree in a 22rem rail is a horizontal scrollbar
 * with a diagram somewhere behind it. Three levels is enough to say
 * "stage → step → the parts of that step" and not enough to build a filesystem.
 *
 * WHY CYCLES ARE REFUSED RATHER THAN TOLERATED. A cycle in `dependsOn` has no
 * topological order, so a layered layout either loops forever or silently drops
 * an edge and draws a lie. Refusing costs one traversal per edited step and is
 * reported to the model, which is the only way it learns the edge was wrong.
 *
 * Nothing here mutates. `applyOps` owns mutation; this file answers questions
 * about a document so those answers are testable without building one.
 */

import type { WorkflowDoc, WorkflowStage, WorkflowStep } from "./state.ts";

/** Root step, its children, their children. Deeper than this is a filesystem. */
export const MAX_DEPTH = 3;

/* -------------------------------------------------------------------------- */
/* The tree                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A step's ancestors, nearest first. Empty for a root step.
 *
 * Walks by id rather than by reference so it is safe against a document mid-edit
 * where a parent has been replaced by a copy. Bounded by MAX_DEPTH + 1 so a
 * `parentId` cycle that somehow got persisted cannot hang a render — this is the
 * read path, and the read path never trusts what it is reading.
 */
export function ancestors(stage: WorkflowStage, stepId: string): WorkflowStep[] {
	const byId = new Map(stage.steps.map((s) => [s.id, s]));
	const out: WorkflowStep[] = [];
	let cursor = byId.get(stepId)?.parentId;
	for (let guard = 0; cursor && guard <= MAX_DEPTH + 1; guard++) {
		const parent = byId.get(cursor);
		if (!parent || out.some((a) => a.id === parent.id)) break;
		out.push(parent);
		cursor = parent.parentId;
	}
	return out;
}

/** 1 for a root step. Used to enforce MAX_DEPTH before a parent is accepted. */
export function depthOf(stage: WorkflowStage, stepId: string): number {
	return ancestors(stage, stepId).length + 1;
}

/**
 * Every step beneath this one, at any depth.
 *
 * `removeStep` needs it: deleting a parent and leaving its children behind would
 * orphan them into invisible steps — present in the tally, absent from the
 * diagram, because a renderer walking roots-then-children never reaches a child
 * whose parent is gone.
 */
export function descendants(stage: WorkflowStage, stepId: string): WorkflowStep[] {
	const out: WorkflowStep[] = [];
	const frontier = [stepId];
	const seen = new Set<string>([stepId]);
	while (frontier.length > 0) {
		const current = frontier.pop() as string;
		for (const step of stage.steps) {
			if (step.parentId !== current || seen.has(step.id)) continue;
			seen.add(step.id);
			out.push(step);
			frontier.push(step.id);
		}
	}
	return out;
}

/**
 * The steps of a stage in READING order: each root followed by its subtree.
 *
 * The stored array stays in insertion order — that is what keeps a patch by id
 * cheap and a `before` insert meaningful — so tree order is derived rather than
 * maintained. Any step whose `parentId` names something that is not in this
 * stage is treated as a root: a dangling parent must not make a step disappear.
 */
export function treeOrder(stage: WorkflowStage): { step: WorkflowStep; depth: number }[] {
	const ids = new Set(stage.steps.map((s) => s.id));
	const out: { step: WorkflowStep; depth: number }[] = [];
	const emitted = new Set<string>();

	const emit = (step: WorkflowStep, depth: number) => {
		if (emitted.has(step.id)) return;
		emitted.add(step.id);
		out.push({ step, depth });
		if (depth >= MAX_DEPTH) return;
		for (const child of stage.steps) {
			if (child.parentId === step.id) emit(child, depth + 1);
		}
	};

	for (const step of stage.steps) {
		if (!step.parentId || !ids.has(step.parentId)) emit(step, 1);
	}
	// A step orphaned by a parentId cycle would otherwise never be emitted. It is
	// still the agent's work, so it lands at the root rather than vanishing.
	for (const step of stage.steps) emit(step, 1);

	return out;
}

/** Whether making `stepId` a child of `parentId` would close a loop. */
export function parentWouldCycle(stage: WorkflowStage, stepId: string, parentId: string): boolean {
	if (stepId === parentId) return true;
	return ancestors(stage, parentId).some((a) => a.id === stepId);
}

/* -------------------------------------------------------------------------- */
/* The DAG                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether giving `stepId` these dependencies would close a cycle.
 *
 * Cross-stage edges are legitimate, so the walk is over the whole document. An
 * edge naming a step that does not exist is NOT a cycle and not an error: a
 * workflow written top-down names its later steps before it creates them, and
 * the renderer drops an edge it cannot resolve rather than drawing it to
 * nowhere. Only edges between steps that both exist can loop.
 */
export function dependsWouldCycle(doc: WorkflowDoc, stepId: string, deps: readonly string[]): boolean {
	const edges = new Map<string, readonly string[]>();
	for (const stage of doc.stages) {
		for (const step of stage.steps) edges.set(step.id, step.dependsOn ?? []);
	}
	edges.set(stepId, deps);

	// Depth-first from each dependency, looking for a way back to the step.
	const seen = new Set<string>();
	const frontier = [...deps];
	while (frontier.length > 0) {
		const current = frontier.pop() as string;
		if (current === stepId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const next = edges.get(current);
		if (next) frontier.push(...next);
	}
	return false;
}

/**
 * The steps that are actually LIVE, which is the plural answer to "where are we".
 *
 * `currentStage` answers it with one stage, and that is the right answer for a
 * roster line. It is the wrong answer for a diagram: a session running three
 * things at once has three positions, and reporting the first of them as "the"
 * position is how a parallel workflow came to look like a queue.
 *
 * A step is on the front when it is running, or when it is pending and every
 * dependency it names has finished. An unresolvable dependency does not block —
 * it is a forward reference, and blocking on one would freeze a document that
 * was merely written out of order.
 */
export function activeFront(doc: WorkflowDoc): WorkflowStep[] {
	const byId = new Map<string, WorkflowStep>();
	for (const stage of doc.stages) {
		for (const step of stage.steps) byId.set(step.id, step);
	}

	const settled = (id: string): boolean => {
		const step = byId.get(id);
		if (!step) return true; // forward reference — not a blocker
		return step.status === "done" || step.status === "skipped";
	};

	const out: WorkflowStep[] = [];
	for (const stage of doc.stages) {
		if (stage.status === "done" || stage.status === "skipped") continue;
		for (const step of stage.steps) {
			if (step.status === "running") {
				out.push(step);
				continue;
			}
			if (step.status !== "pending") continue;
			if ((step.dependsOn ?? []).every(settled)) out.push(step);
		}
	}
	return out;
}
