import { mkdtemp, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { cancellable, hiveLease, LEASE_UNAVAILABLE_GRACE_MS, LeaseManager, processScope } from "../extensions/claude-sdk/runtime.ts";
import { testTempEnv } from "./temp-env.ts";
import { SdkLeaseRefused } from "../extensions/claude-sdk/events.ts";

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

// Hive answers 503 while the node's SDK capability advert reads unavailable (a harness
// update dips it until the next heartbeat). As a 403 that killed live sessions at once.
it("waits out a 503 for the advert, honouring Retry-After, then leases", async () => {
	vi.useFakeTimers();
	let calls = 0;
	const leases = new LeaseManager(async () => { if (++calls < 3) throw new SdkLeaseRefused(503, true, 2_000); return value(); });
	const output = leases.get(new AbortController().signal);
	await vi.advanceTimersByTimeAsync(2 * 2_000);
	expect(await output).toMatchObject({ access_token: "offline-only" }); expect(calls).toBe(3);
	leases.close();
});

it("fails a 503 that outlasts the grace with its own error, and every other refusal at once", async () => {
	vi.useFakeTimers();
	const started = Date.now(); let failedAt = 0;
	const unavailable = new LeaseManager(async () => { throw new SdkLeaseRefused(503, true); });
	const output = unavailable.get(new AbortController().signal).catch(error => { failedAt = Date.now(); return error; });
	await vi.advanceTimersByTimeAsync(LEASE_UNAVAILABLE_GRACE_MS + 30_000);
	expect((await output).message).toMatch(/stayed temporarily refused for \d+ s \(HTTP 503/);
	expect(failedAt - started).toBeGreaterThan(LEASE_UNAVAILABLE_GRACE_MS - 30_000);
	expect(failedAt - started).toBeLessThanOrEqual(LEASE_UNAVAILABLE_GRACE_MS - 10_000);
	unavailable.close();
	// An unmarked 503 (a proxy's, the broker's) is as final as any other refusal.
	for (const status of [403, 404, 502, 503]) {
		const refused = vi.fn(async () => { throw new SdkLeaseRefused(status); });
		await expect(new LeaseManager(refused).get(new AbortController().signal)).rejects.toMatchObject({ status });
		expect(refused).toHaveBeenCalledOnce();
	}
});

it("treats only Hive's marked 503 as a temporary lease refusal", async () => {
	const config = { executable: "/pinned/claude", stateRoot: "/state", url: "https://hive.invalid", token: "synthetic-hive", launch: "launch-offline", cwd: process.cwd() };
	const refusal = async (status: number, headers: Record<string, string>) =>
		hiveLease(config, async () => new Response("{}", { status, headers }))(new AbortController().signal).catch(error => error);
	expect(await refusal(503, { "X-Hive-Lease-Retryable": "1", "Retry-After": "15" })).toMatchObject({ status: 503, retryable: true, retryAfterMs: 15_000 });
	expect(await refusal(503, { "Retry-After": "15" })).toMatchObject({ status: 503, retryable: false });
	expect(await refusal(403, { "X-Hive-Lease-Retryable": "1" })).toMatchObject({ status: 403, retryable: false });
});

it("stops asking Hive once no caller waits for the lease", async () => {
	vi.useFakeTimers();
	const source = vi.fn(async () => { throw new SdkLeaseRefused(503, true); });
	const leases = new LeaseManager(source);
	const caller = new AbortController();
	const output = leases.get(caller.signal).catch(error => error);
	await vi.advanceTimersByTimeAsync(0);
	caller.abort(new Error("turn aborted"));
	expect((await output).message).toBe("turn aborted");
	const asked = source.mock.calls.length;
	await vi.advanceTimersByTimeAsync(LEASE_UNAVAILABLE_GRACE_MS);
	expect(source).toHaveBeenCalledTimes(asked);
	leases.close();
});

it("closing a lease manager ends a 503 wait at once", async () => {
	const leases = new LeaseManager(async () => { throw new SdkLeaseRefused(503, true, 15_000); });
	const output = leases.get(new AbortController().signal).catch(error => error);
	await new Promise(resolve => setImmediate(resolve));
	leases.close();
	expect(await output).toMatchObject({ name: "AbortError" });
});

it("closing a lease manager aborts acquisition without authorizing a later request", async () => {
	const source = vi.fn(() => new Promise<ReturnType<typeof value>>(() => {}));
	const leases = new LeaseManager(source);
	const output = leases.get(new AbortController().signal).catch(error => error);
	leases.close(); expect(await output).toMatchObject({ name: "AbortError" });
	await expect(leases.get(new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
});

it.runIf(process.platform === "linux")("the real process launcher inherits umask 077, restores the parent mask and cleans its process group", async () => {
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
	`], cwd: dir, env: { ...testTempEnv(), STATE: dir }, signal: new AbortController().signal });
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
	`], cwd: dir, env: { ...testTempEnv(), STATE: dir }, signal: new AbortController().signal });
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

it.runIf(process.platform === "linux")("cleanup escalates to SIGKILL for a synthetic descendant that ignores SIGTERM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-sdk-descendant-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const scope = processScope(); cleanup.push(scope.close);
	const child = scope.spawn({ command: process.execPath, args: ["-e", `
		const cp = require('node:child_process');
		process.on('SIGTERM', () => {});
		const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},10000)"], {stdio:['ignore','pipe','ignore']});
		child.stdout.once('data', () => { require('node:fs').writeFileSync(process.env.STATE + '/pid', String(child.pid)); console.log('ready'); });
		setInterval(()=>{},10000);
	`], cwd: dir, env: { ...testTempEnv(), STATE: dir }, signal: new AbortController().signal });
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
	`], cwd: dir, env: { ...testTempEnv(), STATE: dir }, signal: new AbortController().signal });
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
