import type { ClassifierResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { noulQuestion, choiceQuestion, scoreQuestion } from "../extensions/typesafe-common/client.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";
import { nativeClassifier, type ClassifierRegistry } from "../extensions/typesafe-common/native.ts";

type Registry = ClassifierRegistry;
const questions = { aligned: noulQuestion("Does this serve the goal?", { true: "yes", false: "no" }) };
const model: NonNullable<ReturnType<Registry["findOfType"]>> = { type: "classifier", api: "typesafe-system-one", provider: "typesafe", id: "jev-latest",
	name: "Jev", baseUrl: "https://api.typesafe.ai/v1", contextWindow: 64000, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const result: ClassifierResult = { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest",
	answers: { aligned: { type: "bool", probability: 0.9 } }, stopReason: "stop", timestamp: 0,
	usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } };
function setup(raw: unknown = { enabled: true }, response = result) {
	const classify = vi.fn<Registry["classify"]>().mockResolvedValue(response);
	const findOfType = vi.fn<Registry["findOfType"]>().mockReturnValue(model);
	const registry: Registry = { classify, findOfType };
	return { client: nativeClassifier(configFrom(raw), () => registry), classify, findOfType };
}

describe("native advisory classification", () => {
	it.each([null, {}, { enabled: false }])("never resolves a provider or sends data without opt-in: %j", async raw => {
		const { client, classify, findOfType } = setup(raw);
		expect(client.live).toBe(false);
		expect(await client.ask("private", questions)).toEqual({ kind: "disabled", reason: "config" });
		expect(classify).not.toHaveBeenCalled(); expect(findOfType).not.toHaveBeenCalled();
	});
	it("uses the registry's bool contract, signal, token counts and catalog prices", async () => {
		const { client, classify, findOfType } = setup();
		const outcome = await client.ask({ goal: "finish" }, questions);
		expect(findOfType).toHaveBeenCalledWith("classifier", "typesafe", "jev-latest");
		expect(classify).toHaveBeenCalledWith(model, { state: { goal: "finish" }, questions: {
			aligned: { type: "bool", instructions: "Does this serve the goal?", criteria: { true: "yes", false: "no" } },
		} }, { signal: expect.any(AbortSignal) });
		expect(outcome).toMatchObject({ kind: "ok", answers: { aligned: { type: "noul", noul: 0.9 } },
			usage: { inputTokens: 10, outputTokens: 2, cost: { total: 0.03 } } });
	});
	it("fails closed when the context or selected model is unavailable", async () => {
		const client = nativeClassifier(configFrom({ enabled: true }), () => null);
		expect(client.live).toBe(false);
		expect(await client.ask("private", questions)).toEqual({ kind: "disabled", reason: "no_model" });
		const missing = setup(); missing.findOfType.mockReturnValue(undefined);
		expect(await missing.client.ask("private", questions)).toEqual({ kind: "disabled", reason: "no_model" });
		expect(missing.classify).not.toHaveBeenCalled();
	});
	it("refuses old custom endpoints rather than silently rerouting private data", async () => {
		const { client, classify } = setup({ enabled: true, endpoint: "https://proxy.example/v1/systemone" });
		expect(await client.ask("private", questions)).toMatchObject({ kind: "rejected" });
		expect(classify).not.toHaveBeenCalled();
	});
	it("refuses invalid requests before classification", async () => {
		const { client, classify } = setup();
		expect(await client.ask("private", { invalid: choiceQuestion("pick", { one: "one" }) })).toMatchObject({ kind: "rejected" });
		expect(classify).not.toHaveBeenCalled();
	});
	it.each([
		{}, { aligned: { type: "bool", probability: 2 } }, { aligned: { type: "bool", probability: NaN } },
		{ aligned: { type: "score", score: 1, confidence: 1 } },
	])("rejects success-shaped missing, out-of-range or wrong-type answers: %j", async answers => {
		const { client } = setup(undefined, { ...result, answers } as ClassifierResult);
		expect(await client.ask("private", questions)).toMatchObject({ kind: "malformed" });
	});
	it("validates choice and score answers against the supplied criteria", async () => {
		const { client } = setup(undefined, { ...result, answers: { pick: { type: "choice", choice: "invented", confidence: 1, probabilities: {} } } });
		expect(await client.ask("state", { pick: choiceQuestion("pick", { a: "a", b: "b" }) })).toMatchObject({ kind: "malformed" });
		const score = setup(undefined, { ...result, answers: { value: { type: "score", score: 9, confidence: 1 } } });
		expect(await score.client.ask("state", { value: scoreQuestion("score", ["low", "high"]) })).toMatchObject({ kind: "malformed" });
	});
	it("never exposes provider error prose or treats it as an answer", async () => {
		const { client } = setup(undefined, { ...result, stopReason: "error", errorMessage: "Bearer secret-token", answers: {} });
		expect(await client.ask("private", questions)).toEqual({ kind: "transport_error", error: "native_classifier_error" });
	});
	it("redacts thrown provider errors as well as error envelopes", async () => {
		const { client, classify } = setup();
		classify.mockRejectedValue(new Error("Bearer secret-token: private transcript"));
		expect(await client.ask("private", questions)).toEqual({ kind: "transport_error", error: "native_classifier_error" });
	});
	it("propagates caller cancellation into the native request signal", async () => {
		const { classify, findOfType } = setup();
		const controller = new AbortController();
		classify.mockImplementation(async (_model, _context, options) => new Promise(resolve => {
			options?.signal?.addEventListener("abort", () => resolve({ ...result, stopReason: "aborted", answers: {} }));
		}));
		const client = nativeClassifier(configFrom({ enabled: true }), () => ({ classify, findOfType }), () => controller.signal);
		const pending = client.ask("private", questions);
		await Promise.resolve();
		controller.abort();
		expect(await pending).toMatchObject({ kind: "timeout" });
		findOfType.mockClear(); classify.mockClear();
		expect(await client.ask("private", questions)).toMatchObject({ kind: "timeout" });
		expect(classify).not.toHaveBeenCalled(); expect(findOfType).not.toHaveBeenCalled();
	});
	it("enforces its deadline even when a provider ignores abort", async () => {
		vi.useFakeTimers();
		try {
			const { client, classify } = setup({ enabled: true, timeoutMs: 250 });
			classify.mockImplementation(async () => new Promise(() => {}));
			const pending = client.ask("private", questions);
			await vi.advanceTimersByTimeAsync(251);
			expect(await pending).toEqual({ kind: "timeout", timeoutMs: 250 });
		} finally { vi.useRealTimers(); }
	});
	it("aborts through the native signal at the deadline", async () => {
		vi.useFakeTimers();
		try {
			const { client, classify } = setup({ enabled: true, timeoutMs: 250 });
			classify.mockImplementation(async (_model, _context, options) => new Promise(resolve => {
				options?.signal?.addEventListener("abort", () => resolve({ ...result, stopReason: "aborted", answers: {} }));
			}));
			const outcome = client.ask("private", questions);
			await vi.advanceTimersByTimeAsync(251);
			expect(await outcome).toEqual({ kind: "timeout", timeoutMs: 250 });
		} finally { vi.useRealTimers(); }
	});
});
