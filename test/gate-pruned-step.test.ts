/**
 * A pruned step is not a refusal (measured 2026-08-17).
 *
 * `hive check --step lint` on a web-only diff comes back 400: Hive's `lint` is
 * `go vet`, gated on `ctx.changed`, so a diff touching only `web/` prunes it out
 * of the plan. The server is right, and it says so in a sentence that also names
 * the steps that DID survive — and the gate threw all of that away and reported
 * `NO VERDICT`. Six agents on 2026-08-17 shipped with nothing verified.
 */

import { describe, expect, it } from "vitest";

import { prunedStepSurvivors } from "../extensions/gate/hivecheck.ts";

/** The live 400, as the CLI prints it. */
const PRUNED =
  'hive: POST /api/v1/runs: 400 Bad Request: {"type":"https://hive.dev/errors/bad_request",' +
  '"code":"bad_request","title":"Bad Request","status":400,"detail":"step \\"lint\\" is not in ' +
  "this run's plan because this run PRUNED it: the pipeline declares it, and its when= was false " +
  "for this event/diff (a step gated on ctx.changed drops out when the diff touches none of its " +
  "inputs). It is not a typo and the name is right. Use --full to run the whole gate, or include " +
  'a file that step reads. Steps that DID survive: file-length, loc, web-check","request_id":"cd7eabf0"}';

describe("prunedStepSurvivors", () => {
  it("recovers the steps the plan kept", () => {
    expect(prunedStepSurvivors(PRUNED)).toEqual(["file-length", "loc", "web-check"]);
  });

  it("does NOT fire on an unknown step — that is a typo, not a prune", () => {
    // The discriminator that matters. This message also carries a step list, and
    // retrying it would run steps the caller never asked for because they
    // misspelled one — a `--step lint` quietly becoming the whole gate.
    const typo =
      'hive: POST /api/v1/runs: 400 Bad Request: {"detail":"unknown step \\"linte\\"; ' +
      'available steps: lint, file-length, loc, web-check","request_id":"ede6a0c9"}';
    expect(prunedStepSurvivors(typo)).toBeNull();
  });

  it("is null for every ordinary failure, so the verbatim refusal path is untouched", () => {
    expect(prunedStepSurvivors("")).toBeNull();
    expect(prunedStepSurvivors("hive: connection refused")).toBeNull();
    expect(prunedStepSurvivors("packed 3650 files (7.6 MB), uploading…")).toBeNull();
    // PRUNED without a survivor list is not actionable — nothing to retry with.
    expect(prunedStepSurvivors("this run PRUNED it: the pipeline declares it")).toBeNull();
  });

  it("stops at the JSON field boundary rather than swallowing the rest of the payload", () => {
    // The list sits inside a JSON string; a greedy match would drag
    // `","request_id":"…` in as a step name and dispatch garbage.
    const steps = prunedStepSurvivors(PRUNED)!;
    expect(steps.every((s) => !s.includes("request_id"))).toBe(true);
    expect(steps.every((s) => !s.includes('"'))).toBe(true);
  });

  it("handles a single surviving step", () => {
    expect(
      prunedStepSurvivors('…this run PRUNED it: … Steps that DID survive: web-check","request_id":"x"}'),
    ).toEqual(["web-check"]);
  });
});
