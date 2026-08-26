/**
 * CHARACTERIZATION tests for the repo gate — written in HIV-1095 against the
 * standalone `verification-loop.ts`, now re-pointed at `extensions/agenda/`
 * which absorbed it (HIV-1098).
 *
 * **The assertions below are unchanged across that move.** Only the import and
 * the harness wiring differ. That is the entire point of having written them
 * first: the refactor is proved rather than eyeballed, and any behavioural drift
 * shows up here instead of in a daily driver.
 *
 * Three assertions DID change, all of them intended, all of them named here so
 * the diff cannot smuggle a fourth past review:
 *
 *  1. `customType` and the `setStatus` key are now `agenda`, not
 *     `verification-loop`. The policy's identity moved to `hive.metric.name`;
 *     one customType across all policies means one renderer later. Nothing
 *     consumed the old value — no renderer was registered for it.
 *  2. An exhausted budget reports `outcome:"skip"` where it used to report
 *     nothing at all, closing the gap the original suite pinned.
 *  3. The budget is keyed per repo root rather than per process. One test's
 *     MECHANISM changed to suit (see its comment); its assertion did not.
 *
 * Every other assertion — message text, cap wording, silence conditions, the
 * metric payload's shape — is byte-identical to HIV-1095.
 *
 * These do not assert that the behaviour is *good*. They pin what it IS.
 *
 * The gate command really is spawned (it is `exit 0` / `exit 1`), because the
 * spawn/exit-code path is part of what is being characterized.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";
import { ensureBash } from "./bash-shim.ts";

beforeAll(ensureBash);

/** A throwaway git-rooted repo carrying a `.pi/harness.json`. */
function makeRepo(config: Record<string, unknown> | null): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-vloop-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	if (config) {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify(config));
	}
	return root;
}

const PASSING = { check: "exit 0", checkTimeoutMs: 30_000 };
const FAILING = { check: "echo BOOM >&2; exit 1", checkTimeoutMs: 30_000 };

let pi: FakePi;

beforeEach(() => {
	pi = createFakePi();
	agenda(pi.api);
});

/**
 * Only the hive.metric channel — the contract these assertions pin. Since
 * HIV-1240/1242 the extension also emits the agent-status doorbell (every
 * settle) and the injection doorbell (every injection); both are additive and
 * carry counters/enums only, and neither is this suite's subject. CHANGED (4),
 * in the header's numbering: the assertions' channel scope, not their content.
 */
function metricEvents() {
	return pi.busEvents.filter((event) => event.name === "hive.metric");
}

describe("verification-loop — when it stays silent", () => {
	it("does nothing when the repo has no .pi/harness.json", async () => {
		const cwd = makeRepo(null);
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(0);
		expect(metricEvents()).toHaveLength(0);
	});

	it("does nothing when the gate passes", async () => {
		const cwd = makeRepo(PASSING);
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(0);
	});

	it.each(["print", "json"] as const)("does nothing in %s mode (session is replaced at settle)", async (mode) => {
		const cwd = makeRepo(FAILING);
		await pi.emit({ type: "agent_settled" }, { cwd, mode });
		expect(pi.messages).toHaveLength(0);
		expect(metricEvents()).toHaveLength(0);
	});

	it("does nothing when `check` is present but blank", async () => {
		const cwd = makeRepo({ check: "   " });
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(0);
	});

	it("does nothing when .pi/harness.json is malformed", async () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-vloop-bad-"));
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), "{ not json");
		await pi.emit({ type: "agent_settled" }, { cwd: root });
		expect(pi.messages).toHaveLength(0);
	});
});

describe("verification-loop — the injection", () => {
	it("injects exactly once per settle, as a turn-triggering followUp", async () => {
		const cwd = makeRepo(FAILING);
		await pi.emit({ type: "agent_settled" }, { cwd });

		expect(pi.messages).toHaveLength(1);
		const injected = pi.messages[0];
		expect(injected.customType).toBe("agenda"); // CHANGED (1) — was "verification-loop"
		expect(injected.display).toBe(true);
		expect(injected.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("names the gate, quotes the output tail, and states the remaining budget", async () => {
		const cwd = makeRepo(FAILING);
		await pi.emit({ type: "agent_settled" }, { cwd });

		const content = pi.messages[0].content;
		expect(content).toContain("The project gate `echo BOOM >&2; exit 1` FAILED.");
		expect(content).toContain("Output (tail):");
		expect(content).toContain("BOOM");
		expect(content).toContain("2 attempt(s) left");
	});

	it("switches to the final-attempt wording on the last allowed injection", async () => {
		const cwd = makeRepo({ ...FAILING, maxInjections: 1 });
		await pi.emit({ type: "agent_settled" }, { cwd });

		expect(pi.messages[0].content).toContain(
			"This was the final automatic attempt — stop, summarize what is still failing, and hand back to the user.",
		);
	});

	it("stops injecting once maxInjections is reached", async () => {
		const cwd = makeRepo({ ...FAILING, maxInjections: 2 });
		for (let i = 0; i < 5; i++) await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(2);
	});

	it("defaults to 3 injections when maxInjections is absent", async () => {
		const cwd = makeRepo(FAILING);
		for (let i = 0; i < 5; i++) await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(3);
	});

	it("resets the injection budget on session_start", async () => {
		const cwd = makeRepo({ ...FAILING, maxInjections: 1 });
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(1);

		await pi.emit({ type: "session_start", reason: "startup" }, { cwd });
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(2);
	});

	it("clears the injection counter after a pass, so a later failure gets the full budget", async () => {
		// CHANGED (3) — mechanism only; the intent is the original's.
		//
		// This used to drive a FAILING repo, then a PASSING one, then the failing
		// one again, and expect the third settle to inject. That passed only
		// because the old counter was a single module-level `let injections`
		// shared across every repo, so a green gate anywhere reset a red gate
		// everywhere. The ledger keys per repo root, which is the correct
		// scoping: in a session that moves between worktrees, repo A's failures
		// must not spend repo B's budget.
		//
		// The assertion the original was actually making — "a pass resets the
		// budget" — is preserved, now against ONE repo whose gate goes green and
		// red again, which is what happens in real life when you fix the build.
		// maxInjections is 2, and the budget is never fully spent — deliberately.
		// An EXHAUSTED item stops running its check at all (that is what the cap
		// means), so it can never observe the pass that would clear it; only
		// `session_start` recovers from a spent budget. Both the original and
		// this one behave that way. What is under test here is the other path: a
		// green gate zeroing a partially-spent counter.
		const root = makeRepo({ check: `test -f "$AGENDA_FIXTURE"`, checkTimeoutMs: 30_000, maxInjections: 2 });
		const marker = join(root, ".fixed");
		process.env.AGENDA_FIXTURE = marker;

		await pi.emit({ type: "agent_settled" }, { cwd: root }); // red → 1 charged
		expect(pi.messages).toHaveLength(1);

		writeFileSync(marker, ""); // build fixed
		await pi.emit({ type: "agent_settled" }, { cwd: root }); // green → counter zeroed
		expect(pi.messages).toHaveLength(1);

		rmSync(marker); // broken again
		await pi.emit({ type: "agent_settled" }, { cwd: root });

		// Without the zeroing this would be 2-of-2 and skip, leaving 1 message.
		expect(pi.messages).toHaveLength(2);
		expect(pi.messages[1].content).toContain("1 attempt(s) left");

		delete process.env.AGENDA_FIXTURE;
	});
});

describe("verification-loop — the hive.metric contract", () => {
	it("reports a pass as a gate metric with a duration and no free text", async () => {
		const cwd = makeRepo(PASSING);
		await pi.emit({ type: "agent_settled" }, { cwd });

		expect(metricEvents()).toHaveLength(1);
		const { name, payload } = metricEvents()[0];
		expect(name).toBe("hive.metric");
		const metric = payload as Record<string, unknown>;
		expect(metric.kind).toBe("gate");
		expect(metric.name).toBe("verification-loop");
		expect(metric.outcome).toBe("pass");
		expect(typeof metric.value).toBe("number");
		// The command's OUTPUT must never ride this channel.
		expect(Object.keys(metric).sort()).toEqual(["kind", "name", "outcome", "value"]);
	});

	it("reports a failure as outcome:fail", async () => {
		const cwd = makeRepo(FAILING);
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect((metricEvents()[0].payload as Record<string, unknown>).outcome).toBe("fail");
	});

	it("reports outcome:skip once the budget is exhausted, instead of going silent", async () => {
		const cwd = makeRepo({ ...FAILING, maxInjections: 1 });
		await pi.emit({ type: "agent_settled" }, { cwd });
		await pi.emit({ type: "agent_settled" }, { cwd });

		// CHANGED (2). HIV-1095 pinned the GAP here: the cap check returned before
		// the gate ran, so an exhausted loop emitted nothing and was
		// indistinguishable downstream from one that never armed. It now reports.
		// Still exactly one injection — the cap itself is unchanged.
		expect(pi.messages).toHaveLength(1);
		expect(metricEvents()).toHaveLength(2);
		expect((metricEvents()[1].payload as Record<string, unknown>).outcome).toBe("skip");
		// And it does so without re-running the gate: value 0, not a duration.
		expect((metricEvents()[1].payload as Record<string, unknown>).value).toBe(0);
	});
});

describe("verification-loop — status", () => {
	it("shows the gate command while running, then clears the status", async () => {
		const cwd = makeRepo(PASSING);
		await pi.emit({ type: "agent_settled" }, { cwd });

		const ours = pi.statuses.filter((s) => s.key === "agenda"); // CHANGED (1) — was "verification-loop"
		expect(ours[0].text).toBe("running: exit 0");
		expect(ours[ours.length - 1].text).toBe("");
	});
});
