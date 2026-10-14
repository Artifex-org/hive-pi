import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatePolicy, gateInputStamp, runCheck } from "../extensions/agenda/gate.ts";
import { emptyLedger } from "../extensions/agenda/ledger.ts";
import { acquireGateLease } from "../extensions/agenda/gate-lease.ts";
import type { GatePolicyOptions } from "../extensions/agenda/gate.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(command?: string, committed = true) {
	const dir = mkdtempSync(join(tmpdir(), "hive-auto-gate-")); dirs.push(dir);
	const root = join(dir, "repo"); mkdirSync(join(root, ".pi"), { recursive: true });
	const log = join(dir, "runs");
	const check = command ?? `printf x >> '${log}'`;
	writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check, checkTimeoutMs: 10_000 }));
	writeFileSync(join(root, "code.txt"), "base\n");
	git(root, "init", "-q"); git(root, "add", "."); if (committed) git(root, "commit", "-qm", "base");
	return { root, log, check, dir };
}
function git(root: string, ...args: string[]) {
	return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "ignore" });
}
const run = async (root: string, options: GatePolicyOptions = {}, signal?: AbortSignal, deliver = true) => {
	const outcome = await createGatePolicy(undefined, options).decide({ cwd: root, ledger: emptyLedger, transcript: "", lastAssistantText: undefined, signal })!.run();
	if (deliver) await outcome.delivered?.(); // model the host accepting the follow-up
	return outcome;
};

async function waitFor(path: string) {
	const end = Date.now() + 3_000;
	while (!existsSync(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	expect(existsSync(path)).toBe(true);
}

describe("automatic gate attempts, not cached green verification", () => {
	it("does not rerun unchanged successful input across fresh policy instances", async () => {
		const { root, log } = fixture();
		expect((await run(root)).metric.outcome).toBe("pass");
		expect((await run(root)).metric.outcome).toBe("skip");
		expect(readFileSync(log, "utf8")).toBe("x");
		// Explicit verification is not deduplicated or suppressed.
		expect((await runCheck(`printf y >> '${log}'`, root, 1_000)).ok).toBe(true);
		expect(readFileSync(log, "utf8")).toBe("xy");
	});

	it("a host-cutoff reports incomplete once, charges once and never restarts unchanged input", async () => {
		const { root, log, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; sleep 5`, checkTimeoutMs: 10_000 }));
		const options = { timeoutCapMs: () => 250 };
		const first = await run(root, options);
		expect(first.metric.outcome).toBe("skip");
		expect(first.inject).toContain("INCOMPLETE");
		expect(first.inject).toContain("NOT successful verification");
		expect(first.ledger!(emptyLedger).iterations[`gate:${root}`]).toBe(1);
		const second = await run(root, options);
		expect(second).toEqual({ metric: { outcome: "skip", value: 0 } });
		expect(readFileSync(log, "utf8")).toBe("x");
	});

	it("one worktree runs only once when hooks overlap", async () => {
		const { root, log, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; sleep 0.3`, checkTimeoutMs: 10_000 }));
		const outcomes = await Promise.all([run(root), run(root)]);
		expect(outcomes.map((x) => x.metric.outcome).sort()).toEqual(["pass", "skip"]);
		expect(readFileSync(log, "utf8")).toBe("x");
	});

	it("still enforces single-flight admission when HEAD is unborn and fingerprinting fails", async () => {
		const { root, log, check, dir } = fixture(undefined, false);
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; sleep 0.3`, checkTimeoutMs: 10_000 }));
		expect(await gateInputStamp(root, check, 10_000)).toBeNull();
		const options = { leaseOptions: { directory: join(dir, "leases") } };
		const outcomes = await Promise.all([run(root, options), run(root, options)]);
		expect(outcomes.map((x) => x.metric.outcome).sort()).toEqual(["pass", "skip"]);
		expect(readFileSync(log, "utf8")).toBe("x");
	});

	it("reports admission-clipped execution as incomplete, not the repo timeout, and persists that receipt", async () => {
		const first = fixture(), second = fixture(), third = fixture();
		const leaseOptions = { directory: join(third.dir, "leases"), slots: 2 };
		const end = Date.now() + 5_000;
		const one = await acquireGateLease(first.root, () => end, undefined, leaseOptions);
		const two = await acquireGateLease(second.root, () => end, undefined, leaseOptions);
		expect(one).not.toBeNull(); expect(two).not.toBeNull();
		writeFileSync(join(third.root, ".pi", "harness.json"), JSON.stringify({ check: `${third.check}; sleep 1`, checkTimeoutMs: 1_500 }));
		const release = setTimeout(() => { void one!.release(); }, 900);
		try {
			const outcome = await run(third.root, { leaseOptions });
			expect(readFileSync(third.log, "utf8")).toBe("x");
			expect(outcome.metric.outcome).toBe("skip");
			expect(outcome.inject).toContain("INCOMPLETE");
			expect(outcome.inject).not.toContain("TIMED OUT");
			const receiptLease = await acquireGateLease(third.root, () => Date.now() + 1_000, undefined, leaseOptions);
			try { expect((await receiptLease!.read())?.outcome).toBe("incomplete"); }
			finally { await receiptLease?.release(); }
		} finally { clearTimeout(release); await one?.release(); await two?.release(); }
	});

	it("replays an undelivered terminal warning without re-running the check", async () => {
		const { root, log, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; exit 1`, checkTimeoutMs: 10_000 }));
		const first = await run(root, {}, undefined, false); // host killed after run, BEFORE delivery
		expect(first.inject).toContain("FAILED");
		const replay = await run(root); // new hook delivers and acknowledges the stored warning
		expect(replay.inject).toBe(first.inject);
		expect(replay.metric.outcome).toBe("skip");
		expect(replay.ledger).toBeUndefined(); // replay is not another attempt
		expect(readFileSync(log, "utf8")).toBe("x");
		expect((await run(root)).inject).toBeUndefined();
	});

	it("an acknowledgement blocked by a worktree owner returns promptly and preserves the notice", async () => {
		const { root, dir, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; exit 1`, checkTimeoutMs: 10_000 }));
		const leaseOptions = { directory: join(dir, "leases") };
		const first = await run(root, { leaseOptions }, undefined, false);
		const deadline = Date.now() + 3_000;
		const held = await acquireGateLease(root, () => deadline, undefined, { ...leaseOptions, deferSlot: true });
		expect(held).not.toBeNull();
		try {
			await Promise.race([first.delivered!(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("notice acknowledgement blocked")), 500))]);
		} finally { await held?.release(); }
		expect((await run(root, { leaseOptions })).inject).toBe(first.inject);
	});

	it("a cached attempt skips promptly even when all execution slots are occupied", async () => {
		const first = fixture(), second = fixture(), third = fixture();
		const leaseOptions = { directory: join(third.dir, "leases"), slots: 2 };
		await run(third.root, { leaseOptions });
		const end = Date.now() + 5_000;
		const one = await acquireGateLease(first.root, () => end, undefined, leaseOptions);
		const two = await acquireGateLease(second.root, () => end, undefined, leaseOptions);
		try {
			const result = await Promise.race([
				run(third.root, { leaseOptions }),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cached attempt waited for execution capacity")), 1_000)),
			]);
			expect(result.metric.outcome).toBe("skip");
		} finally { await one?.release(); await two?.release(); }
	});

	it("new HEAD, dirty content and gate command each re-enable checking", async () => {
		const { root, log, check } = fixture();
		await run(root);
		git(root, "commit", "--allow-empty", "-qm", "new HEAD");
		expect((await run(root)).metric.outcome).toBe("pass");
		writeFileSync(join(root, "code.txt"), "dirty fix\n");
		expect((await run(root)).metric.outcome).toBe("pass");
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; true`, checkTimeoutMs: 10_000 }));
		expect((await run(root)).metric.outcome).toBe("pass");
		expect(readFileSync(log, "utf8")).toBe("xxxx");
	});

	it("does not stamp post-run edits as if the gate checked them", async () => {
		const { root, log, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; sleep 0.3`, checkTimeoutMs: 10_000 }));
		const first = run(root); await waitFor(log);
		writeFileSync(join(root, "code.txt"), "edited while gate ran\n");
		await first;
		expect((await run(root)).metric.outcome).toBe("pass");
		expect(readFileSync(log, "utf8")).toBe("xx");
	});

	it("aborted attempts are not green and manual retry remains possible", async () => {
		const { root, log, check } = fixture();
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `${check}; sleep 5`, checkTimeoutMs: 10_000 }));
		const controller = new AbortController();
		const first = run(root, {}, controller.signal); await waitFor(log); controller.abort();
		expect((await first).metric.outcome).toBe("skip");
		expect((await run(root)).metric.outcome).toBe("skip");
		expect((await runCheck("true", root, 1_000)).ok).toBe(true);
	});

	it("does not spawn if cancellation predates the call", async () => {
		const { root, log, check } = fixture();
		const controller = new AbortController(); controller.abort();
		expect(await runCheck(check, root, 1_000, controller.signal)).toMatchObject({ ok: false, cancelled: true });
		expect(existsSync(log)).toBe(false);
	});

	it("the input key includes command, timeout and committed content", async () => {
		const { root } = fixture();
		const first = await gateInputStamp(root, "true", 1_000);
		expect(first).not.toBeNull();
		expect(await gateInputStamp(root, "false", 1_000)).not.toBe(first);
		expect(await gateInputStamp(root, "true", 2_000)).not.toBe(first);
		writeFileSync(join(root, "code.txt"), "committed fix\n"); git(root, "add", "."); git(root, "commit", "-qm", "fix");
		expect(await gateInputStamp(root, "true", 1_000)).not.toBe(first);
	});
});
