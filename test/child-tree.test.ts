import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../extensions/hive-common/child-tree.ts";
import { runCheck } from "../extensions/agenda/gate.ts";
import { nodeGateHost } from "../claude/mcp/gate-tool.ts";
import { shellQuote } from "../extensions/toolcwd/cwd.ts";

const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const pids: number[] = [];
function stat(pid: number): string[] | undefined {
	try { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/); }
	catch { return undefined; }
}
function running(pid: number): boolean { const s = stat(pid); return s !== undefined && !["Z", "X"].includes(s[0]); }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function marker(path: string): Promise<number> {
	const deadline = Date.now() + 3_000;
	while ((!existsSync(path) || !readFileSync(path, "utf8").trim()) && Date.now() < deadline) await delay(10);
	const pid = Number(readFileSync(path, "utf8").trim()); pids.push(pid); expect(pid).toBeGreaterThan(1); return pid;
}
function temp(): string { const d = mkdtempSync(join(tmpdir(), "child-tree-")); dirs.push(d); return d; }
function own(command: string) {
	const tree = { ...treeSpawnOptions(), detached: true };
	const child = spawn("bash", ["-c", command], { ...tree, stdio: ["pipe", "pipe", "pipe"] });
	trackTree(child, true, tree.env[TREE_TOKEN]); children.push(child); child.stdout.resume(); child.stderr.resume();
	return child;
}
async function gone(pid: number) {
	const end = Date.now() + 1_000;
	while (running(pid) && Date.now() < end) await delay(10);
	expect(running(pid)).toBe(false);
}

afterEach(async () => {
	for (const child of children.splice(0)) { killTree(child, "SIGKILL", true); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
	for (const pid of pids.splice(0)) { if (running(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
	await delay(20);
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("tree ownership token", () => {
	it("preserves custom env and ancestor membership without mutating the parent", () => {
		const base = { CUSTOM: "preserved", HIVE_PI_HELPER_CHILD: "1" };
		const outer = treeSpawnOptions(base), inner = treeSpawnOptions(outer.env);
		expect(outer.detached).toBe(true); expect(inner.env.CUSTOM).toBe("preserved");
		expect(inner.env[TREE_TOKEN]!.split(",")).toEqual([outer.env[TREE_TOKEN], expect.any(String)]);
		expect(inner.env[TREE_TOKEN]).not.toBe(outer.env[TREE_TOKEN]);
		expect(base).not.toHaveProperty(TREE_TOKEN);
	});
});

describe.runIf(process.platform === "linux")("owned Linux descendants across process groups", () => {
	it("kills an actual GNU-timeout child in a DIFFERENT PGID, including TERM resistance", async () => {
		const file = join(temp(), "pid");
		const child = own(`timeout 10s bash -c ${shellQuote(`trap "" TERM HUP; echo $$ > ${shellQuote(file)}; while :; do sleep 1; done`)} & wait`);
		const pid = await marker(file);
		expect(Number(stat(pid)![2])).not.toBe(child.pid); // stat field 5: PGID, NOT this test's PID
		killTree(child, "SIGTERM", true); await delay(100);
		expect(running(pid)).toBe(true); // this is genuinely the resistant path
		killTree(child, "SIGKILL", true); await gone(pid);
	}, 6_000);

	it("kills an environment-cleared original-group child after its wrapper exits", async () => {
		const file = join(temp(), "cleared");
		const child = own(`env -i /bin/sleep 10 & echo $! > ${shellQuote(file)}; exit 0`);
		const pid = await marker(file); await delay(100);
		expect(child.exitCode).toBe(0); expect(running(pid)).toBe(true);
		expect(Number(stat(pid)![2])).toBe(child.pid);
		expect(readFileSync(`/proc/${pid}/environ`, "utf8")).not.toContain(TREE_TOKEN);
		killTree(child, "SIGKILL", true); await gone(pid);
	});

	it("finds an escaped orphan even after the original shell exited", async () => {
		const file = join(temp(), "orphan");
		const child = own(`timeout 10s bash -c ${shellQuote(`trap "" TERM HUP; echo $$ > ${shellQuote(file)}; sleep 10`)} & exit 0`);
		const pid = await marker(file); await delay(100);
		expect(child.exitCode).toBe(0); expect(running(pid)).toBe(true);
		expect(Number(stat(pid)![2])).not.toBe(child.pid);
		killTree(child, "SIGKILL", true); await gone(pid);
	});

	it("reaps a silent detached worker on normal wrapper close", async () => {
		const file = join(temp(), "silent");
		const child = own(`setsid bash -c ${shellQuote(`echo $$ > ${shellQuote(file)}; trap "" TERM HUP; sleep 10`)} >/dev/null 2>&1 & sleep 0.2`);
		const pid = await marker(file);
		await new Promise((resolve) => child.once("close", resolve));
		await gone(pid);
	});

	it("does not kill an unrelated sibling tree", async () => {
		const dir = temp(), one = join(dir, "one"), two = join(dir, "two");
		const first = own(`timeout 10s bash -c ${shellQuote(`echo $$ > ${shellQuote(one)}; sleep 10`)} & wait`);
		own(`timeout 10s bash -c ${shellQuote(`echo $$ > ${shellQuote(two)}; sleep 10`)} & wait`);
		const firstPid = await marker(one), secondPid = await marker(two);
		killTree(first, "SIGKILL", true); await gone(firstPid);
		expect(running(secondPid)).toBe(true);
	});

	it("runCheck meets its deadline with a pipe-holding escaped orphan", async () => {
		const dir = temp(), file = join(dir, "deadline");
		const began = Date.now();
		const result = await runCheck(`timeout 10s bash -c ${shellQuote(`echo $$ > ${shellQuote(file)}; sleep 10`)} & exit 0`, dir, 300);
		const pid = await marker(file);
		expect(result).toMatchObject({ ok: false, timedOut: true });
		expect(Date.now() - began).toBeLessThan(1_500); await gone(pid);
	});

	it("quality_gate cancellation does not cancel escalation just because pipes closed", async () => {
		const dir = temp(), file = join(dir, "closed-pipes");
		const abort = new AbortController();
		const result = nodeGateHost.exec("bash", ["-c", `setsid bash -c ${shellQuote(`echo $$ > ${shellQuote(file)}; trap "" TERM HUP; sleep 10`)} >/dev/null 2>&1 & wait`], { cwd: dir, timeout: 4_000, signal: abort.signal });
		const pid = await marker(file); abort.abort();
		expect(await result).toMatchObject({ killed: true }); await gone(pid);
	}, 6_000);
});
