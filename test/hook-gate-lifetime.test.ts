import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI, makeLaunch, REPO, runCli, writeTranscript } from "./claude-harness.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function running(pid: number) {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !["Z", "X"].includes(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0]);
	} catch { return false; }
}

describe.runIf(process.platform === "linux")("Stop hook process lifetime", () => {
	it("SIGTERM kills the escaped gate tree and a new hook reports interruption instead of restarting", async () => {
		const launch = makeLaunch();
		const transcript = writeTranscript(join(launch.root, "t.jsonl"), [{ user: "fix the test" }, { assistant: "I edited the implementation." }]);
		const root = join(launch.root, "repo"), marker = join(launch.root, "sleeper"), runs = join(launch.root, "runs");
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({
			check: `printf x >> ${runs}; timeout 20s bash -c 'trap "" TERM HUP; echo $$ > ${marker}; sleep 20' & wait`,
			checkTimeoutMs: 200_000,
		}));
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "input"], { cwd: root });
		const input = JSON.stringify({ transcript_path: transcript, cwd: root });
		const hook = spawn(process.execPath, [CLI, "hook", "stop"], { cwd: REPO, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
		const closed = new Promise((resolve) => hook.once("close", resolve));
		hook.stdout.resume(); hook.stderr.resume(); hook.stdin.end(input);
		let sleeper = 0;
		try {
			const end = Date.now() + 7_000;
			while ((!existsSync(marker) || !readFileSync(marker, "utf8").trim()) && Date.now() < end) await delay(20);
			sleeper = Number(readFileSync(marker, "utf8").trim()); expect(sleeper).toBeGreaterThan(1);
			hook.kill("SIGTERM"); await closed;
			const goneBy = Date.now() + 1_000;
			while (running(sleeper) && Date.now() < goneBy) await delay(20);
			expect(running(sleeper)).toBe(false);
			const resumed = await runCli(["hook", "stop"], launch.env, input);
			expect(resumed.code).toBe(0);
			expect(JSON.parse(resumed.stdout).reason).toContain("was interrupted");
			expect(JSON.parse(resumed.stdout).reason).toContain("NOT verified");
			expect(readFileSync(runs, "utf8")).toBe("x");
			const again = await runCli(["hook", "stop"], launch.env, input);
			expect(again.stdout).toBe(""); expect(readFileSync(runs, "utf8")).toBe("x");
		} finally {
			hook.kill("SIGTERM");
			await Promise.race([closed, delay(500)]);
			if (hook.exitCode === null && hook.signalCode === null) hook.kill("SIGKILL");
			if (sleeper && running(sleeper)) { try { process.kill(sleeper, "SIGKILL"); } catch { /* already exited */ } }
			hook.stdin.destroy(); hook.stdout.destroy(); hook.stderr.destroy();
		}
	}, 15_000);

	it("replays a terminal failure if the hook dies after recording it but before writing its block", async () => {
		const launch = makeLaunch(), root = join(launch.root, "repo"), runs = join(launch.root, "runs"), ready = join(launch.root, "ready");
		const transcript = writeTranscript(join(launch.root, "t.jsonl"), [{ user: "fix it" }, { assistant: "Implementation changed." }]);
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check: `printf x >> ${runs}; echo BOOM; exit 1`, checkTimeoutMs: 10_000, maxInjections: 1 }));
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "input"], { cwd: root });
		const input = JSON.stringify({ transcript_path: transcript, cwd: root });
		// Production Stop decision, deliberately held at the pre-stdout boundary.
		const script = `
			import {writeFileSync} from "node:fs";
			const {stopDecision} = await import(${JSON.stringify(pathToFileURL(join(REPO, "claude/hooks/stop.ts")).href)});
			const {createSpool} = await import(${JSON.stringify(pathToFileURL(join(REPO, "claude/spool.ts")).href)});
			const out = await stopDecision(${input}, {stateDir:${JSON.stringify(launch.stateDir)}, spool:createSpool(${JSON.stringify(launch.spool)},()=>{}), modelUnavailable:"test", resolveEvaluator:async()=>({ok:false,reason:"unused"}), stderr:()=>{}});
			if (!out?.delivered) throw new Error("No pending terminal notice");
			writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(()=>{}, 1000);
		`;
		const hook = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO, env: launch.env, stdio: ["ignore", "pipe", "pipe"] });
		const closed = new Promise((resolve) => hook.once("close", resolve));
		hook.stdout.resume(); hook.stderr.resume();
		try {
			const end = Date.now() + 5_000;
			while (!existsSync(ready) && Date.now() < end) await delay(20);
			expect(existsSync(ready)).toBe(true);
			hook.kill("SIGTERM"); await closed;
			const next = await runCli(["hook", "stop"], launch.env, input);
			expect(next.code).toBe(0);
			expect(JSON.parse(next.stdout).reason).toContain("FAILED");
			expect(JSON.parse(next.stdout).reason).toContain("BOOM");
			expect(readFileSync(runs, "utf8")).toBe("x");
			expect((await runCli(["hook", "stop"], launch.env, input)).stdout).toBe("");
		} finally {
			hook.kill("SIGTERM"); await Promise.race([closed, delay(500)]);
			if (hook.exitCode === null && hook.signalCode === null) hook.kill("SIGKILL");
			hook.stdout.destroy(); hook.stderr.destroy();
		}
	}, 15_000);
});
