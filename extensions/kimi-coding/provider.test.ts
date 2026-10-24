import { describe, expect, it } from "vitest";

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { declarations, hiveKimiProvider, kimiModels } from "./provider.ts";

const native = builtinProviders().find(provider => provider.id === "kimi-coding")!;

describe("kimi-coding provider", () => {
	it("keeps every model pi ships, unchanged and first", () => {
		const shipped = native.getModels();
		expect(kimiModels.slice(0, shipped.length)).toEqual(shipped);
	});

	it("adds each declared K3.1 model on pi's k3 transport", () => {
		const k3 = native.getModels().find(model => model.id === "k3")!;
		for (const declared of declarations.models) {
			const model = kimiModels.find(candidate => candidate.id === declared.id);
			expect(model, declared.id).toBeDefined();
			expect(model).toEqual({ ...k3, ...declared });
			expect(model!.provider).toBe("kimi-coding");
			expect(model!.baseUrl).toBe(k3.baseUrl);
		}
		expect(hiveKimiProvider.getAllModels().map(model => model.id)).toEqual(
			expect.arrayContaining(declarations.models.map(model => model.id)),
		);
	});

	// The undeclared fallback (a custom id built from kimi-for-coding) capped
	// output at 32768 tokens; the reason this module exists.
	it("does not inherit kimi-for-coding's output cap", () => {
		for (const declared of declarations.models) {
			expect(kimiModels.find(model => model.id === declared.id)!.maxTokens).toBeGreaterThan(32768);
		}
	});

	// K3.1 Pro answers HTTP 400 to a thinking-disabled request.
	it("clamps a requested thinking level of off up to a supported one", () => {
		for (const declared of declarations.models) {
			const model = kimiModels.find(candidate => candidate.id === declared.id)!;
			expect(clampThinkingLevel(model, "off")).not.toBe("off");
		}
	});

	it("retains pi's native OAuth and transport", () => {
		expect(hiveKimiProvider.auth.oauth).toBeDefined();
		expect(hiveKimiProvider.streamSimple).toBeTypeOf("function");
		expect(hiveKimiProvider.baseUrl).toBe(native.baseUrl);
	});
});
