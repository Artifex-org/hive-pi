/**
 * The Claude SDK provider's failure diagnostics and its one pre-effect retry.
 *
 * HIV-3906 eval, 2026-10-20: two interactive turns came back as the generic
 * "Claude SDK interrupted or failed" with no diagnostics. The SDK frame carried
 * error code "unknown" and "API Error: 400 …", and nothing of it reached Hive.
 * Both requests had failed before the model proposed anything.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkRuntime, type QueryFactory } from "../extensions/claude-sdk/provider.ts";
import { emptyUsage, sdkFailureDetail } from "../extensions/claude-sdk/events.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ACCESS = "synthetic-access-only-token-value";
const lease = async () => ({ access_token: ACCESS, expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "account-a", slot: "slot-a" });
const tool = { name: "read", description: "Pi read", parameters: Type.Object({ path: Type.String() }) };
const message = (event: unknown): SDKMessage => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-000000000001", session_id: "fixture" }) as unknown as SDKMessage;
function* text(value: string) {
	yield message({ type: "message_start", message: { id: "response", usage: { input_tokens: 1, output_tokens: 0 } } });
	yield message({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	yield message({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });
	yield message({ type: "content_block_stop", index: 0 });
	yield message({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
	yield message({ type: "message_stop" });
	yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
}
const REFUSAL = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage"},"request_id":"req_011CUsecretrequestid"}';
const failure = (code: string, apiText = REFUSAL): SDKMessage => ({
	type: "assistant", error: code, parent_tool_use_id: null, uuid: "u", session_id: "s",
	message: { id: "failed", content: [{ type: "text", text: apiText }], stop_reason: null, model: "m" },
}) as unknown as SDKMessage;

/** A runtime whose Nth query (1-based) yields `frames(n)`. */
async function runtime(frames: (attempt: number) => Iterable<SDKMessage>) {
	const root = await mkdtemp(join(tmpdir(), "claude-sdk-retry-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	let queries = 0;
	const query: QueryFactory = request => {
		const attempt = ++queries;
		const iterator = (async function* () {
			await request.prompt[Symbol.asyncIterator]().next();
			yield* frames(attempt);
		})();
		return { [Symbol.asyncIterator]: () => iterator, close() {} };
	};
	const sdk = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: "synthetic-hive",
		launch: "launch-offline", cwd: process.cwd() }, { query, lease, validateExecutable: async () => {} });
	cleanups.push(sdk.close);
	const model = sdk.provider.getModels().find(m => m.id.includes("sonnet"))!;
	return { ...sdk, root, model, queries: () => queries };
}
const prompt = () => normalizeContext({ systemPrompt: "Pi", tools: [tool], messages: [{ role: "user", content: "go", timestamp: 1 }] });

describe("sdkFailureDetail — a sanitized cause, never raw SDK text", () => {
	it("keeps the status and the API error's type and message, not its request id", () => {
		const detail = sdkFailureDetail([{ type: "text", text: REFUSAL }]);
		expect(detail).toBe("API Error 400: invalid_request_error: Third-party apps now draw from your extra usage");
	});

	it("redacts tokens and known secrets, drops URL queries and long opaque runs, and caps the length", () => {
		const raw = `API Error: 401 Bearer abc.def.ghi sk-ant-api03-${"a".repeat(30)} ${ACCESS} see https://console.anthropic.com/settings?org=secret&token=x ${"Z9".repeat(20)} ${"word ".repeat(80)}`;
		const detail = sdkFailureDetail([{ type: "text", text: raw }], [ACCESS])!;
		expect(detail.startsWith("API Error 401: ")).toBe(true);
		for (const leaked of ["abc.def.ghi", "sk-ant", ACCESS, "org=secret", "token=x", "Z9Z9Z9Z9"]) expect(detail).not.toContain(leaked);
		// A query that names no secret still goes; the address stays readable.
		const plain = sdkFailureDetail([{ type: "text", text: "API Error: see https://docs.anthropic.com/limits?org=4711#usage for details" }]);
		expect(plain).toBe("API Error: see https://docs.anthropic.com/limits for details");
		expect(detail.length).toBeLessThanOrEqual(200);
		expect(detail.endsWith("…")).toBe(true);
	});

	it("never copies a JSON body it cannot read the error message from", () => {
		const truncated = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"},"request_id":"req_011CUsecret"}';
		expect(sdkFailureDetail([{ type: "text", text: truncated }])).toBe("API Error 400: (unreadable error body)");
		expect(sdkFailureDetail([{ type: "text", text: 'API Error: 500 {"request_id":"req_011CUsecret", "partial' }])).toBe("API Error 500: (unreadable error body)");
		expect(sdkFailureDetail([{ type: "text", text: "API Error: overloaded, request req_011CUsecret" }])).toBe("API Error: overloaded, request [ID]");
	});

	it("copies nothing from a frame that is not the CLI's API-error text", () => {
		expect(sdkFailureDetail([{ type: "text", text: "SECRET-SDK-TOKEN" }])).toBeUndefined();
		expect(sdkFailureDetail([{ type: "tool_use", id: "x" }])).toBeUndefined();
		expect(sdkFailureDetail(undefined)).toBeUndefined();
	});
});

describe("one automatic retry before any content or tool call", () => {
	it("retries the eval's up-front refusal once and records its cause", async () => {
		const sdk = await runtime(attempt => attempt === 1 ? [failure("unknown")] : text("ok"));
		const result = await sdk.provider.streamSimple(sdk.model, prompt(), { sessionId: "eval" }).result();
		expect(sdk.queries()).toBe(2);
		expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
		expect(result.diagnostics).toEqual([{ type: "claude_sdk_assistant_failure", timestamp: expect.any(Number),
			error: { code: "unknown", message: "API Error 400: invalid_request_error: Third-party apps now draw from your extra usage" },
			details: { retrySafe: false, phase: "post_start", continuation: "fresh_prompt", retriedOnce: expect.any(String) } }]);
		expect(JSON.stringify(result)).not.toContain("req_011CU");
		expect(await readdir(sdk.root)).toEqual([]);
	});

	it("retries only once; the second failure is quarantined like any other", async () => {
		const sdk = await runtime(() => [failure("unknown")]);
		const ctx = prompt();
		const result = await sdk.provider.streamSimple(sdk.model, ctx, { sessionId: "twice" }).result();
		expect(sdk.queries()).toBe(2);
		expect(result.errorMessage).toBe("Claude SDK interrupted or failed; reconcile any pending side effects before retrying");
		const context = { retrySafe: false, phase: "post_start", continuation: "fresh_prompt" };
		expect(result.diagnostics?.map(d => d.details)).toEqual([{ ...context, retriedOnce: expect.any(String) }, context]);
		expect((await sdk.provider.streamSimple(sdk.model, ctx, { sessionId: "twice" }).result()).errorMessage).toMatch(/Ambiguous previous/);
		expect(sdk.queries()).toBe(2);
	});

	it.each(["authentication_failed", "billing_error", "model_not_found", "invalid_request"])("does not repeat a %s failure, which would fail the same way", async code => {
		const sdk = await runtime(() => [failure(code)]);
		const result = await sdk.provider.streamSimple(sdk.model, prompt()).result();
		expect(sdk.queries()).toBe(1);
		expect(result.diagnostics).toMatchObject([{ error: { code }, details: { retrySafe: false } }]);
	});

	it("does not retry a failure on tool-result input, even when nothing was streamed", async () => {
		// The tool already ran in Pi: that request is past a side effect.
		const sdk = await runtime(() => [failure("unknown")]);
		const call: AssistantMessage = { role: "assistant", api: "claude-sdk", provider: "claude-sdk", model: sdk.model.id,
			content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } }], usage: emptyUsage(), stopReason: "toolUse", timestamp: 2 };
		const resultMessage: Message = { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: 3 };
		const ctx = prompt(); ctx.messages.push(call, resultMessage);
		const result = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(sdk.queries()).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("does not retry once a content block was streamed", async () => {
		const sdk = await runtime(() => {
			const frames = [...text("partial")].slice(0, 3); // message_start, block start, delta
			return [...frames, failure("unknown")];
		});
		const result = await sdk.provider.streamSimple(sdk.model, prompt()).result();
		expect(sdk.queries()).toBe(1);
		expect(result.stopReason).toBe("error");
	});
});
