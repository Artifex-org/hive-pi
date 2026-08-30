/**
 * `only=lint` on a Hive-adopter repo that ALSO vendors quality-gate (pyERP has
 * both) went to the VENDORED gate, where `lint` is not a check name — so the
 * gate ran 0 checks and answered "NOTHING CHECKED" after 30–166s. The repo's
 * own docs teach the step vocabulary (`hive check --step lint`), so agents
 * wrote step names, burned the round trip, then shelled out by hand: 17
 * papercuts in the 7 days to 2026-08-30 (HIV-3077).
 *
 * selectorMatchedNothing is the discriminator index.ts uses to re-dispatch
 * that exact state through the Hive pipeline instead. The dangerous direction
 * is firing when it should not: a redispatch buries the vendored gate's real
 * verdict under a fleet run's, so every "did check something" and every "did
 * fail" state must stay false.
 */

import { describe, expect, it } from "vitest";

import { selectorMatchedNothing } from "../extensions/gate/gate.ts";
import type { GateResult } from "../extensions/gate/gate.ts";

const zeroCheckPass: GateResult = { passed: true, checks: [], failures: [], total_duration_ms: 31_900 };

describe("selectorMatchedNothing", () => {
	it("fires on the measured state: a selector, a pass, zero checks", () => {
		expect(selectorMatchedNothing("lint", zeroCheckPass)).toBe(true);
		expect(selectorMatchedNothing("lint,test-mobile", zeroCheckPass)).toBe(true);
	});

	it("fires when the trailer omits the arrays entirely", () => {
		// reporter.sh only emits what ran; a zero-check run can carry no keys.
		expect(selectorMatchedNothing("test-backend", { passed: true })).toBe(true);
	});

	it("never fires without a selector — a bare zero-check pass is report()'s NOTHING CHECKED case", () => {
		expect(selectorMatchedNothing(undefined, zeroCheckPass)).toBe(false);
		expect(selectorMatchedNothing("", zeroCheckPass)).toBe(false);
	});

	it("never fires when the gate actually checked something", () => {
		expect(
			selectorMatchedNothing("ruff_lint", {
				passed: true,
				checks: [{ name: "ruff_lint", status: "pass" }],
				failures: [],
			}),
		).toBe(false);
	});

	it("never fires on a failing gate — a real verdict must not be buried under a redispatch", () => {
		expect(selectorMatchedNothing("lint", { passed: false, checks: [], failures: ["lint"] })).toBe(false);
		expect(selectorMatchedNothing("lint", { passed: true, checks: [], failures: ["ruff_lint"] })).toBe(false);
	});

	it("never fires with no trailer at all — a gate that died mid-run is its own error path", () => {
		expect(selectorMatchedNothing("lint", null)).toBe(false);
	});
});
