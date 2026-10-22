/**
 * The Claude SDK provider's plan-limit billing guard: a turn the pinned CLI
 * reports as charged to usage credits (extra usage) fails before Pi sees it,
 * so Pi issues no further charged turns.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaudeSdkRuntime, type QueryFactory } from "../extensions/claude-sdk/provider.ts";
import { billedToUsageCredits, rateLimitSnapshot } from "../extensions/claude-sdk/billing.ts";
import { firstInput } from "./claude-sdk-test-input.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const lease = async () => ({ access_token: "synthetic-access-only", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "account-a", slot: "slot-a" });
const tool = { name: "read", description: "Pi read", parameters: Type.Object({ path: Type.String() }) };
const message = (event: unknown): SDKMessage => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-000000000001", session_id: "fixture" }) as unknown as SDKMessage;
const rateLimit = (info: Record<string, unknown>): SDKMessage => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
const PLAN = { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, isUsingOverage: false };
const OVERAGE = { status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: true, overageInUse: true };
function* text(value: string) {
	yield message({ type: "message_start", message: { id: `response-${value}`, usage: { input_tokens: 1, output_tokens: 0 } } });
	yield message({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	yield message({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });
	yield message({ type: "content_block_stop", index: 0 });
	yield message({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
	yield message({ type: "message_stop" });
	yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
}
function* toolCall(id: string) {
	yield message({ type: "message_start", message: { id: `response-${id}`, usage: { input_tokens: 1, output_tokens: 0 } } });
	yield message({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__pi__read", input: {} } });
	yield message({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: id }) } });
	yield message({ type: "content_block_stop", index: 0 });
	yield message({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
	yield message({ type: "message_stop" });
}

/** Every query yields `frames`; a `"call"` entry answers the parked call through the real MCP bridge. */
async function runtime(frames: () => Iterable<SDKMessage | "call">) {
	const root = await mkdtemp(join(tmpdir(), "claude-sdk-billing-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	let queries = 0;
	const query: QueryFactory = request => {
		queries++;
		const client = new Client({ name: "fake-sdk", version: "1" });
		const iterator = (async function* () {
			await firstInput(request);
			const bridge = request.options.mcpServers!.pi;
			if (bridge.type !== "sdk") throw new Error("Expected SDK bridge");
			const [a, b] = InMemoryTransport.createLinkedPair();
			await bridge.instance.connect(b); await client.connect(a);
			try {
				for (const frame of frames()) {
					if (frame === "call") await client.callTool({ name: "read", arguments: { path: "call-a" }, _meta: { "claudecode/toolUseId": "call-a" } });
					else yield frame;
				}
			} finally { await client.close(); }
		})();
		return { [Symbol.asyncIterator]: () => iterator, close: () => { void client.close(); } };
	};
	const sdk = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: "synthetic-hive",
		launch: "launch-offline", cwd: process.cwd() }, { query, lease, validateExecutable: async () => {} });
	cleanups.push(sdk.close);
	const model = sdk.provider.getModels().find(m => m.id.includes("sonnet"))!;
	const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "read" }], details: undefined }));
	const agent = new Agent({ initialState: { model, systemPrompt: "Pi", tools: [{ ...tool, label: "Read", execute: executed }] },
		streamFn: (m, ctx, opts) => sdk.provider.streamSimple(m, normalizeContext(ctx), opts), sessionId: "billing" });
	return { ...sdk, root, model, agent, executed, queries: () => queries };
}

describe("rateLimitSnapshot — allowlisted fields only", () => {
	it("copies known enums, finite counters and booleans, and nothing else", () => {
		expect(rateLimitSnapshot({ ...OVERAGE, utilization: 0.97, resetsAt: 1_790_000_000, overageDisabledReason: "out_of_credits",
			surpassedThreshold: 0.9, adminRequestOffer: { email: "owner@example.com" }, limitScope: "group_pool" })).toEqual({
			status: "rejected", rateLimitType: "five_hour", utilization: 0.97, resetsAt: 1_790_000_000, overageStatus: "allowed",
			overageDisabledReason: "out_of_credits", isUsingOverage: true, overageInUse: true });
	});

	it("reports an unknown enum as unrecognized and drops malformed values", () => {
		expect(rateLimitSnapshot({ status: "secret-text", rateLimitType: "monthly", utilization: Number.NaN, resetsAt: -1, isUsingOverage: "yes" }))
			.toMatchObject({ status: "unrecognized", rateLimitType: "unrecognized", utilization: undefined, resetsAt: undefined, isUsingOverage: undefined });
		expect(rateLimitSnapshot({ unrelated: 1 })).toBeUndefined();
		expect(rateLimitSnapshot(null)).toBeUndefined();
		expect(rateLimitSnapshot([OVERAGE])).toBeUndefined();
	});
});

describe("billedToUsageCredits — the pinned CLI's own classification", () => {
	it.each([
		[{ overageInUse: true }, true],
		[{ isUsingOverage: true, rateLimitType: "five_hour" }, true],
		[{ isUsingOverage: true, rateLimitType: "unrecognized" }, true],
		[{ isUsingOverage: true }, true],
		[{ isUsingOverage: true, rateLimitType: "seven_day_overage_included" }, false],
		[{ status: "allowed_warning", isUsingOverage: false }, false],
		[{ status: "rejected" }, false],
	])("%j → %s", (info, billed) => {
		expect(billedToUsageCredits(rateLimitSnapshot(info)!)).toBe(billed);
	});
});

describe("plan-limit billing guard", () => {
	it("serves a turn on plan limits unchanged", async () => {
		const sdk = await runtime(() => [rateLimit(PLAN), ...text("on plan")]);
		await sdk.agent.prompt("go");
		expect(sdk.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "on plan" }] });
		expect(sdk.agent.state.messages.at(-1)).not.toHaveProperty("diagnostics");
	});

	it("fails a turn charged to usage credits, names billing and is never retried", async () => {
		const sdk = await runtime(() => [rateLimit(OVERAGE), ...text("charged")]);
		await sdk.agent.prompt("go");
		const last = sdk.agent.state.messages.at(-1)!;
		expect(last).toMatchObject({ role: "assistant", stopReason: "error" });
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.errorMessage).toMatch(/^Claude SDK billing: Anthropic charged this turn to usage credits/);
		expect(isRetryableAssistantError(last)).toBe(false);
		expect(last.diagnostics).toEqual([{ type: "claude_sdk_failure", timestamp: expect.any(Number),
			error: { name: "SdkUsageCreditsCharged", code: "usage_credits",
				message: "Claude SDK billing: Anthropic charged this turn to usage credits (extra usage) instead of the plan limits" },
			details: { kind: "usage_credits", retrySafe: false, phase: "post_start", continuation: "fresh_prompt",
				rateLimit: { status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: true, overageInUse: true } } }]);
		expect(sdk.queries()).toBe(1);
		expect(await readdir(sdk.root)).toEqual([]);
	});

	it("stops a charged tool proposal before Pi runs it", async () => {
		const sdk = await runtime(() => [rateLimit(OVERAGE), ...toolCall("call-a")]);
		await sdk.agent.prompt("go");
		expect(sdk.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringMatching(/^Claude SDK billing/) });
		expect(sdk.executed).not.toHaveBeenCalled();
	});

	it("does not charge a seven_day_overage_included window", async () => {
		const sdk = await runtime(() => [rateLimit({ status: "allowed", rateLimitType: "seven_day_overage_included", isUsingOverage: true }), ...text("included")]);
		await sdk.agent.prompt("go");
		expect(sdk.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop", content: [{ text: "included" }] });
	});

	it("stops a parked continuation whose next response moved to usage credits", async () => {
		const sdk = await runtime(() => [rateLimit(PLAN), ...toolCall("call-a"), "call", rateLimit(OVERAGE), ...text("charged")]);
		await sdk.agent.prompt("go");
		expect(sdk.executed).toHaveBeenCalledOnce();
		expect(sdk.queries()).toBe(1);
		const last = sdk.agent.state.messages.at(-1)!;
		expect(last).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringMatching(/^Claude SDK billing/) });
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.diagnostics).toMatchObject([{ error: { code: "usage_credits" }, details: { continuation: "parked" } }]);
	});

	it("keeps an earlier plan-limit status across a parked continuation, as the CLI reports only changes", async () => {
		const sdk = await runtime(() => [rateLimit(PLAN), ...toolCall("call-a"), "call", ...text("still on plan")]);
		await sdk.agent.prompt("go");
		expect(sdk.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop", content: [{ text: "still on plan" }] });
	});

	it("records the latest rate-limit status on any other failure", async () => {
		const sdk = await runtime(() => [rateLimit({ ...PLAN, status: "allowed_warning", utilization: 0.93 }),
			{ type: "result", subtype: "error_during_execution", is_error: true, errors: [] } as unknown as SDKMessage]);
		await sdk.agent.prompt("go");
		const last = sdk.agent.state.messages.at(-1)!;
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.errorMessage).toBe("Claude SDK interrupted or failed; reconcile any pending side effects before retrying");
		expect(last.diagnostics).toMatchObject([{ error: { code: "result_error" },
			details: { rateLimit: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.93, isUsingOverage: false } } }]);
	});
});
