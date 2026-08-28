/**
 * The plan-document fold.
 *
 * The assertions that matter are the ones a careless implementation gets wrong
 * silently, and every one of them is a way the plan could start lying:
 *
 *   - a re-stated steps block resetting finished work to `pending`
 *   - a status tick inflating the revision counter, so "how often did the plan
 *     change" stops meaning anything
 *   - an unknown block id quietly becoming a second block for the same idea
 *   - a removed block's id being handed out again, re-pointing stored references
 *   - an unknown block type surviving normalization, which is the hole the
 *     closed catalog exists to close
 */

import { describe, expect, it } from "vitest";
import {
	allSteps,
	applyOps,
	emptyPlan,
	isEmpty,
	MAX_ARTIFACT_CHARS,
	PLAN_ENTRY_TYPE,
	rehydratePlan,
	stepCounts,
	toEntry,
	validateSnapshot,
	type PlanDoc,
	type StepsBlock,
} from "../extensions/plan/state.ts";

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

const withSteps = (...titles: string[]): PlanDoc =>
	applyOps(emptyPlan(NOW), [{ op: "upsert", block: { type: "steps", steps: titles.map((title) => ({ title })) } }], NOW)
		.doc;

const stepsOf = (doc: PlanDoc): StepsBlock["steps"] => allSteps(doc);

describe("applyOps — blocks", () => {
	it("creates blocks with sequential ids and appends by default", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", block: { type: "text", markdown: "first" } },
				{ op: "upsert", block: { type: "text", markdown: "second" } },
			],
			NOW,
		);
		expect(result.created).toEqual(["1", "2"]);
		expect(result.doc.blocks.map((b) => b.id)).toEqual(["1", "2"]);
		expect(result.doc.nextId).toBe(3);
	});

	it("inserts after a named block", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", block: { type: "text", markdown: "a" } },
				{ op: "upsert", block: { type: "text", markdown: "c" } },
			],
			NOW,
		).doc;
		const result = applyOps(base, [{ op: "upsert", after: "1", block: { type: "text", markdown: "b" } }], LATER);
		expect(result.doc.blocks.map((b) => (b.type === "text" ? b.markdown : ""))).toEqual(["a", "b", "c"]);
	});

	it("appends and complains when `after` names an unknown block", () => {
		const base = applyOps(emptyPlan(NOW), [{ op: "upsert", block: { type: "text", markdown: "a" } }], NOW).doc;
		const result = applyOps(base, [{ op: "upsert", after: "99", block: { type: "text", markdown: "b" } }], LATER);
		expect(result.created).toEqual(["2"]);
		expect(result.problems.join()).toContain('unknown block "99"');
	});

	it("replaces in place, keeping position and created time", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", block: { type: "text", markdown: "a" } },
				{ op: "upsert", block: { type: "text", markdown: "b" } },
			],
			NOW,
		).doc;
		const result = applyOps(base, [{ op: "upsert", id: "1", block: { type: "text", markdown: "a2" } }], LATER);
		expect(result.updated).toEqual(["1"]);
		expect(result.doc.blocks[0]).toMatchObject({ id: "1", markdown: "a2", createdAt: NOW, updatedAt: LATER });
		expect(result.doc.blocks.map((b) => b.id)).toEqual(["1", "2"]);
	});

	it("creates with an author-chosen id when that id is new", () => {
		// The first live run found this: asked to create a plan, the model supplied
		// `id:"smoke-steps"` and an earlier version rejected it as unknown, so the
		// header applied and the steps silently did not. An `upsert` that cannot
		// insert is a trap.
		const result = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", id: "context", block: { type: "text", markdown: "why" } },
				{ op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "do it" }] } },
			],
			NOW,
		);
		expect(result.problems).toEqual([]);
		expect(result.created).toEqual(["context", "steps"]);
		expect(result.doc.blocks.map((b) => b.id)).toEqual(["context", "steps"]);
	});

	it("replaces rather than duplicating when an author-chosen id is reused", () => {
		const base = applyOps(emptyPlan(NOW), [{ op: "upsert", id: "risks", block: { type: "text", markdown: "a" } }], NOW).doc;
		const result = applyOps(base, [{ op: "upsert", id: "risks", block: { type: "text", markdown: "b" } }], LATER);
		expect(result.created).toEqual([]);
		expect(result.updated).toEqual(["risks"]);
		expect(result.doc.blocks).toHaveLength(1);
	});

	it("honours `after` when creating with an author-chosen id", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", id: "a", block: { type: "text", markdown: "a" } },
				{ op: "upsert", id: "c", block: { type: "text", markdown: "c" } },
			],
			NOW,
		).doc;
		const result = applyOps(base, [{ op: "upsert", id: "b", after: "a", block: { type: "text", markdown: "b" } }], LATER);
		expect(result.doc.blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
	});

	it("never lets a generated id collide with an author-chosen one", () => {
		// A plan mixing `1` with generated ids must not hand out `1` twice.
		const base = applyOps(emptyPlan(NOW), [{ op: "upsert", id: "1", block: { type: "text", markdown: "mine" } }], NOW).doc;
		const result = applyOps(base, [{ op: "upsert", block: { type: "text", markdown: "generated" } }], LATER);
		expect(result.doc.blocks.map((b) => b.id)).toEqual(["1", "2"]);
		expect(new Set(result.doc.blocks.map((b) => b.id)).size).toBe(2);
	});

	it("never reuses the id of a removed block", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", block: { type: "text", markdown: "a" } },
				{ op: "upsert", block: { type: "text", markdown: "b" } },
			],
			NOW,
		).doc;
		const afterRemove = applyOps(base, [{ op: "remove", id: "2" }], LATER).doc;
		const result = applyOps(afterRemove, [{ op: "upsert", block: { type: "text", markdown: "c" } }], LATER);
		expect(result.created).toEqual(["3"]);
	});

	it("moves a block, and refuses to move one after itself", () => {
		const base = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", block: { type: "text", markdown: "a" } },
				{ op: "upsert", block: { type: "text", markdown: "b" } },
				{ op: "upsert", block: { type: "text", markdown: "c" } },
			],
			NOW,
		).doc;

		const moved = applyOps(base, [{ op: "move", id: "3", after: "1" }], LATER);
		expect(moved.doc.blocks.map((b) => b.id)).toEqual(["1", "3", "2"]);

		const front = applyOps(base, [{ op: "move", id: "3" }], LATER);
		expect(front.doc.blocks.map((b) => b.id)).toEqual(["3", "1", "2"]);

		const self = applyOps(base, [{ op: "move", id: "2", after: "2" }], LATER);
		expect(self.problems.join()).toContain("cannot be moved after itself");
		expect(self.doc.blocks.map((b) => b.id)).toEqual(["1", "2", "3"]);
	});
});

describe("applyOps — the closed catalog", () => {
	it("rejects an unknown block type and names the real ones", () => {
		const result = applyOps(
			emptyPlan(NOW),
			// The catalog is the security property: passing an unknown type through
			// for "the renderer to cope with" is exactly the hole it closes.
			[{ op: "upsert", block: { type: "html", markdown: "<script>alert(1)</script>" } as never }],
			NOW,
		);
		expect(result.doc.blocks).toHaveLength(0);
		expect(result.problems.join()).toContain('unknown block type "html"');
		expect(result.problems.join()).toContain("text, steps, chart");
	});

	it("rejects a chart point without a finite numeric value", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[
				{
					op: "upsert",
					block: {
						type: "chart",
						chart: "bar",
						series: [
							{ label: "ok", value: 3 },
							{ label: "bad", value: Number.NaN },
						],
					},
				},
			],
			NOW,
		);
		expect(result.problems.join()).toContain("finite numeric value");
		const block = result.doc.blocks[0];
		expect(block.type === "chart" && block.series).toHaveLength(1);
	});

	it("pads a ragged table row rather than failing the block", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[{ op: "upsert", block: { type: "table", columns: ["a", "b", "c"], rows: [["1"], ["1", "2", "3", "4"]] } }],
			NOW,
		);
		const block = result.doc.blocks[0];
		expect(block.type === "table" && block.rows).toEqual([
			["1", "", ""],
			["1", "2", "3"],
		]);
	});

	// `artifact` is the one block whose payload is unbounded, so the cap is the
	// only thing standing between a plan snapshot and an arbitrarily large blob
	// that is re-emitted on every read.
	it("refuses an oversized artifact rather than truncating it", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[{ op: "upsert", block: { type: "artifact", html: "x".repeat(MAX_ARTIFACT_CHARS + 1) } }],
			NOW,
		);
		expect(result.doc.blocks).toHaveLength(0);
		// Truncating would render as garbage and read as the model's mistake
		// rather than the cap's, so the real reason is named.
		expect(result.problems.join()).toContain(String(MAX_ARTIFACT_CHARS));
	});

	it("accepts an artifact at the limit and keeps its html verbatim", () => {
		const html = "<!doctype html><style>b{color:red}</style><b>hi</b>";
		const result = applyOps(emptyPlan(NOW), [{ op: "upsert", block: { type: "artifact", html, height: 240.6 } }], NOW);
		const block = result.doc.blocks[0];
		expect(result.problems).toEqual([]);
		// Verbatim: the sandbox is what makes this safe, so nothing here rewrites
		// the document — a normalizer that "cleaned" it would be a second, weaker
		// sanitizer nobody audits.
		expect(block.type === "artifact" && block.html).toBe(html);
		expect(block.type === "artifact" && block.height).toBe(241);
	});

	it("rejects an empty artifact and an empty code block", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[
				{ op: "upsert", id: "a", block: { type: "artifact", html: "   " } },
				{ op: "upsert", id: "c", block: { type: "code", code: "\n\n" } },
			],
			NOW,
		);
		expect(result.doc.blocks).toHaveLength(0);
		expect(result.problems.join()).toContain("artifact block needs a non-empty html");
		expect(result.problems.join()).toContain("code block needs a non-empty code");
	});

	it("keeps a code block's indentation, which cleanString would have eaten", () => {
		const code = "  if (x) {\n    return 1;\n  }\n";
		const result = applyOps(emptyPlan(NOW), [{ op: "upsert", block: { type: "code", language: "ts", code } }], NOW);
		const block = result.doc.blocks[0];
		expect(block.type === "code" && block.code).toBe(code);
		expect(block.type === "code" && block.language).toBe("ts");
	});

	it("rejects a callout with an unknown tone", () => {
		const result = applyOps(
			emptyPlan(NOW),
			[{ op: "upsert", block: { type: "callout", tone: "spicy", markdown: "x" } as never }],
			NOW,
		);
		expect(result.doc.blocks).toHaveLength(0);
		expect(result.problems.join()).toContain("callout tone");
	});
});

describe("applyOps — set_step", () => {
	it("finds a step by id without being told which block holds it", () => {
		const base = withSteps("one", "two");
		const result = applyOps(base, [{ op: "set_step", id: "2", status: "done" }], LATER);
		expect(result.updated).toEqual(["1"]);
		expect(stepsOf(result.doc).map((s) => s.status)).toEqual(["pending", "done"]);
	});

	it("records a note without touching status", () => {
		const base = withSteps("one");
		const result = applyOps(base, [{ op: "set_step", id: "1", note: "turned out to need a migration" }], LATER);
		expect(stepsOf(result.doc)[0]).toMatchObject({ status: "pending", note: "turned out to need a migration" });
	});

	// `taskId` used to sit beside these. It was documented as "the tasks
	// extension id this step materialized into once approved" and
	// `scripts/plan-shape.mjs` found ZERO producers across 594 sessions —
	// nothing ever wrote it. Since the merge there is nothing for it to point
	// at either: the todo IS the item, and being in a lane is the relationship
	// the link was trying to express.
	it("clears owner and linearKey on null", () => {
		const base = applyOps(withSteps("one"), [{ op: "set_step", id: "1", owner: "w1", linearKey: "HIV-1" }], NOW).doc;
		expect(stepsOf(base)[0]).toMatchObject({ owner: "w1", linearKey: "HIV-1" });

		const cleared = applyOps(base, [{ op: "set_step", id: "1", owner: null, linearKey: null }], LATER);
		const step = stepsOf(cleared.doc)[0];
		expect(step.owner).toBeUndefined();
		expect(step.linearKey).toBeUndefined();
	});

	it("complains about an unknown step and an unknown status", () => {
		const base = withSteps("one");
		expect(applyOps(base, [{ op: "set_step", id: "9", status: "done" }], LATER).problems.join()).toContain(
			'no lane contains item "9"',
		);
		expect(
			applyOps(base, [{ op: "set_step", id: "1", status: "finished" as never }], LATER).problems.join(),
		).toContain("unknown item status");
	});
});

describe("applyOps — revision counts intent, not progress", () => {
	it("does not bump on a status tick", () => {
		const base = withSteps("one", "two");
		const before = base.revision;
		const result = applyOps(base, [{ op: "set_step", id: "1", status: "done" }], LATER);
		expect(result.doc.revision).toBe(before);
	});

	it("bumps once per batch that changes intent", () => {
		const base = withSteps("one");
		const result = applyOps(
			base,
			[
				{ op: "upsert", block: { type: "text", markdown: "rationale" } },
				{ op: "upsert", block: { type: "text", markdown: "risks" } },
			],
			LATER,
		);
		expect(result.doc.revision).toBe(base.revision + 1);
	});

	it("does not bump when every op was rejected", () => {
		const base = withSteps("one");
		const result = applyOps(base, [{ op: "remove", id: "nope" }], LATER);
		expect(result.doc.revision).toBe(base.revision);
		expect(result.problems).toHaveLength(1);
	});

	it("treats a phase change as progress but a goal change as intent", () => {
		const base = withSteps("one");
		expect(applyOps(base, [{ op: "header", phase: "ready" }], LATER).doc.revision).toBe(base.revision);
		expect(applyOps(base, [{ op: "header", goal: "ship it" }], LATER).doc.revision).toBe(base.revision + 1);
	});
});

describe("applyOps — re-stating a steps block preserves progress", () => {
	it("carries status and links across a reword matched by id", () => {
		// The failure this prevents: a model rewords a step list and every finished
		// step silently reverts to pending, so the plan reports that completed work
		// has not started.
		const base = applyOps(
			withSteps("read the schema", "wire the gate"),
			[{ op: "set_step", id: "1", status: "done", linearKey: "HIV-11" }],
			NOW,
		).doc;

		const result = applyOps(
			base,
			[
				{
					op: "upsert",
					id: "1",
					block: {
						type: "steps",
						steps: [
							{ id: "1", title: "read the schema carefully" },
							{ id: "2", title: "wire the gate" },
						],
					},
				},
			],
			LATER,
		);

		const steps = stepsOf(result.doc);
		expect(steps[0]).toMatchObject({ title: "read the schema carefully", status: "done", linearKey: "HIV-11" });
		expect(steps[1].status).toBe("pending");
	});

	it("falls back to matching by exact title when no id is supplied", () => {
		const base = applyOps(withSteps("wire the gate"), [{ op: "set_step", id: "1", status: "in_progress" }], NOW).doc;
		const result = applyOps(
			base,
			[{ op: "upsert", id: "1", block: { type: "steps", steps: [{ title: "wire the gate" }, { title: "new step" }] } }],
			LATER,
		);
		const steps = stepsOf(result.doc);
		expect(steps[0].status).toBe("in_progress");
		expect(steps[1].status).toBe("pending");
	});

	it("lets an explicit status win over the preserved one", () => {
		const base = applyOps(withSteps("one"), [{ op: "set_step", id: "1", status: "done" }], NOW).doc;
		const result = applyOps(
			base,
			[{ op: "upsert", id: "1", block: { type: "steps", steps: [{ id: "1", title: "one", status: "blocked" }] } }],
			LATER,
		);
		expect(stepsOf(result.doc)[0].status).toBe("blocked");
	});
});

describe("queries", () => {
	it("counts steps across every steps block", () => {
		const base = applyOps(
			withSteps("a", "b"),
			[{ op: "upsert", block: { type: "steps", steps: [{ title: "c" }] } }],
			NOW,
		).doc;
		const ticked = applyOps(base, [{ op: "set_step", id: "1", status: "done" }], LATER).doc;
		const counts = stepCounts(ticked);
		expect(counts.total).toBe(3);
		expect(counts.done).toBe(1);
		expect(counts.pending).toBe(2);
	});

	it("reports an empty plan as empty", () => {
		expect(isEmpty(emptyPlan(NOW))).toBe(true);
		expect(isEmpty(withSteps("a"))).toBe(false);
	});
});

describe("persistence", () => {
	it("round-trips through an entry", () => {
		const doc = applyOps(
			withSteps("one"),
			[{ op: "header", title: "Plan", goal: "ship" }, { op: "upsert", block: { type: "diagram", mermaid: "graph TD" } }],
			NOW,
		).doc;
		const restored = validateSnapshot(toEntry(doc));
		expect(restored).not.toBeNull();
		expect(restored?.title).toBe("Plan");
		expect(restored?.blocks.map((b) => b.type)).toEqual(["steps", "diagram"]);
	});

	it("rejects a snapshot from an unknown schema version", () => {
		expect(validateSnapshot({ kind: "plan", schemaVersion: 99, doc: { blocks: [] } })).toBeNull();
	});

	it("repairs a nextId that trails the live maximum", () => {
		// Trusting a stale counter hands the next block an id that already exists.
		const restored = validateSnapshot({
			kind: "plan",
			schemaVersion: 1,
			doc: { blocks: [{ id: "7", type: "text", markdown: "x" }], nextId: 2 },
		});
		expect(restored?.nextId).toBe(8);
	});

	it("drops blocks with an unknown type on rehydrate", () => {
		const restored = validateSnapshot({
			kind: "plan",
			schemaVersion: 1,
			doc: { blocks: [{ id: "1", type: "text", markdown: "ok" }, { id: "2", type: "iframe", src: "evil" }], nextId: 3 },
		});
		expect(restored?.blocks.map((b) => b.id)).toEqual(["1"]);
	});

	it("takes the newest valid snapshot and ignores foreign entries", () => {
		const first = applyOps(emptyPlan(NOW), [{ op: "header", title: "old" }], NOW).doc;
		const second = applyOps(first, [{ op: "header", title: "new" }], LATER).doc;
		const restored = rehydratePlan([
			{ customType: "tasks", data: { kind: "tasks" } },
			{ customType: PLAN_ENTRY_TYPE, data: toEntry(first) },
			{ customType: "agenda", data: {} },
			{ customType: PLAN_ENTRY_TYPE, data: toEntry(second) },
		]);
		expect(restored?.title).toBe("new");
	});

	it("returns null when no plan entry exists", () => {
		expect(rehydratePlan([{ customType: "tasks", data: {} }])).toBeNull();
	});
});
/**
 * A patch must not rename the item it patches.
 *
 * `normalizeItem` used to default `title` to the item's id. On the create path
 * that was invisible — a titleless new item is refused before it runs — but on
 * the PATCH path it was destructive: `writeItem` preserves a field by dropping
 * it when it is `undefined`, so a title that always had a value overwrote the
 * real one with the id.
 *
 * This is not hypothetical and it was not caught by the suite. Measured across
 * 77 real sessions, 27% of plans carried purely numeric step titles — "2",
 * "3", "4", which are `String(doc.nextId++)` — and one carried "local-gate",
 * a supplied id. Ticking a status renamed the item to its own id, so the plans
 * worked on hardest lost the most: a finished step is a ticked step.
 */
describe("a patch preserves the title it does not restate", () => {
	const NOW = 1_700_000_000_000;
	const LATER = NOW + 60_000;
	const titlesOf = (doc: ReturnType<typeof emptyPlan>) =>
		doc.blocks.flatMap((block) => (block.type === "steps" ? block.steps : [])).map((item) => item.title);

	it("keeps a supplied-id item's title through a status tick", () => {
		const planned = applyOps(emptyPlan(NOW), [
			{ op: "lane", kind: "execute", items: [{ id: "local-gate", title: "Run the local gate" }] },
		], NOW).doc;
		const ticked = applyOps(planned, [{ op: "item", item: { id: "local-gate", status: "done" } }], LATER).doc;
		expect(titlesOf(ticked)).toEqual(["Run the local gate"]);
		expect(ticked.blocks.flatMap((b) => (b.type === "steps" ? b.steps : []))[0].status).toBe("done");
	});

	it("keeps an AUTO-id item's title — the numeric case readers actually saw", () => {
		const planned = applyOps(emptyPlan(NOW), [
			{ op: "lane", kind: "execute", items: [{ title: "Rebase and inspect existing plan surfaces" }, { title: "Integrate the stage strip" }] },
		], NOW).doc;
		const ids = planned.blocks.flatMap((b) => (b.type === "steps" ? b.steps : [])).map((i) => i.id);
		const ticked = applyOps(planned, [{ op: "item", item: { id: ids[0], status: "done" } }], LATER).doc;
		expect(titlesOf(ticked)).toEqual(["Rebase and inspect existing plan surfaces", "Integrate the stage strip"]);
		// The regression's signature: a title equal to its own id.
		for (const item of ticked.blocks.flatMap((b) => (b.type === "steps" ? b.steps : []))) {
			expect(item.title).not.toBe(item.id);
		}
	});

	it("still refuses a new item that has no title at all", () => {
		const result = applyOps(emptyPlan(NOW), [{ op: "item", lane: "execute", item: { status: "pending" } }], NOW);
		expect(result.problems.join()).toContain("needs a title");
	});
});
