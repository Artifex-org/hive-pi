import { mkdtemp, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { cancellable, LeaseManager, processScope } from "../extensions/claude-sdk/runtime.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
const value = () => ({ access_token: "offline-only", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "one", slot: "one" });

it("observes a promise's late rejection even when cancellation precedes the race", async () => {
	const abort = new AbortController(); abort.abort(new Error("already cancelled"));
	let reject!: (error: Error) => void;
	const operation = new Promise<void>((_, fail) => { reject = fail; });
	await expect(cancellable(operation, abort.signal)).rejects.toThrow("already cancelled");
	reject(new Error("late operation failure"));
	await new Promise(resolve => setImmediate(resolve));
});

it("bounds a lease source even if an injected transport ignores cancellation", async () => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms); return controller.signal; });
	const source = vi.fn(() => new Promise<ReturnType<typeof value>>(() => {}));
	const leases = new LeaseManager(source);
	const output = leases.get(new AbortController().signal).catch(error => error);
	await vi.advanceTimersByTimeAsync(10_001);
	expect(await output).toMatchObject({ name: "TimeoutError" }); expect(source).toHaveBeenCalledOnce();
	leases.close();
});

it("one canceled lease waiter does not cancel another caller's shared acquisition", async () => {
	let finish!: (lease: ReturnType<typeof value>) => void;
	const source = vi.fn(() => new Promise<ReturnType<typeof value>>(resolve => { finish = resolve; }));
	const leases = new LeaseManager(source);
	const cancel = new AbortController();
	const first = leases.get(cancel.signal).catch(error => error);
	const second = leases.get(new AbortController().signal);
	cancel.abort(new Error("one waiter canceled"));
	expect((await first).message).toBe("one waiter canceled");
	finish(value()); expect(await second).toMatchObject({ access_token: "offline-only" }); expect(source).toHaveBeenCalledOnce();
	leases.close();
});

it("closing a lease manager aborts acquisition without authorizing a later request", async () => {
	const source = vi.fn(() => new Promise<ReturnType<typeof value>>(() => {}));
	const leases = new LeaseManager(source);
	const output = leases.get(new AbortController().signal).catch(error => error);
	leases.close(); expect(await output).toMatchObject({ name: "AbortError" });
	await expect(leases.get(new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("the real process launcher inherits umask 077, restores the parent mask and cleans its process group", async () => {
	// A synthetic Node child, NOT Claude or an SDK inference invocation.
	const dir = await mkdtemp(join(tmpdir(), "claude-sdk-process-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const scope = processScope(); cleanup.push(scope.close);
	const mask = process.umask();
	const child = scope.spawn({ command: process.execPath, args: ["-e", `
		const fs = require('node:fs');
		fs.mkdirSync(process.env.STATE + '/child');
		fs.writeFileSync(process.env.STATE + '/child/state', 'synthetic state');
		console.log(process.umask());
		setInterval(() => {}, 10000);
	`], cwd: dir, env: { STATE: dir }, signal: new AbortController().signal });
	const exited = new Promise(resolve => child.once("exit", resolve));
	const [bytes] = await once(child.stdout, "data");
	expect(String(bytes).trim()).toBe("63"); expect(process.umask()).toBe(mask);
	expect((await stat(join(dir, "child"))).mode & 0o777).toBe(0o700);
	expect((await stat(join(dir, "child/state"))).mode & 0o777).toBe(0o600);
	await scope.close(); await exited;
});

it.runIf(process.platform === "linux")("finds a token-owned detached Node descendant after its leader exits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-sdk-orphan-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const scope = processScope(); cleanup.push(scope.close);
	const child = scope.spawn({ command: process.execPath, args: ["-e", `
		const cp = require('node:child_process');
		require('node:fs').writeFileSync(process.env.STATE + '/leader', String(process.pid));
		cp.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.env.STATE + '/pid', String(process.pid)); console.log('ready'); setInterval(()=>{},10000)"],
			{detached:true, stdio:['ignore','inherit','ignore']}).unref();
	`], cwd: dir, env: { STATE: dir }, signal: new AbortController().signal });
	const exited = new Promise(resolve => child.once("exit", resolve));
	await once(child.stdout, "data"); await exited;
	const descendant = Number(await readFile(join(dir, "pid"), "utf8"));
	const raw = await readFile(`/proc/${descendant}/stat`, "utf8");
	expect(Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[2])).toBe(descendant);
	expect(descendant).not.toBe(Number(await readFile(join(dir, "leader"), "utf8"))); expect(child.exitCode).toBe(0);
	const environment = await readFile(`/proc/${descendant}/environ`, "utf8");
	expect(environment).toContain("HIVE_PI_TREE_TOKENS=");
	await scope.close();
	await vi.waitFor(async () => {
		try { expect(await readFile(`/proc/${descendant}/status`, "utf8")).toMatch(/State:\s+Z/); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	});
});

it("cleanup escalates to SIGKILL for a synthetic descendant that ignores SIGTERM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-sdk-descendant-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const scope = processScope(); cleanup.push(scope.close);
	const child = scope.spawn({ command: process.execPath, args: ["-e", `
		const cp = require('node:child_process');
		process.on('SIGTERM', () => {});
		const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},10000)"], {stdio:['ignore','pipe','ignore']});
		child.stdout.once('data', () => { require('node:fs').writeFileSync(process.env.STATE + '/pid', String(child.pid)); console.log('ready'); });
		setInterval(()=>{},10000);
	`], cwd: dir, env: { STATE: dir }, signal: new AbortController().signal });
	const exited = new Promise(resolve => child.once("exit", resolve));
	await once(child.stdout, "data");
	const descendant = Number(await readFile(join(dir, "pid"), "utf8"));
	await scope.close(); await exited;
	await vi.waitFor(async () => {
		try { const status = await readFile(`/proc/${descendant}/status`, "utf8"); expect(status).toMatch(/State:\s+Z/); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	});
});

 it.runIf(process.platform === "linux")("reaps a real detached Node orphan after all leader pipes close", async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-sdk-silent-orphan-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const scope = processScope(); cleanup.push(scope.close);
	const child = scope.spawn({ command: process.execPath, args: ["-e", `
		const worker = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.env.STATE + '/pid', String(process.pid)); setInterval(()=>{},10000)"], {detached:true, stdio:'ignore'});
		worker.unref();
		const ready = setInterval(() => { if (require('node:fs').existsSync(process.env.STATE + '/pid')) clearInterval(ready); }, 5);
	`], cwd: dir, env: { STATE: dir }, signal: new AbortController().signal });
	const leaderExited = new Promise(resolve => child.once("exit", resolve));
	const outputClosed = once(child.stdout, "close"); child.stdout.resume();
	await Promise.all([leaderExited, outputClosed]);
	await new Promise(resolve => setImmediate(resolve));
	let descendant = 0;
	await vi.waitFor(async () => { descendant = Number(await readFile(join(dir, "pid"), "utf8")); expect(descendant).toBeGreaterThan(1); });
	await scope.close();
	await vi.waitFor(async () => {
		try { expect(await readFile(`/proc/${descendant}/status`, "utf8")).toMatch(/State:\s+Z/); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	});
 });
