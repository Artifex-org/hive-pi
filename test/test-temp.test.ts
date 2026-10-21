import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRun, prepareRoot, recoverRuns } from "../scripts/test-temp.ts";

const fixture = fileURLToPath(new URL("./fixtures/test-temp-worker.ts", import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];
const orphans: number[] = [];
function setup() {
	const base = mkdtempSync(join(tmpdir(), "t-"));
	dirs.push(base);
	const root = join(base, "runs");
	return { base, root };
}
function launch(root: string, mode: string, state: string) {
	const child = spawn(process.execPath, [fixture, root, mode, state], { env: { ...process.env, NODE_COMPILE_CACHE: join(dirname(root), "parent-compile-cache") }, stdio: ["ignore", "pipe", "pipe"] });
	children.push(child);
	let stderr = "";
	child.stderr!.on("data", data => { stderr += data; });
	const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
	return { child, done, stderr: () => stderr };
}
async function waitFor<T>(read: () => T | undefined): Promise<T> {
	for (let i = 0; i < 200; i++) { const result = read(); if (result !== undefined) return result; await delay(25); }
	throw new Error("Timed out waiting for fixture state");
}
type State = { pid: number; descendant?: number; artifact: string; tmp: string; run: string; compile: string };
async function stateAt(path: string): Promise<State> {
	return waitFor(() => { try { return JSON.parse(readFileSync(path, "utf8")) as State; } catch { return undefined; } });
}
afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const pid of orphans.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
	await delay(50);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("test invocation temporary ownership", () => {
	it.each([["success", 0], ["fail", 7]] as const)("cleans %s and preserves the child's exit code", async (mode, code) => {
		const { base, root } = setup();
		const state = join(base, "state");
		const run = launch(root, mode, state);
		expect(await run.done, run.stderr()).toBe(code);
		const recorded = await stateAt(state);
		expect(recorded.tmp).toBe(join(recorded.run, "tmp"));
		expect(recorded.compile).toBe(join(recorded.tmp, "compile-cache"));
		expect(recorded.artifact.startsWith(recorded.tmp + "/")).toBe(true);
		if (process.platform === "linux") expect(readdirSync(root)).toEqual([]);
		else expect(run.stderr()).toContain("retained");
	});

	it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("cleans on %s", async signal => {
		const { base, root } = setup();
		const run = launch(root, "hang", join(base, "state"));
		await stateAt(join(base, "state"));
		run.child.kill(signal);
		expect(await run.done).toBe({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal]);
		if (process.platform === "linux") expect(readdirSync(root)).toEqual([]);
	});

	it("escalates a TERM-resistant owned child before cleanup", async () => {
		const { base, root } = setup();
		const run = launch(root, "stubborn", join(base, "state"));
		await stateAt(join(base, "state"));
		run.child.kill("SIGTERM");
		expect(await run.done).toBe(143);
		if (process.platform === "linux") expect(readdirSync(root)).toEqual([]);
	});

	it("preserves live concurrent runs and unrelated files", async () => {
		const { base, root } = setup();
		prepareRoot(root);
		writeFileSync(join(root, "unrelated"), "keep");
		const live = launch(root, "hang", join(base, "live"));
		const state = await stateAt(join(base, "live"));
		const other = launch(root, "success", join(base, "other"));
		expect(await other.done, other.stderr()).toBe(0);
		expect(readFileSync(join(state.artifact, "data"), "utf8")).toBe("owned");
		expect(readFileSync(join(root, "unrelated"), "utf8")).toBe("keep");
		live.child.kill("SIGTERM");
		await live.done;
	});

	it.each(["orphan", "fd-reader", "cwd-reader", "registered-reader"])("retains a killed wrapper's %s, then recovers after all readers exit", async mode => {
		const { base, root } = setup();
		const first = launch(root, mode, join(base, "first"));
		const state = await stateAt(join(base, "first"));
		orphans.push(state.pid, state.descendant!);
		first.child.kill("SIGKILL");
		// The child still owns inherited output pipes; close is not parent death.
		await waitFor(() => first.child.signalCode === "SIGKILL" ? true : undefined);
		process.kill(state.pid, "SIGKILL");
		await first.done;
		const second = launch(root, "success", join(base, "second"));
		expect(await second.done, second.stderr()).toBe(0);
		expect(existsSync(state.artifact)).toBe(true);
		process.kill(state.descendant!, "SIGKILL");
		// Simulate PID reuse: a live unrelated PID with a different start time.
		const ownerPath = join(state.run, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
		if (owner.owner) { owner.owner.pid = process.pid; owner.owner.start = "1"; writeFileSync(ownerPath, JSON.stringify(owner)); }
		await delay(100);
		const third = launch(root, "success", join(base, "third"));
		const fourth = launch(root, "success", join(base, "fourth"));
		expect(await third.done, third.stderr()).toBe(0);
		expect(await fourth.done, fourth.stderr()).toBe(0);
		if (process.platform === "linux") expect(existsSync(state.run)).toBe(false);
		else expect(existsSync(state.run)).toBe(true);
	});

	it("does not follow root, run, manifest or interior symlinks", async () => {
		const { base, root } = setup();
		const outside = join(base, "outside");
		expect(() => prepareRoot(join(base, "invalid\nroot"))).toThrow(/Control characters/);
		mkdirSync(outside, { mode: 0o700 });
		writeFileSync(join(outside, "keep"), "safe");
		symlinkSync(outside, root);
		expect(() => prepareRoot(root)).toThrow(/symlink/i);
		rmSync(root);
		prepareRoot(root);
		chmodSync(root, 0o755);
		expect(() => prepareRoot(root)).toThrow(/private/);
		chmodSync(root, 0o700);
		symlinkSync(outside, join(root, "r-link"));
		const run = launch(root, "hang", join(base, "state"));
		const state = await stateAt(join(base, "state"));
		symlinkSync(outside, join(state.run, "interior"));
		recoverRuns(root);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
		run.child.kill("SIGTERM");
		await run.done;
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
		const incomplete = join(root, "r-incomplete");
		mkdirSync(incomplete, { mode: 0o700 });
		symlinkSync(join(outside, "keep"), join(incomplete, "owner.json"));
		expect(cleanRun(root, incomplete).status).not.toBe("removed");
		expect(existsSync(incomplete)).toBe(true);
	});

	it("preserves incomplete and mismatched-namespace ownership records", async () => {
		const { base, root } = setup();
		const run = launch(root, "hang", join(base, "state"));
		const state = await stateAt(join(base, "state"));
		const ownerFile = join(state.run, "owner.json");
		const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
		owner.domain = { boot: "unknown", namespace: "unknown" };
		writeFileSync(ownerFile, JSON.stringify(owner));
		expect(cleanRun(root, state.run).status).toBe("retained");
		run.child.kill("SIGTERM");
		await run.done;
		recoverRuns(root);
		expect(existsSync(state.run)).toBe(true);
		mkdirSync(join(root, "r-unpublished"), { mode: 0o700 });
		recoverRuns(root);
		expect(existsSync(join(root, "r-unpublished"))).toBe(true);
	});
});
