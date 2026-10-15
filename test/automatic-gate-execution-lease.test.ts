import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../extensions/agenda/gate.ts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function identity(pid: number) {
	try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" "); return { birth: f[19], live: !["Z", "X"].includes(f[0]) }; } catch { return undefined; }
}
async function until(test: () => boolean, ms = 4_000) {
	const end = Date.now() + ms;
	while (!test() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
	expect(test()).toBe(true);
}

describe.runIf(process.platform === "linux")("execution lifetime survives stale owner heartbeats", () => {
	it("never retries a project command that exits with the flock conflict code", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gate-exit-status-")), log = join(directory, "runs");
		try {
			const result = await runCheck(`printf x >> ${quote(log)}; exit 250`, directory, 2_000, undefined, { directory, rootLock: join(directory, "root.kernel"), slots: 2 });
			expect(result.ok).toBe(false); expect(result.notExecuted).toBeUndefined();
			expect(readFileSync(log, "utf8")).toBe("x");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it.each(["stopped-slots", "killed-slots", "stopped-worktree"])("does not overbook %s", async mode => {
		const base = mkdtempSync(join(tmpdir(), "gate-live-execution-")), directory = join(base, "leases"), release = join(base, "release"), third = join(base, "third");
		const owners: { child: ChildProcess; ended: boolean; output: string }[] = [];
		const checks = new Map<number, string>();
		const source = new URL("../extensions/agenda/gate.ts", import.meta.url).href;
		function repo(name: string, long: boolean) {
			const root = join(base, name), ready = join(base, `${name}-ready`);
			mkdirSync(join(root, ".pi"), { recursive: true });
			const check = long ? `echo $$ > ${quote(ready)}; while [ ! -f ${quote(release)} ]; do sleep .05; done` : `echo $$ > ${quote(third)}`;
			writeFileSync(join(root, ".pi", "harness.json"), JSON.stringify({ check, checkTimeoutMs: 20_000 }));
			execFileSync("git", ["init", "-q"], { cwd: root });
			execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: root });
			return { root, ready };
		}
		function start(root: string) {
			const code = `const {createGatePolicy}=await import(${JSON.stringify(source)}); const result=await createGatePolicy(undefined,{timeoutCapMs:()=>10000,leaseOptions:{directory:${JSON.stringify(directory)}}}).decide({cwd:${JSON.stringify(root)},ledger:{iterations:{}},transcript:""}).run(); console.log(JSON.stringify(result.inject));`;
			const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], detached: true });
			const owner = { child, ended: false, output: "" }; owners.push(owner);
			child.once("exit", () => { owner.ended = true; });
			child.stdout.on("data", d => { owner.output += d; }); child.stderr.on("data", d => { owner.output += d; });
			return owner;
		}
		try {
			const a = repo("a", true), b = mode === "stopped-worktree" ? undefined : repo("b", true);
			for (const fixture of [a, ...(b ? [b] : [])]) {
				const owner = start(fixture.root);
				await until(() => existsSync(fixture.ready) || owner.ended);
				expect(existsSync(fixture.ready), owner.output).toBe(true);
				const pid = Number(readFileSync(fixture.ready, "utf8")); checks.set(pid, identity(pid)!.birth);
				owner.child.kill(mode === "killed-slots" ? "SIGKILL" : "SIGSTOP");
			}
			for (const pid of checks.keys()) expect(identity(pid)?.live).toBe(true);
			// Advance lease age, not test time: the owner cannot refresh while stopped/dead.
			const old = new Date(Date.now() - 31_000);
			for (const file of readdirSync(directory)) if (file.endsWith(".lock")) utimesSync(join(directory, file), old, old);
			const next = mode === "stopped-worktree" ? a.root : repo("c", false).root;
			if (mode === "stopped-worktree") writeFileSync(join(next, ".pi", "harness.json"), JSON.stringify({ check: `echo $$ > ${quote(third)}`, checkTimeoutMs: 20_000 }));
			const contender = start(next);
			await until(() => contender.ended);
			expect(existsSync(third), contender.output).toBe(false);
			expect(contender.output).toContain("No check was executed");
		} finally {
			writeFileSync(release, "release");
			for (const owner of owners) if (!owner.ended) { owner.child.kill("SIGCONT"); owner.child.kill("SIGTERM"); }
			for (const [pid, birth] of checks) if (identity(pid)?.birth === birth) { try { process.kill(pid, "SIGKILL"); } catch { /* already ended */ } }
			await until(() => owners.every(owner => owner.ended));
			await until(() => [...checks.keys()].every(pid => !identity(pid)?.live));
			rmSync(base, { recursive: true, force: true });
		}
	}, 15_000);
});
