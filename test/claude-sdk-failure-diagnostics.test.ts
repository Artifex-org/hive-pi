/**
 * Every Claude SDK turn that ends in error carries a sanitized diagnostic.
 *
 * Three live failures came back as the generic "Claude SDK interrupted or
 * failed" with `diagnostics: null`: they hit paths other than an SDK
 * `assistant.error` frame (the only one #191 covered). These tests pin a stable
 * `kind` for each path, the CLI stderr tail, the continuation context, and that
 * errorMessage and the no-replay behaviour are unchanged.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeContext, type AssistantMessage, type AssistantMessageDiagnostic, type Message } from "@earendil-works/pi-ai";
import type { SDKMessage, SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSdkRuntime, type QueryFactory } from "../extensions/claude-sdk/provider.ts";
import { failureDiagnostic, STDERR_DIAGNOSTIC_CHARS, type FailureContext } from "../extensions/claude-sdk/diagnostics.ts";
import { frameShape, streamFailure } from "../extensions/claude-sdk/events.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

const GENERIC = "Claude SDK interrupted or failed; reconcile any pending side effects before retrying";
const ACCESS = "synthetic-access-only-token-value";
const HIVE_TOKEN = "synthetic-hive-token";
const tool = { name: "read", description: "Pi read", parameters: Type.Object({ path: Type.String() }) };
const frame = (event: unknown): SDKMessage => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
function* toolBatch(id = "call-a", name = "mcp__pi__read") {
	yield frame({ type: "message_start", message: { id: `response-${id}`, usage: { input_tokens: 1, output_tokens: 0 } } });
	yield frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } });
	yield frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: id }) } });
	yield frame({ type: "content_block_stop", index: 0 });
	yield frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
	yield frame({ type: "message_stop" });
}
const resultError = (fields: Record<string, unknown>): SDKMessage => ({ type: "result", subtype: "error_during_execution", is_error: true,
	num_turns: 1, stop_reason: null, errors: [], uuid: "u", session_id: "s", ...fields }) as unknown as SDKMessage;
const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("closed")), { once: true }));

type Frames = (attempt: number, request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> | Iterable<SDKMessage>;
async function runtime(frames: Frames, leaseMs = 3600_000) {
	const root = await mkdtemp(join(tmpdir(), "claude-sdk-diagnostics-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	let queries = 0;
	const query: QueryFactory = request => {
		const attempt = ++queries;
		const iterator = (async function* () {
			await request.prompt[Symbol.asyncIterator]().next();
			yield* frames(attempt, request);
		})();
		return { [Symbol.asyncIterator]: () => iterator, close() {} };
	};
	const lease = async () => ({ access_token: ACCESS, expires_at: new Date(Date.now() + leaseMs).toISOString(), credential: "account-a", slot: "slot-a" });
	const sdk = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: HIVE_TOKEN,
		launch: "launch-offline", cwd: process.cwd() }, { query, lease, validateExecutable: async () => {} });
	cleanups.push(sdk.close);
	const model = sdk.provider.getModels().find(m => m.id.includes("sonnet"))!;
	return { ...sdk, root, model, queries: () => queries };
}
const prompt = () => normalizeContext({ systemPrompt: "Pi", tools: [tool], messages: [{ role: "user", content: "go", timestamp: 1 }] });
const results = (output: AssistantMessage): Message[] => output.content.flatMap(block => block.type === "toolCall"
	? [{ role: "toolResult" as const, toolCallId: block.id, toolName: block.name, content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: 3 }] : []);
const only = (output: AssistantMessage): AssistantMessageDiagnostic => {
	expect(output.diagnostics).toHaveLength(1);
	return output.diagnostics![0];
};
/** The generic, nonretryable contract: generic text, one query, and the exact attempt quarantined. */
async function expectQuarantined(sdk: Awaited<ReturnType<typeof runtime>>, ctx: ReturnType<typeof prompt>, output: AssistantMessage, queries = 1) {
	expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
	expect(sdk.queries()).toBe(queries);
	expect((await sdk.provider.streamSimple(sdk.model, ctx).result()).errorMessage).toMatch(/Ambiguous previous SDK attempt/);
	expect(sdk.queries()).toBe(queries);
	expect(await readdir(sdk.root)).toEqual([]);
	const serialized = JSON.stringify(output);
	for (const leaked of [ACCESS, HIVE_TOKEN, "sk-ant-api03", "req_011", "SECRET"]) expect(serialized).not.toContain(leaked);
}

describe("result_error: an SDK result that ended the query in error", () => {
	it("records the subtype, startup reason and sanitized errors, and is never retried", async () => {
		const sdk = await runtime(() => [resultError({ startup_failure_reason: "proxy_invalid", num_turns: 2, stop_reason: "tool_use",
			errors: [`MCP tool call failed token=SECRET-VALUE ${ACCESS}`, `sk-ant-api03-${"x".repeat(30)} request req_011CUabc`] })]);
		const ctx = prompt();
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(only(output)).toEqual({ type: "claude_sdk_failure", timestamp: expect.any(Number),
			error: { name: "SdkResultFailure", code: "result_error",
				message: "Claude SDK result error_during_execution: MCP tool call failed [REDACTED] [REDACTED]; [REDACTED] request [ID]" },
			details: { kind: "result_error", retrySafe: false, phase: "post_start", continuation: "fresh_prompt",
				result: { subtype: "error_during_execution", isError: true, stopReason: "tool_use", numTurns: 2, startupFailure: "proxy_invalid",
					errors: "MCP tool call failed [REDACTED] [REDACTED]; [REDACTED] request [ID]" } } });
		await expectQuarantined(sdk, ctx, output);
	});

	it("reads an is_error success result's API error and never copies an unknown subtype", async () => {
		const api = await runtime(() => [resultError({ subtype: "success", is_error: true,
			result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CUsecret"}' })]);
		expect(only(await api.provider.streamSimple(api.model, prompt()).result())).toMatchObject({ error: { code: "result_error",
			message: "Claude SDK result success: API Error 529: overloaded_error: Overloaded" },
			details: { result: { subtype: "success", isError: true, apiError: "API Error 529: overloaded_error: Overloaded" } } });
		const odd = await runtime(() => [resultError({ subtype: "error_SECRET_new", startup_failure_reason: "SECRET_reason" })]);
		const output = await odd.provider.streamSimple(odd.model, prompt()).result();
		expect(only(output).details).toMatchObject({ result: { subtype: "unrecognized", startupFailure: "unrecognized" } });
		expect(JSON.stringify(output)).not.toContain("SECRET");
	});
});

describe("thrown_error, stream_protocol, stream_ended and bridge_correlation", () => {
	it("withholds unrecognized thrown text and keeps only the known part of a known SDK message", async () => {
		const unknown = await runtime(() => { throw new TypeError(`SECRET request body ${ACCESS}`); });
		const ctx = prompt();
		const output = await unknown.provider.streamSimple(unknown.model, ctx).result();
		expect(only(output)).toMatchObject({ error: { name: "TypeError", code: "thrown_error", message: "(unrecognized error text withheld)" },
			details: { kind: "thrown_error", phase: "post_start" } });
		await expectQuarantined(unknown, ctx, output);
		const exit = await runtime(() => { throw new Error("Claude Code process exited with code 1\nstderr: SECRET token"); });
		expect(only(await exit.provider.streamSimple(exit.model, prompt()).result()).error)
			.toEqual({ name: "Error", code: "thrown_error", message: "Claude Code process exited with code 1" });
	});

	it.each([
		["canonical frame without partials", { type: "assistant", parent_tool_use_id: null, message: { id: "x", content: [], stop_reason: null, usage: {} } },
			"stream_protocol", "Missing Claude SDK partial frames; no complete assistant response"],
		["subagent output", { type: "assistant", parent_tool_use_id: "toolu_parent", message: { id: "x", content: [], stop_reason: "end_turn", usage: {} } },
			"stream_protocol", "Unexpected SDK subagent output"],
		["SDK compaction", { type: "system", subtype: "compact_boundary" }, "stream_protocol", "SDK compaction is forbidden; Pi owns history"],
		["an ended stream", undefined, "stream_ended", "Claude SDK ended without result"],
	])("records %s as %s", async (_, sdkFrame, kind, message) => {
		const sdk = await runtime(() => sdkFrame ? [sdkFrame as unknown as SDKMessage] : []);
		const ctx = prompt();
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		const diagnostic = only(output);
		expect(diagnostic).toMatchObject({ type: "claude_sdk_failure", error: { name: "SdkProtocolError", code: kind, message }, details: { kind, retrySafe: false } });
		expect(diagnostic.details!.frame).toEqual(sdkFrame ? frameShape(sdkFrame) : undefined);
		await expectQuarantined(sdk, ctx, output);
	});

	it("records the frame a parked continuation fails on: subagent output read after a long Pi tool", async () => {
		// A parked query's next frames are read by the continuation request. A frame
		// carrying parent_tool_use_id hits the converter's subagent guard there.
		const subagent = { type: "assistant", parent_tool_use_id: "call-a", uuid: "u", session_id: "s",
			message: { id: "SECRET-subagent", content: [{ type: "text", text: "SECRET subagent text" }], stop_reason: "end_turn", usage: {} } };
		const sdk = await runtime(async function* (_, request) {
			yield* toolBatch("call-a"); yield subagent as unknown as SDKMessage; await never(request.options.abortController!.signal);
		});
		const ctx = prompt();
		const first = await sdk.provider.streamSimple(sdk.model, ctx).result();
		ctx.messages.push(first, ...results(first));
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
		expect(only(output)).toEqual({ type: "claude_sdk_failure", timestamp: expect.any(Number),
			error: { name: "SdkProtocolError", code: "stream_protocol", message: "Unexpected SDK subagent output" },
			details: { kind: "stream_protocol", retrySafe: false, phase: "post_start", continuation: "parked",
				frame: { type: "assistant", parentToolUseId: true } } });
		expect(JSON.stringify(output.diagnostics)).not.toContain("SECRET");
	});

	it("names the CLI's tool_progress heartbeat frame when the subagent guard refuses it", () => {
		// The live failure: after a Pi tool ran 30 s the CLI sent this heartbeat, and
		// consume() refused it as "Unexpected SDK subagent output" (fixed in #196). This pins
		// that a frame refused by the subagent guard is diagnosable by its type.
		const heartbeat = { type: "tool_progress", tool_use_id: "toolu_SECRET-heartbeat-0", parent_tool_use_id: "toolu_SECRET",
			elapsed_time_seconds: 30, heartbeat: true } as unknown as SDKMessage;
		const failure = streamFailure(new Error("Unexpected SDK subagent output"), heartbeat, []);
		const context: FailureContext = { phase: "post_start", continuation: "parked", aborted: false, leaseExpired: false, cleanupFailed: false, secrets: [] };
		const diagnostic = failureDiagnostic(failure, context, 1);
		expect(diagnostic).toEqual({ type: "claude_sdk_failure", timestamp: 1,
			error: { name: "SdkProtocolError", code: "stream_protocol", message: "Unexpected SDK subagent output" },
			details: { kind: "stream_protocol", retrySafe: false, phase: "post_start", continuation: "parked",
				frame: { type: "tool_progress", parentToolUseId: true } } });
		expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
	});

	it("records a tool call the bridge cannot correlate", async () => {
		const sdk = await runtime(() => toolBatch("call-x", "mcp__pi__write"));
		const ctx = prompt();
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(only(output)).toMatchObject({ error: { name: "BridgeError", code: "bridge_correlation", message: "Invalid Pi tool call" } });
		await expectQuarantined(sdk, ctx, output);
	});
});

describe("aborts, lease expiry and continuations", () => {
	it("records a caller abort as aborted", async () => {
		const sdk = await runtime(async function* (_, request) { await never(request.options.abortController!.signal); });
		const abort = new AbortController();
		const pending = sdk.provider.streamSimple(sdk.model, prompt(), { signal: abort.signal }).result();
		await new Promise(resolve => setTimeout(resolve, 20));
		abort.abort();
		const output = await pending;
		expect(output.stopReason).toBe("aborted");
		expect(only(output)).toMatchObject({ error: { code: "aborted" }, details: { kind: "aborted", phase: "post_start" } });
	});

	it("records an inference stopped at lease expiry as lease_expired", async () => {
		vi.useFakeTimers();
		let started!: () => void;
		const running = new Promise<void>(resolve => { started = resolve; });
		const sdk = await runtime(async function* (_, request) { started(); await never(request.options.abortController!.signal); }, 120_000);
		const pending = sdk.provider.streamSimple(sdk.model, prompt()).result();
		await running;
		await vi.advanceTimersByTimeAsync(120_001);
		const output = await pending;
		expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
		expect(only(output)).toMatchObject({ error: { name: "SdkLeaseExpired", code: "lease_expired" }, details: { kind: "lease_expired" } });
	});

	it("names a parked continuation, and a rebuild after the parked query expired", async () => {
		vi.useFakeTimers();
		const sdk = await runtime(async function* (attempt, request) {
			if (attempt === 1) { yield* toolBatch("call-a"); await never(request.options.abortController!.signal); }
			if (attempt === 2) yield resultError({ errors: ["rebuilt continuation failed"] });
		}, 20 * 60_000);
		const ctx = prompt();
		const first = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(first.stopReason).toBe("toolUse");
		ctx.messages.push(first, ...results(first));
		// A 20-minute lease keeps the parked query 19 minutes.
		await vi.advanceTimersByTimeAsync(19 * 60_000 + 1);
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
		expect(sdk.queries()).toBe(2);
		expect(only(output)).toMatchObject({ error: { code: "result_error", message: "Claude SDK result error_during_execution: rebuilt continuation failed" },
			details: { phase: "post_start", continuation: "rebuilt_after_parked_expired", parkedEnd: { parkedMs: 19 * 60_000, endedMsAgo: expect.any(Number) } } });
		// The same tool-result request again is refused before any parked query is looked up.
		const again = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(again.errorMessage).toMatch(/Ambiguous previous SDK attempt/);
		expect(only(again)).toMatchObject({ error: { code: "provider_refusal" }, details: { phase: "pre_start", continuation: "tool_results" } });
	});

	it("keeps the cause of a lease refusal on a claimed parked continuation", async () => {
		let leases = 0;
		const root = await mkdtemp(join(tmpdir(), "claude-sdk-diagnostics-"));
		cleanups.push(() => rm(root, { force: true, recursive: true }));
		const query: QueryFactory = request => {
			const iterator = (async function* () {
				await request.prompt[Symbol.asyncIterator]().next();
				yield* toolBatch("call-a"); await never(request.options.abortController!.signal);
			})();
			return { [Symbol.asyncIterator]: () => iterator, close() {} };
		};
		// The second lease is too near expiry: LeaseManager refuses it after the continuation was claimed.
		const lease = async () => ({ access_token: ACCESS, expires_at: new Date(Date.now() + (++leases > 1 ? 30_000 : 3600_000)).toISOString(),
			credential: "account-a", slot: "slot-a" });
		const sdk = createClaudeSdkRuntime({ executable: "/pinned/claude", stateRoot: root, url: "https://hive.invalid", token: HIVE_TOKEN,
			launch: "launch-offline", cwd: process.cwd() }, { query, lease, validateExecutable: async () => {} });
		cleanups.push(sdk.close);
		const model = sdk.provider.getModels().find(m => m.id.includes("sonnet"))!;
		const ctx = prompt();
		const first = await sdk.provider.streamSimple(model, ctx).result();
		ctx.messages.push(first, ...results(first));
		const output = await sdk.provider.streamSimple(model, ctx).result();
		expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
		expect(only(output)).toMatchObject({ error: { name: "SdkProviderError", code: "provider_refusal",
			message: "Claude SDK lease too near expiry; wait for authd renewal" }, details: { phase: "post_start", continuation: "parked" } });
	});

	it("records a refusal of a claimed parked continuation as provider_refusal", async () => {
		const sdk = await runtime(async function* (_, request) { yield* toolBatch("call-a"); await never(request.options.abortController!.signal); });
		const ctx = prompt();
		const first = await sdk.provider.streamSimple(sdk.model, ctx).result();
		const [result] = results(first);
		ctx.messages.push(first, { ...result, toolName: "other" } as Message);
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(output).toMatchObject({ stopReason: "error", errorMessage: GENERIC });
		expect(only(output)).toMatchObject({ error: { name: "SdkProviderError", code: "provider_refusal",
			message: "Missing correlated Pi tool results; reconcile before continuing" }, details: { phase: "post_start", continuation: "parked" } });
	});

	it("records invalid Pi tool names as the provider's refusal, not a bridge correlation", async () => {
		const sdk = await runtime(() => []);
		const ctx = normalizeContext({ systemPrompt: "Pi", tools: [{ ...tool, name: "bad name" }], messages: [{ role: "user", content: "go", timestamp: 1 }] });
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(output.errorMessage).toBe("Invalid Pi tool names");
		expect(only(output)).toMatchObject({ error: { name: "SdkProviderError", code: "provider_refusal" }, details: { phase: "pre_start" } });
	});

	it("keeps a pre-start refusal's own errorMessage and records it as pre_start", async () => {
		const sdk = await runtime(() => [resultError({})]);
		const ctx = prompt();
		await sdk.provider.streamSimple(sdk.model, ctx).result();
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		expect(output.errorMessage).toBe("Ambiguous previous SDK attempt; reconcile side effects before retrying");
		expect(only(output)).toMatchObject({ error: { code: "provider_refusal", message: output.errorMessage }, details: { phase: "pre_start" } });
	});
});

describe.runIf(process.platform === "linux")("cli_exit: the CLI child died on its own", () => {
	it("records the exit code and a sanitized, bounded stderr tail", async () => {
		const script = [
			"i=0; while [ $i -lt 400 ]; do printf 'noise line %s\\n' $i >&2; i=$((i+1)); done",
			`printf ' Error: upstream failed token=SECRET-STDERR Bearer abc.def.ghi sk-ant-api03-${"y".repeat(24)} ${ACCESS}\\n' >&2`,
			`printf ' see https://api.anthropic.com/v1/messages?beta=tools-2026 request req_011CUxyz\\n' >&2`,
			"exit 3",
		].join("; ");
		const sdk = await runtime(async function* (_, request) {
			const child = request.options.spawnClaudeCodeProcess!({ command: "/bin/sh", args: ["-c", script], cwd: process.cwd(),
				env: request.options.env!, signal: request.options.abortController!.signal });
			await new Promise<void>(resolve => (child.on as (event: string, listener: () => void) => void)("close", () => resolve()));
			child.stdout.resume();
		});
		const ctx = prompt();
		const output = await sdk.provider.streamSimple(sdk.model, ctx).result();
		const diagnostic = only(output);
		expect(diagnostic).toMatchObject({ error: { code: "cli_exit", message: "Claude CLI exited with code 3" },
			details: { kind: "cli_exit", phase: "post_start", cliExit: { code: 3, signal: null, requested: false } } });
		const tail = diagnostic.details!.stderrTail as string;
		expect(tail.length).toBeLessThanOrEqual(STDERR_DIAGNOSTIC_CHARS);
		expect(tail.startsWith("…")).toBe(true);
		expect(tail).toContain("Error: upstream failed [REDACTED]");
		expect(tail).toContain("see https://api.anthropic.com/v1/messages request [ID]");
		await expectQuarantined(sdk, ctx, output);
	});

	it("waits briefly for a dying CLI's exit and last stderr when the stream ends first", async () => {
		const sdk = await runtime(async function* (_, request) {
			request.options.spawnClaudeCodeProcess!({ command: "/bin/sh", args: ["-c", "sleep 0.05; printf 'fatal: late words\\n' >&2; exit 4"],
				cwd: process.cwd(), env: request.options.env!, signal: request.options.abortController!.signal }).stdout.resume();
		});
		const output = await sdk.provider.streamSimple(sdk.model, prompt()).result();
		expect(only(output)).toMatchObject({ error: { code: "cli_exit", message: "Claude CLI exited with code 4" },
			details: { cliExit: { code: 4, signal: null, requested: false }, stderrTail: "fatal: late words" } });
	});
});
