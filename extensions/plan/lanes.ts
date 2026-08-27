/**
 * Lanes — the execution half of the plan document, and the rules that keep it
 * navigable.
 *
 * WHY THIS FILE EXISTS AT ALL. Until HIV-2902 a session recorded what it was
 * doing in three places: the `tasks` extension's todo list, this document's
 * `steps` blocks, and the `workflow` extension's stages-containing-steps. They
 * were stitched together by `taskId` / `planStepId`, spoke three different
 * status vocabularies, and were stored, transported and drawn by three
 * different paths. Measured over 594 sessions before the merge: 48% ended
 * holding all three, and 65% held the SAME todos twice — 1755 duplicated items.
 *
 * The stated reason for keeping the workflow separate was that a plan is
 * revised on an intent change while a workflow ticks constantly, and sharing
 * one document would re-arm the handsfree approval timer on every checkbox.
 * That reason was already answered inside this document: `PlanDoc.revision` is
 * documented as bumped when INTENT changes and NOT when a step ticks over, and
 * `isIntentOp` in state.ts has enforced it since the beginning. The merge adds
 * the second counter that distinction always implied — `progress` — and moves
 * the workflow's two genuinely missing ideas in: a lane KIND, and a step kind
 * whose truth belongs to somebody else.
 *
 * So a LANE is a `steps` block that knows which phase of the work it holds, and
 * a WORK ITEM is what a todo, a plan step and a workflow step all were.
 *
 * WHAT IS PORTED HERE, and from where:
 *
 *   the TREE   `parentId` — decomposition. "Trace the root cause" is not one
 *              action, it is four, and discovering that mid-run is the normal
 *              case. Ported from `workflow/graph.ts` unchanged in behaviour.
 *
 *   the DAG    `dependsOn` — ordering, across lanes. Enforced, not advisory: a
 *              cycle has no topological order, so a layered layout can only
 *              respond to one by looping or by dropping an edge and drawing a
 *              lie.
 *
 *   the RANK   which lane a newly-created lane belongs before. A guideline that
 *              is never followed is not a mechanism: the workflow document
 *              documented a `before` argument for exactly this and measured
 *              ZERO uses in 213 ops, while 11 of 11 sessions that grew a
 *              research lane put it after the work it precedes. A rank fires
 *              whether or not the model remembers.
 *
 *   the KINDS  which item statuses Hive overwrites from its own rows, so the
 *              tool can refuse a status that would be thrown away rather than
 *              accepting it and silently discarding it.
 *
 * ON `parentId`, BECAUSE THE RECORD HERE WAS WRONG. `workflow/graph.ts` carried
 * a note calling nesting a feature with a depth cap, cycle refusal, cascade
 * delete and a whole nested rendering path that had "never once been used in
 * 206 ops". That measurement covered 21 sessions taken days after the feature
 * shipped. Re-measured over 30 days and 364 model-authored sessions
 * (`scripts/plan-shape.mjs`, HIV-2903): 52 sessions, 264 ops, 254 nested steps,
 * and 43 of those sessions in the last week. It is kept. A zero-adoption
 * reading taken immediately after a feature ships measures the deploy, not the
 * feature.
 *
 * Nothing here mutates. `applyOps` owns mutation; this file answers questions
 * about a document so those answers are testable without building one.
 */

import type { LaneBlock, PlanDoc, WorkItem, WorkItemStatus } from "./state.ts";

/** Root item, its children, their children. Deeper than this is a filesystem. */
export const MAX_DEPTH = 3;

/**
 * Item kinds whose truth lives in Hive, not in the agent.
 *
 * Written down on this side as well as in the browser so the TOOL can refuse a
 * status that would be thrown away on read — a tool that silently ignores half
 * its argument teaches the model nothing. The browser resolves these from its
 * own run and pull rows (`hive web/src/lib/agentWorkflowResolve.ts`), which is
 * the rule that stops an agent marking its own gate green by asserting it.
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

/** The kind of an item only the agent knows the state of. The default. */
export const TASK_KIND = "task";

export function isObservedKind(kind: string | undefined): boolean {
	return kind !== undefined && OBSERVED_KINDS.includes(kind);
}

/* -------------------------------------------------------------------------- */
/* The tree                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An item's ancestors, nearest first. Empty for a root item.
 *
 * Walks by id rather than by reference so it is safe against a document
 * mid-edit where a parent has been replaced by a copy. Bounded by MAX_DEPTH + 1
 * so a `parentId` cycle that somehow got persisted cannot hang a render — this
 * is the read path, and the read path never trusts what it is reading.
 */
export function ancestors(lane: LaneBlock, itemId: string): WorkItem[] {
	const byId = new Map(lane.steps.map((s) => [s.id, s]));
	const out: WorkItem[] = [];
	let cursor = byId.get(itemId)?.parentId;
	for (let guard = 0; cursor && guard <= MAX_DEPTH + 1; guard++) {
		const parent = byId.get(cursor);
		if (!parent || out.some((a) => a.id === parent.id)) break;
		out.push(parent);
		cursor = parent.parentId;
	}
	return out;
}

/** 1 for a root item; MAX_DEPTH is the deepest allowed. */
export function depthOf(lane: LaneBlock, itemId: string): number {
	return ancestors(lane, itemId).length + 1;
}

/** Every item under this one, at any depth. Used by cascade delete. */
export function descendants(lane: LaneBlock, itemId: string): WorkItem[] {
	const out: WorkItem[] = [];
	const frontier = [itemId];
	const seen = new Set<string>([itemId]);
	while (frontier.length > 0) {
		const current = frontier.pop() as string;
		for (const item of lane.steps) {
			if (item.parentId !== current || seen.has(item.id)) continue;
			seen.add(item.id);
			out.push(item);
			frontier.push(item.id);
		}
	}
	return out;
}

/**
 * Reading order: each root followed by its subtree, with a depth for indenting.
 *
 * Derived rather than stored, which is what keeps a patch-by-id cheap: the
 * stored array stays flat and in insertion order.
 *
 * One rule carries the weight — **an item whose `parentId` names something not
 * in this lane is a ROOT, not a dropped item.** Readers drop malformed and
 * duplicate items, so a child can outlive its parent, and a walk that only
 * descended from roots would lose it silently: present in the count, absent
 * from the diagram.
 */
export function treeOrder(lane: LaneBlock): { item: WorkItem; depth: number }[] {
	const out: { item: WorkItem; depth: number }[] = [];
	const emitted = new Set<string>();
	const ids = new Set(lane.steps.map((s) => s.id));

	const emit = (item: WorkItem, depth: number): void => {
		if (emitted.has(item.id) || depth > MAX_DEPTH) return;
		emitted.add(item.id);
		out.push({ item, depth });
		for (const child of lane.steps) {
			if (child.parentId === item.id) emit(child, depth + 1);
		}
	};

	for (const item of lane.steps) {
		const parentPresent = item.parentId !== undefined && ids.has(item.parentId);
		if (!parentPresent) emit(item, 1);
	}
	// An item orphaned by a parentId cycle would otherwise never be emitted. It
	// is still the agent's work, so it lands at the root rather than vanishing.
	for (const item of lane.steps) emit(item, 1);

	return out;
}

/** Whether making `itemId` a child of `parentId` would close a loop. */
export function parentWouldCycle(lane: LaneBlock, itemId: string, parentId: string): boolean {
	if (itemId === parentId) return true;
	return ancestors(lane, parentId).some((a) => a.id === itemId);
}

/* -------------------------------------------------------------------------- */
/* The DAG                                                                     */
/* -------------------------------------------------------------------------- */

/** Every lane in the document, in document order. */
export function lanesOf(doc: PlanDoc): LaneBlock[] {
	return doc.blocks.filter((block): block is LaneBlock => block.type === "steps");
}

/** Every work item in the document, in document order. */
export function allItems(doc: PlanDoc): WorkItem[] {
	return lanesOf(doc).flatMap((lane) => lane.steps);
}

/**
 * Whether giving `itemId` these dependencies would close a cycle.
 *
 * Cross-lane edges are legitimate, so the walk is over the whole document. An
 * edge naming an item that does not exist is NOT a cycle and not an error: a
 * plan written top-down names its later work before it creates it, and the
 * renderer drops an edge it cannot resolve rather than drawing it to nowhere.
 * Only edges between items that both exist can loop.
 */
export function dependsWouldCycle(doc: PlanDoc, itemId: string, deps: readonly string[]): boolean {
	const edges = new Map<string, readonly string[]>();
	for (const item of allItems(doc)) edges.set(item.id, item.dependsOn ?? []);
	edges.set(itemId, deps);

	const seen = new Set<string>();
	const frontier = [...deps];
	while (frontier.length > 0) {
		const current = frontier.pop() as string;
		if (current === itemId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const next = edges.get(current);
		if (next) frontier.push(...next);
	}
	return false;
}

/**
 * The items that are actually LIVE — the plural answer to "where are we".
 *
 * A session running three things at once has three positions, and reporting the
 * first of them as "the" position is how parallel work came to look like a
 * queue. An item is on the front when it is running, or when it is pending and
 * every dependency it names has finished. An unresolvable dependency does not
 * block: it is a forward reference, and blocking on one would freeze a document
 * that was merely written out of order.
 */
export function activeFront(doc: PlanDoc): WorkItem[] {
	const byId = new Map(allItems(doc).map((item) => [item.id, item]));

	const settled = (id: string): boolean => {
		const item = byId.get(id);
		if (!item) return true; // forward reference — not a blocker
		return item.status === "done" || item.status === "skipped";
	};

	const out: WorkItem[] = [];
	for (const lane of lanesOf(doc)) {
		for (const item of lane.steps) {
			if (item.status === "in_progress") {
				out.push(item);
				continue;
			}
			if (item.status !== "pending") continue;
			if ((item.dependsOn ?? []).every(settled)) out.push(item);
		}
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Lane placement                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Canonical order of the lane kinds this file has an opinion about.
 *
 * `research` earns its rank from measurement rather than taste. Across 21 live
 * sessions every one of the 11 that grew a research or triage lane put it AFTER
 * the execute lane the todo mirror had already created on turn one — 11 out of
 * 11, a document claiming the investigation happened after the work it
 * informed. The tool documented a `before` argument for exactly this and no
 * session used it once.
 *
 * Kinds absent from this list (`monitor`, `planning`, anything a model invents)
 * are placed where the model put them. Ranking what we know beats normalising a
 * model's vocabulary into a house one it did not choose.
 */
export const LANE_ORDER: readonly string[] = [
	"frame",
	"research",
	"plan",
	"execute",
	"verify",
	"deliver",
	"consolidate",
];

/** Where a lane belongs, or -1 for one this file has no opinion about. */
export function laneRank(kind: string | undefined): number {
	return kind === undefined ? -1 : LANE_ORDER.indexOf(kind);
}

/**
 * The block a newly-created lane should be inserted BEFORE, by rank.
 *
 * A lane with a known position is placed against the first lane that ranks
 * after it, and appended only when there is none. Lanes with no rank are never
 * used as an anchor — the model put them where it wanted them, and a ranked
 * lane has no opinion about where it sits relative to "Triage the flake".
 *
 * Returns the id to insert BEFORE. `applyOps` converts that to its own
 * insert-after addressing, because `after` is what the block ops already speak.
 */
export function laneAnchor(doc: PlanDoc, kind: string | undefined): string | undefined {
	const rank = laneRank(kind);
	if (rank < 0) return undefined;
	for (const lane of lanesOf(doc)) {
		const other = laneRank(lane.kind);
		if (other >= 0 && other > rank) return lane.id;
	}
	return undefined;
}

/**
 * The lane the todo façade should write into.
 *
 * This is the question that took four rounds to answer in the workflow document
 * and is the single most damaging defect the merge removes. `kind` was doing
 * two jobs — a loose label the model writes as free text, and the key this code
 * matches on — so a session that labelled its lanes Triage / Fix / Verification
 * got its todos in a FOURTH box restating the same three phases, and 13 of 15
 * measured sessions carried two "Execute" lanes.
 *
 * The order is: the lane the model says it is IN, then a lane of execute kind,
 * then the first lane that a machine did not make. A lane a machine made
 * (`origin`) is claimable — the moment the model writes to it, it is the
 * model's — which is what lets the mirror's items and the model's declared work
 * end up in one lane instead of two.
 *
 * Returns undefined when there is no lane at all; the caller creates one.
 */
export function targetLane(doc: PlanDoc): LaneBlock | undefined {
	const lanes = lanesOf(doc);
	if (lanes.length === 0) return undefined;
	const running = lanes.find((lane) => lane.steps.some((item) => item.status === "in_progress"));
	if (running) return running;
	const execute = lanes.find((lane) => lane.kind === "execute");
	if (execute) return execute;
	const claimed = lanes.find((lane) => lane.origin === undefined);
	return claimed ?? lanes[0];
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Item counts across the document.
 *
 * Items whose kind Hive resolves are EXCLUDED, for the same reason the tool
 * refuses to set their status: their status here is not a fact, so counting it
 * would report a delivery lane's five pending steps as work the agent has left
 * to do when their truth lives in a gate nobody has run yet.
 */
export function itemCounts(doc: PlanDoc): Record<WorkItemStatus, number> & { total: number } {
	const counts: Record<WorkItemStatus, number> & { total: number } = {
		pending: 0,
		in_progress: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		blocked: 0,
		total: 0,
	};
	for (const item of allItems(doc)) {
		if (isObservedKind(item.kind)) continue;
		counts[item.status]++;
		counts.total++;
	}
	return counts;
}

/**
 * The lane the session is currently in, for a one-line report.
 *
 * The first lane holding a running item, else the first unfinished one. A
 * document with no lanes has no stage, which is the truth about a session that
 * never declared one.
 */
export function currentLane(doc: PlanDoc): LaneBlock | undefined {
	const lanes = lanesOf(doc);
	const running = lanes.find((lane) => lane.steps.some((item) => item.status === "in_progress"));
	if (running) return running;
	return lanes.find((lane) =>
		lane.steps.some((item) => item.status === "pending" || item.status === "blocked"),
	);
}
