/**
 * `TodoWrite` and `workflow_write` as translations into the plan document.
 *
 * These two tools are named ~360 times across the skill corpus and directly in
 * three shipped prompts, so the merge is only safe if their existing callers
 * keep working unchanged. The failure mode is quiet: a wrong mapping does not
 * throw, it writes the right thing to the wrong place — a todo into a delivery
 * lane, a step into a lane the batch was not addressing, a delete that deletes
 * nothing. Every test here is one of those.
 */

import { describe, expect, it } from "vitest";
import {
	registerFacadeTools,
	renderWorkflowReply,
	taskRowsOf,
	todoWritesToOps,
	workflowOpsToPlanOps,
	type WorkflowToolOp,
} from "../extensions/plan/facades.ts";
import { applyOps, emptyPlan, type LaneBlock, type PlanDoc, type PlanOp } from "../extensions/plan/state.ts";

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

const lanesOf = (doc: PlanDoc): LaneBlock[] => doc.blocks.filter((b): b is LaneBlock => b.type === "steps");
const lane = (doc: PlanDoc, ref: string): LaneBlock | undefined =>
	lanesOf(doc).find((l) => l.id === ref || l.kind === ref);

/** Run a TodoWrite batch the way the tool will. */
const todo = (doc: PlanDoc, writes: Parameters<typeof todoWritesToOps>[1]): PlanDoc =>
	applyOps(doc, todoWritesToOps(doc, writes), LATER).doc;

/** Run a workflow_write batch the way the tool will. */
const wf = (doc: PlanDoc, ops: Parameters<typeof workflowOpsToPlanOps>[1]) => {
	const mapped = workflowOpsToPlanOps(doc, ops);
	return { ...applyOps(doc, mapped.ops, LATER), notes: mapped.notes, dropped: mapped.dropped };
};

describe("TodoWrite writes into a lane", () => {
	it("creates the lane it needs, once, and marks it claimable", () => {
		// The mark is what lets the model's later "Implement" merge into this
		// lane instead of appearing beside it — the defect 13 of 15 measured
		// sessions had.
		const doc = todo(emptyPlan(NOW), [{ subject: "wire it" }, { subject: "prove it" }]);
		expect(lanesOf(doc)).toHaveLength(1);
		expect(lanesOf(doc)[0].origin).toBe("mirror");
		expect(lanesOf(doc)[0].steps.map((i) => i.title)).toEqual(["wire it", "prove it"]);
	});

	it("writes into the lane the session is in rather than making another", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "research", title: "Triage", items: [{ id: "r", title: "read", status: "done" }] },
				{ op: "lane", kind: "execute", title: "Fix", items: [{ id: "e", title: "patch", status: "in_progress" }] },
			],
			NOW,
		).doc;

		const doc = todo(base, [{ subject: "and test it" }]);
		expect(lanesOf(doc)).toHaveLength(2);
		expect(lane(doc, "execute")!.steps.map((i) => i.title)).toContain("and test it");
	});

	it("does not re-mark a lane the model has already claimed", () => {
		const claimed = applyOps(
			emptyPlan(NOW),
			[{ op: "lane", kind: "execute", title: "Implement", items: [{ id: "a", title: "a" }] }],
			NOW,
		).doc;
		const doc = todo(claimed, [{ subject: "another" }]);
		expect(lane(doc, "execute")!.origin).toBeUndefined();
	});

	it("maps the todo vocabulary onto the item's fields", () => {
		const doc = todo(emptyPlan(NOW), [
			{
				id: "t1",
				subject: "run the migration",
				description: "against the template DB",
				activeForm: "Running the migration",
				blockedBy: ["t0"],
				owner: "w1",
			},
		]);
		expect(lanesOf(doc)[0].steps[0]).toMatchObject({
			id: "t1",
			title: "run the migration",
			detail: "against the template DB",
			activeForm: "Running the migration",
			dependsOn: ["t0"],
			owner: "w1",
		});
	});

	it("accepts `completed`, which is the only word its callers have ever used", () => {
		const base = todo(emptyPlan(NOW), [{ id: "t1", subject: "a" }]);
		const doc = todo(base, [{ id: "t1", status: "completed" }]);
		expect(lanesOf(doc)[0].steps[0].status).toBe("done");
	});

	it("deletes on `deleted`, taking the subtree with it", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{
					op: "lane",
					kind: "execute",
					items: [
						{ id: "root", title: "root" },
						{ id: "child", title: "child", parentId: "root" },
						{ id: "other", title: "other" },
					],
				},
			],
			NOW,
		).doc;
		const doc = todo(base, [{ id: "root", status: "deleted" }]);
		expect(lanesOf(doc)[0].steps.map((i) => i.id)).toEqual(["other"]);
	});

	it("keeps a status change on the tick clock", () => {
		// `TodoWrite` is the most frequent writer in the harness. If its ticks
		// bumped `revision`, every todo would re-arm the approval timer and write
		// a full snapshot.
		const base = todo(emptyPlan(NOW), [{ id: "t1", subject: "a" }]);
		const doc = todo(base, [{ id: "t1", status: "in_progress" }]);
		expect(doc.revision).toBe(base.revision);
		expect(doc.progress).toBe(base.progress + 1);
	});
});

describe("the list a task tool reports back", () => {
	it("speaks the todo vocabulary, for one lane", () => {
		// The tools promise the text they return IS the view of the list, and the
		// model plans against it. A list that silently grew to include another
		// lane's work would be a different list than the caller wrote to.
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{ op: "lane", kind: "execute", items: [{ id: "a", title: "do it", status: "in_progress" }] },
				{ op: "template", name: "delivery" },
			],
			NOW,
		).doc;
		const rows = taskRowsOf(doc);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: "a", subject: "do it", status: "in_progress" });
	});

	it("collapses the statuses the todo vocabulary does not have", () => {
		// `failed` and `skipped` are finished being attempted; reporting them as
		// "to do" would put them back on the list the model works from.
		// `blocked` genuinely is still to be done.
		const doc = applyOps(
			emptyPlan(NOW),
			[
				{
					op: "lane",
					kind: "execute",
					items: [
						{ id: "f", title: "f", status: "failed" },
						{ id: "s", title: "s", status: "skipped" },
						{ id: "b", title: "b", status: "blocked" },
					],
				},
			],
			NOW,
		).doc;
		const byId = Object.fromEntries(taskRowsOf(doc).map((r) => [r.id, r.status]));
		expect(byId).toEqual({ f: "completed", s: "completed", b: "pending" });
	});
});

describe("workflow_write maps onto the same document", () => {
	it("turns a stage into a lane and its steps into items", () => {
		const result = wf(emptyPlan(NOW), [
			{ op: "stage", id: "impl", kind: "execute", title: "Implement" },
			{ op: "step", stageId: "impl", id: "one", title: "first" },
			{ op: "step", id: "two", title: "second", dependsOn: ["one"] },
		]);
		const impl = lane(result.doc, "impl")!;
		expect(impl.title).toBe("Implement");
		expect(impl.kind).toBe("execute");
		// The second step names no stage: the documented affordance is "the lane
		// this batch last touched", and the prompts rely on it.
		expect(impl.steps.map((i) => i.id)).toEqual(["one", "two"]);
		expect(impl.steps[1].dependsOn).toEqual(["one"]);
	});

	it("says so when it drops a lane status instead of silently ignoring it", () => {
		// Lane status is derived from its items now, so a lane cannot be marked
		// done while holding pending work. Accepting the field and dropping it is
		// exactly the silence this codebase refuses elsewhere.
		const result = wf(emptyPlan(NOW), [{ op: "stage", id: "impl", kind: "execute", status: "done" }]);
		expect(result.notes.join()).toContain("derived from its items");
	});

	it("keeps the loop contract working under its own names", () => {
		const base = wf(emptyPlan(NOW), [
			{ op: "stage", id: "orch", kind: "orchestrate" },
			{ op: "step", stageId: "orch", id: "launch", title: "launch" },
			{ op: "loop", stage: "orch", steps: ["launch"], until: "everyone is collected" },
		]).doc;
		expect(lane(base, "orch")!.loop).toMatchObject({ steps: ["launch"], until: "everyone is collected", iteration: 1 });

		const ticked = wf(base, [{ op: "loop_tick", stage: "orch" }]).doc;
		expect(lane(ticked, "orch")!.loop?.iteration).toBe(2);
	});

	it("expands both spellings of the delivery lane", () => {
		const viaTemplate = wf(emptyPlan(NOW), [{ op: "template", name: "delivery" }]).doc;
		const viaLegacy = wf(emptyPlan(NOW), [{ op: "delivery" }]).doc;
		expect(lane(viaTemplate, "deliver")!.steps.map((i) => i.kind)).toEqual(
			lane(viaLegacy, "deliver")!.steps.map((i) => i.kind),
		);
	});

	it("moves a stage by resolving `before` to the sibling it follows", () => {
		const base = wf(emptyPlan(NOW), [
			{ op: "stage", id: "a", kind: "frame" },
			{ op: "stage", id: "b", kind: "execute" },
			{ op: "stage", id: "c", kind: "consolidate" },
		]).doc;
		const moved = wf(base, [{ op: "moveStage", id: "c", before: "b" }]).doc;
		expect(lanesOf(moved).map((l) => l.id)).toEqual(["a", "c", "b"]);
	});

	it("removes a stage and a step under their own op names", () => {
		const base = wf(emptyPlan(NOW), [
			{ op: "stage", id: "a", kind: "execute" },
			{ op: "step", stageId: "a", id: "s1", title: "s1" },
			{ op: "step", stageId: "a", id: "s2", title: "s2" },
			{ op: "stage", id: "b", kind: "verify" },
		]).doc;

		const noStep = wf(base, [{ op: "removeStep", id: "s1" }]).doc;
		expect(lane(noStep, "a")!.steps.map((i) => i.id)).toEqual(["s2"]);

		const noStage = wf(base, [{ op: "removeStage", id: "b" }]).doc;
		expect(lanesOf(noStage).map((l) => l.id)).toEqual(["a"]);
	});

	it("refuses a status on a delivery step through this path too", () => {
		// The rule is on the document, not on one tool, so it holds whichever
		// vocabulary the caller speaks.
		const base = wf(emptyPlan(NOW), [{ op: "delivery" }]).doc;
		const ciStep = lane(base, "deliver")!.steps.find((i) => i.kind === "ci.green")!;
		const result = wf(base, [{ op: "set_step", id: ciStep.id, status: "done" }]);
		expect(result.problems.join()).toContain("Hive resolves");
	});

	it("refuses a gate status DECLARED on a new item, not just set on an old one", () => {
		// The same claim, made on the way in. An agent that writes
		// `{kind:"ci.green", status:"done"}` in the batch that creates the lane
		// is asserting a gate result exactly as it would by setting it after.
		const result = wf(emptyPlan(NOW), [
			{ op: "stage", id: "d", kind: "deliver" },
			{ op: "step", stageId: "d", id: "ci", title: "CI green", kind: "ci.green", status: "done" },
		]);
		expect(result.problems.join()).toContain("Hive resolves");
		expect(lane(result.doc, "d")!.steps[0].status).toBe("pending");
	});

	it("reports an op it does not know rather than dropping it, and names what it would accept", () => {
		const result = wf(emptyPlan(NOW), [{ op: "teleport", id: "x" }]);
		expect(result.dropped.join()).toContain('unknown workflow op "teleport"');
		// Naming only the rejected word tells a caller nothing it did not already
		// know. The accepted set is what lets it fix the call on the next turn.
		expect(result.dropped.join()).toContain("stage");
	});

	it("accepts `lane` and `item`, the words its own description and `plan_write` use", () => {
		// THE HALF-APPLIED BATCH THIS PREVENTS. Measured before the alias:
		// `{op:"lane", kind:"execute", title:"Implement"}` fell to the default
		// branch and was dropped, and the `step` that followed then AUTO-CREATED
		// the lane — so the work landed in a lane titled "Execute", a title the
		// model never chose, with the one it did choose gone. The tool's own
		// description says "lanes" and `plan_write` spells the op `lane`, so this
		// is the word a model reaches for, not a mistake.
		const result = wf(emptyPlan(NOW), [
			{ op: "lane", kind: "execute", title: "Implement" },
			{ op: "item", stageId: "execute", id: "s1", title: "wire it" },
		]);
		expect(result.dropped).toEqual([]);
		const impl = lane(result.doc, "execute")!;
		expect(impl.title).toBe("Implement");
		expect(impl.steps.map((i) => i.id)).toEqual(["s1"]);
	});

	it("reads `lane` as the lane a step names, which is how plan_write spells it", () => {
		const result = wf(emptyPlan(NOW), [
			{ op: "stage", id: "impl", kind: "execute", title: "Implement" },
			{ op: "stage", id: "ver", kind: "verify", title: "Verify" },
			{ op: "step", lane: "impl", id: "s1", title: "wire it" },
		]);
		expect(lane(result.doc, "impl")!.steps.map((i) => i.id)).toEqual(["s1"]);
		expect(lane(result.doc, "ver")!.steps).toHaveLength(0);
	});

	it("says so when a lane op carries `items`, rather than dropping the work silently", () => {
		// `plan_write`'s `lane` op nests its items; this vocabulary's does not,
		// and the schema deliberately stays open, so an `items` array would
		// validate and then evaporate. The known edge of accepting the alias.
		const result = wf(emptyPlan(NOW), [
			{ op: "lane", kind: "execute", title: "Implement", items: [{ id: "s1", title: "wire it" }] },
		]);
		expect(result.notes.join()).toContain("items");
		expect(lane(result.doc, "execute")!.steps).toHaveLength(0);
	});

	it("says so when a step op nests its body, the other half of the same mismatch", () => {
		// `plan_write` sends `{op:"item", lane, item:{title, …}}`; this tool
		// carries those fields flat. A nested body leaves every field undefined,
		// which for a new item means a titleless one — so the caller is told what
		// was not read instead of finding a blank row.
		const result = wf(emptyPlan(NOW), [
			{ op: "stage", id: "impl", kind: "execute", title: "Implement" },
			{ op: "item", lane: "impl", item: { title: "wire it" } },
		]);
		expect(result.notes.join()).toContain('nested "item" object is not read');
	});

	it("tells the caller what applied separately from what did not", () => {
		// A lane status is mapped-but-lossy: the lane WAS written. Filing that
		// under "Not applied" beside a verb that produced nothing at all reads as
		// "your lane never landed", which is the opposite of what happened.
		const text = renderWorkflowReply("1 item(s) in the current lane", ["a lane's status is derived"], [
			'unknown workflow op "teleport" was ignored',
		]);
		expect(text).toContain("Applied, with changes:");
		expect(text).toContain("Not applied:");
		expect(text.indexOf("Applied, with changes:")).toBeLessThan(text.indexOf("Not applied:"));
		expect(text.slice(text.indexOf("Not applied:"))).not.toContain("derived");
	});

	it("reports that split from the tool itself, not only from the helper", async () => {
		// The helper being right proves nothing if `execute` still renders the old
		// single list, and nothing else in this file goes through the registered
		// tool. This is the only test that reads what a caller actually receives.
		let doc = emptyPlan(NOW);
		const host = {
			doc: () => doc,
			apply: (ops: readonly PlanOp[]) => {
				const applied = applyOps(doc, ops, LATER);
				doc = applied.doc;
				return applied;
			},
		};
		const tools = new Map<string, Record<string, unknown>>();
		registerFacadeTools({ registerTool: (definition) => tools.set(definition.name as string, definition) }, host);
		const workflowWrite = tools.get("workflow_write")!.execute as (
			id: string,
			params: { ops: WorkflowToolOp[] },
		) => Promise<{
			content: { text: string }[];
			details: { problems?: string[]; notes?: string[]; notApplied?: string[] };
		}>;

		const result = await workflowWrite("t", {
			// One op that landed and lost a field, one that landed nowhere.
			ops: [{ op: "stage", id: "impl", kind: "execute", status: "done" }, { op: "teleport" }],
		});
		const text = result.content[0].text;
		// Assert both headings EXIST before comparing their positions: a missing
		// one gives `indexOf` -1, and -1 is less than any real index, so ordering
		// alone reads as a pass when the section is not there at all. Measured —
		// reverting `execute` to the single-list rendering passed this test until
		// the two `toContain`s were added.
		expect(text).toContain("Applied, with changes:");
		expect(text).toContain("Not applied:");
		expect(text.indexOf("Applied, with changes:")).toBeLessThan(text.indexOf("Not applied:"));
		expect(text.slice(text.indexOf("Not applied:"))).not.toContain("derived from its items");
		expect(result.details.notes!.join()).toContain("derived from its items");
		expect(result.details.notApplied!.join()).toContain("teleport");
		// The union key survives under its original name: Hive's tasks widget and
		// every transcript reader key on it, so the split is added, not swapped.
		expect(result.details.problems).toHaveLength(2);
	});
});

describe("the two façades land in the same lane", () => {
	it("is the whole point of the merge", () => {
		// Before it, these were two documents and the todo list was MIRRORED into
		// the workflow by id — 65% of sessions held the same work twice.
		let doc = todo(emptyPlan(NOW), [{ id: "t1", subject: "wire the gate" }]);
		doc = wf(doc, [{ op: "stage", kind: "execute", title: "Implement" }]).doc;
		doc = wf(doc, [{ op: "step", stageId: "execute", id: "s1", title: "prove it" }]).doc;

		expect(lanesOf(doc)).toHaveLength(1);
		expect(lanesOf(doc)[0].steps.map((i) => i.id)).toEqual(["t1", "s1"]);
		expect(lanesOf(doc)[0].title).toBe("Implement");
	});
});
