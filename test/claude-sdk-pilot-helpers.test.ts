import { afterEach, describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn(() => { throw new Error("Forbidden helper subprocess"); }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn }));
import { assertHelperInferenceAllowed, isSdkPilotEnv, isWorkerEnv } from "../extensions/fast/policy.ts";
import { runOneShot } from "../extensions/agenda/spawn.ts";
import { runBriefer } from "../extensions/brief/run.ts";
import { PI_ROLES_RUNTIME } from "../extensions/harness/roles.ts";
import { claudeSdkModels } from "../extensions/claude-sdk/provider.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nativeClassifier } from "../extensions/typesafe-common/native.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";
import { aideDeps, type AideRequest } from "../extensions/hive-remote/communication-aide.ts";
import { resolveYouShouldKnowModel } from "../extensions/you-should-know/index.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); spawn.mockClear(); });
describe("bounded SDK pilot helper restrictions", () => {
	it("is not worker identity or a default restriction", () => {
		const env = { HIVE_CLAUDE_SDK_PILOT: "1" };
		expect(isSdkPilotEnv(env)).toBe(true);
		expect(isWorkerEnv(env)).toBe(false);
		expect(env).toEqual({ HIVE_CLAUDE_SDK_PILOT: "1" });
		expect(() => assertHelperInferenceAllowed(env)).toThrow("Helper inference disabled for bounded SDK pilot");
		for (const value of [undefined, "0", "true"]) {
			const ordinary = { HIVE_CLAUDE_SDK_PILOT: value };
			expect(isSdkPilotEnv(ordinary)).toBe(false);
			expect(() => assertHelperInferenceAllowed(ordinary)).not.toThrow();
		}
	});
	it("refuses one-shot judges, drift and recap before any subprocess", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		const result = await runOneShot({ prompt: "offline helper fixture", cwd: process.cwd(), timeoutMs: 10 });
		expect(result).toMatchObject({ text: "", tokens: 0, exitCode: 1, timedOut: false,
			stderr: "Helper inference disabled for bounded SDK pilot" });
		expect(spawn).not.toHaveBeenCalled();
	});
	it("refuses retrieval workers without network or spawning", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		const network = vi.fn(() => { throw new Error("Forbidden helper network"); });
		vi.stubGlobal("fetch", network);
		const result = await runBriefer({ task: "offline fixture", cwd: process.cwd(), timeoutMs: 10, roles: PI_ROLES_RUNTIME });
		expect(result).toMatchObject({ draft: null, usage: null, lanes: [],
			failure: "Helper inference disabled for bounded SDK pilot" });
		expect(network).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
	});
	it("refuses production helper resolvers before accessing model credentials", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		const lookup = vi.fn(() => { throw new Error("Forbidden credential lookup"); });
		const ctx = Object.defineProperty({}, "modelRegistry", { get: lookup }) as ExtensionContext;
		await expect(resolveYouShouldKnowModel(ctx)).rejects.toThrow("Helper inference disabled for bounded SDK pilot");
		await expect(aideDeps.select(ctx, "low")).rejects.toThrow("Helper inference disabled for bounded SDK pilot");
		await expect(aideDeps.complete(ctx, "offline", {} as AideRequest, new AbortController().signal)).rejects.toThrow("Helper inference disabled for bounded SDK pilot");
		expect(lookup).not.toHaveBeenCalled();
	});
	it("refuses native question/drift classification before registry or credential access", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		const registry = vi.fn(() => null);
		const client = nativeClassifier(configFrom({ enabled: true }), registry);
		expect(client.live).toBe(false);
		expect(await client.ask({}, {})).toEqual({ kind: "disabled", reason: "config" });
		expect(registry).not.toHaveBeenCalled();
	});
	it("does not advertise a cache lifetime that could start Pi cache warming", () => {
		const models = claudeSdkModels(); expect(models.length).toBeGreaterThan(0);
		for (const model of models) expect(model.promptCache).toBeUndefined();
	});
});
