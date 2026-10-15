import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { treeStamp, type StampOptions } from "../extensions/harness/verify.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatePolicy } from "../extensions/agenda/gate.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";

// Deliberately expensive preparation, with immediately available capacity.
vi.mock("../extensions/harness/verify.ts", () => ({
	treeStamp: vi.fn(async (_cwd: string, _identity: string, options: StampOptions = {}) => {
		const signals = options.signal ? [options.signal] : [];
		if (Number.isFinite(options.deadline)) signals.push(AbortSignal.timeout(Math.max(0, Math.ceil(options.deadline! - Date.now()))));
		const signal = signals.length ? AbortSignal.any(signals) : undefined;
		try { await delay(250, undefined, { signal }); }
		catch (error) { if (signal?.aborted) return null; throw error; }
		return "stable-input";
	}),
}));
const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gate-preparation-")); dirs.push(root);
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: "sleep .65", checkTimeoutMs: 1_000 }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return { root, leaseOptions: { directory: join(root, ".leases"), slots: 1 } };
}

describe("automatic gate preparation versus command budget", () => {
	it("stops preparation at the overall host deadline without starting another fingerprint", async () => {
		const { root, leaseOptions } = fixture();
		const started = Date.now();
		const result = await createGatePolicy(undefined, { leaseOptions, timeoutCapMs: () => 150 }).decide({ cwd: root, ledger: emptyLedger, transcript: "", lastAssistantText: undefined })!.run();
		expect(Date.now() - started).toBeLessThan(400);
		expect(result.inject).toContain("No check was executed");
		expect(treeStamp).toHaveBeenCalledTimes(1);
	});

	it("does not accept command success when post-execution revalidation exhausts the host deadline", async () => {
		const { root, leaseOptions } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: "sleep .65; echo command-completed", checkTimeoutMs: 1_000 }));
		const started = Date.now();
		const result = await createGatePolicy(undefined, { leaseOptions, timeoutCapMs: () => 1_400 }).decide({ cwd: root, ledger: emptyLedger, transcript: "", lastAssistantText: undefined })!.run();
		expect(result.metric.outcome).toBe("skip");
		expect(result.inject).toContain("command-completed");
		expect(result.inject).toContain("NOT successful verification");
		expect(treeStamp).toHaveBeenCalledTimes(3);
		expect(Date.now() - started).toBeLessThan(1_650);
	});

	it("gives an unqueued command its configured execution window after fingerprinting", async () => {
		const { root, leaseOptions } = fixture();
		const result = await createGatePolicy(undefined, { leaseOptions }).decide({ cwd: root, ledger: emptyLedger, transcript: "", lastAssistantText: undefined })!.run();
		expect(result.metric.outcome).toBe("pass");
	});

	it("reports a preparation-shortened host cutoff as incomplete even when the initial cap equals the command timeout", async () => {
		const { root, leaseOptions } = fixture();
		const result = await createGatePolicy(undefined, { leaseOptions, timeoutCapMs: () => 1_000 }).decide({ cwd: root, ledger: emptyLedger, transcript: "", lastAssistantText: undefined })!.run();
		expect(result.metric.outcome).toBe("skip");
		expect(result.inject).toContain("INCOMPLETE");
		expect(result.inject).not.toContain("TIMED OUT");
	});
});
