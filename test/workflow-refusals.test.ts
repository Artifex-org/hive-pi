/**
 * Refusals are a CHANNEL, not a shape of sentence.
 *
 * `applyOps` reports every op on one list, and the renderer used to sort that
 * list into "applied" and "not applied" with `!/^(stage|step) /` — on the
 * theory that a success line always opens with the noun it created. Three
 * refusals open the same way, so they were dropped from the result entirely,
 * which is the exact failure the loud heading exists to prevent. And when
 * `workflow_write` gained a notice for `plan_write`'s `set_step` spelling, that
 * matched neither pattern and was printed UNDER "Not applied:" — telling the
 * caller in one breath that the edit landed and that it did not. Two agents
 * reported that on 2026-08-18 ("This is contradictory and leaves callers unsure
 * whether the update landed").
 *
 * Every assertion here fails against the prose-sorted version.
 */

import { describe, expect, it } from "vitest";
import {
	applyOps,
	emptyWorkflow,
	MAX_STAGES,
	MAX_STEPS_PER_STAGE,
	type WorkflowDoc,
	type WorkflowOp,
} from "../extensions/workflow/state.ts";
import { renderWorkflow } from "../extensions/workflow/render.ts";

const NOW = 1_770_000_000_000;
const apply = (doc: WorkflowDoc, ...ops: WorkflowOp[]) => applyOps(doc, ops, NOW);

describe("applyOps classifies at the push site", () => {
	// The success lines stay in `notes` — several tests and the adopt path read
	// them — but they are NOT refusals, and that is now stated rather than
	// guessed from the first word.
	it("keeps what landed out of the refusal channel", () => {
		const result = apply(emptyWorkflow(NOW), { op: "stage", title: "Build" });
		expect(result.notes.some((n) => /^stage s\d/.test(n))).toBe(true);
		expect(result.refused).toEqual([]);
	});

	it("reports a refusal in both channels", () => {
		const result = apply(emptyWorkflow(NOW), { op: "step", title: "orphan" });
		expect(result.refused).toContain("no stage to add a step to");
		// `notes` remains the full account, so nothing that read it before is
		// now missing a line.
		expect(result.notes).toContain("no stage to add a step to");
	});

	// THE BUG. A refusal whose first word is "stage" or "step" matched the
	// success shape and never reached the caller: the batch silently did less
	// than it was asked, and said nothing at all.
	it("does not lose a refusal that opens with the noun it refuses", () => {
		let doc = emptyWorkflow(NOW);
		for (let i = 0; i < MAX_STAGES; i++) doc = apply(doc, { op: "stage", title: `S${i}` }).doc;
		const capped = apply(doc, { op: "stage", title: "one too many" });

		expect(capped.refused.some((n) => /stage limit reached/.test(n))).toBe(true);
		// …and it survives all the way to what the model actually reads.
		expect(renderWorkflow(capped.doc, capped.refused)).toContain("stage limit reached");
	});

	it("does not lose the step-limit refusal either", () => {
		let doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Build" }).doc;
		for (let i = 0; i < MAX_STEPS_PER_STAGE; i++) {
			doc = apply(doc, { op: "step", title: `t${i}` }).doc;
		}
		const capped = apply(doc, { op: "step", title: "one too many" });

		expect(capped.refused.some((n) => /step limit reached/.test(n))).toBe(true);
		expect(renderWorkflow(capped.doc, capped.refused)).toContain("step limit reached");
	});
});

describe("renderWorkflow", () => {
	const doc = apply(emptyWorkflow(NOW), { op: "stage", title: "Build" }).doc;

	it("says nothing extra when the batch applied cleanly", () => {
		expect(renderWorkflow(doc, [])).not.toContain("Not applied");
	});

	it("shouts every refusal under one heading", () => {
		const out = renderWorkflow(doc, ['no stage "nope"', "step limit reached for s1"]);
		expect(out).toContain("**Not applied:**");
		expect(out).toContain('- no stage "nope"');
		expect(out).toContain("- step limit reached for s1");
	});

	// The reported papercut, verbatim in shape: a notice describes what DID
	// happen, so it must not appear under a heading that denies it.
	it("never files a notice under Not applied", () => {
		const notice = "Applied `set_step` → `step` — that is plan_write's spelling; workflow_write's own is the shorter one.";
		const out = renderWorkflow(doc, [], [notice]);

		expect(out).toContain("set_step");
		expect(out).not.toContain("Not applied");
	});

	// Both at once is the case that has to stay readable: the caller needs to
	// see which of the two sentences is about its failure.
	it("keeps a notice and a refusal apart when both happen", () => {
		const out = renderWorkflow(doc, ['no stage "nope"'], ["Applied `set_step` → `step`."]);
		const heading = out.indexOf("**Not applied:**");
		const refusal = out.indexOf('- no stage "nope"');
		const notice = out.indexOf("_Applied `set_step`");

		expect(heading).toBeGreaterThan(-1);
		expect(refusal).toBeGreaterThan(heading);
		// The notice sits outside the refusal block, after it — not among the
		// bullets the heading governs.
		expect(notice).toBeGreaterThan(refusal);
		expect(out.slice(heading, notice)).not.toContain("_Applied");
	});
});
