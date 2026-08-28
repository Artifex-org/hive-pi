import { describe, expect, it } from "vitest";
import { consume, emptyProgress, finish, widgetEnvelope } from "../extensions/gate/stream.ts";

/**
 * Marker lines copied from the emitter's own printf (quality-gate
 * lib/utils.sh:237 and :257) rather than paraphrased, because the whole value
 * of this parser is that it reads what is actually written.
 */
const start = (n: string) => `##hive:substep {"name":"${n}","phase":"start"}`;
const end = (n: string, outcome: string, ms = 100, message = "") =>
	`##hive:substep {"name":"${n}","phase":"end","outcome":"${outcome}","duration_ms":${ms},"message":"${message}"}`;

describe("consume", () => {
	it("folds an end marker into a finished check, and hides it from the model", () => {
		const p = emptyProgress("quick", "changed");
		const r = consume(p, end("python/ruff_lint", "passed", 412));
		expect(r).toEqual({ changed: true, hide: true });
		expect(p.checks).toEqual([
			{ name: "python/ruff_lint", outcome: "passed", duration_ms: 412, message: undefined },
		]);
		expect(p.done).toBe(1);
	});

	// The emitter deliberately reports a `warn` as outcome "passed" — a red
	// substep inside a green CI step reads as a broken UI — and puts the truth in
	// the message. Without recovering it here an advisory is invisible.
	it("recovers an advisory from the message the emitter hides it in", () => {
		const p = emptyProgress("quick", "changed");
		consume(p, end("js/oxlint", "passed", 90, "advisory finding (non-blocking)"));
		expect(p.checks[0].outcome).toBe("advisory");
		expect(p.advisories).toEqual(["js/oxlint"]);
		expect(p.failures).toEqual([]);
	});

	it("collects failures", () => {
		const p = emptyProgress("quick", "changed");
		consume(p, end("python/mypy", "failed", 8100));
		expect(p.failures).toEqual(["python/mypy"]);
		expect(p.checks[0].outcome).toBe("failed");
	});

	it("tracks start markers under the serial runner", () => {
		const p = emptyProgress("quick", "changed");
		consume(p, start("python/mypy"));
		expect(p.running).toEqual(["python/mypy"]);
		consume(p, end("python/mypy", "passed"));
		expect(p.running).toEqual([]);
	});

	it("reads the run banner for the denominator", () => {
		const p = emptyProgress("quick", "changed");
		const r = consume(p, "  Mode: quick | Files: staged | Checks: 27");
		// The banner is real output, so it is NOT hidden from the model.
		expect(r).toEqual({ changed: true, hide: false });
		expect(p.total).toBe(27);
	});

	// `--changed --lint-all`, which is what scope:"all" maps to, produces a Files
	// label with commas and equals signs. A `\w+` pattern would silently lose the
	// denominator on the single most expensive scope there is.
	it("reads a banner whose Files label is not one word", () => {
		const p = emptyProgress("thorough", "all");
		consume(p, "  Mode: thorough | Files: lint=full_repo, tests=changed | Checks: 52");
		expect(p.total).toBe(52);
		expect(p.scope).toBe("lint=full_repo, tests=changed");
	});

	// The emitter prefixes an `i` glyph, so a start-anchored pattern matches
	// nothing — and under the parallel runner this line is the ONLY source of
	// what is still going.
	it("reads the stall heartbeat despite its glyph prefix", () => {
		const p = emptyProgress("thorough", "all");
		const r = consume(p, "i still running: python/mypy (63s), python/basedpyright (61s) — 4 queued");
		expect(r.changed).toBe(true);
		expect(p.running).toEqual(["python/mypy", "python/basedpyright"]);
	});

	it("hides a malformed marker rather than showing protocol noise", () => {
		const p = emptyProgress("quick", "changed");
		expect(consume(p, "##hive:substep {not json}")).toEqual({ changed: false, hide: true });
		expect(p.checks).toEqual([]);
	});

	it("passes ordinary output straight through", () => {
		const p = emptyProgress("quick", "changed");
		expect(consume(p, "src/app.py:12:1: F401 unused import")).toEqual({
			changed: false,
			hide: false,
		});
	});
});

describe("finish", () => {
	// The fixture carries a check because a zero-check trailer is no longer a
	// pass anywhere (see the nosummary case below) — a PASS spec has to come
	// from a run that actually checked something.
	it("stamps a pass and normalises missing tools to objects", () => {
		const p = finish(emptyProgress("quick", "changed"), {
			passed: true,
			total_duration_ms: 41000,
			checks: [{ name: "python/ruff_lint", status: "pass" }],
			skipped_missing_tools: [{ tool: "gitleaks", reason: "not installed" }, "bandit"],
		}, 0);
		expect(p.status).toBe("pass");
		expect(p.missing_tools).toEqual([
			{ tool: "gitleaks", reason: "not installed" },
			{ tool: "bandit" },
		]);
		expect(p.running).toEqual([]);
	});

	// A gate that died before its summary made NO verdict. Folding this into
	// `fail` would be a verdict; folding it into `pass` would be a lie.
	it("keeps a missing summary as its own status, never a pass or a fail", () => {
		const p = finish(emptyProgress("quick", "changed"), null, 2);
		expect(p.status).toBe("nosummary");
		expect(p.exit_code).toBe(2);
	});

	// The widget half of "a pass that checked nothing is not a pass". The text
	// path has refused this since gate.ts's zero-check branch; the spec that
	// feeds the deck and the browser card still stamped `pass`, so the same run
	// read NOTHING CHECKED in the transcript and PASS on the card.
	it("refuses to stamp a pass on a trailer that checked nothing", () => {
		const p = finish(emptyProgress("quick", "changed"), { passed: true }, 0);
		expect(p.status).toBe("nosummary");
	});

	// A run that was SIGNALLED has no exit code at all. `exit_code` is a shared
	// widget field typed `number` (HIV-1366), so it must be left unset rather
	// than carrying a null across the contract.
	it("leaves exit_code unset when the run was signalled", () => {
		const p = finish(emptyProgress("quick", "changed"), null, null);
		expect(p.status).toBe("nosummary");
		expect(p.exit_code).toBeUndefined();
	});

	it("prefers the trailer's failures over markers cut short by fast-fail", () => {
		const p = emptyProgress("quick", "changed");
		consume(p, end("a", "failed"));
		finish(p, { passed: false, failures: ["a", "b"] }, 1);
		expect(p.failures).toEqual(["a", "b"]);
	});
});

describe("widgetEnvelope", () => {
	it("is the shape hive's registry dispatches on", () => {
		const e = widgetEnvelope(emptyProgress("quick", "changed"));
		expect(e.hive_widget.v).toBe(1);
		expect(e.hive_widget.type).toBe("gate");
		expect(e.hive_widget.spec.status).toBe("running");
	});
});
