/**
 * The workflow-document fold.
 *
 * The assertions that matter are the ones a careless implementation gets wrong
 * SILENTLY, and every one of them is a way the workflow could start lying:
 *
 *   - a model setting a delivery step's status and the tool taking it, so the
 *     document disagrees with the browser about whether CI is green
 *   - a no-op batch bumping the revision, which is a PUT to Hive per conductor
 *     beat forever
 *   - a re-stated stage resetting finished steps
 *   - a removed stage's id being handed out again, re-pointing stored edges
 *   - a removed PARENT leaving its children behind: counted by `stepCounts`,
 *     unreachable to every renderer, so the workflow never reads as finished
 *   - a `dependsOn` cycle, which has no topological order and makes a layered
 *     layout either loop or quietly drop an edge and draw a lie
 *   - a rehydrated document restarting the lifecycle at `frame`
 */

import { describe, expect, it } from "vitest";
import {
	applyOps,
	currentStage,
	emptyWorkflow,
	isEmpty,
	MAX_LOOP_ITERATION,
	MAX_LOOP_UNTIL_LENGTH,
	MAX_STAGES,
	validateSnapshot,
	rehydrateWorkflow,
	stepCounts,
	toEntry,
	WORKFLOW_ENTRY_TYPE,
	type WorkflowDoc,
	type WorkflowOp,
} from "../extensions/workflow/state.ts";
import { MAX_DEPTH, treeOrder } from "../extensions/workflow/graph.ts";
import { workflowToMarkdown } from "../extensions/workflow/render.ts";
import {
	DELIVERY_STEPS,
	LANE_TEMPLATES,
	templateLaneOps,
	opsForStage,
	opsForWalkComplete,
	opsForTasks,
} from "../extensions/workflow/template.ts";

const NOW = 1_700_000_000_000;

function apply(doc: WorkflowDoc, ...ops: WorkflowOp[]) {
	return applyOps(doc, ops, NOW);
}

/**
 * A document with the delivery lane on it, built the way one now is.
 *
 * Three applies, each boundary a fact that does not exist yet: the stage is
 * ONE apply, as `index.ts` does it. It used to take three — create the stage,
 * name it from the steps, chain them once their generated ids existed — and all
 * three boundaries were the same missing feature: a caller could not choose an
 * id. It can now, so the lane is one batch of forward references.
 */
function withDelivery(doc: WorkflowDoc = emptyWorkflow(NOW)): WorkflowDoc {
	return applyOps(doc, templateLaneOps(doc, "delivery"), NOW).doc;
}

/** A document walked through the lifecycle, which is what creates its stages. */
function walkedThrough(...stages: string[]): WorkflowDoc {
	let doc = emptyWorkflow(NOW);
	for (const stage of stages) doc = applyOps(doc, opsForStage(doc, stage, NOW), NOW).doc;
	return doc;
}

/** A stage with three steps, for the tree and ordering cases. */
function threeSteps() {
	let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Execute", kind: "execute" }).doc;
	const stageId = doc.stages[0].id;
	for (const title of ["one", "two", "three"]) {
		doc = apply(doc, { op: "step", stageId, title }).doc;
	}
	return { doc, stageId };
}

describe("applyOps", () => {
	it("appends a stage and gives it a fresh id", () => {
		const { doc, changed } = apply(emptyWorkflow(NOW), { op: "stage", title: "Discover" });
		expect(changed).toBe(true);
		expect(doc.stages).toHaveLength(1);
		expect(doc.stages[0].title).toBe("Discover");
		expect(doc.revision).toBe(1);
	});

	it("does NOT bump the revision for a batch that changed nothing", () => {
		// Every revision is a PUT to Hive, and the conductor and the task mirror
		// both fire on beats that are usually no-ops.
		const one = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		// A stage op naming an unknown id CREATES now, so the no-op has to be an
		// op with nothing to fall back to.
		const again = apply(one, { op: "removeStage", id: "nope" });
		expect(again.changed).toBe(false);
		expect(again.doc.revision).toBe(one.revision);
		expect(again.notes).toContain('no stage "nope"');
	});

	it("patches a stage in place when its id is re-stated", () => {
		const one = apply(emptyWorkflow(NOW), { op: "stage", title: "Execute", kind: "execute" }).doc;
		const id = one.stages[0].id;
		const two = apply(one, { op: "stage", id, status: "running" }).doc;
		expect(two.stages).toHaveLength(1);
		expect(two.stages[0].status).toBe("running");
		expect(two.stages[0].startedAt).toBe(NOW);
	});

	it("keeps a stage's steps when the stage is patched", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Execute" }).doc;
		const stageId = doc.stages[0].id;
		doc = apply(doc, { op: "step", stageId, title: "write it", status: "done" }).doc;
		doc = apply(doc, { op: "stage", id: stageId, title: "Execute (renamed)" }).doc;
		expect(doc.stages[0].steps).toHaveLength(1);
		expect(doc.stages[0].steps[0].status).toBe("done");
	});

	// The load-bearing rule. Hive resolves an observed step from its own rows and
	// throws this value away, so accepting it here would produce a document that
	// disagrees with the browser — and the model would never learn why.
	it("REFUSES a status on a step whose kind Hive observes, and says so", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Deliver" }).doc;
		const stageId = doc.stages[0].id;
		const result = apply(doc, { op: "step", stageId, title: "CI green", kind: "ci.green", status: "done" });
		doc = result.doc;
		expect(doc.stages[0].steps[0].status).toBe("pending");
		expect(result.notes.some((n) => /status ignored/.test(n))).toBe(true);
	});

	it("accepts a status on a task step — nothing else knows it", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Execute" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "write it", status: "running" }).doc;
		expect(doc.stages[0].steps[0].status).toBe("running");
		expect(doc.stages[0].steps[0].startedAt).toBe(NOW);
	});

	it("reports a refused step rather than dropping it silently", () => {
		const result = apply(emptyWorkflow(NOW), { op: "step", title: "orphan" });
		expect(result.changed).toBe(false);
		expect(result.notes).toContain("no stage to add a step to");
	});

	it("caps the stage count and says so", () => {
		let doc = emptyWorkflow(NOW);
		for (let i = 0; i < MAX_STAGES; i++) doc = apply(doc, { op: "stage", title: `S${i}` }).doc;
		const result = apply(doc, { op: "stage", title: "one too many" });
		expect(result.doc.stages).toHaveLength(MAX_STAGES);
		expect(result.notes.some((n) => /limit reached/.test(n))).toBe(true);
	});

	it("never reuses a removed stage's id", () => {
		// A reused id silently re-points every dependsOn edge that still names it.
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		const first = doc.stages[0].id;
		doc = apply(doc, { op: "removeStage", id: first }).doc;
		doc = apply(doc, { op: "stage", title: "B" }).doc;
		expect(doc.stages[0].id).not.toBe(first);
	});
});

/**
 * Placement. The bug that motivated it, measured on a live session: the agent
 * discovered a triage phase after the delivery lane already existed, and got
 * `… deliver · consolidate · triage` — a diagram claiming triage happens after
 * the merge, because a create op could only ever append.
 */
describe("position", () => {
	it("inserts a stage BEFORE another when asked", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Fix", kind: "fix" }).doc;
		const fix = doc.stages[0].id;
		doc = apply(doc, { op: "stage", title: "Triage", kind: "triage", before: fix }).doc;
		expect(doc.stages.map((s) => s.title)).toEqual(["Triage", "Fix"]);
	});

	it("appends when `before` names a stage that is not there", () => {
		// A position hint is worth less than the stage; losing the stage would be
		// the larger failure.
		const doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A", before: "s99" }).doc;
		expect(doc.stages).toHaveLength(1);
	});

	it("moves a stage that is already in the wrong place", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Deliver", kind: "deliver" }).doc;
		doc = apply(doc, { op: "stage", title: "Triage", kind: "triage" }).doc;
		const [deliver, triage] = doc.stages.map((s) => s.id);
		doc = apply(doc, { op: "moveStage", id: triage, before: deliver }).doc;
		expect(doc.stages.map((s) => s.title)).toEqual(["Triage", "Deliver"]);
	});

	it("moves a stage to the end when `before` is omitted", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "stage", title: "B" }).doc;
		const first = doc.stages[0].id;
		doc = apply(doc, { op: "moveStage", id: first }).doc;
		expect(doc.stages.map((s) => s.title)).toEqual(["B", "A"]);
	});

	it("inserts a step before a sibling", () => {
		const { doc, stageId } = threeSteps();
		const second = doc.stages[0].steps[1].id;
		const next = apply(doc, { op: "step", stageId, title: "inserted", before: second }).doc;
		expect(next.stages[0].steps.map((s) => s.title)).toEqual(["one", "inserted", "two", "three"]);
	});
});

/**
 * The tree. Decomposition, which is the shape work actually has: "trace the root
 * cause" turns out to be four things, and discovering that mid-run is the normal
 * case rather than a planning failure.
 */
describe("sub-steps", () => {
	it("nests a step under another and reads it back in tree order", () => {
		const { doc } = threeSteps();
		const parent = doc.stages[0].steps[0].id;
		const next = apply(doc, { op: "step", parentId: parent, title: "part one" }).doc;

		const child = next.stages[0].steps.find((s) => s.title === "part one")!;
		expect(child.parentId).toBe(parent);
		// Stored flat, read as a tree — the child sits directly under its parent
		// rather than at the end where it was appended.
		expect(treeOrder(next.stages[0]).map((e) => [e.step.title, e.depth])).toEqual([
			["one", 1],
			["part one", 2],
			["two", 1],
			["three", 1],
		]);
	});

	it("puts a sub-step in its PARENT's stage, not the one named", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "stage", title: "B" }).doc;
		const [a, b] = doc.stages.map((s) => s.id);
		doc = apply(doc, { op: "step", stageId: a, title: "root" }).doc;
		const parent = doc.stages[0].steps[0].id;

		doc = apply(doc, { op: "step", stageId: b, parentId: parent, title: "child" }).doc;
		expect(doc.stages[0].steps).toHaveLength(2);
		expect(doc.stages[1].steps).toHaveLength(0);
	});

	it(`refuses to nest deeper than ${MAX_DEPTH} levels`, () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "d1" }).doc;
		let parent = doc.stages[0].steps[0].id;
		for (let depth = 2; depth <= MAX_DEPTH; depth++) {
			doc = apply(doc, { op: "step", parentId: parent, title: `d${depth}` }).doc;
			parent = doc.stages[0].steps[doc.stages[0].steps.length - 1].id;
		}
		const result = apply(doc, { op: "step", parentId: parent, title: "too deep" });
		expect(result.doc.stages[0].steps).toHaveLength(MAX_DEPTH);
		expect(result.notes.some((n) => /nesting limit/.test(n))).toBe(true);
	});

	// Unreachable to every renderer (they walk roots, then children) but still
	// counted by `stepCounts` — a step that exists in the tally and nowhere on
	// screen, which reads as a workflow that will not finish.
	it("CASCADES a delete through the subtree", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "parent" }).doc;
		const parent = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", parentId: parent, title: "child" }).doc;
		const child = doc.stages[0].steps[1].id;
		doc = apply(doc, { op: "step", parentId: child, title: "grandchild" }).doc;
		expect(doc.stages[0].steps).toHaveLength(3);

		const result = apply(doc, { op: "removeStep", id: parent });
		expect(result.doc.stages[0].steps).toHaveLength(0);
		expect(result.notes.some((n) => /sub-step/.test(n))).toBe(true);
	});

	it("carries the subtree when a step MOVES stage", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "stage", title: "B" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "parent" }).doc;
		const parent = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", parentId: parent, title: "child" }).doc;

		doc = apply(doc, { op: "moveStep", id: parent, stageId: doc.stages[1].id, parentId: null }).doc;
		expect(doc.stages[0].steps).toHaveLength(0);
		expect(doc.stages[1].steps.map((s) => s.title)).toEqual(["parent", "child"]);
	});

	it("refuses to nest a step under its own descendant", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "parent" }).doc;
		const parent = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", parentId: parent, title: "child" }).doc;
		const child = doc.stages[0].steps[1].id;

		const result = apply(doc, { op: "moveStep", id: parent, parentId: child });
		expect(result.notes.some((n) => /own descendant/.test(n))).toBe(true);
		expect(result.doc.stages[0].steps.find((s) => s.id === parent)?.parentId).toBeUndefined();
	});

	it("promotes a sub-step back to the top with parentId: null", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "parent" }).doc;
		const parent = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", parentId: parent, title: "child" }).doc;
		const child = doc.stages[0].steps[1].id;

		doc = apply(doc, { op: "moveStep", id: child, parentId: null }).doc;
		expect(doc.stages[0].steps.find((s) => s.id === child)?.parentId).toBeUndefined();
	});

	it("sends a reparent through `step` to moveStep rather than doing it halfway", () => {
		// Honouring it here would move the step WITHOUT its children.
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "a" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "b" }).doc;
		const [a, b] = doc.stages[0].steps.map((s) => s.id);

		const result = apply(doc, { op: "step", id: b, parentId: a });
		expect(result.notes.some((n) => /use moveStep/.test(n))).toBe(true);
		expect(result.doc.stages[0].steps.find((s) => s.id === b)?.parentId).toBeUndefined();
	});
});

/**
 * The DAG. `dependsOn` used to be stored verbatim, validated by nothing and
 * consumed by nothing; a structure people navigate by has to be enforced.
 */
describe("dependencies", () => {
	it("keeps an edge naming a step that does not exist yet", () => {
		// A workflow written top-down names its later steps before creating them,
		// and the renderer drops what it cannot resolve.
		const { doc, stageId } = threeSteps();
		const next = apply(doc, { op: "step", stageId, title: "later", dependsOn: ["s99.9"] }).doc;
		expect(next.stages[0].steps[3].dependsOn).toEqual(["s99.9"]);
	});

	it("REFUSES a self-edge", () => {
		const { doc } = threeSteps();
		const first = doc.stages[0].steps[0].id;
		const result = apply(doc, { op: "step", id: first, dependsOn: [first] });
		expect(result.doc.stages[0].steps[0].dependsOn).toBeUndefined();
		expect(result.notes.some((n) => /cycle/.test(n))).toBe(true);
	});

	it("REFUSES a longer cycle", () => {
		// No topological order exists, so a layered layout can only respond by
		// looping or by quietly dropping an edge and drawing a lie.
		const { doc } = threeSteps();
		const [a, b, c] = doc.stages[0].steps.map((s) => s.id);
		let next = apply(doc, { op: "step", id: b, dependsOn: [a] }).doc;
		next = apply(next, { op: "step", id: c, dependsOn: [b] }).doc;

		const result = apply(next, { op: "step", id: a, dependsOn: [c] });
		expect(result.doc.stages[0].steps[0].dependsOn).toBeUndefined();
		expect(result.notes.some((n) => /cycle/.test(n))).toBe(true);
	});

	it("keeps the edges that are fine when one in the batch is not", () => {
		const { doc } = threeSteps();
		const [a, b, c] = doc.stages[0].steps.map((s) => s.id);
		const result = apply(doc, { op: "step", id: c, dependsOn: [a, c, b] });
		expect(result.doc.stages[0].steps[2].dependsOn).toEqual([a, b]);
	});

	it("allows an edge ACROSS stages", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "stage", title: "B" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "first" }).doc;
		const first = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", stageId: doc.stages[1].id, title: "second", dependsOn: [first] }).doc;
		expect(doc.stages[1].steps[0].dependsOn).toEqual([first]);
	});
});

describe("stepCounts", () => {
	it("counts only the steps whose status is actually read", () => {
		// Including Hive-resolved steps would produce a tally the browser
		// disagrees with, and the browser's reading is the true one.
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Deliver" }).doc;
		const stageId = doc.stages[0].id;
		doc = apply(doc, { op: "step", stageId, title: "mine", status: "done" }).doc;
		doc = apply(doc, { op: "step", stageId, title: "CI", kind: "ci.green" }).doc;
		const counts = stepCounts(doc);
		expect(counts.total).toBe(1);
		expect(counts.done).toBe(1);
	});
});

describe("persistence", () => {
	it("round-trips through an entry", () => {
		const doc = withDelivery(apply(emptyWorkflow(NOW), { op: "meta", title: "Ship it" }).doc);
		const entry = { customType: WORKFLOW_ENTRY_TYPE, data: toEntry(doc) };
		const back = rehydrateWorkflow([entry]);
		expect(back?.title).toBe("Ship it");
		expect(back?.stages.map((s) => s.kind)).toEqual(doc.stages.map((s) => s.kind));
	});

	it("round-trips a step's parentId", () => {
		// A nested step that rehydrates flat is a tree that silently collapses on
		// every `/reload`.
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "A" }).doc;
		doc = apply(doc, { op: "step", stageId: doc.stages[0].id, title: "parent" }).doc;
		const parent = doc.stages[0].steps[0].id;
		doc = apply(doc, { op: "step", parentId: parent, title: "child" }).doc;

		const back = rehydrateWorkflow([{ customType: WORKFLOW_ENTRY_TYPE, data: toEntry(doc) }]);
		expect(back?.stages[0].steps[1].parentId).toBe(parent);
	});

	it("rehydrates the NEWEST snapshot", () => {
		const first = withDelivery(apply(emptyWorkflow(NOW), { op: "meta", title: "old" }).doc);
		const second = apply(first, { op: "meta", title: "new" }).doc;
		const back = rehydrateWorkflow([
			{ customType: WORKFLOW_ENTRY_TYPE, data: toEntry(first) },
			{ customType: WORKFLOW_ENTRY_TYPE, data: toEntry(second) },
		]);
		expect(back?.title).toBe("new");
	});

	it("declines a snapshot from a schema version it cannot understand", () => {
		const doc = withDelivery();
		const entry = { customType: WORKFLOW_ENTRY_TYPE, data: { ...toEntry(doc), schemaVersion: 99 } };
		expect(rehydrateWorkflow([entry])).toBeNull();
	});

	it("repairs a nextId that fell behind the live maximum", () => {
		// A stale nextId hands the next stage an id that already exists.
		const doc = withDelivery();
		const entry = { customType: WORKFLOW_ENTRY_TYPE, data: { ...toEntry({ ...doc, nextId: 1 }) } };
		const back = rehydrateWorkflow([entry]);
		const ids = new Set(back?.stages.map((s) => s.id));
		const grown = apply(back as WorkflowDoc, { op: "stage", title: "new" }).doc;
		expect(ids.has(grown.stages[grown.stages.length - 1].id)).toBe(false);
	});

	it("is empty when nothing has been written", () => {
		expect(isEmpty(emptyWorkflow(NOW))).toBe(true);
		expect(rehydrateWorkflow([])).toBeNull();
	});
});

describe("stage loops", () => {
	it("declares by kind in stage body order, replaces, and ticks without reopening steps", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", id: "orchestrate", kind: "orchestrate", title: "Orchestrate" }).doc;
		for (const id of ["launch", "watch", "collect"]) {
			doc = apply(doc, { op: "step", stageId: "orchestrate", id, title: id, status: id === "watch" ? "running" : "done" }).doc;
		}
		doc = apply(doc, {
			op: "loop",
			stage: "orchestrate",
			steps: ["collect", "unknown", "launch", "watch"],
			until: "results collected",
		}).doc;
		expect(doc.stages[0].loop).toEqual({
			steps: ["launch", "watch", "collect"],
			until: "results collected",
			iteration: 1,
			active: true,
		});
		doc = apply(doc, { op: "loop", stage: "orchestrate", steps: ["watch"], active: false }).doc;
		expect(doc.stages[0].loop).toMatchObject({ steps: ["watch"], iteration: 1, active: false });
		doc = apply(doc, { op: "loop_tick", stage: "orchestrate" }).doc;
		expect(doc.stages[0].loop?.iteration).toBe(2);
		doc.stages[0].loop!.iteration = MAX_LOOP_ITERATION;
		const capped = apply(doc, { op: "loop_tick", stage: "orchestrate" });
		expect(capped.changed).toBe(false);
		expect(capped.notes).toContain("orchestrate: loop iteration limit reached");
		expect(doc.stages[0].steps.find((step) => step.id === "watch")?.status).toBe("running");
	});

	it("bounds persisted loops and drops unknown body ids", () => {
		const doc = apply(emptyWorkflow(NOW),
			{ op: "stage", id: "lane", title: "Lane" },
			{ op: "step", stageId: "lane", id: "one", title: "One" },
		).doc;
		const restored = validateSnapshot({
			kind: WORKFLOW_ENTRY_TYPE,
			schemaVersion: 1,
			doc: {
				...doc,
				stages: [{ ...doc.stages[0], loop: { steps: ["missing", "one"], until: ` x\n${"x".repeat(MAX_LOOP_UNTIL_LENGTH + 1)}`, iteration: 0 } }],
			},
		});
		expect(restored?.stages[0].loop).toMatchObject({ steps: ["one"], iteration: 1, active: true });
		expect(restored?.stages[0].loop?.until).toHaveLength(MAX_LOOP_UNTIL_LENGTH);
		expect(restored?.stages[0].loop?.until).not.toContain("\n");
		const empty = validateSnapshot({
			kind: WORKFLOW_ENTRY_TYPE,
			schemaVersion: 1,
			doc: { ...doc, stages: [{ ...doc.stages[0], loop: { steps: ["missing"] } }] },
		});
		expect(empty?.stages[0].loop).toEqual({ steps: [], iteration: 1, active: true });
		const malformed = validateSnapshot({
			kind: WORKFLOW_ENTRY_TYPE,
			schemaVersion: 1,
			doc: { ...doc, stages: [{ ...doc.stages[0], loop: { steps: "bad" } as unknown as typeof doc.stages[number]["loop"] }] },
		});
		expect(malformed?.stages[0].loop).toBeUndefined();
	});

	it("renders the wave badge without introducing dependency edges", () => {
		const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "orchestration"), NOW).doc;
		const stage = doc.stages[0];
		const markdown = workflowToMarkdown(doc);
		expect(markdown).toContain("↻ wave 1 — until: coverage is complete and every live worker is collected or intentionally stopped");
		expect(markdown).not.toContain("teammate");
		expect(stage.steps.map((step) => [step.id, step.dependsOn ?? []])).toEqual([
			["orchestration.split", []],
			["orchestration.launch", ["orchestration.split"]],
			["orchestration.supervise", ["orchestration.launch"]],
			["orchestration.resize", ["orchestration.launch"]],
			["orchestration.collect", ["orchestration.launch"]],
			["orchestration.reconcile", ["orchestration.collect"]],
			["orchestration.synthesise", ["orchestration.reconcile"]],
		]);
	});
});

describe("the delivery lane", () => {
	it("lays the standard steps, chained", () => {
		const doc = withDelivery();
		const deliver = doc.stages.find((s) => s.kind === "deliver")!;
		expect(deliver.steps.map((s) => s.kind)).toEqual(DELIVERY_STEPS.map((s) => s.kind));
		// Chained, which is what makes the lane read as a lane rather than five
		// parallel boxes.
		expect(deliver.steps[0].dependsOn).toBeUndefined();
		expect(deliver.steps[1].dependsOn).toEqual([deliver.steps[0].id]);
		expect(deliver.steps[4].dependsOn).toEqual([deliver.steps[3].id]);
	});

	it("lays every step pending — the document claims existence, not progress", () => {
		const deliver = withDelivery().stages.find((s) => s.kind === "deliver")!;
		expect(deliver.steps.every((s) => s.status === "pending")).toBe(true);
	});

	it("is absent from a document nobody asked for one on", () => {
		// The point of dropping the seed: a research or orchestration session has
		// no branch, and a permanently-pending lane on one reads as unfinished work
		// forever.
		const doc = walkedThrough("frame", "execute");
		expect(doc.stages.some((s) => s.kind === "deliver")).toBe(false);
	});

	it("asking for a lane it already has is a no-op, not a second lane", () => {
		const doc = withDelivery();
		expect(templateLaneOps(doc, "delivery")).toEqual([]);
	});
});

describe("opsForStage", () => {
	it("CREATES the stage the conductor entered, rather than needing it seeded", () => {
		const doc = walkedThrough("execute");
		expect(doc.stages.map((s) => s.kind)).toEqual(["execute"]);
		expect(doc.stages[0].status).toBe("running");
	});

	it("marks passed stages done and the current one running", () => {
		const doc = walkedThrough("frame", "plan", "execute");
		const byKind = new Map(doc.stages.map((s) => [s.kind, s.status]));
		expect(byKind.get("frame")).toBe("done");
		expect(byKind.get("plan")).toBe("done");
		expect(byKind.get("execute")).toBe("running");
	});

	it("places a late lifecycle stage in its RIGHT position, not at the end", () => {
		// Append-only placement is what put `triage` after `merged` in a live
		// document. A lifecycle stage has a known position relative to its
		// siblings, so it goes there.
		let doc = walkedThrough("execute");
		doc = withDelivery(doc);
		doc = applyOps(doc, opsForStage(doc, "verify", NOW), NOW).doc;
		const kinds = doc.stages.map((s) => s.kind);
		expect(kinds.indexOf("verify")).toBeLessThan(kinds.indexOf("deliver"));
	});

	it("leaves the DELIVERY lane alone — it is not part of the conductor's walk", () => {
		// Its steps are resolved from Hive; sweeping the stage to `done` because
		// the conductor moved past `verify` would be the document claiming a merge
		// nobody observed.
		let doc = withDelivery(walkedThrough("frame", "plan", "execute", "verify"));
		doc = applyOps(doc, opsForStage(doc, "consolidate", NOW), NOW).doc;
		expect(doc.stages.find((s) => s.kind === "deliver")?.status).toBe("pending");
	});

	it("leaves an AGENT-AUTHORED stage alone", () => {
		// Position in the array is not evidence about work the conductor knows
		// nothing about, so sweeping one to `done` would mark work complete that
		// nobody did.
		let doc = apply(emptyWorkflow(NOW), { op: "stage", kind: "research", title: "Investigate" }).doc;
		doc = applyOps(doc, opsForStage(doc, "execute", NOW), NOW).doc;
		expect(doc.stages.find((s) => s.kind === "research")?.status).toBe("pending");
	});

	it("returns NO ops when the document already shows that stage", () => {
		const at = walkedThrough("frame", "execute");
		expect(opsForStage(at, "execute", NOW)).toEqual([]);
	});

	it("returns no ops for a stage the conductor does not own", () => {
		const doc = walkedThrough("execute");
		expect(opsForStage(doc, "nonexistent", NOW)).toEqual([]);
	});
});

describe("opsForWalkComplete", () => {
	// The bug this closes, measured before the fix:
	//   frame=done plan=done execute=done verify=done deliver=pending consolidate=RUNNING
	// and it never moved again, because `done` is a conductor state with no stage
	// of its own. The diagram showed a finished session spinning on Consolidate.
	function walked() {
		return withDelivery(walkedThrough("frame", "plan", "execute", "verify", "consolidate"));
	}

	it("leaves NO stage running once the walk is finished", () => {
		const before = walked();
		expect(before.stages.find((s) => s.kind === "consolidate")?.status).toBe("running");

		const after = applyOps(before, opsForWalkComplete(before), NOW).doc;
		expect(after.stages.filter((s) => s.status === "running")).toHaveLength(0);
		expect(after.stages.find((s) => s.kind === "consolidate")?.status).toBe("done");
	});

	// The subtle half. "Current stage" is the first RUNNING one, else the first
	// PENDING — so while consolidate stayed running, `deliver` could never be
	// reported, and `deliver` is the whole reason a roster wants this: it means
	// the agent has finished and is waiting on a gate.
	it("makes DELIVER the current stage, which is what it now is", () => {
		const after = applyOps(walked(), opsForWalkComplete(walked()), NOW).doc;
		expect(currentStage(after)?.kind).toBe("deliver");
	});

	it("does NOT sweep the delivery lane to done", () => {
		// That would be the document claiming a merge nobody observed.
		const after = applyOps(walked(), opsForWalkComplete(walked()), NOW).doc;
		expect(after.stages.find((s) => s.kind === "deliver")?.status).toBe("pending");
	});

	it("keeps an active loop with a running body step alive", () => {
		let doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "orchestration"), NOW).doc;
		const stage = doc.stages[0];
		doc = applyOps(doc, [{ op: "stage", id: stage.id, status: "running" }, { op: "step", id: "orchestration.supervise", status: "running" }], NOW).doc;
		expect(opsForWalkComplete(doc)).toEqual([]);
		doc = applyOps(doc, [{ op: "loop", stage: stage.id, steps: ["orchestration.supervise"], active: false }], NOW).doc;
		expect(opsForWalkComplete(doc)).toContainEqual({ op: "stage", id: stage.id, kind: stage.kind, status: "done" });
	});

	it("is a no-op when the walk is already closed out", () => {
		// Every revision is a PUT to Hive, and `done` can be re-announced.
		const once = applyOps(walked(), opsForWalkComplete(walked()), NOW).doc;
		expect(opsForWalkComplete(once)).toEqual([]);
	});

	it("leaves a SKIPPED stage skipped rather than marking it done", () => {
		// The conductor skips `plan` for a simple task; rewriting that to `done`
		// would claim work that deliberately did not happen.
		let doc = walkedThrough("frame", "plan", "execute");
		const planStage = doc.stages.find((s) => s.kind === "plan")!;
		doc = applyOps(doc, [{ op: "stage", id: planStage.id, status: "skipped" }], NOW).doc;
		const after = applyOps(doc, opsForWalkComplete(doc), NOW).doc;
		expect(after.stages.find((s) => s.kind === "plan")?.status).toBe("skipped");
	});
});

describe("opsForTasks", () => {
	const tasks = [
		{ id: "1", subject: "read the code", status: "completed" },
		{ id: "2", subject: "write the fix", status: "in_progress" },
	];

	it("CREATES the execute stage when there is none", () => {
		// A session whose conductor never engaged (the complexity heuristic
		// declines simple work) has todos and, without this, nowhere to put them —
		// so the mirror would silently do nothing forever.
		const doc = emptyWorkflow(NOW);
		const next = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		const execute = next.stages.find((s) => s.kind === "execute")!;
		expect(execute.steps.map((s) => s.title)).toEqual(["read the code", "write the fix"]);
	});

	it("writes nothing at all when there are no tasks", () => {
		const doc = emptyWorkflow(NOW);
		expect(opsForTasks(doc, [], NOW)).toEqual([]);
	});

	it("mirrors the task list into the execute stage", () => {
		const doc = walkedThrough("execute");
		const next = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		const execute = next.stages.find((s) => s.kind === "execute")!;
		expect(execute.steps.map((s) => s.title)).toEqual(["read the code", "write the fix"]);
		expect(execute.steps[0].status).toBe("done");
		expect(execute.steps[1].status).toBe("running");
		expect(execute.steps[0].taskId).toBe("1");
	});

	it("UPDATES a reworded todo rather than growing a second step", () => {
		const doc = walkedThrough("execute");
		let next = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		const reworded = [{ ...tasks[0], subject: "read the code carefully" }, tasks[1]];
		next = applyOps(next, opsForTasks(next, reworded, NOW), NOW).doc;
		const execute = next.stages.find((s) => s.kind === "execute")!;
		expect(execute.steps).toHaveLength(2);
		expect(execute.steps[0].title).toBe("read the code carefully");
	});

	it("returns no ops when the mirror is already current", () => {
		const doc = walkedThrough("execute");
		const next = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		expect(opsForTasks(next, tasks, NOW)).toEqual([]);
	});

	it("keeps a step whose todo was deleted — the record is of how the work went", () => {
		const doc = walkedThrough("execute");
		let next = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		next = applyOps(next, opsForTasks(next, [tasks[1]], NOW), NOW).doc;
		const execute = next.stages.find((s) => s.kind === "execute")!;
		expect(execute.steps).toHaveLength(2);
	});
});

describe("declaring a stage the machine already made", () => {
	// THE defect this round exists to fix. Measured across 21 live sessions: 13
	// of the 15 that authored a workflow carried TWO "Execute" lanes, because the
	// task mirror writes its lane on turn one — with steps in it — and the model
	// declares its own "Implement" some turns later.
	//
	// The old rule only adopted an EMPTY, still-pending lane, which is exactly
	// the case that never occurs.
	it("adopts the mirrored lane even though it already has steps", () => {
		let doc = emptyWorkflow(NOW);
		const tasks = [{ id: "1", subject: "Trace the callers", status: "in_progress" }];
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		expect(doc.stages).toHaveLength(1);
		expect(doc.stages[0].steps).toHaveLength(1);

		const { doc: next, notes } = applyOps(
			doc,
			[{ op: "stage", kind: "execute", title: "Implement", status: "running" }],
			NOW,
		);

		expect(next.stages.filter((s) => s.kind === "execute")).toHaveLength(1);
		expect(next.stages[0].title).toBe("Implement");
		// The mirrored todo is still there — the lanes MERGE, they do not replace.
		expect(next.stages[0].steps.map((s) => s.title)).toEqual(["Trace the callers"]);
		expect(notes.join(" ")).toContain("adopted");
	});

	it("adopts a lane the conductor walked into", () => {
		const doc = walkedThrough("plan");
		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "plan", title: "Design" }], NOW);
		expect(next.stages).toHaveLength(1);
		expect(next.stages[0].title).toBe("Design");
	});

	// Adoption is a one-time claim, which is what keeps a deliberate second pass
	// expressible: an agent that comes back to implement after verify gets its
	// own lane rather than silently merging into the one it already claimed.
	it("does not adopt a lane the model has already claimed", () => {
		let doc = walkedThrough("execute");
		doc = applyOps(doc, [{ op: "stage", kind: "execute", title: "Implement" }], NOW).doc;
		expect(doc.stages.filter((s) => s.kind === "execute")).toHaveLength(1);

		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "execute", title: "Second pass" }], NOW);
		expect(next.stages.filter((s) => s.kind === "execute")).toHaveLength(2);
	});

	// Patching by id claims it too, or a model that adjusted the mirrored lane
	// and then declared its own kind would still end up with two.
	/**
	 * Replayed from a live 53-turn Borealis session (`agents-borealis-ops-ea9842fc`,
	 * BOR-3681), which is how this was found — monitoring running agents, not a
	 * test.
	 *
	 * The model declared its lane with its own id AND a kind the mirror had
	 * already made a lane for. Adoption fired, kept `s1`, and `"implement"` never
	 * existed — so both of its real steps were dropped with `no stage
	 * "implement"` and the `gate` step was left depending on one of them. The
	 * lane it got back held only the mirrored todos, so the document looked
	 * plausible while missing the actual work.
	 *
	 * Adoption was defeating the caller-supplied id that the op above it honours.
	 */
	it("keeps the id the caller gave it when adopting", () => {
		let doc = emptyWorkflow(NOW);
		doc = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Ship it", status: "running" }], NOW), NOW).doc;

		const { doc: next, notes } = applyOps(
			doc,
			[
				{ op: "stage", id: "implement", title: "Implementation", kind: "execute" },
				{ op: "step", stageId: "implement", id: "code", title: "Implement the IOC path" },
				{ op: "step", stageId: "implement", id: "tests", title: "Add regressions", dependsOn: ["code"] },
			],
			NOW,
		);

		expect(notes.join(" ")).not.toContain("no stage");
		const lane = next.stages.find((s) => s.kind === "execute")!;
		expect(lane.id).toBe("implement");
		expect(lane.title).toBe("Implementation");
		// The model's own steps survived, alongside the mirrored todo.
		expect(lane.steps.map((s) => s.title)).toEqual([
			"Ship it",
			"Implement the IOC path",
			"Add regressions",
		]);
	});

	it("does not take an id another stage already holds", () => {
		let doc = applyOps(emptyWorkflow(NOW), [{ op: "stage", id: "taken", title: "Elsewhere" }], NOW).doc;
		doc = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Ship it", status: "running" }], NOW), NOW).doc;

		const { doc: next } = applyOps(doc, [{ op: "stage", id: "taken", kind: "execute", title: "Clash" }], NOW);
		const ids = next.stages.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("treats an explicit patch by id as a claim", () => {
		let doc = walkedThrough("execute");
		doc = applyOps(doc, [{ op: "stage", id: doc.stages[0].id, title: "Implement" }], NOW).doc;

		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "execute", title: "Again" }], NOW);
		expect(next.stages.filter((s) => s.kind === "execute")).toHaveLength(2);
	});

	// A stage op with no kind defaults to "stage", which every generic stage
	// shares — matching on that would collapse N of them into one.
	it("never adopts across a differing kind", () => {
		const doc = walkedThrough("plan");
		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "research", title: "Triage" }], NOW);
		expect(next.stages).toHaveLength(2);
	});
});

describe("where a new stage lands", () => {
	// The second measured defect: 11 of the 11 sessions that grew a research or
	// triage lane put it AFTER the execute lane it precedes, because the mirror
	// created execute on turn one and everything since could only append. `before`
	// was documented for exactly this and used zero times in 206 ops.
	it("places a ranked stage ahead of a later one instead of appending", () => {
		const doc = walkedThrough("execute");
		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "research", title: "Triage" }], NOW);
		expect(next.stages.map((s) => s.kind)).toEqual(["research", "execute"]);
	});

	it("still honours an explicit before over the rank", () => {
		let doc = walkedThrough("execute", "verify");
		doc = applyOps(
			doc,
			[{ op: "stage", kind: "research", title: "Triage", before: doc.stages[1].id }],
			NOW,
		).doc;
		expect(doc.stages.map((s) => s.kind)).toEqual(["execute", "research", "verify"]);
	});

	it("appends a kind it has no opinion about", () => {
		const doc = walkedThrough("execute");
		const { doc: next } = applyOps(doc, [{ op: "stage", kind: "monitor", title: "Watch" }], NOW);
		expect(next.stages.map((s) => s.kind)).toEqual(["execute", "monitor"]);
	});

	// Rank-based insertion broke the old "steps default to the last stage in the
	// array" rule, because the stage just created is no longer that stage. Every
	// measured session writes this interleaved shape, so getting it wrong would
	// have posted each stage's steps into whichever lane sorted last.
	it("adds steps to the stage the batch just created, not the array's last", () => {
		const doc = walkedThrough("execute");
		const { doc: next } = applyOps(
			doc,
			[
				{ op: "stage", kind: "research", title: "Triage" },
				{ op: "step", title: "Read the Sentry issue" },
			],
			NOW,
		);
		const research = next.stages.find((s) => s.kind === "research")!;
		expect(research.steps.map((s) => s.title)).toEqual(["Read the Sentry issue"]);
		expect(next.stages.find((s) => s.kind === "execute")!.steps).toHaveLength(0);
	});
});

describe("the machine marker survives a round trip", () => {
	/**
	 * Adoption is the fix for the duplicate-lane defect, and it hangs entirely on
	 * `origin` still being there when the model finally calls the tool. That is
	 * not a rare gap: the document is rehydrated on every session restore and
	 * every branch move, and the mirror writes its lane on turn one. A session
	 * that reloads in between would silently get the old behaviour back — and no
	 * in-memory `applyOps` test can see it.
	 */
	it("still adopts after the document has been persisted and read back", () => {
		let doc = emptyWorkflow(NOW);
		doc = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Trace it", status: "pending" }], NOW), NOW).doc;

		const restored = rehydrateWorkflow([{ customType: "workflow", data: toEntry(doc) }]);
		expect(restored).not.toBeNull();

		const { doc: next } = applyOps(restored!, [{ op: "stage", kind: "execute", title: "Implement" }], NOW);
		expect(next.stages.filter((s) => s.kind === "execute")).toHaveLength(1);
		expect(next.stages[0].title).toBe("Implement");
	});

	it("does not resurrect a marker the model already cleared", () => {
		let doc = walkedThrough("execute");
		doc = applyOps(doc, [{ op: "stage", kind: "execute", title: "Implement" }], NOW).doc;

		const restored = rehydrateWorkflow([{ customType: "workflow", data: toEntry(doc) }])!;
		const { doc: next } = applyOps(restored, [{ op: "stage", kind: "execute", title: "Second pass" }], NOW);
		expect(next.stages.filter((s) => s.kind === "execute")).toHaveLength(2);
	});
});

describe("the mirror follows the model, not the word \"execute\"", () => {
	/**
	 * Replayed from the first session measured on the deployed build. It labelled
	 * its Triage, Fix and Verification stages ALL `plan` — `kind` is a loose
	 * label to a model and the adoption key to this code — so nothing matched the
	 * mirror's `execute` lane, and the diagram carried a FOURTH box restating the
	 * same three phases in the mirror's words.
	 *
	 * This is the shape that had been hidden until caller-supplied ids started
	 * being honoured: before that, all six of these ops were rejected outright
	 * and the document simply had no model structure to collide with.
	 */
	const modelStages: WorkflowOp[] = [
		{ op: "stage", id: "triage", kind: "plan", title: "Triage", status: "running" },
		{ op: "step", id: "identify", stageId: "triage", title: "Identify the failing test" },
		{ op: "stage", id: "fix", kind: "plan", title: "Fix" },
		{ op: "step", id: "repair", stageId: "fix", title: "Apply the root-cause fix" },
		{ op: "stage", id: "verification", kind: "plan", title: "Verification" },
		{ op: "step", id: "prove", stageId: "verification", title: "Prove it is deterministic" },
	];

	it("mirrors into the lane the model says it is in", () => {
		let doc = applyOps(emptyWorkflow(NOW), modelStages, NOW).doc;
		doc = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Reproduce it", status: "in_progress" }], NOW), NOW).doc;

		expect(doc.stages.map((s) => s.title)).toEqual(["Triage", "Fix", "Verification"]);
		expect(doc.stages[0].steps.map((s) => s.title)).toEqual([
			"Identify the failing test",
			"Reproduce it",
		]);
	});

	// The mirror almost always gets there FIRST, on turn one, so the fix above is
	// not enough on its own: the lane it made is left holding the early todos
	// while everything since goes elsewhere.
	it("folds the lane it made on turn one into the model's structure", () => {
		let doc = emptyWorkflow(NOW);
		const tasks = [{ id: "1", subject: "Reproduce it", status: "in_progress" }];
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		expect(doc.stages).toHaveLength(1);

		doc = applyOps(doc, modelStages, NOW).doc;
		expect(doc.stages).toHaveLength(4); // the fourth box, before the fold

		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;

		expect(doc.stages.map((s) => s.title)).toEqual(["Triage", "Fix", "Verification"]);
		expect(doc.stages[0].steps.map((s) => s.title)).toEqual([
			"Identify the failing test",
			"Reproduce it",
		]);
		// Migrated, not re-mirrored: one step, still carrying its taskId.
		const mirrored = doc.stages.flatMap((s) => s.steps).filter((s) => s.taskId);
		expect(mirrored).toHaveLength(1);
	});

	/**
	 * Replayed from the session that ran the build which shipped the fold — where
	 * it did not fire.
	 *
	 * Every model stage was `pending`, because a plan written before the work
	 * starts has nothing running yet. That is the ORDINARY case, and the previous
	 * target chain reached "any execute-kind stage" before the model fallback, so
	 * it matched the machine's own lane, made it the target, and the fold's
	 * `target.origin` guard then skipped the whole migration. Every existing test
	 * of the fold happened to mark a stage running.
	 */
	it("folds into an all-pending model structure", () => {
		const pendingStages: WorkflowOp[] = [
			{ op: "stage", id: "triage", kind: "investigation", title: "1. Triage" },
			{ op: "step", id: "baseline", stageId: "triage", title: "Establish a baseline" },
			{ op: "stage", id: "fix", kind: "implementation", title: "2. Fix" },
			{ op: "step", id: "minimal", stageId: "fix", title: "Apply the minimal fix" },
		];
		let doc = emptyWorkflow(NOW);
		const tasks = [{ id: "1", subject: "Triage endpoint latency", status: "pending" }];
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		doc = applyOps(doc, pendingStages, NOW).doc;

		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;

		expect(doc.stages.map((s) => s.title)).toEqual(["1. Triage", "2. Fix"]);
		expect(doc.stages[0].steps.map((s) => s.title)).toEqual([
			"Establish a baseline",
			"Triage endpoint latency",
		]);
	});

	it("does not re-mirror a todo whose step has moved", () => {
		let doc = emptyWorkflow(NOW);
		const tasks = [{ id: "1", subject: "Reproduce it", status: "in_progress" }];
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		doc = applyOps(doc, modelStages, NOW).doc;
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		// A second beat with the same list must be a no-op.
		const again = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW);
		expect(again.changed).toBe(false);
		expect(again.doc.stages.flatMap((s) => s.steps).filter((s) => s.taskId)).toHaveLength(1);
	});

	// A lane holding anything the mirror did not write is somebody's real record.
	it("leaves a machine lane alone once it holds work of its own", () => {
		let doc = emptyWorkflow(NOW);
		const tasks = [{ id: "1", subject: "Reproduce it", status: "pending" }];
		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		const machineLane = doc.stages[0].id;
		doc = applyOps(doc, [{ op: "step", stageId: machineLane, title: "Hand-written" }], NOW).doc;
		doc = applyOps(doc, modelStages, NOW).doc;

		doc = applyOps(doc, opsForTasks(doc, tasks, NOW), NOW).doc;
		expect(doc.stages.some((s) => s.id === machineLane)).toBe(true);
	});

	// Unchanged for the sessions that never author a workflow at all.
	it("still creates its own lane when the model authored nothing", () => {
		const doc = emptyWorkflow(NOW);
		const next = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Do it", status: "pending" }], NOW), NOW).doc;
		expect(next.stages).toHaveLength(1);
		expect(next.stages[0].kind).toBe("execute");
		expect(next.stages[0].steps).toHaveLength(1);
	});
});

describe("replayed from a live session", () => {
	/**
	 * The exact shape a real session wrote, against the exact document it wrote
	 * it into — the task mirror had already created the execute lane on turn one.
	 *
	 * Before this round it produced five stages reading
	 * `Execute · Triage · Fix · Verify`, with two execute lanes and the triage
	 * after the work. It is here as one case rather than three because the three
	 * fixes only add up in combination: adoption removes the second lane, the
	 * rank moves triage in front of it, and the batch's stage tracking is what
	 * keeps each stage's steps in the stage they were declared under once the
	 * ranked insert stops appending.
	 */
	it("produces one lane per phase, in the order the work happens", () => {
		let doc = emptyWorkflow(NOW);
		doc = applyOps(
			doc,
			opsForTasks(doc, [{ id: "1", subject: "Review active Sentry issues", status: "in_progress" }], NOW),
			NOW,
		).doc;

		const { doc: next } = applyOps(
			doc,
			[
				{ op: "meta", title: "Resolve Borealis Sentry issues", goal: "A PR fixes a confirmed issue." },
				{ op: "stage", title: "Triage", kind: "research", status: "running" },
				{ op: "step", title: "Review the Sentry issue list", kind: "task", status: "running" },
				{ op: "stage", title: "Fix", kind: "execute", status: "pending" },
				{ op: "step", title: "Trace and repair the root cause", kind: "task" },
				{ op: "stage", title: "Verify", kind: "verify", status: "pending" },
				{ op: "step", title: "Run the relevant quality gate", kind: "task" },
			],
			NOW,
		);

		expect(next.stages.map((s) => s.title)).toEqual(["Triage", "Fix", "Verify"]);
		// The mirrored todo survived the adoption and sits with the model's own
		// step in the one execute lane.
		expect(next.stages[1].steps.map((s) => s.title)).toEqual([
			"Review active Sentry issues",
			"Trace and repair the root cause",
		]);
		expect(next.stages[0].steps.map((s) => s.title)).toEqual(["Review the Sentry issue list"]);
		expect(next.stages[2].steps.map((s) => s.title)).toEqual(["Run the relevant quality gate"]);
	});
});

describe("caller-supplied ids", () => {
	// Two sessions in the corpus wrote `{op:"stage", id:"discover"}` and then
	// `{op:"step", stageId:"discover"}`, using `id` as a client key. The stage was
	// rejected as "no stage", and then every step naming it was rejected too — 18
	// ops, two whole opening declarations, lost.
	it("creates a stage with the id it was given, and steps can name it", () => {
		const { doc, notes } = applyOps(
			emptyWorkflow(NOW),
			[
				{ op: "stage", id: "discover", kind: "research", title: "Discover" },
				{ op: "step", stageId: "discover", title: "Locate the component" },
			],
			NOW,
		);
		expect(doc.stages).toHaveLength(1);
		expect(doc.stages[0].id).toBe("discover");
		expect(doc.stages[0].steps.map((s) => s.title)).toEqual(["Locate the component"]);
		expect(notes.join(" ")).not.toContain("no stage");
	});

	it("patches rather than duplicates when the id is already there", () => {
		let doc = applyOps(emptyWorkflow(NOW), [{ op: "stage", id: "discover", title: "A" }], NOW).doc;
		doc = applyOps(doc, [{ op: "stage", id: "discover", title: "B" }], NOW).doc;
		expect(doc.stages).toHaveLength(1);
		expect(doc.stages[0].title).toBe("B");
	});

	it("creates a step with the id it was given", () => {
		const { doc } = applyOps(
			emptyWorkflow(NOW),
			[
				{ op: "stage", id: "fix", title: "Fix" },
				{ op: "step", id: "repro", stageId: "fix", title: "Reproduce it" },
				{ op: "step", id: "repro", status: "done" },
			],
			NOW,
		);
		expect(doc.stages[0].steps).toHaveLength(1);
		expect(doc.stages[0].steps[0].status).toBe("done");
	});

	// Honouring "s4" would hand out an id the counter is free to mint again, and
	// the collision would land as a silent patch of somebody else's stage.
	it("refuses an id that collides with the generated space", () => {
		const { doc } = applyOps(emptyWorkflow(NOW), [{ op: "stage", id: "s7", title: "Sneaky" }], NOW);
		expect(doc.stages[0].id).not.toBe("s7");
		expect(doc.stages[0].title).toBe("Sneaky");
	});

	// The stage guard covers `s<n>`, but steps mint as `<stageId>.<n>` — so in a
	// stage the caller NAMED, the mint is `discover.7`, a shape no pattern can
	// reserve because the caller chose the prefix. Minting has to step over what
	// is already there instead.
	it("never mints a step id that is already taken", () => {
		// The collision needs a GAP: a supplied id bumps the counter too, so one
		// taken just ahead of it is simply stepped past. Claiming `discover.5`
		// while the counter is at 2 leaves three mints (3, 4, 5) before it lands
		// on the same id. Written from the arithmetic rather than from the fix —
		// the first version of this test claimed `discover.2` and passed on the
		// unfixed code, which is the only reason it was caught.
		const { doc } = applyOps(
			emptyWorkflow(NOW),
			[
				{ op: "stage", id: "discover", title: "Discover" },
				{ op: "step", id: "discover.5", stageId: "discover", title: "Claimed early" },
				{ op: "step", stageId: "discover", title: "One" },
				{ op: "step", stageId: "discover", title: "Two" },
				{ op: "step", stageId: "discover", title: "Three" },
			],
			NOW,
		);
		const ids = doc.stages[0].steps.map((s) => s.id);
		expect(doc.stages[0].steps).toHaveLength(4);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("currentStage", () => {
	it("names the running stage, else the first one still pending", () => {
		const doc = walkedThrough("frame");
		expect(currentStage(doc)?.kind).toBe("frame");
		const at = applyOps(doc, opsForStage(doc, "verify", NOW), NOW).doc;
		expect(currentStage(at)?.kind).toBe("verify");
	});
});

describe("where the delivery lane lands", () => {
	// The defect this closes is the one that started the whole rework, arriving
	// through the convenience op that was meant to be the safe path: the lane was
	// APPENDED, so a session whose walk had already reached `consolidate` got
	// `… consolidate · deliver` — the wrap-up before the shipping.
	it("goes BEFORE consolidate, not after it", () => {
		const walked = walkedThrough("execute", "consolidate");
		const doc = withDelivery(walked);
		const kinds = doc.stages.map((s) => s.kind);
		expect(kinds.indexOf("deliver")).toBeLessThan(kinds.indexOf("consolidate"));
	});

	it("goes after the work when there is no later stage to anchor against", () => {
		const doc = withDelivery(walkedThrough("execute"));
		expect(doc.stages.map((s) => s.kind)).toEqual(["execute", "deliver"]);
	});

	it("puts its steps in the lane even though the lane is not last", () => {
		// The trap in placing it: the steps used to default to "the last stage",
		// which is only the lane while the lane is appended.
		const doc = withDelivery(walkedThrough("execute", "consolidate"));
		const lane = doc.stages.find((s) => s.kind === "deliver")!;
		expect(lane.steps.map((s) => s.kind)).toEqual(DELIVERY_STEPS.map((s) => s.kind));
		expect(doc.stages.find((s) => s.kind === "consolidate")?.steps).toHaveLength(0);
	});
});

describe("lane templates", () => {
	// The whole reason these are templates rather than prose in a guideline: a
	// chained-by-default lane is wrong the SAME way in every session that asks
	// for it. The audit and research middles are genuine fan-outs and the
	// diagram is built to draw them side by side.
	it("leaves the fan-outs unchained", () => {
		for (const name of ["audit", "research"]) {
			const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), name), NOW).doc;
			const steps = doc.stages[0].steps;
			const roots = steps.filter((s) => (s.dependsOn ?? []).length === 0);
			expect(roots).toHaveLength(1); // the framing step
			// The sweeps all wait on that one step and on nothing else, so they
			// rank together rather than in a line.
			const sweeps = steps.filter((s) => (s.dependsOn ?? []).length === 1 && s.dependsOn![0] === roots[0].id);
			expect(sweeps.length).toBeGreaterThanOrEqual(3);
		}
	});

	// The review lane's middle is four readings of one diff. They are independent
	// on purpose: a security reading does not wait on a correctness one, and
	// chaining them would also imply an order of importance the reviewer has not
	// earned yet.
	it("the review readings do not wait on each other", () => {
		const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "review"), NOW).doc;
		const steps = doc.stages[0].steps;
		const scope = steps.find((s) => s.title.includes("trying to do"))!;
		const readings = steps.filter((s) => (s.dependsOn ?? []).length === 1 && s.dependsOn![0] === scope.id);
		expect(readings).toHaveLength(4);
		// And every one of them is waited on by the verify step — a finding that
		// skipped verification would reach the report unchallenged.
		const verify = steps.find((s) => s.title.includes("disprove"))!;
		for (const r of readings) expect(verify.dependsOn, r.title).toContain(r.id);
	});

	// The fix lane is the one place a full chain is the CONTENT rather than a
	// lazy default: fixing before you can reproduce is guessing, and a fix proved
	// by anything other than the check that failed is not proved.
	it("the fix lane keeps reproduce → diagnose → fix → prove in order", () => {
		const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "fix"), NOW).doc;
		const steps = doc.stages[0].steps;
		expect(steps.map((s) => (s.dependsOn ?? []).length)).toEqual([0, 1, 1, 1]);
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i].dependsOn, steps[i].title).toEqual([steps[i - 1].id]);
		}
	});

	// A migration's residue pass must NOT wait on the verification of the sites
	// it already changed — they answer different questions ("do the changed ones
	// work" vs "did I find them all"), and chaining them would make the search
	// for missed sites the last thing anyone does, if at all.
	it("the migration residue pass runs beside verification, not after it", () => {
		const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "migration"), NOW).doc;
		const steps = doc.stages[0].steps;
		const sweep = steps.find((s) => s.title.includes("rest"))!;
		const verify = steps.find((s) => s.title.includes("changed sites work"))!;
		const residue = steps.find((s) => s.title.includes("missed"))!;
		expect(verify.dependsOn).toEqual([sweep.id]);
		expect(residue.dependsOn).toEqual([sweep.id]);
		expect(residue.dependsOn).not.toContain(verify.id);
	});

	it("mitigation does not wait on diagnosis", () => {
		// Waiting for a root cause before stopping the bleeding is the classic
		// incident mistake; a chained template would encode it in every session.
		const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "incident"), NOW).doc;
		const byId = new Map(doc.stages[0].steps.map((s) => [s.id, s]));
		const mitigate = [...byId.values()].find((s) => s.title.includes("bleeding"))!;
		const diagnose = [...byId.values()].find((s) => s.title.includes("cause"))!;
		expect(mitigate.dependsOn).not.toContain(diagnose.id);
		expect(diagnose.dependsOn).not.toContain(mitigate.id);
	});

	it("targets its own kind when an existing stage holds the template id", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", id: "orchestration", title: "Existing" }).doc;
		doc = applyOps(doc, templateLaneOps(doc, "orchestration"), NOW).doc;
		const lane = doc.stages.find((stage) => stage.kind === "orchestrate")!;
		expect(lane.loop?.steps).toEqual([
			"orchestration.launch",
			"orchestration.supervise",
			"orchestration.resize",
			"orchestration.collect",
		]);
	});

	it("builds every template in one apply, with resolvable dependencies", () => {
		for (const name of Object.keys(LANE_TEMPLATES)) {
			const { doc, notes } = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), name), NOW);
			expect(notes.join(" "), name).not.toContain("no stage");
			expect(doc.stages, name).toHaveLength(1);
			const ids = new Set(doc.stages[0].steps.map((s) => s.id));
			expect(doc.stages[0].steps.length, name).toBe(LANE_TEMPLATES[name].steps.length);
			// A forward reference is fine while writing; a DANGLING one is not.
			for (const step of doc.stages[0].steps) {
				for (const dep of step.dependsOn ?? []) expect(ids.has(dep), `${name}: ${dep}`).toBe(true);
			}
		}
	});

	it("only the delivery lane is machine-driven", () => {
		for (const name of Object.keys(LANE_TEMPLATES)) {
			const doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), name), NOW).doc;
			expect(doc.stages[0].origin, name).toBe(name === "delivery" ? "machine" : undefined);
		}
	});

	// A model-claimed template lane must be able to receive the todo list, or an
	// audit session grows an Execute box beside its Audit lane.
	it("a template lane can be the todo mirror's target", () => {
		let doc = applyOps(emptyWorkflow(NOW), templateLaneOps(emptyWorkflow(NOW), "audit"), NOW).doc;
		doc = applyOps(doc, [{ op: "stage", id: doc.stages[0].id, status: "running" }], NOW).doc;
		doc = applyOps(doc, opsForTasks(doc, [{ id: "1", subject: "Check the IAM policies", status: "running" }], NOW), NOW).doc;
		expect(doc.stages).toHaveLength(1);
		expect(doc.stages[0].steps.some((s) => s.title === "Check the IAM policies")).toBe(true);
	});

	it("an unknown name builds nothing rather than an empty lane", () => {
		expect(templateLaneOps(emptyWorkflow(NOW), "nonsense")).toEqual([]);
	});
});
