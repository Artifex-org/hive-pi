/**
 * Checkpoint commits during a long execute phase (checkpoint.ts), and the one
 * interaction that makes them safe: a commit answering a checkpoint request is
 * not the delivery milestone (delivery-progress.ts).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CHECKPOINT_LEDGER_ID,
	checkpointIntervalMs,
	type CheckpointProbe,
	createCheckpoint,
	foldProbe,
	isExecuting,
	MIN_PROBE_GAP_MS,
	probeCheckpoint,
	startClock,
} from "../extensions/agenda/checkpoint.ts";
import type { ConductorStage } from "../extensions/agenda/conductor-state.ts";
import { DELIVERY_PROGRESS_ENTRY, milestoneKind, registerDeliveryProgress } from "../extensions/agenda/delivery-progress.ts";
import { installDriver } from "../extensions/agenda/driver.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";
import { emptySignals, type SessionSignals } from "../extensions/agenda/signals.ts";
import { createFakePi } from "./fake-pi.ts";

const MIN = 60_000;
const INTERVAL = 90 * MIN;
const T0 = 1_000_000_000_000;

describe("foldProbe — the checkpoint clock", () => {
	it("entering execute with a dirty tree asks for a checkpoint at once", () => {
		const { due } = foldProbe(startClock(T0), { dirty: 3, headAt: T0 - 10 * MIN }, T0, INTERVAL);
		expect(due).toMatchObject({ dirty: 3, entering: true });
	});

	it("entering execute with a clean tree asks for nothing and starts the clock", () => {
		const { clock, due } = foldProbe(startClock(T0), { dirty: 0, headAt: T0 }, T0, INTERVAL);
		expect(due).toBeNull();
		expect(clock).toMatchObject({ entering: false, cleanAt: T0, nextProbeAt: T0 + INTERVAL });
	});

	it("is quiet while the uncommitted stretch is shorter than the interval, and probes again when it could be due", () => {
		const watching = { ...startClock(T0), entering: false };
		const { clock, due } = foldProbe(watching, { dirty: 5, headAt: T0 + 30 * MIN }, T0 + 60 * MIN, INTERVAL);
		expect(due).toBeNull();
		expect(clock.nextProbeAt).toBe(T0 + 30 * MIN + INTERVAL);
	});

	it("asks once the tree has been dirty and uncommitted for the interval", () => {
		const watching = { ...startClock(T0), entering: false };
		const { clock, due } = foldProbe(watching, { dirty: 70, headAt: T0 - 600 * MIN }, T0 + INTERVAL, INTERVAL);
		expect(due).toMatchObject({ dirty: 70, entering: false, sinceMs: INTERVAL });
		expect(clock.requestedAt).toBe(T0 + INTERVAL);
		expect(clock.nextProbeAt).toBe(T0 + 2 * INTERVAL);
	});

	it("a months-old HEAD on a freshly dirtied checkout is not months of uncommitted work", () => {
		const watching = { ...startClock(T0), entering: false };
		const { due } = foldProbe(watching, { dirty: 1, headAt: T0 - 90 * 24 * 60 * MIN }, T0 + 10 * MIN, INTERVAL);
		expect(due).toBeNull();
	});

	it("a commit restarts the clock: more edits after it are measured from the commit", () => {
		const watching = { ...startClock(T0), entering: false };
		const commitAt = T0 + 80 * MIN;
		expect(foldProbe(watching, { dirty: 2, headAt: commitAt }, T0 + INTERVAL, INTERVAL).due).toBeNull();
		expect(foldProbe(watching, { dirty: 2, headAt: commitAt }, commitAt + INTERVAL, INTERVAL).due).not.toBeNull();
	});

	it("a tree last seen clean is measured from then", () => {
		const clock = { ...startClock(T0), entering: false, cleanAt: T0 + 60 * MIN };
		expect(foldProbe(clock, { dirty: 1, headAt: null }, T0 + INTERVAL, INTERVAL).due).toBeNull();
	});

	it("never probes again sooner than the minimum gap", () => {
		const watching = { ...startClock(T0), entering: false };
		const { clock } = foldProbe(watching, { dirty: 1, headAt: null }, T0 + INTERVAL - 1, INTERVAL);
		expect(clock.nextProbeAt).toBe(T0 + INTERVAL - 1 + MIN_PROBE_GAP_MS);
	});

	it("a tree git cannot read asks for nothing and looks again an interval later", () => {
		const { clock, due } = foldProbe(startClock(T0), null, T0, INTERVAL);
		expect(due).toBeNull();
		expect(clock.nextProbeAt).toBe(T0 + INTERVAL);
	});
});

describe("isExecuting", () => {
	const approved = { ...emptySignals.plan, phase: "approved" as const };
	it.each<[ConductorStage | null, boolean, boolean]>([
		["execute", false, true],
		["verify", false, true],
		["plan", true, false],
		["consolidate", true, false],
		["done", true, false],
		["idle", true, true],
		[null, true, true],
		[null, false, false],
	])("stage %s, plan approved %s → %s", (stage, planApproved, expected) => {
		expect(isExecuting(stage, planApproved ? approved : emptySignals.plan)).toBe(expected);
	});
});

describe("checkpointIntervalMs", () => {
	it("defaults to 90 minutes, reads PI_AGENDA_CHECKPOINT_MINUTES, and 0 turns it off", () => {
		expect(checkpointIntervalMs({})).toBe(90 * MIN);
		expect(checkpointIntervalMs({ PI_AGENDA_CHECKPOINT_MINUTES: "30" })).toBe(30 * MIN);
		expect(checkpointIntervalMs({ PI_AGENDA_CHECKPOINT_MINUTES: "0" })).toBe(0);
		expect(checkpointIntervalMs({ PI_AGENDA_CHECKPOINT_MINUTES: "soon" })).toBe(90 * MIN);
	});
});

describe("the checkpoint policy", () => {
	function setup(options: { stage?: ConductorStage | null; probe?: CheckpointProbe | null; enabled?: boolean; intervalMs?: number } = {}) {
		let now = T0;
		let probes = 0;
		let probe = options.probe === undefined ? { dirty: 4, headAt: T0 - 600 * MIN } : options.probe;
		const checkpoint = createCheckpoint({
			enabled: () => options.enabled ?? true,
			stage: () => options.stage === undefined ? "execute" : options.stage,
			probe: async () => {
				probes++;
				return probe;
			},
			now: () => now,
			intervalMs: options.intervalMs ?? INTERVAL,
		});
		const signals: SessionSignals = emptySignals;
		const context = { cwd: "/repo", ledger: emptyLedger, lastAssistantText: undefined, transcript: "", signals };
		return {
			checkpoint,
			context,
			advance: (ms: number) => { now += ms; },
			setProbe: (next: CheckpointProbe | null) => { probe = next; },
			probes: () => probes,
		};
	}

	it("asks for a checkpoint on entering execute with a dirty tree, and charges its ledger", async () => {
		const h = setup();
		const outcome = await h.checkpoint.policy.decide(h.context)!.run();
		expect(outcome.inject).toMatch(/^Conductor: execution starts with 4 uncommitted paths.*Commit a checkpoint on your working branch now.*not a push/);
		expect(outcome.ledger!(emptyLedger).iterations[CHECKPOINT_LEDGER_ID]).toBe(1);
		expect(h.checkpoint.outstanding()).toBe(true);
	});

	it("is quiet on a clean tree, and does not even probe again until the interval has passed", async () => {
		const h = setup({ probe: { dirty: 0, headAt: T0 } });
		const outcome = await h.checkpoint.policy.decide(h.context)!.run();
		expect(outcome.inject).toBeUndefined();
		expect(h.checkpoint.outstanding()).toBe(false);
		h.advance(INTERVAL - 1);
		expect(h.checkpoint.policy.decide(h.context)).toBeNull();
		expect(h.probes()).toBe(1);
	});

	it("asks again after the interval of uncommitted work — the 5 h 45 m, 70-file, zero-commit case", async () => {
		const h = setup({ probe: { dirty: 0, headAt: T0 - 600 * MIN } });
		await h.checkpoint.policy.decide(h.context)!.run();
		h.setProbe({ dirty: 70, headAt: T0 - 600 * MIN });
		h.advance(INTERVAL);
		const outcome = await h.checkpoint.policy.decide(h.context)!.run();
		expect(outcome.inject).toMatch(/^Conductor: 70 uncommitted paths and no commit for 90 min in this execute phase/);
	});

	it("does nothing outside execute, when the conductor is off, or when the interval is 0", () => {
		expect(setup({ stage: "plan" }).checkpoint.policy.decide(setup().context)).toBeNull();
		const off = setup({ enabled: false });
		expect(off.checkpoint.policy.decide(off.context)).toBeNull();
		const disabled = setup({ intervalMs: 0 });
		expect(disabled.checkpoint.policy.decide(disabled.context)).toBeNull();
	});

	it("runs at a completed turn boundary, so a run that never settles is still reached", async () => {
		const h = setup();
		const pi = createFakePi();
		installDriver(pi.api, { policies: [], turnPolicies: [h.checkpoint.policy] });
		await pi.emit({ type: "session_start" }, { mode: "rpc" });
		const results = await pi.emit(
			{ type: "turn_end", outcome: "completed", entries: [] },
			{ mode: "rpc", idle: false, branch: [{ message: { role: "user", content: "Implement the plan" } }] },
		);
		const boundary = results.find((r) => r && typeof r === "object" && "entries" in r) as { entries: { content: string }[]; continue: boolean };
		expect(boundary.continue).toBe(true);
		expect(boundary.entries[0].content).toMatch(/Commit a checkpoint/);
	});
});

describe("a checkpoint commit is not the delivery milestone", () => {
	function observe(outstanding: boolean) {
		const pi = createFakePi();
		let taken = 0;
		let pending = outstanding;
		registerDeliveryProgress(pi.api, () => null, { outstanding: () => pending, taken: () => { taken++; pending = false; } });
		const run = (command: string, text: string) => pi.emit({
			type: "tool_result", toolName: "bash", toolCallId: command, input: { command }, content: [{ type: "text", text }], isError: false,
		});
		const stamped = () => pi.entries.filter((e) => e.customType === DELIVERY_PROGRESS_ENTRY).length;
		return { run, stamped, taken: () => taken };
	}

	it("a commit answering an outstanding request is handed back, not stamped — and the NEXT commit is delivery again", async () => {
		const h = observe(true);
		await h.run("git commit -m checkpoint", "[work abc1234] checkpoint");
		expect(h.stamped()).toBe(0);
		expect(h.taken()).toBe(1);
		await h.run("git commit -m done", "[work def5678] done");
		expect(h.stamped()).toBe(1);
	});

	it("with no request outstanding a commit is the milestone, as before", async () => {
		const h = observe(false);
		await h.run("git commit -m change", "[work abc1234] change");
		expect(h.stamped()).toBe(1);
		expect(h.taken()).toBe(0);
	});

	it("a PR opening is always delivery, even while a checkpoint is outstanding", async () => {
		const h = observe(true);
		await h.run("gh pr create", "https://github.com/owner/repo/pull/123");
		expect(h.stamped()).toBe(1);
		expect(h.taken()).toBe(0);
	});

	it("a chain that commits AND opens a PR is a PR opening", () => {
		expect(milestoneKind("git commit -m x && gh pr create", "[work abc1234] x\nhttps://github.com/o/r/pull/9")).toBe("pr");
		expect(milestoneKind("git commit -m x", "[work abc1234] x")).toBe("commit");
		expect(milestoneKind("git status", "")).toBeNull();
	});
});

describe("probeCheckpoint against a real checkout", () => {
	it("counts untracked paths as uncommitted work and reads HEAD's commit time", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
			git("init", "-q");
			git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
			writeFileSync(join(cwd, "new.ts"), "export {};\n");
			const probe = await probeCheckpoint(cwd);
			expect(probe?.dirty).toBe(1);
			expect(probe?.headAt).toBeGreaterThan(Date.now() - 10 * MIN);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("is null outside a git checkout", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-checkpoint-nogit-"));
		try {
			expect(await probeCheckpoint(cwd)).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
