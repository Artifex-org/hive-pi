/**
 * Gate-retry throttling (HIV-1229): after a red gate, the gate is not re-run
 * until the worktree's CONTENT changes. Drives the full agenda extension over
 * a REAL git repo — the stamp is `git status` + a hash of `git diff HEAD`, so
 * a fake `.git` directory (the verification-loop suite's fixture) disables the
 * feature by design and proves nothing about it.
 *
 * The content-aware part is the load-bearing assertion: a fix landing in an
 * ALREADY-DIRTY file leaves `git status --porcelain` byte-identical, and a
 * status-only stamp would skip the gate on exactly the settle where the fix
 * arrived.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import { gateStamp } from "../extensions/harness/verify.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";
import { ensureBash } from "./bash-shim.ts";
import { gitAvailable } from "./require-tools.ts";

beforeAll(ensureBash);

const hasGit = gitAvailable();

/** A real git repo (init + one commit) carrying a `.pi/harness.json`. */
function makeGitRepo(config: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-gateskip-"));
	execSync(
		"git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
		{ cwd: root, stdio: "ignore" },
	);
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify(config));
	return root;
}

const FAILING = { check: "echo BOOM >&2; exit 1", checkTimeoutMs: 30_000 };

function gateMetrics(pi: FakePi): string[] {
	return pi.busEvents
		.filter((event) => event.name === "hive.metric")
		.map((event) => event.payload as { name?: string; outcome?: string })
		.filter((payload) => payload.name === "verification-loop")
		.map((payload) => payload.outcome as string);
}

let pi: FakePi;

beforeEach(() => {
	pi = createFakePi();
	agenda(pi.api);
});

describe.runIf(hasGit)("gate-skip on unchanged worktree", () => {
	it("skips the re-run while the tree is unchanged, and re-runs after a content change", async () => {
		const cwd = makeGitRepo(FAILING);

		// First settle: the gate runs, fails, injects.
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(1);
		expect(gateMetrics(pi)).toEqual(["fail"]);

		// Second settle, nothing changed: the gate is SKIPPED — no spawn result,
		// no injection, no ledger charge; the metric says so.
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(1);
		expect(gateMetrics(pi)).toEqual(["fail", "skip"]);

		// The tree changes (a new untracked file): the gate runs again.
		writeFileSync(join(cwd, "fix.txt"), "attempt");
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(pi.messages).toHaveLength(2);
		expect(gateMetrics(pi)).toEqual(["fail", "skip", "fail"]);
	});

	it("an edit to an ALREADY-DIRTY tracked file changes the stamp (content-aware, not status-aware)", async () => {
		const cwd = makeGitRepo(FAILING);
		writeFileSync(join(cwd, "code.txt"), "broken");
		execSync("git add code.txt && git -c user.email=t@t -c user.name=t commit -q -m base", {
			cwd,
			stdio: "ignore",
		});
		// Dirty BEFORE the first gate run: status shows ` M code.txt` both before
		// and after the "fix" below — only the diff hash can tell them apart.
		writeFileSync(join(cwd, "code.txt"), "still broken");
		const before = await gateStamp(cwd);

		writeFileSync(join(cwd, "code.txt"), "fixed now");
		const after = await gateStamp(cwd);

		expect(before).not.toBeNull();
		expect(after).not.toBeNull();
		expect(before).not.toEqual(after);
	});

	it("a fix that turns the gate green clears the stamp and the budget", async () => {
		const cwd = makeGitRepo({ check: "test -f ok", checkTimeoutMs: 30_000 });

		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(gateMetrics(pi)).toEqual(["fail"]);

		writeFileSync(join(cwd, "ok"), "");
		await pi.emit({ type: "agent_settled" }, { cwd });
		expect(gateMetrics(pi)).toEqual(["fail", "pass"]);
		// Green produced no injection beyond the original failure.
		expect(pi.messages).toHaveLength(1);
	});

});

describe("gate-skip without a usable git", () => {
	it("outside a real git repo the skip disables itself (null stamp) and the gate keeps running", async () => {
		// The verification-loop suite's fixture shape: a bare `.git` DIRECTORY.
		const root = mkdtempSync(join(tmpdir(), "hive-pi-gateskip-fake-"));
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify(FAILING));

		await pi.emit({ type: "agent_settled" }, { cwd: root });
		await pi.emit({ type: "agent_settled" }, { cwd: root });
		// No skip: both settles ran the gate and injected.
		expect(gateMetrics(pi)).toEqual(["fail", "fail"]);
		expect(pi.messages).toHaveLength(2);
	});
});
