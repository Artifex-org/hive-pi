/**
 * A dispatch that could not finish must not be reported as a fact.
 *
 * `hive check` classifies its own exits (hive `cmd/hive/exitcode.go`, HIV-664)
 * and reserves 4 for "the result was never confirmed": the create-run POST's
 * response was lost AFTER the body was delivered, so the server was very likely
 * already evaluating the snapshot. That file's own comment on the code reads
 * "1 is worse still: it asserts a verdict nobody has" — and the gate wrapper was
 * asserting exactly that one layer up, reporting every no-ref outcome alike as
 * `created no run`.
 *
 * Measured 2026-09-05..07: 88 papercuts across two developers, 77 MB uploaded,
 * `context deadline exceeded`, then `NO VERDICT — created no run`. One agent
 * caught it unaided — "A timeout is indeterminate, not proof no run was
 * created" — and another recorded that the false certainty had already steered
 * it wrong.
 *
 * The signal half was worse: `code ?? 0` turned the dispatch timeout's SIGKILL
 * into a clean exit 0.
 *
 * These drive the REAL `dispatch()` against a fake `hive` on PATH, so the
 * verdicts under test come from the actual child-process plumbing rather than
 * from hand-built objects.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch, dispatchUnconfirmed, EXIT_UNCONFIRMED } from "../extensions/gate/hiverun.ts";

let bin: string;
let realPath: string | undefined;

/** Install a fake `hive` whose body is `script`. */
function fakeHive(script: string): void {
	const file = join(bin, "hive");
	writeFileSync(file, `#!/bin/bash\n${script}\n`);
	chmodSync(file, 0o755);
}

beforeAll(() => {
	bin = mkdtempSync(join(tmpdir(), "hive-pi-dispatch-"));
	realPath = process.env.PATH;
	process.env.PATH = `${bin}:${realPath ?? ""}`;
});

afterAll(() => {
	process.env.PATH = realPath;
	rmSync(bin, { recursive: true, force: true });
});

describe("dispatch reports what the CLI could establish", () => {
	it("keeps exit 4 as its own outcome, and never calls it success", async () => {
		// The real shape: the CLI's own unconfirmed-create guidance on stderr.
		fakeHive(
			'echo "hive: Post \\"https://app.hiveci.io/api/v1/runs\\": context deadline exceeded" >&2\n' +
				'echo "DO NOT simply re-run: the snapshot finished uploading" >&2\n' +
				`exit ${EXIT_UNCONFIRMED}`,
		);
		const run = await dispatch(["lint"], process.cwd(), undefined);
		expect(run.code).toBe(4);
		expect(run.signal).toBeNull();
		expect(run.ref).toBeNull();
		expect(dispatchUnconfirmed(run)).toBe(true);
	});

	it("does NOT report a signal kill as exit 0", async () => {
		// `code ?? 0` was the bug: a process killed mid-upload closes with a null
		// code, and substituting 0 claimed it exited cleanly.
		fakeHive('echo "packing working tree..."\nkill -9 $$');
		const run = await dispatch(["lint"], process.cwd(), undefined);
		expect(run.code).not.toBe(0);
		expect(run.code).toBeNull();
		expect(run.signal).toBe("SIGKILL");
		expect(dispatchUnconfirmed(run)).toBe(true);
	});

	it("leaves a definite refusal definite, so the CLI's own text still speaks", async () => {
		// An unknown step name comes back with the pipeline's ACTUAL step list —
		// the thing nothing in the wrapper could reconstruct. That IS a fact about
		// the run, and must keep being reported as one.
		fakeHive('echo "hive: step \\"lnit\\" is not in this run plan" >&2\nexit 2');
		const run = await dispatch(["lnit"], process.cwd(), undefined);
		expect(run.code).toBe(2);
		expect(run.signal).toBeNull();
		expect(dispatchUnconfirmed(run)).toBe(false);
	});

	it("leaves a plain gate failure definite", async () => {
		fakeHive("exit 1");
		const run = await dispatch(["lint"], process.cwd(), undefined);
		expect(dispatchUnconfirmed(run)).toBe(false);
	});

	it("leaves a setup failure definite — exit 3 promises the gate never ran", async () => {
		fakeHive('echo "hive: not inside a git repository" >&2\nexit 3');
		const run = await dispatch(["lint"], process.cwd(), undefined);
		expect(run.code).toBe(3);
		expect(dispatchUnconfirmed(run)).toBe(false);
	});

	it("still parses the run ref out of a successful dispatch", async () => {
		// The happy path must survive the shape change.
		fakeHive('echo "run 4821 https://app.hiveci.io/runs/4821"\nexit 0');
		const run = await dispatch(["lint"], process.cwd(), undefined);
		expect(run.code).toBe(0);
		expect(dispatchUnconfirmed(run)).toBe(false);
	});
});
