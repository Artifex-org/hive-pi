/**
 * Lanes, work items, and the two clocks — the merge itself (HIV-2904).
 *
 * These are the assertions that would have caught the defects the three
 * separate stores actually produced, measured over 594 sessions before the
 * merge (`scripts/plan-shape.mjs`, HIV-2903):
 *
 *   - 65% of sessions held the SAME todos twice, because the todo list and the
 *     workflow were separate documents kept in step by a mirror;
 *   - 13 of 15 measured sessions ended with TWO "Execute" lanes, because the
 *     mirror wrote its lane on turn one and the model declared its own later,
 *     and four rounds of adoption logic each keyed on something the race made
 *     untrue;
 *   - 11 of 11 sessions that grew a research lane put it AFTER the work it
 *     precedes, because placement was a documented argument nobody passed.
 *
 * Every one of those is a rule here rather than a guideline, and each test is
 * named for the lie the document would otherwise tell.
 */

import { describe, expect, it } from "vitest";
import { activeFront, isObservedKind, targetLane, treeOrder } from "../extensions/plan/lanes.ts";
import {
	applyOps,
	emptyPlan,
	hasPlan,
	isLanesOnly,
	normalizeStatus,
	rehydratePlan,
	stepCounts,
	toEntry,
	validateSnapshot,
	type LaneBlock,
	type PlanDoc,
} from "../extensions/plan/state.ts";

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

const lanesOf = (doc: PlanDoc): LaneBlock[] => doc.blocks.filter((b): b is LaneBlock => b.type === "steps");
const lane = (doc: PlanDoc, ref: string): LaneBlock | undefined =>
	lanesOf(doc).find((l) => l.id === ref || l.kind === ref);

/** A session that wrote todos and never planned — the majority shape. */
const withMirroredTodos = (...titles: string[]): PlanDoc =>
	applyOps(
		emptyPlan(NOW),
		[
			{
				op: "lane",
				kind: "execute",
				title: "Execute",
				origin: "mirror",
				items: titles.map((title) => ({ title })),
			},
		],
		NOW,
	).doc;

describe("two clocks", () => {
	it("does not let a ticked checkbox re-arm the approval timer", () => {
		// The whole reason the workflow was a second document. `revision` drives
		// approval, the handsfree timer and the stored revision history; if a
		// status change moved it, every checkbox would ask the operator to
		// approve the plan again.
		const base = withMirroredTodos("one", "two");
		const before = { revision: base.revision, progress: base.progress };

		const ticked = applyOps(base, [{ op: "set_step", id: base.blocks[0].id + "", status: "done" }], LATER);
		void ticked;
		const items = lane(base, "execute")!.steps;
		const result = applyOps(base, [{ op: "set_step", id: items[0].id, status: "done" }], LATER);

		expect(result.doc.revision).toBe(before.revision);
		expect(result.doc.progress).toBe(before.progress + 1);
	});

	it("counts a re-plan on the intent clock and not on the tick clock", () => {
		const base = withMirroredTodos("one");
		const result = applyOps(base, [{ op: "upsert", id: "approach", block: { type: "text", markdown: "do it thus" } }], LATER);
		expect(result.doc.revision).toBe(base.revision + 1);
		expect(result.doc.progress).toBe(base.progress);
	});

	it("counts one batch of ticks once, not once per op", () => {
		// A façade that writes six status changes in one call did ONE thing. A
		// counter that reported six would make the number unreadable at a glance.
		const base = withMirroredTodos("a", "b", "c");
		const ids = lane(base, "execute")!.steps.map((i) => i.id);
		const result = applyOps(
			base,
			ids.map((id) => ({ op: "set_step" as const, id, status: "done" as const })),
			LATER,
		);
		expect(result.doc.progress).toBe(base.progress + 1);
	});

	it("treats a conductor stage advance as a tick, never as a re-plan", () => {
		const base = withMirroredTodos("one");
		const result = applyOps(base, [{ op: "header", stage: "verify" }], LATER);
		expect(result.doc.stage).toBe("verify");
		expect(result.doc.revision).toBe(base.revision);
		expect(result.doc.progress).toBe(base.progress + 1);
	});
});

describe("phase none — lanes without a plan", () => {
	it("starts a document with no plan, so a three-todo session is not an approval request", () => {
		// Measured before the merge: 98% of sessions kept a todo list and only
		// 71% kept a plan. "Lanes but no plan" is the majority state, and a
		// document that presented it as `drafting` would put every trivial
		// session in front of an operator as something to approve.
		const doc = emptyPlan(NOW);
		expect(doc.phase).toBe("none");
		expect(hasPlan(doc)).toBe(false);

		const withTodos = withMirroredTodos("one");
		expect(hasPlan(withTodos)).toBe(false);
		expect(isLanesOnly(withTodos)).toBe(true);
	});

	it("stops being lanes-only the moment the agent writes anything else", () => {
		const doc = applyOps(withMirroredTodos("one"), [{ op: "upsert", id: "why", block: { type: "text", markdown: "because" } }], LATER).doc;
		expect(isLanesOnly(doc)).toBe(false);
	});

	it("keeps an old snapshot presenting itself exactly as it did", () => {
		// A plan written before the merge has no `phase: "none"` and no
		// `progress`. It must rehydrate as the drafting plan it was, not as a
		// document with no plan — that would silently un-arm an approval an
		// operator was waiting on.
		const legacy = { kind: "plan", schemaVersion: 1, doc: { title: "t", goal: "g", phase: "drafting", revision: 3, blocks: [], nextId: 1, createdAt: NOW, updatedAt: NOW } };
		const doc = validateSnapshot(legacy);
		expect(doc?.phase).toBe("drafting");
		expect(doc?.progress).toBe(0);
		expect(hasPlan(doc as PlanDoc)).toBe(true);
	});

	it("round-trips the new header fields through an entry", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "header", stage: "execute", tickets: [{ key: "hiv-2904", role: "primary" }], milestone: { goalId: "g1" } }],
			NOW,
		).doc;
		const back = rehydratePlan([{ customType: "plan", data: toEntry(doc) }]);
		expect(back?.stage).toBe("execute");
		expect(back?.tickets?.[0]).toMatchObject({ key: "HIV-2904", role: "primary" });
		expect(back?.milestone?.goalId).toBe("g1");
	});
});

describe("one lane, whoever made it", () => {
	it("reaches the machine's lane when the model declares its own by kind", () => {
		// THE duplicate-lane defect, as a test. The mirror writes an execute lane
		// on turn one with items already in it; the model later declares
		// "Implement". Before the merge that produced two lanes and the todos sat
		// in the wrong one.
		const base = withMirroredTodos("wire it", "prove it");
		const result = applyOps(base, [{ op: "lane", kind: "execute", title: "Implement" }], LATER);

		expect(lanesOf(result.doc)).toHaveLength(1);
		const only = lanesOf(result.doc)[0];
		expect(only.title).toBe("Implement");
		expect(only.steps.map((i) => i.title)).toEqual(["wire it", "prove it"]);
	});

	it("clears the machine mark when the model claims the lane", () => {
		const base = withMirroredTodos("one");
		expect(lane(base, "execute")?.origin).toBe("mirror");
		const claimed = applyOps(base, [{ op: "lane", kind: "execute", title: "Implement" }], LATER).doc;
		expect(lane(claimed, "execute")?.origin).toBeUndefined();
	});

	it("sends a new item to the lane the session is in, not to the first one", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "research", title: "Triage", items: [{ title: "read the logs", status: "done" }] },
				{ op: "lane", kind: "execute", title: "Fix", items: [{ title: "patch it", status: "in_progress" }] },
			],
			NOW,
		).doc;
		expect(targetLane(doc)?.kind).toBe("execute");

		const result = applyOps(doc, [{ op: "item", item: { title: "and test it" } }], LATER);
		expect(lane(result.doc, "execute")!.steps.map((i) => i.title)).toContain("and test it");
		expect(lane(result.doc, "research")!.steps).toHaveLength(1);
	});

	it("refuses to create an item with no title, and says which id it could not find", () => {
		const doc = applyOps(emptyPlan(NOW), [{ op: "lane", kind: "execute", items: [{ id: "e1", title: "write" }] }], NOW).doc;
		const result = applyOps(doc, [{ op: "item", item: { id: "typo", status: "done" } }], LATER);
		expect(result.problems.join()).toContain('nothing here has id "typo"');
		expect(lane(result.doc, "execute")!.steps).toHaveLength(1);
	});

	it("patches an existing item where it is rather than relocating it", () => {
		// A caller that names a lane while ticking an item meant to tick it, not
		// to move it. Moving work somebody only meant to update is `move_item`.
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "research", items: [{ id: "r1", title: "read" }] },
				{ op: "lane", kind: "execute", items: [{ id: "e1", title: "write" }] },
			],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "item", lane: "execute", item: { id: "r1", status: "done" } }], LATER);
		expect(lane(result.doc, "research")!.steps[0]).toMatchObject({ id: "r1", status: "done" });
		expect(lane(result.doc, "execute")!.steps).toHaveLength(1);
	});
});

describe("placement by rank", () => {
	it("puts a research lane in front of the work it informs", () => {
		// 11 of 11 measured sessions got this wrong, because placement was an
		// argument (`before`) that was used zero times in 213 ops. A rank fires
		// whether or not the model remembers.
		const base = withMirroredTodos("do the thing");
		const result = applyOps(base, [{ op: "lane", kind: "research", title: "Triage" }], LATER);
		expect(lanesOf(result.doc).map((l) => l.kind)).toEqual(["research", "execute"]);
	});

	it("leaves a lane the model invented where the model put it", () => {
		const base = withMirroredTodos("do the thing");
		const result = applyOps(base, [{ op: "lane", kind: "haruspicy", title: "Consult the omens" }], LATER);
		expect(lanesOf(result.doc).map((l) => l.kind)).toEqual(["execute", "haruspicy"]);
	});
});

describe("an agent cannot mark its own gate green", () => {
	it("refuses a status on a kind Hive resolves, and says why", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "deliver", items: [{ id: "ci", title: "CI green", kind: "ci.green" }] }],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "set_step", id: "ci", status: "done" }], LATER);

		expect(result.problems.join()).toContain("Hive resolves");
		expect(lane(result.doc, "deliver")!.steps[0].status).toBe("pending");
	});

	it("still lets the agent record a note on one", () => {
		// The refusal is about the STATUS. An agent explaining why the gate is
		// red is exactly the note the field exists for.
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "deliver", items: [{ id: "ci", title: "CI green", kind: "ci.green" }] }],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "set_step", id: "ci", note: "red on a flake, retried" }], LATER);
		expect(result.problems).toEqual([]);
		expect(lane(result.doc, "deliver")!.steps[0].note).toBe("red on a flake, retried");
	});

	it("leaves observed items out of the counts", () => {
		// Counting them reports a finished session as 40% done forever: those
		// five steps are not work the agent has left to do, they are
		// observations nobody has made yet.
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "execute", items: [{ id: "e1", title: "write it", status: "done" }] },
				{ op: "template", name: "delivery" },
			],
			NOW,
		).doc;
		expect(stepCounts(doc).total).toBe(1);
		expect(stepCounts(doc).done).toBe(1);
		expect(isObservedKind("ci.green")).toBe(true);
		expect(isObservedKind("task")).toBe(false);
	});
});

describe("the merged status vocabulary", () => {
	it("accepts the words the façades have always used", () => {
		// `TodoWrite` says `completed`; `workflow_write` says `running`. Both
		// keep their schemas, so both spellings arrive here and mean what they
		// have always meant.
		expect(normalizeStatus("completed")).toBe("done");
		expect(normalizeStatus("running")).toBe("in_progress");
		expect(normalizeStatus("blocked")).toBe("blocked");
		expect(normalizeStatus("finished")).toBeUndefined();
	});

	it("keeps failed distinct from blocked", () => {
		const doc = applyOps(emptyPlan(NOW), [{ op: "lane", kind: "verify", items: [{ id: "v", title: "gate" }] }], NOW).doc;
		const result = applyOps(doc, [{ op: "set_step", id: "v", status: "failed" }], LATER);
		expect(result.problems).toEqual([]);
		expect(stepCounts(result.doc).failed).toBe(1);
		expect(stepCounts(result.doc).blocked).toBe(0);
	});

	it("stamps the timestamps a delegation hangs from", () => {
		const doc = applyOps(emptyPlan(NOW), [{ op: "lane", kind: "execute", items: [{ id: "e", title: "work" }] }], NOW).doc;
		const started = applyOps(doc, [{ op: "set_step", id: "e", status: "in_progress" }], LATER).doc;
		expect(started.blocks.flatMap((b) => (b.type === "steps" ? b.steps : []))[0].startedAt).toBe(LATER);

		const ended = applyOps(started, [{ op: "set_step", id: "e", status: "done" }], LATER + 1).doc;
		const item = ended.blocks.flatMap((b) => (b.type === "steps" ? b.steps : []))[0];
		expect(item.startedAt).toBe(LATER);
		expect(item.endedAt).toBe(LATER + 1);
	});
});

describe("the tree and the DAG", () => {
	it("keeps a decomposed item nested under its parent", () => {
		// Kept through the merge on measurement, not on the stale note that said
		// nothing used it: 14% of sessions nest, and the rate is rising.
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{
					op: "lane",
					kind: "execute",
					items: [
						{ id: "root", title: "trace the cause" },
						{ id: "a", title: "read the log", parentId: "root" },
						{ id: "b", title: "check the config", parentId: "root" },
					],
				},
			],
			NOW,
		).doc;
		expect(treeOrder(lane(doc, "execute")!).map((n) => [n.item.id, n.depth])).toEqual([
			["root", 1],
			["a", 2],
			["b", 2],
		]);
	});

	it("treats an item whose parent is missing as a root rather than losing it", () => {
		// A child can outlive its parent, and a walk that only descended from
		// roots would drop it silently: present in the count, absent from the
		// diagram.
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "execute", items: [{ id: "orphan", title: "left behind", parentId: "gone" }] }],
			NOW,
		).doc;
		expect(treeOrder(lane(doc, "execute")!).map((n) => n.item.id)).toEqual(["orphan"]);
	});

	it("refuses a parent loop and keeps the item", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }, { id: "b", title: "b", parentId: "a" }] }],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "item", item: { id: "a", title: "a", parentId: "b" } }], LATER);
		expect(result.problems.join()).toContain("would close a loop");
		expect(lane(result.doc, "execute")!.steps.find((i) => i.id === "a")?.parentId).toBeUndefined();
	});

	it("refuses a dependency cycle and keeps the item", () => {
		// A cycle has no topological order, so a layered layout can only respond
		// by looping or by dropping an edge and drawing a lie.
		const doc = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "execute", items: [{ id: "a", title: "a" }, { id: "b", title: "b", dependsOn: ["a"] }] }],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "item", item: { id: "a", title: "a", dependsOn: ["b"] } }], LATER);
		expect(result.problems.join()).toContain("would close a cycle");
		expect(lane(result.doc, "execute")!.steps.find((i) => i.id === "a")?.dependsOn).toBeUndefined();
	});

	it("accepts a forward reference, because a document is written top-down", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "execute", items: [{ id: "a", title: "a", dependsOn: ["not-yet"] }] }],
			NOW,
		);
		expect(result.problems).toEqual([]);
		expect(lane(result.doc, "execute")!.steps[0].dependsOn).toEqual(["not-yet"]);
	});

	it("reports every live item, so a fan-out does not read as a queue", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{
					op: "lane",
					kind: "execute",
					items: [
						{ id: "scope", title: "scope", status: "done" },
						{ id: "x", title: "x", dependsOn: ["scope"] },
						{ id: "y", title: "y", dependsOn: ["scope"] },
						{ id: "z", title: "z", dependsOn: ["x", "y"] },
					],
				},
			],
			NOW,
		).doc;
		expect(activeFront(doc).map((i) => i.id).sort()).toEqual(["x", "y"]);
	});

	it("moves a subtree with its root", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "research", items: [{ id: "r", title: "r" }, { id: "rc", title: "rc", parentId: "r" }] },
				{ op: "lane", kind: "execute", items: [] },
			],
			NOW,
		).doc;
		const result = applyOps(doc, [{ op: "move_item", id: "r", lane: "execute" }], LATER);
		expect(lane(result.doc, "research")!.steps).toHaveLength(0);
		expect(lane(result.doc, "execute")!.steps.map((i) => i.id).sort()).toEqual(["r", "rc"]);
	});
});

describe("lane templates", () => {
	it("expands a shape in one apply and refuses to do it twice", () => {
		const first = applyOps(emptyPlan(NOW), [{ op: "template", name: "fix" }], NOW);
		const items = lane(first.doc, "fix")!.steps;
		expect(items.map((i) => i.id)).toEqual(["fix.reproduce", "fix.diagnose", "fix.fix", "fix.prove"]);
		// `fix` is fully chained, and that is the content: fixing before you can
		// reproduce is guessing.
		expect(items[1].dependsOn).toEqual(["fix.reproduce"]);

		const again = applyOps(first.doc, [{ op: "template", name: "fix" }], LATER);
		expect(lanesOf(again.doc).filter((l) => l.kind === "fix")).toHaveLength(1);
	});

	it("leaves a fan-out unchained, because chaining it would be wrong every time", () => {
		// An audit's four sweeps do not wait on each other. A template that
		// chained them would teach every session that asked for it to draw a
		// queue.
		const doc = applyOps(emptyPlan(NOW), [{ op: "template", name: "audit" }], NOW).doc;
		const items = lane(doc, "audit")!.steps;
		const sweeps = items.filter((i) => ["audit.inventory", "audit.config", "audit.access", "audit.signals"].includes(i.id));
		expect(sweeps).toHaveLength(4);
		for (const sweep of sweeps) expect(sweep.dependsOn).toEqual(["audit.scope"]);
	});

    it("names the templates it has when asked for one it does not", () => {
		const result = applyOps(emptyPlan(NOW), [{ op: "template", name: "vibes" }], NOW);
		expect(result.problems.join()).toContain("Available:");
		expect(result.problems.join()).toContain("delivery");
	});
});

describe("loops", () => {
	it("carries a wave counter without pretending it is a dependency edge", () => {
		// HIV-2155's contract, verbatim. An orchestrator's watch → collect →
		// dispatch is a loop, and a DAG cannot say so; without it a lead running
		// waves for hours reads as "almost done".
		const doc = applyOps(emptyPlan(NOW), [{ op: "template", name: "orchestration" }], NOW).doc;
		const declared = lane(doc, "orchestrate")!;
		expect(declared.loop?.steps).toContain("orchestration.launch");
		expect(declared.loop?.iteration).toBe(1);

		const ticked = applyOps(doc, [{ op: "loop_tick", lane: "orchestrate" }], LATER);
		expect(lane(ticked.doc, "orchestrate")!.loop?.iteration).toBe(2);
		// A tick is progress, never a re-plan.
		expect(ticked.doc.revision).toBe(doc.revision);
		expect(ticked.doc.progress).toBe(doc.progress + 1);
	});

	it("does not silently reopen the body it just finished", () => {
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "orchestrate", items: [{ id: "launch", title: "launch", status: "done" }] },
				{ op: "loop", lane: "orchestrate", steps: ["launch"], until: "everyone is collected" },
			],
			NOW,
		).doc;
		const ticked = applyOps(doc, [{ op: "loop_tick", lane: "orchestrate" }], LATER).doc;
		expect(lane(ticked, "orchestrate")!.steps[0].status).toBe("done");
	});

	it("drops a loop id the lane does not have rather than refusing the annotation", () => {
		const doc = applyOps(emptyPlan(NOW), [{ op: "lane", kind: "orchestrate", items: [{ id: "a", title: "a" }] }], NOW).doc;
		const result = applyOps(doc, [{ op: "loop", lane: "orchestrate", steps: ["a", "renamed-away"] }], LATER);
		expect(result.problems).toEqual([]);
		expect(lane(result.doc, "orchestrate")!.loop?.steps).toEqual(["a"]);
	});
});
