import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "./claude-sdk-test-deferred.ts";
const fake = vi.hoisted(() => ({ beforeOpen: undefined as (() => Promise<void>) | undefined, writes: 0 }));
vi.mock("node:fs/promises", async original => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
		await fake.beforeOpen?.();
		const file = await actual.open(...args), write = file.writeFile.bind(file);
		file.writeFile = (...values: Parameters<typeof write>) => { fake.writes++; return write(...values); };
		return file;
	} };
});
import { OwnedPilotFile, PilotOperations } from "../extensions/claude-sdk/pilot-operations.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { fake.beforeOpen = undefined; fake.writes = 0; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("retains late exclusive creation and removes it without starting a late write", async () => {
	const root = await mkdtemp(join(tmpdir(), "sdk-owned-operation-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const release = deferred(), entered = deferred();
	fake.beforeOpen = async () => { entered.resolve(); await release.promise; };
	const operations = new PilotOperations(30, () => {});
	const file = new OwnedPilotFile(join(root, "fixture"));
	try {
		const observed = operations.wait(() => file.write("OFFLINE_PAYLOAD", operations));
		const refused = expect(observed).rejects.toThrow("deadline");
		await entered.promise;
		await refused;
		expect(fake.writes).toBe(0);
		release.resolve();
		await file.cleanup();
		expect(fake.writes).toBe(0);
		expect(await readdir(root)).toEqual([]);
	} finally { release.resolve(); await file.cleanup(); operations.stop(); }
});

it("starts each required cleanup attempt even after the observation deadline", async () => {
	const operations = new PilotOperations(1_000, () => {}), release = deferred();
	operations.cancel();
	let started = 0;
	try {
		await expect(operations.wait(() => { started++; return release.promise; })).rejects.toThrow("deadline");
		expect(started).toBe(0);
		await expect(operations.wait(() => { started++; return release.promise; }, true)).rejects.toThrow("deadline");
		expect(started).toBe(1);
	} finally { release.resolve(); operations.stop(); }
});

it("never removes a preexisting file when exclusive creation fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "sdk-existing-operation-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "fixture");
	await writeFile(path, "existing");
	const operations = new PilotOperations(1_000, () => {}), file = new OwnedPilotFile(path);
	try {
		await expect(operations.wait(() => file.write("replacement", operations))).rejects.toMatchObject({ code: "EEXIST" });
		await file.cleanup();
		expect(await readFile(path, "utf8")).toBe("existing");
	} finally { operations.stop(); }
});
