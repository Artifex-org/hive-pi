import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createClaudeSdkRuntime } from "../extensions/claude-sdk/provider.ts";

const fault = vi.hoisted(() => ({ remove: false, processes: false, processCloses: 0, secondClose: undefined as Promise<void> | undefined, paths: [] as string[] }));
vi.mock("../extensions/claude-sdk/runtime.ts", async original => {
	const runtime = await original<typeof import("../extensions/claude-sdk/runtime.ts")>();
	return { ...runtime, processScope: () => {
		const scope = runtime.processScope();
		return { ...scope, close: async () => {
			fault.processCloses++;
			if (fault.processCloses === 2) await fault.secondClose;
			await scope.close();
			if (fault.processes) throw new Error("synthetic ownership loss; operator cleanup required");
		} };
	} };
});
vi.mock("node:fs/promises", async original => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, rm: vi.fn(async (...args: Parameters<typeof fs.rm>) => {
		if (fault.remove) { fault.paths.push(String(args[0])); throw new Error("synthetic rm failure"); }
		return fs.rm(...args);
	}) };
});

it.each(["query", "iterator"])("latches and reports failed setup cleanup after %s throws with seeded private history", async stage => {
	const root = await mkdtemp(join(tmpdir(), "sdk-setup-cleanup-"));
	let queries = 0; let seed = "";
	const queryClose = vi.fn();
	const runtime = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, cwd: process.cwd(),
		url: "https://hive.invalid", token: "synthetic", launch: "offline" }, {
		lease: async () => ({ access_token: "synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "a", slot: "a" }),
		validateExecutable: async () => {},
		query: request => {
			queries++; seed = request.options.resume!;
			if (stage === "query") throw new Error("synthetic setup query failure");
			return { close: queryClose, [Symbol.asyncIterator]() { throw new Error("synthetic iterator failure"); } };
		},
	});
	const model = runtime.provider.getModels().find(model => model.id.includes("sonnet"))!;
	const context = normalizeContext({ messages: [
		{ role: "user", content: "sensitive previous history", timestamp: 1 },
		{ role: "user", content: "new turn", timestamp: 2 },
	] });
	fault.paths.length = 0; fault.remove = true;
	try {
		const first = await runtime.provider.streamSimple(model, context).result();
		expect(first).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/operator cleanup required/) });
		expect(await readFile(seed, "utf8")).toContain("sensitive previous history");
		expect(fault.paths).toHaveLength(1); expect(await readdir(root)).toHaveLength(1);
		const independent = normalizeContext({ messages: [{ role: "user", content: "independent request", timestamp: 3 }] });
		expect((await runtime.provider.streamSimple(model, independent).result()).errorMessage).toMatch(/operator cleanup required/);
		expect(queries).toBe(1); expect(fault.paths).toHaveLength(1);
		expect(queryClose).toHaveBeenCalledTimes(stage === "iterator" ? 1 : 0);
		await expect(runtime.close()).rejects.toThrow(/operator cleanup required/);
		await expect(runtime.close()).rejects.toThrow(/operator cleanup required/);
	} finally {
		fault.remove = false;
		await runtime.close().catch(() => {});
		await rm(root, { force: true, recursive: true });
	}
});

it("setup cleanup still closes processes and removes private state when query.close throws", async () => {
	const root = await mkdtemp(join(tmpdir(), "sdk-owner-cleanup-"));
	fault.processCloses = 0; fault.processes = true;
	const queryClose = vi.fn(() => { throw new Error("synthetic query close failure"); });
	let queries = 0;
	const runtime = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, cwd: process.cwd(),
		url: "https://hive.invalid", token: "synthetic", launch: "offline" }, {
		lease: async () => ({ access_token: "synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "a", slot: "a" }),
		validateExecutable: async () => {},
		query: () => { queries++; return { close: queryClose, [Symbol.asyncIterator]() { throw new Error("synthetic iterator failure"); } }; },
	});
	try {
		const model = runtime.provider.getModels().find(model => model.id.includes("sonnet"))!;
		const context = normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] });
		expect((await runtime.provider.streamSimple(model, context).result()).errorMessage).toMatch(/operator cleanup required/);
		expect(queryClose).toHaveBeenCalledOnce(); expect(fault.processCloses).toBe(1);
		expect(await readdir(root)).toEqual([]);
		expect((await runtime.provider.streamSimple(model, context).result()).errorMessage).toMatch(/operator cleanup required/);
		expect(queries).toBe(1); await expect(runtime.close()).rejects.toThrow(/operator cleanup required/);
	} finally {
		fault.processes = false; await runtime.close().catch(() => {}); await rm(root, { force: true, recursive: true });
	}
});

it("shutdown awaits all owned cleanup even after another disposal fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "sdk-shutdown-settlement-"));
	let release!: () => void;
	fault.secondClose = new Promise<void>(resolve => { release = resolve; });
	fault.processCloses = 0; fault.processes = true;
	const runtime = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, cwd: process.cwd(),
		url: "https://hive.invalid", token: "synthetic", launch: "offline" }, {
		lease: async () => ({ access_token: "synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "a", slot: "a" }),
		validateExecutable: async () => {},
		query: () => ({ close() {}, [Symbol.asyncIterator]() { throw new Error("synthetic setup failure"); } }),
	});
	const model = runtime.provider.getModels().find(model => model.id.includes("sonnet"))!;
	const context = normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] });
	const requests = ["a", "b"].map(sessionId => runtime.provider.streamSimple(model, context, { sessionId }).result());
	try {
		await vi.waitFor(() => expect(fault.processCloses).toBe(2));
		const closing = runtime.close(); let settled = false;
		const observed = closing.then(() => { settled = true; }, () => { settled = true; });
		expect(runtime.close()).toBe(closing);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(settled).toBe(false);
		release();
		await expect(closing).rejects.toThrow(/operator cleanup required/);
		await observed; await Promise.all(requests);
		expect(settled).toBe(true); expect(await readdir(root)).toEqual([]);
	} finally {
		release(); fault.secondClose = undefined; fault.processes = false;
		await Promise.allSettled(requests); await runtime.close().catch(() => {});
		await rm(root, { force: true, recursive: true });
	}
});
