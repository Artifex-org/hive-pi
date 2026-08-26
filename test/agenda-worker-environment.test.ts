/**
 * Two environment fixes, both found by measuring rather than reading.
 *
 *  1. A gate that CANNOT RUN must never be reported as a gate that ran and
 *     failed (HIV-1099).
 *  2. A worker must not inherit the interactive session's context pack
 *     (HIV-1109).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bashAvailable, gatePolicy } from "../extensions/agenda/gate.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";
import { createFakePi } from "./fake-pi.ts";
import { ensureBash } from "./bash-shim.ts";

// The "bash IS present" cases must hold on a host without bash too — the CI
// image has none. The shim makes the assertion about behaviour, not environment.
//
// `basePath` is captured INSIDE beforeAll, after the shim is installed. Reading
// it at module scope would snapshot the pre-shim PATH, and the first afterEach
// would then quietly revert the shim — a failure that only appears on a host
// which actually needs it, which is to say only in CI.
let basePath: string | undefined;
beforeAll(() => {
	ensureBash();
	basePath = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = basePath;
	vi.unstubAllEnvs();
	vi.resetModules();
});

function makeGatedRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-env-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: "exit 1", checkTimeoutMs: 5000 }));
	return root;
}

const context = (cwd: string) => ({ cwd, ledger: emptyLedger, lastAssistantText: undefined, transcript: "" });

describe("HIV-1099 — a gate that cannot run is not a gate that failed", () => {
	it("detects bash once it is resolvable", () => {
		// Real bash or the POSIX-sh shim — either counts, which is the point:
		// what matters is whether `spawn("bash", …)` will resolve.
		expect(bashAvailable()).toBe(true);
	});

	it("reports it missing when PATH has no bash", () => {
		process.env.PATH = mkdtempSync(join(tmpdir(), "hive-pi-nobash-"));
		expect(bashAvailable()).toBe(false);
	});

	it("INJECTS NOTHING when bash is absent, and reports skip", async () => {
		// Before this, spawn ENOENT'd, the error path reported ok:false, and the
		// model was told "the project gate FAILED" with `spawn bash ENOENT` as the
		// output tail — for a gate that never ran. It would then try to fix a
		// build that was fine and burn its whole injection budget doing it.
		const cwd = makeGatedRepo();
		process.env.PATH = mkdtempSync(join(tmpdir(), "hive-pi-nobash-"));

		const work = gatePolicy.decide(context(cwd));
		expect(work).not.toBeNull();

		const outcome = await work!.run();
		expect(outcome.inject).toBeUndefined();
		expect(outcome.metric.outcome).toBe("skip");
	});

	it("does not charge the injection budget for a gate it could not run", async () => {
		const cwd = makeGatedRepo();
		process.env.PATH = mkdtempSync(join(tmpdir(), "hive-pi-nobash-"));

		const outcome = await gatePolicy.decide(context(cwd))!.run();
		expect(outcome.ledger).toBeUndefined();
	});

	it("still runs normally when bash IS present", async () => {
		const cwd = makeGatedRepo();
		const outcome = await gatePolicy.decide(context(cwd))!.run();
		expect(outcome.metric.outcome).toBe("fail"); // `exit 1` really ran
		expect(outcome.inject).toContain("FAILED");
	});
});

describe("HIV-1109 — a worker does not inherit the session's context pack", () => {
	it("arms normally in an interactive session", async () => {
		vi.resetModules();
		const pi = createFakePi();
		const { default: sessionContext } = await import("../extensions/session-context.ts");
		sessionContext(pi.api);

		// Handlers are registered either way; the guard lives inside them.
		expect(pi.handlers.get("session_start")?.length).toBe(1);
		expect(pi.handlers.get("before_agent_start")?.length).toBe(1);
	});

	it("REGISTERS its handlers inside a worker but does no work", async () => {
		// Registration must stay unconditional — the factory runs once, so a
		// registration gated on state could never be un-gated later. The guard
		// belongs inside the handler.
		vi.stubEnv("PI_AGENDA_WORKER", "1");
		vi.resetModules();

		const pi = createFakePi();
		const { default: sessionContext } = await import("../extensions/session-context.ts");
		sessionContext(pi.api);

		expect(pi.handlers.get("session_start")?.length).toBe(1);

		// `startup` is exactly what every `pi -p --no-session` child reports, and
		// exactly what used to arm this extension.
		await pi.emit({ type: "session_start", reason: "startup" });
		const result = await Promise.all(
			(pi.handlers.get("before_agent_start") ?? []).map((handler) =>
				handler({ type: "before_agent_start" }, {} as never),
			),
		);
		// Nothing armed, so the handler returns no message to inject.
		expect(result.every((value) => value === undefined)).toBe(true);
	});

	it("does not re-arm on compaction inside a worker either", async () => {
		vi.stubEnv("PI_AGENDA_WORKER", "1");
		vi.resetModules();

		const pi = createFakePi();
		const { default: sessionContext } = await import("../extensions/session-context.ts");
		sessionContext(pi.api);

		await pi.emit({ type: "session_compact" });
		const result = await Promise.all(
			(pi.handlers.get("before_agent_start") ?? []).map((handler) =>
				handler({ type: "before_agent_start" }, {} as never),
			),
		);
		expect(result.every((value) => value === undefined)).toBe(true);
	});
});
