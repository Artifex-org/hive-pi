/**
 * OpenAI Fast mode: the priority tier is requested only when asked for, only on
 * allowlisted models, and otherwise the request is exactly what pi would send.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const calls: Array<{ api: string; options: Record<string, unknown> | undefined }> = [];

/**
 * The built-in providers as `ctx.modelRegistry.getProvider()` hands them out.
 * The extension captures these BEFORE overriding, and delegates to them.
 */
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

import fast from "../extensions/fast/index.ts";
import {
	DEFAULT_FAST_MODELS,
	fastApplies,
	parseFastCommand,
	resolveFastConfig,
	withPriorityTier,
} from "../extensions/fast/policy.ts";
import { createFakePi } from "./fake-pi.ts";

const terra = { provider: "openai-codex", id: "gpt-5.6-terra", api: "openai-codex-responses" };
const spark = { provider: "openai-codex", id: "gpt-5.3-codex-spark", api: "openai-codex-responses" };
const on = { enabled: true, models: DEFAULT_FAST_MODELS };

describe("resolveFastConfig — opt-in, because it spends money", () => {
	it("is off unless enabled is literally true or the launch asks for it", () => {
		expect(resolveFastConfig(null, {}).enabled).toBe(false);
		expect(resolveFastConfig({ enabled: "yes" }, {}).enabled).toBe(false);
		expect(resolveFastConfig({ enabled: true }, {}).enabled).toBe(true);
		expect(resolveFastConfig(null, { HIVE_PI_FAST: "1" }).enabled).toBe(true);
		expect(resolveFastConfig(null, { HIVE_PI_FAST: "true" }).enabled).toBe(false);
	});

	it("takes a configured allowlist and ignores entries that are not provider/id", () => {
		expect(resolveFastConfig({ models: ["openai/gpt-5.4-mini", "bare", 3] }, {}).models).toEqual(["openai/gpt-5.4-mini"]);
		expect(resolveFastConfig({ models: [] }, {}).models).toEqual(DEFAULT_FAST_MODELS);
	});
});

describe("fastApplies — allowlisted OpenAI models only", () => {
	it("applies to an allowlisted model on a tier-capable api when on", () => {
		expect(fastApplies(terra, on)).toBe(true);
		expect(fastApplies(terra, { ...on, enabled: false })).toBe(false);
		expect(fastApplies(spark, on)).toBe(false);
		expect(fastApplies({ ...terra, api: "openai-completions" }, on)).toBe(false);
		expect(fastApplies(undefined, on)).toBe(false);
	});
});

describe("withPriorityTier — one top-level field, after any existing hook", () => {
	const model = {} as never;
	it("adds service_tier to the body", async () => {
		expect(await withPriorityTier(undefined)({ input: [] }, model)).toEqual({ input: [], service_tier: "priority" });
	});
	it("applies to the body an earlier hook returned, and keeps its edits", async () => {
		const previous = () => ({ input: [], store: false });
		expect(await withPriorityTier(previous)({ input: [1] }, model)).toEqual({ input: [], store: false, service_tier: "priority" });
	});
	it("leaves a body it cannot extend alone", async () => {
		expect(await withPriorityTier(undefined)("raw", model)).toBeUndefined();
	});
});

describe("parseFastCommand", () => {
	it("reads on, off, status and a bare toggle", () => {
		expect(parseFastCommand("")).toBe("toggle");
		expect(parseFastCommand(" ON ")).toBe("on");
		expect(parseFastCommand("status")).toBe("status");
		expect(parseFastCommand("maybe")).toBeUndefined();
	});
});

describe("the extension", () => {
	let home: string;
	let realHome: string | undefined;
	let realFast: string | undefined;

	beforeEach(() => {
		calls.length = 0;
		home = mkdtempSync(join(tmpdir(), "fast-home-"));
		realHome = process.env.HOME;
		realFast = process.env.HIVE_PI_FAST;
		process.env.HOME = home;
		delete process.env.HIVE_PI_FAST;
	});
	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		if (realFast === undefined) delete process.env.HIVE_PI_FAST;
		else process.env.HIVE_PI_FAST = realFast;
		rmSync(home, { recursive: true, force: true });
	});

	const configFile = () => join(home, ".pi", "agent", "hive-telemetry", "fast.config.json");

	async function load() {
		const fake = createFakePi();
		const providers = new Map<string, { api: string; streamSimple: (...args: unknown[]) => unknown }>();
		(fake.api as unknown as { registerProvider: unknown }).registerProvider = (name: string, config: never) => {
			providers.set(name, config);
		};
		fast(fake.api);
		await fake.emit({ type: "session_start", reason: "startup" }, { model: terra as never, modelRegistry: registry });
		return { fake, providers };
	}

	it("wraps nothing when the registry has no provider to delegate to", async () => {
		const fake = createFakePi();
		const registered: string[] = [];
		(fake.api as unknown as { registerProvider: unknown }).registerProvider = (name: string) => registered.push(name);
		fast(fake.api);
		await fake.emit({ type: "session_start", reason: "startup" }, { model: terra as never });
		expect(registered).toEqual([]);
	});

	it("wraps once per process, so a later session cannot wrap its own override", async () => {
		const fake = createFakePi();
		const registered: string[] = [];
		(fake.api as unknown as { registerProvider: unknown }).registerProvider = (name: string) => registered.push(name);
		fast(fake.api);
		await fake.emit({ type: "session_start", reason: "startup" }, { modelRegistry: registry });
		await fake.emit({ type: "session_start", reason: "new" }, { modelRegistry: registry });
		expect(registered).toEqual(["openai-codex", "openai"]);
	});

	it("registers the built-in provider ids, so pi routes their models through it", async () => {
		const { providers } = await load();
		expect(providers.get("openai-codex")?.api).toBe("openai-codex-responses");
		expect(providers.get("openai")?.api).toBe("openai-responses");
	});

	it("off, hands pi's own options through untouched", async () => {
		const { providers } = await load();
		const options = { reasoning: "high" };
		providers.get("openai-codex")?.streamSimple(terra, {}, options);
		expect(calls).toEqual([{ api: "openai-codex-responses", options }]);
	});

	it("on, requests the priority tier for an allowlisted model and not for another", async () => {
		process.env.HIVE_PI_FAST = "1";
		const { providers } = await load();
		const codex = providers.get("openai-codex");
		codex?.streamSimple(terra, {}, { reasoning: "high" });
		codex?.streamSimple(spark, {}, { reasoning: "high" });

		const hook = calls[0]?.options?.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
		expect(calls[0]?.options?.reasoning).toBe("high");
		expect(await hook({ input: [] }, terra)).toEqual({ input: [], service_tier: "priority" });
		expect(calls[1]?.options).toEqual({ reasoning: "high" });
	});

	it("/fast on persists, shows the marker, and the next request carries the tier", async () => {
		const { fake, providers } = await load();
		await fake.runCommand("fast", "on", { model: terra as never });

		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ enabled: true });
		expect(fake.statuses.at(-1)).toEqual({ key: "fast", text: "⚡ fast" });
		providers.get("openai-codex")?.streamSimple(terra, {}, {});
		expect(calls[0]?.options?.onPayload).toBeTypeOf("function");

		await fake.runCommand("fast", "off", { model: terra as never });
		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ enabled: false });
		expect(fake.statuses.at(-1)).toEqual({ key: "fast", text: undefined });
	});

	it("keeps the rest of an existing config file when toggling", async () => {
		mkdirSync(join(home, ".pi", "agent", "hive-telemetry"), { recursive: true });
		writeFileSync(configFile(), JSON.stringify({ models: ["openai-codex/gpt-5.3-codex-spark"] }));
		const { fake, providers } = await load();
		await fake.runCommand("fast", "on", { model: spark as never });

		expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({
			models: ["openai-codex/gpt-5.3-codex-spark"],
			enabled: true,
		});
		providers.get("openai-codex")?.streamSimple(spark, {}, {});
		expect(calls[0]?.options?.onPayload).toBeTypeOf("function");
	});
});
