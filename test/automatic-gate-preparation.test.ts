import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatePolicy } from "../extensions/agenda/gate.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";

// Deliberately expensive preparation, with immediately available capacity.
vi.mock("../extensions/harness/verify.ts", () => ({
	treeStamp: async () => {
		await new Promise(resolve => setTimeout(resolve, 250));
		return "stable-input";
	},
}));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gate-preparation-")); dirs.push(root);
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: "sleep .65", checkTimeoutMs: 1_000 }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return { root, leaseOptions: { directory: join(root, ".leases"), slots: 1 } };
}

describe("automatic gate preparation versus command budget", () => {
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
