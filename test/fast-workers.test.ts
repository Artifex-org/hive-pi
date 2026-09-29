/**
 * Fast mode in delegated workers and one-shot helpers.
 *
 * A Hive launch asks for fast with two separate switches: HIVE_PI_FAST=1 for
 * the main session and PI_SUBAGENT_FAST=1 for its helpers. Workers inherit the
 * parent's whole environment, so a worker must decide by PI_SUBAGENT_FAST alone
 * — otherwise "main fast, helpers default" (or the reverse) cannot be said.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import fast from "../extensions/fast/index.ts";
import { isCacheWarm, isWorkerEnv, resolveFastConfig } from "../extensions/fast/policy.ts";
import fastWorker from "../extensions/fast/worker.ts";
import { workerExtensionPaths } from "../extensions/subagent/worker.ts";
import { createFakePi } from "./fake-pi.ts";

const calls: Array<{ api: string; options: Record<string, unknown> | undefined }> = [];
const registry = {
	getProvider: (id: string) => {
		const api = id === "openai-codex" ? "openai-codex-responses" : id === "openai" ? "openai-responses" : undefined;
		if (!api) return undefined;
		return {
			id,
			streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
				calls.push({ api, options });
				return {} as never;
			},
		};
	},
};
const luna = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses" };

describe("resolveFastConfig — the worker rule", () => {
	const matrix: Array<[string, NodeJS.ProcessEnv, Record<string, unknown> | null, boolean]> = [
		["main: HIVE_PI_FAST", { HIVE_PI_FAST: "1" }, null, true],
		["main: PI_SUBAGENT_FAST is not the main switch", { PI_SUBAGENT_FAST: "1" }, null, false],
		["main: stored setting", {}, { enabled: true }, true],
		["worker: PI_SUBAGENT_FAST", { PI_AGENDA_WORKER: "1", PI_SUBAGENT_FAST: "1" }, null, true],
		["briefer: PI_SUBAGENT_FAST", { PI_BRIEF_WORKER: "1", PI_SUBAGENT_FAST: "1" }, null, true],
		["worker: the inherited HIVE_PI_FAST is ignored", { PI_AGENDA_WORKER: "1", HIVE_PI_FAST: "1" }, null, false],
		["worker: the stored setting is ignored", { PI_AGENDA_WORKER: "1" }, { enabled: true }, false],
		["worker: helpers fast, main not", { PI_AGENDA_WORKER: "1", PI_SUBAGENT_FAST: "1", HIVE_PI_FAST: "0" }, null, true],
	];
	for (const [name, env, raw, want] of matrix) {
		it(name, () => expect(resolveFastConfig(raw, env).enabled).toBe(want));
	}

	it("keeps the stored allowlist in a worker: models are a fact, not a choice", () => {
		const config = resolveFastConfig({ models: ["openai/gpt-5.4-mini"] }, { PI_AGENDA_WORKER: "1" });
		expect(config.models).toEqual(["openai/gpt-5.4-mini"]);
	});

	it("knows a worker by either spawner's marker", () => {
		expect(isWorkerEnv({ PI_AGENDA_WORKER: "1" })).toBe(true);
		expect(isWorkerEnv({ PI_BRIEF_WORKER: "1" })).toBe(true);
		expect(isWorkerEnv({})).toBe(false);
	});
});

describe("cache warming", () => {
	it("recognises pi's warm-up request by its one-token cap", () => {
		expect(isCacheWarm({ maxTokens: 1 })).toBe(true);
		expect(isCacheWarm({ maxTokens: 32_000 })).toBe(false);
		expect(isCacheWarm(undefined)).toBe(false);
	});
});

describe("the extensions in a worker process", () => {
	const saved: Record<string, string | undefined> = {};
	const keys = ["HOME", "HIVE_PI_FAST", "PI_SUBAGENT_FAST", "PI_AGENDA_WORKER", "PI_BRIEF_WORKER"];
	let home: string;

	beforeEach(() => {
		calls.length = 0;
		for (const k of keys) saved[k] = process.env[k];
		for (const k of keys) delete process.env[k];
		home = mkdtempSync(join(tmpdir(), "fast-workers-"));
		process.env.HOME = home;
	});
	afterEach(() => {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(home, { recursive: true, force: true });
	});

	async function start(factory: (pi: never) => void, flags: Record<string, unknown> = {}) {
		const fake = createFakePi();
		const providers = new Map<string, { streamSimple: (...args: unknown[]) => unknown }>();
		(fake.api as unknown as { registerProvider: unknown }).registerProvider = (name: string, config: never) => {
			providers.set(name, config);
		};
		for (const [k, v] of Object.entries(flags)) fake.flags.set(k, v);
		factory(fake.api as never);
		await fake.emit({ type: "session_start", reason: "startup" }, { model: luna as never, modelRegistry: registry });
		return providers;
	}

	it("the worker module sends a subagent's request at the priority tier when PI_SUBAGENT_FAST=1", async () => {
		process.env.PI_AGENDA_WORKER = "1";
		process.env.PI_SUBAGENT_FAST = "1";
		const providers = await start(fastWorker);
		providers.get("openai-codex")?.streamSimple(luna, {}, {});
		const hook = calls[0]?.options?.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
		expect(await hook({ input: [] }, luna)).toEqual({ input: [], service_tier: "priority" });
	});

	it("the worker module registers nothing when only the parent's HIVE_PI_FAST leaked in", async () => {
		process.env.PI_AGENDA_WORKER = "1";
		process.env.HIVE_PI_FAST = "1";
		const providers = await start(fastWorker);
		expect(providers.size).toBe(0);
	});

	it("a one-shot helper, which loads the full extension, follows the worker rule too", async () => {
		// recap / drift / judge / advisor-watch run `pi -p` with PI_AGENDA_WORKER=1
		// and the FULL extension set, so index.ts decides for them.
		process.env.PI_AGENDA_WORKER = "1";
		process.env.HIVE_PI_FAST = "1";
		mkdirSync(join(home, ".pi", "agent", "hive-telemetry"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "hive-telemetry", "fast.config.json"), JSON.stringify({ enabled: true }));
		const providers = await start(fast, { fast: true });
		providers.get("openai-codex")?.streamSimple(luna, {}, {});
		expect(calls[0]?.options?.onPayload).toBeUndefined();

		calls.length = 0;
		process.env.PI_SUBAGENT_FAST = "1";
		const helper = await start(fast);
		helper.get("openai-codex")?.streamSimple(luna, {}, {});
		expect(calls[0]?.options?.onPayload).toBeTypeOf("function");
	});

	it("never pays the priority tier for pi's cache warm-up", async () => {
		process.env.HIVE_PI_FAST = "1";
		const providers = await start(fast);
		providers.get("openai-codex")?.streamSimple(luna, {}, { maxTokens: 1 });
		providers.get("openai-codex")?.streamSimple(luna, {}, { maxTokens: 4096 });
		expect(calls[0]?.options?.onPayload).toBeUndefined();
		expect(calls[1]?.options?.onPayload).toBeTypeOf("function");
	});

	it("does not fail the session when the ctx cannot show a status", async () => {
		// A stale ctx throws on every property read — the harshest stand-in for a
		// helper process whose ctx has no usable UI. The status is cosmetic.
		process.env.HIVE_PI_FAST = "1";
		const fake = createFakePi();
		(fake.api as unknown as { registerProvider: unknown }).registerProvider = () => {};
		fast(fake.api);
		await expect(fake.emit({ type: "session_start", reason: "startup" }, { staleCtx: true })).resolves.toBeDefined();
		await expect(fake.emit({ type: "session_shutdown" }, { staleCtx: true })).resolves.toBeDefined();
	});
});

describe("delegated workers load the fast worker module", () => {
	it("is on the subagent and briefer argv", () => {
		expect(workerExtensionPaths().some((p) => p.endsWith("/extensions/fast/worker.ts"))).toBe(true);
	});
});
