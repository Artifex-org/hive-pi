import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	root: 990000101, member: 990000102, rootStart: "100", memberStart: "101", token: "", recycled: false, denied: false, missingRoot: false, deniedEnvironment: false, exitingEnvironment: false, memberState: "S",
	child: undefined as import("node:child_process").ChildProcess | undefined,
}));
vi.mock("node:child_process", async original => {
	const cp = await original<typeof import("node:child_process")>();
	return { ...cp, spawn: vi.fn((command, args, options) => {
		if (command !== "/synthetic/pinned") throw new Error("Only offline synthetic spawn is allowed");
		expect(args).toEqual(["--fixture"]); expect(options.detached).toBe(true);
		expect(options.env).not.toHaveProperty("HIVE_TOKEN");
		fixture.token = options.env.HIVE_PI_TREE_TOKENS;
		expect(fixture.token).toEqual(expect.any(String));
		return fixture.child;
	}) };
});
vi.mock("node:fs", async original => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs,
		readdirSync: vi.fn((path, ...args) => String(path) === "/proc" ? [String(fixture.root), String(fixture.member)] : (fs.readdirSync as (...args: unknown[]) => unknown)(path, ...args)),
		statSync: vi.fn((path, ...args) => String(path) === `/proc/${fixture.member}` ? { uid: process.getuid?.() } : (fs.statSync as (...args: unknown[]) => unknown)(path, ...args)),
		readFileSync: vi.fn((path, ...args) => {
			if (fixture.deniedEnvironment && String(path) === `/proc/${fixture.member}/environ`) {
				if (fixture.exitingEnvironment) fixture.memberState = "Z";
				throw Object.assign(new Error("offline environment denied"), { code: "EACCES" });
			}
			if (fixture.denied && String(path).startsWith("/proc/")) throw Object.assign(new Error("offline denied"), { code: "EACCES" });
			if (fixture.missingRoot && String(path) === `/proc/${fixture.root}/stat`) throw Object.assign(new Error("offline exited"), { code: "ENOENT" });
			const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(String(path));
			if (match && [fixture.root, fixture.member].includes(Number(match[1]))) {
				if (match[2] === "environ") return `HIVE_PI_TREE_TOKENS=${fixture.recycled ? "unrelated-token" : fixture.token}\0`;
				const fields = Array<string>(20).fill("0"); fields[0] = Number(match[1]) === fixture.member ? fixture.memberState : "S"; fields[1] = "1";
				fields[2] = String(fixture.root);
				fields[19] = Number(match[1]) === fixture.root ? fixture.rootStart : fixture.memberStart;
				return `${match[1]} (offline fixture) ${fields.join(" ")}`;
			}
			return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
		}),
	};
});
import { processScope, validateExecutable } from "../extensions/claude-sdk/runtime.ts";
import { killAllTrees, killTree } from "../extensions/hive-common/child-tree.ts";
import { spawn } from "node:child_process";

afterEach(() => { fixture.denied = false; fixture.missingRoot = false; fixture.deniedEnvironment = false; vi.restoreAllMocks(); vi.useRealTimers(); });

function syntheticChild() {
	fixture.rootStart = "100"; fixture.memberStart = "101"; fixture.recycled = false;
	fixture.denied = false; fixture.missingRoot = false; fixture.deniedEnvironment = false; fixture.exitingEnvironment = false; fixture.memberState = "S";
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: fixture.root });
	child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
	child.kill = vi.fn(() => true); fixture.child = child;
	return child;
}
const request = (signal = new AbortController().signal) => ({ command: "/synthetic/pinned", args: ["--fixture"], env: {}, signal });

describe.runIf(process.platform === "linux")("SDK scope reuses procfs child-tree ownership", () => {
	it.each(["before-close", "during-escalation"])("does not signal recycled PID/group identities %s", async stage => {
		fixture.rootStart = "100"; fixture.memberStart = "101"; fixture.recycled = false;
		const child = new ChildProcess();
		Object.defineProperty(child, "pid", { value: fixture.root });
		child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
		child.kill = vi.fn(() => true); fixture.child = child;
		const scope = processScope();
		const abort = new AbortController();
		scope.spawn({ command: "/synthetic/pinned", args: ["--fixture"], env: {}, signal: abort.signal });
		const recycle = () => {
			fixture.recycled = true; fixture.rootStart = "200"; fixture.memberStart = "201";
			Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
		};
		const send = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			if (stage === "before-close") { recycle(); child.emit("exit", 0); abort.abort(); }
			vi.useFakeTimers();
			const closing = scope.close();
			if (stage === "during-escalation") {
				expect(send).toHaveBeenCalledWith(fixture.root, "SIGTERM");
				expect(send).toHaveBeenCalledWith(fixture.member, "SIGTERM");
				recycle();
			}
			await vi.advanceTimersByTimeAsync(101); await closing;
			if (stage === "before-close") expect(send).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalledWith(-fixture.root, "SIGKILL");
			expect(send).not.toHaveBeenCalledWith(fixture.member, "SIGKILL");
			expect(send).not.toHaveBeenCalledWith(fixture.root, "SIGKILL");
			expect(send.mock.calls.every(([pid]) => pid > 0)).toBe(true);
			expect(child.kill).not.toHaveBeenCalled();
			child.emit("close", 0);
			expect(send).not.toHaveBeenCalledWith(-fixture.root, "SIGKILL");
		} finally {
			child.emit("close", 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
			await scope.close();
		}
	});
});

 it.each(["darwin", "unreadable"])("refuses %s before SDK spawn and executable preflight", async platform => {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	const child = syntheticChild(); const scope = processScope();
	const calls = vi.mocked(spawn).mock.calls.length;
	try {
		if (platform === "darwin") Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		else fixture.denied = true;
		expect(() => scope.spawn(request())).toThrow(/Linux with readable procfs required/);
		await expect(validateExecutable({ executable: "/must-not-be-inspected", stateRoot: "/offline", cwd: "/offline", url: "https://offline.invalid", token: "offline", launch: "offline" }, new AbortController().signal)).rejects.toThrow(/Linux with readable procfs required/);
		expect(vi.mocked(spawn).mock.calls).toHaveLength(calls);
	} finally {
		Object.defineProperty(process, "platform", original); fixture.denied = false;
		await scope.close(); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
	}
 });

 it.each(["abort", "close", "shutdown", "escalation"])("latches post-spawn procfs loss at %s without unsafe signals or observer throws", async stage => {
	const child = syntheticChild(); const scope = processScope(); const abort = new AbortController();
	const send = vi.spyOn(process, "kill").mockReturnValue(true);
	scope.spawn(request(abort.signal));
	try {
		if (stage === "escalation") {
			vi.useFakeTimers();
			const closing = scope.close().catch(error => error);
			expect(send).toHaveBeenCalledWith(fixture.root, "SIGTERM");
			expect(send).toHaveBeenCalledWith(fixture.member, "SIGTERM");
			send.mockClear(); fixture.denied = true;
			await vi.advanceTimersByTimeAsync(101);
			expect(await closing).toMatchObject({ message: expect.stringMatching(/operator cleanup required/) });
			vi.useRealTimers();
		} else {
			fixture.denied = true;
			if (stage === "abort") expect(() => abort.abort()).not.toThrow();
			if (stage === "close") expect(() => child.emit("close", 0)).not.toThrow();
			if (stage === "shutdown") expect(() => killAllTrees("SIGKILL")).not.toThrow();
			await expect(scope.close()).rejects.toThrow(/operator cleanup required/);
		}
		expect(send).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
		expect(() => killTree(child, "SIGKILL", true)).toThrow(/operator cleanup required/);
		fixture.denied = false; fixture.recycled = true; fixture.rootStart = "200"; fixture.memberStart = "201";
		// Recovering visibility cannot erase the failure, or kill recycled occupants.
		await expect(scope.close()).rejects.toThrow(/operator cleanup required/);
		expect(send).not.toHaveBeenCalled();
	} finally {
		fixture.denied = false; child.emit("close", 0);
		child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
	}
 });

 it("retains token-owned descendants after the leader and all its pipes close", async () => {
	const child = syntheticChild(); const scope = processScope();
	const send = vi.spyOn(process, "kill").mockReturnValue(true);
	scope.spawn(request()); fixture.missingRoot = true;
	child.emit("close", 0); send.mockClear();
	await scope.close();
	expect(send).toHaveBeenCalledWith(fixture.member, "SIGTERM");
	expect(send).toHaveBeenCalledWith(fixture.member, "SIGKILL");
	expect(send).not.toHaveBeenCalledWith(fixture.root, expect.anything());
	expect(send.mock.calls.every(([pid]) => pid > 0)).toBe(true);
	expect(child.kill).not.toHaveBeenCalled();
	child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
 });

 it("fails closed when an own-UID orphan candidate environment becomes unreadable", async () => {
	const child = syntheticChild(); const scope = processScope();
	const send = vi.spyOn(process, "kill").mockReturnValue(true);
	scope.spawn(request()); fixture.missingRoot = true; fixture.deniedEnvironment = true;
	expect(() => child.emit("close", 0)).not.toThrow();
	await expect(scope.close()).rejects.toThrow(/operator cleanup required/);
	expect(send).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
	child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
 });

it.each(["before-release", "after-release"])("routes SDK kill callbacks through strict ownership %s", async stage => {
	const child = syntheticChild(); const scope = processScope();
	const handle = scope.spawn(request()); const send = vi.spyOn(process, "kill").mockReturnValue(true);
	if (stage === "after-release") { await scope.close(); send.mockClear(); }
	fixture.denied = true;
	expect(() => handle.kill("SIGKILL")).not.toThrow();
	expect(handle.kill("SIGTERM")).toBe(false);
	expect(send).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
	await expect(scope.close()).rejects.toThrow(/operator cleanup required/);
	child.emit("close", 0); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
});

it("does not confuse an environ exit race with loss of live ownership visibility", async () => {
	const child = syntheticChild(); const scope = processScope();
	const send = vi.spyOn(process, "kill").mockReturnValue(true);
	scope.spawn(request()); fixture.missingRoot = true;
	fixture.deniedEnvironment = true; fixture.exitingEnvironment = true;
	await expect(scope.close()).resolves.toBeUndefined();
	expect(fixture.memberState).toBe("Z"); expect(send).not.toHaveBeenCalled();
	child.emit("close", 0); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
});

it("continues signalling verified siblings and the root after one member refuses cleanup", async () => {
	const child = syntheticChild(); const scope = processScope();
	const send = vi.spyOn(process, "kill").mockImplementation(pid => {
		if (pid === fixture.member) throw Object.assign(new Error("offline denied signal"), { code: "EPERM" });
		return true;
	});
	scope.spawn(request());
	try {
		await expect(scope.close()).rejects.toThrow(/operator cleanup required/);
		expect(send).toHaveBeenCalledWith(fixture.member, "SIGTERM");
		expect(send).toHaveBeenCalledWith(fixture.member, "SIGKILL");
		expect(send).toHaveBeenCalledWith(fixture.root, "SIGTERM");
		expect(send).toHaveBeenCalledWith(fixture.root, "SIGKILL");
		expect(send.mock.calls.every(([pid]) => pid > 0)).toBe(true);
	} finally {
		child.emit("close", 0); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
	}
});
