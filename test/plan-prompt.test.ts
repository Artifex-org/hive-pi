/**
 * The plan-mode prompt.
 *
 * A prompt is usually not worth a test. This one is, for one reason: it is the
 * ONLY place the model learns what a block type is. The renderer, the
 * normalizer, the tool schema and the stored document can all be perfectly
 * correct about a type the prompt never mentions, and the result is a block
 * nothing ever emits — a feature that exists everywhere except in the one place
 * that would cause it to be used. Every other test in this repo passes in that
 * state.
 */

import { describe, expect, it } from "vitest";
import { buildPlanPrompt, PLAN_MODE_MARKER } from "../extensions/plan/prompt.ts";
import { VALID_BLOCK_TYPES } from "../extensions/plan/state.ts";

const prompt = buildPlanPrompt();

describe("buildPlanPrompt", () => {
  it("carries the marker the mode is detected by", () => {
    expect(prompt).toContain(PLAN_MODE_MARKER);
  });

  // The drift guard. Adding a type to the catalog and forgetting the vocabulary
  // table is the failure this file exists for.
  it("names every block type in the catalog", () => {
    for (const type of VALID_BLOCK_TYPES) {
      expect(prompt, `the prompt never mentions the \`${type}\` block`).toContain(`\`${type}\``);
    }
  });

  // `artifact` is the one block that is opaque — to the terminal render, to
  // theming, to export — and the failure it invites is an agent answering every
  // question with an HTML blob. The prompt has to say so, not merely offer it.
  it("presents artifact as a last resort rather than as a peer", () => {
    expect(prompt).toContain("last resort");
    expect(prompt.toLowerCase()).toContain("opaque");
  });

  // Every mechanical constraint the sandbox imposes has to reach the author, or
  // they write a document that silently renders without its font and its data.
  it("states the artifact sandbox's constraints", () => {
    expect(prompt).toMatch(/self-contained/i);
    expect(prompt.toLowerCase()).toContain("no cdn");
    expect(prompt).toMatch(/data:/);
  });

  /**
   * REVERSED 2026-08-28, on measurement, and worth saying plainly because the
   * assertion this replaces was deliberate rather than careless.
   *
   * "Show it" was trimmed to exactly two sentences pointing at the lint, on the
   * theory that a mechanism beats prose: let the lint carry the nudge and keep
   * the prompt short. That theory was tested and lost. Across 487 plans written
   * with the lint live, 44% were still prose-and-checklist only — against a 43%
   * baseline before it — at 3.0 blocks each, with chart and artifact at 0%.
   *
   * The lint could not carry it because most of its rules read prose to find a
   * better representation for it, and the failing plans had almost no prose to
   * read. So the section now TEACHES the shape and shows one worked example,
   * which is the lever a model actually imitates.
   *
   * The sentence count is therefore gone, but this is not a loosened test: it
   * pins the four things the section must still do, including the restraint —
   * without that last clause an author is being told to decorate.
   */
  it("teaches the plan's shape, shows it, and still defers to the lint", () => {
    const section = prompt.match(/## Show it, do not only say it\n([\s\S]+?)\n## Finishing/)?.[1];
    expect(section).toBeTruthy();
    // The three-part shape, named.
    expect(section).toMatch(/`text` — why/);
    expect(section).toMatch(/`steps` — what/);
    expect(section).toMatch(/evidence/i);
    // A worked example, not just a description of one.
    expect(section).toContain("plan_write({ ops: [");
    // Still points at the mechanism rather than replacing it with prose...
    expect(section).toContain("advisory composition lint");
    // ...and still tells the author it is advice, which is what keeps a nudge
    // from becoming a demand to decorate a plan that is already clear.
    expect(section).toMatch(/never as a requirement/);
  });
});
