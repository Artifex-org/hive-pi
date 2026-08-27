/**
 * The THIRD rejection shape: a step this repo's pipeline does not have.
 *
 * `prunedStepSurvivors` covers a step the pipeline DECLARES and this diff
 * pruned. A misspelling is deliberately left to the caller. Neither covers
 * hive-pi, whose pipeline has no `lint` step at all — and `DEFAULT_STEPS` is
 * `["lint"]`, so EVERY `quality_gate` call there that named no `only` asked for
 * a step that cannot exist and came back `NO VERDICT` (2026-08-19 01:52).
 * Not an unlucky diff the way a prune is: a permanent property of the repo.
 *
 * The fixture is the LIVE 400, captured by running `hive check --step lint` in
 * a hive-pi worktree — not written from memory. That mattered: the real list
 * sits MID-sentence ("…: test, typecheck. It may still be a real step…"),
 * where the pruned message ends with its list, and the first parser written
 * from memory swallowed the entire explanation as step names.
 */

import { describe, expect, it } from "vitest";

import { namedSteps, planStepsFromRefusal, recoveryFor, stepsFrom } from "../extensions/gate/hivecheck.ts";

/** Verbatim, from `hive check --step lint` in hive-pi on 2026-08-19. */
const ABSENT = "hive: POST /api/v1/runs: 400 Bad Request: {\"type\":\"https://hive.dev/errors/bad_request\",\"code\":\"bad_request\",\"title\":\"Bad Request\",\"status\":400,\"detail\":\"step \\\"lint\\\" is not in this run's plan. Steps in this plan: test, typecheck. It may still be a real step this run pruned away \u2014 a pipeline gates steps on ctx.changed, so a diff touching none of a step's inputs drops it. Use --full to run the whole gate, or include a file that step reads\",\"request_id\":\"b8ec2eb8-59e6-40c5-a622-9cd5b1a40723\",\"retryable\":false,\"error\":\"step \\\"lint\\\" is not in this run's plan. Steps in this plan: test, typecheck. It may still be a real step this run pruned away \u2014 a pipeline gates steps on ctx.changed, so a diff touching none of a step's inputs drops it. Use --full to run the whole gate, or include a file that step reads\"}";

describe("planStepsFromRefusal", () => {
  it("recovers the steps this repo's plan does have", () => {
    expect(planStepsFromRefusal(ABSENT)).toEqual(["test", "typecheck"]);
  });

  it("stops at the sentence, not at the next quote", () => {
    // The regression the live fixture caught: the explanation that follows the
    // list is prose, and returning it as step names would dispatch nonsense.
    for (const s of planStepsFromRefusal(ABSENT) ?? []) {
      expect(s).not.toMatch(/\s/);
      expect(s.length).toBeLessThan(40);
    }
  });

  it("does NOT fire on a prune — that has its own recovery and its own list", () => {
    const pruned =
      'hive: 400: {"detail":"step \\"lint\\" is not in this run\'s plan because this run PRUNED it: ' +
      'the pipeline declares it. Steps that DID survive: file-length, loc, web-check"}';
    expect(planStepsFromRefusal(pruned)).toBeNull();
  });

  it("does NOT fire when the server saw a typo", () => {
    // "Did you mean" is the server's own evidence of a misspelling, and running
    // something else on the caller's behalf is what the sibling refuses to do.
    const typo =
      'hive: 400: {"detail":"step \\"linte\\" is not in this run\'s plan. ' +
      'Steps in this plan: lint, test. Did you mean \\"lint\\"?"}';
    expect(planStepsFromRefusal(typo)).toBeNull();
  });

  it("is null for every ordinary failure, so the verbatim refusal is untouched", () => {
    expect(planStepsFromRefusal("")).toBeNull();
    expect(planStepsFromRefusal("hive: connection refused")).toBeNull();
    expect(planStepsFromRefusal('{"detail":"this pipeline evaluated to zero steps"}')).toBeNull();
  });
});

describe("namedSteps — who chose the step", () => {
  // The whole gate on the new recovery. A step WE defaulted to is our bug; a
  // step the caller typed is theirs, and silently running something else is how
  // `--step lint` becomes the whole gate.
  it("is null when the caller named none", () => {
    expect(namedSteps(undefined)).toBeNull();
    expect(namedSteps("")).toBeNull();
    expect(namedSteps("  , ,")).toBeNull();
    // …and the default is still what runs.
    expect(stepsFrom(undefined)).toEqual(["lint"]);
  });

  it("returns exactly what the caller named", () => {
    expect(namedSteps("typecheck")).toEqual(["typecheck"]);
    expect(namedSteps(" test , typecheck ")).toEqual(["test", "typecheck"]);
    expect(stepsFrom("test,typecheck")).toEqual(["test", "typecheck"]);
  });
});

// The DECISION, which is the part that was actually broken — the parsers were
// only ever how it finds out. Who chose the step decides whether we may run
// something else on the caller's behalf.
describe("recoveryFor", () => {
  const PRUNED =
    'hive: 400: {"detail":"step \\"lint\\" is not in this run\'s plan because this run PRUNED it: ' +
    'the pipeline declares it. Steps that DID survive: file-length, loc, web-check"}';

  it("runs this run's plan when OUR default named a step the repo lacks", () => {
    expect(recoveryFor(undefined, ABSENT)).toEqual({ steps: ["test", "typecheck"], why: "absent" });
  });

  it("refuses verbatim when the CALLER named the step", () => {
    // Same message, different author of the mistake. This is the whole guard:
    // silently substituting steps for a name someone typed is how `--step lint`
    // becomes the whole gate.
    expect(recoveryFor("lint", ABSENT)).toBeNull();
  });

  it("still recovers a prune, whoever asked for it", () => {
    // A prune is the plan's answer about this DIFF, not about the name, so it
    // is safe either way and predates this change.
    expect(recoveryFor(undefined, PRUNED)).toEqual({
      steps: ["file-length", "loc", "web-check"],
      why: "pruned",
    });
    expect(recoveryFor("lint", PRUNED)).toEqual({
      steps: ["file-length", "loc", "web-check"],
      why: "pruned",
    });
  });

  it("has nothing to say about an ordinary failure", () => {
    expect(recoveryFor(undefined, "hive: connection refused")).toBeNull();
    expect(recoveryFor(undefined, "")).toBeNull();
  });
});
