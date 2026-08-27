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

  // Without this the agent writes prose and a checklist — two of ten types —
  // because nothing asked it not to.
  it("tells the agent to reach past prose and steps", () => {
    expect(prompt).toContain("Show it, do not only say it");
    // The test it gives, which is what keeps this from becoming "add charts".
    expect(prompt).toMatch(/would a reader understand this faster/i);
  });
});
