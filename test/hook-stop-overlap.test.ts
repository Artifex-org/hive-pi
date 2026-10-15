import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, makeLaunch, REPO, runCli, writeTranscript } from "./claude-harness.ts";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
describe("Stop session ledger ownership", () => {
	it("coalesces overlapping processes before they read or replace the same ledger", async () => {
		const launch = makeLaunch(), root = join(launch.root, "repo");
		const runs = join(launch.root, "runs"), ready = join(launch.root, "ready"), release = join(launch.root, "release");
		const transcript = writeTranscript(join(launch.root, "t.jsonl"), [{ user: "fix it" }, { assistant: "I edited the implementation." }]);
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, "code.txt"), "initial");
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({
			check: `printf x >> '${runs}'; touch '${ready}'; while test ! -f '${release}'; do sleep .01; done; echo BOOM; exit 1`,
			checkTimeoutMs: 10_000, maxInjections: 2,
		}));
		execFileSync("git", ["init", "-q", root]); execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "input"], { cwd: root });
		const input = JSON.stringify({ transcript_path: transcript, cwd: root });
		const first = spawn(process.execPath, [CLI, "hook", "stop"], { cwd: REPO, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		first.stdout.on("data", d => { stdout += d; }); first.stderr.on("data", d => { stderr += d; });
		const closed = new Promise<void>(resolve => first.once("close", () => resolve())); first.stdin.end(input);
		try {
			const end = Date.now() + 5_000;
			while (!existsSync(ready) && Date.now() < end) await delay(10);
			expect(existsSync(ready), stderr).toBe(true);
			const overlap = await runCli(["hook", "stop"], launch.env, input);
			expect(overlap.code).toBe(0); expect(overlap.stdout).toBe("");
			expect(overlap.stderr).toContain("already running");
			writeFileSync(release, "release"); await closed;
			expect(first.exitCode, stderr).toBe(0); expect(JSON.parse(stdout).reason).toContain("FAILED");
			const state = () => JSON.parse(readFileSync(join(launch.stateDir, "agenda.json"), "utf8"));
			expect(state().ledger.iterations[`gate:${root}`]).toBe(1);
			expect(state().ledger.noticeCharges[`gate:${root}`]).toHaveLength(1);
			writeFileSync(join(root, "code.txt"), "second input");
			expect(JSON.parse((await runCli(["hook", "stop"], launch.env, input)).stdout).reason).toContain("FAILED");
			expect(state().ledger.iterations[`gate:${root}`]).toBe(2);
			writeFileSync(join(root, "code.txt"), "third input");
			expect((await runCli(["hook", "stop"], launch.env, input)).stdout).toBe("");
			expect(readFileSync(runs, "utf8")).toBe("xx");
		} finally {
			writeFileSync(release, "release"); first.kill("SIGTERM");
			const force = setTimeout(() => first.kill("SIGKILL"), 1_000);
			try { await closed; } finally { clearTimeout(force); }
		}
	}, 15_000);
});
