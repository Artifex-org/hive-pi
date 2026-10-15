import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const fixture = vi.hoisted(() => ({ queries: 0 }));
vi.mock("../extensions/claude-sdk/provider.ts", async original => {
	const actual = await original<typeof import("../extensions/claude-sdk/provider.ts")>();
	return { ...actual, createClaudeSdkRuntime: (config: Parameters<typeof actual.createClaudeSdkRuntime>[0], deps: Parameters<typeof actual.createClaudeSdkRuntime>[1]) =>
		actual.createClaudeSdkRuntime(config, { ...deps,
			lease: async () => ({ access_token: "offline", expires_at: new Date(Date.now() + 3600_000).toISOString(), credential: "a", slot: "a" }),
			validateExecutable: async () => {},
			query: () => { const first = ++fixture.queries === 1; return { close() {}, [Symbol.asyncIterator]: () => (async function* () {
				yield frame({ type: "message_start", message: { id: "lifecycle", usage: {} } });
				yield frame({ type: "content_block_start", index: 0, content_block: first
					? { type: "tool_use", id: "lifecycle-call", name: "mcp__pi__read", input: { path: "offline" } }
					: { type: "text", text: "correlated reconstruction" } });
				yield frame({ type: "content_block_stop", index: 0 });
				yield frame({ type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" } });
				yield frame({ type: "message_stop" });
				yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
			})() }; },
		}) };
});
import claudeSdk from "../extensions/claude-sdk/index.ts";

function frame(event: unknown): SDKMessage {
	return { type: "stream_event", event, parent_tool_use_id: null } as SDKMessage;
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

it.each(["model_select", "session_tree", "session_compact", "session_start"])("preserves handoff replay quarantine across %s while allowing correlated reconstruction", async event => {
	fixture.queries = 0;
	const root = await mkdtemp(join(tmpdir(), "sdk-lifecycle-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
	for (const [key, value] of Object.entries({ HIVE_CLAUDE_SDK: "1", HIVE_CLAUDE_SDK_EXECUTABLE: "/pinned/claude", HIVE_CLAUDE_SDK_STATE_DIR: root,
		HIVE_URL: "https://offline.invalid", HIVE_TOKEN: "offline", HIVE_LAUNCH_ID: "offline-launch" })) vi.stubEnv(key, value);
	let registered: Provider | undefined;
	const hooks = new Map<string, () => Promise<void>>();
	await claudeSdk({ registerProvider: (provider: Provider) => { registered = provider; },
		on: (name: string, handler: () => Promise<void>) => { hooks.set(name, handler); } } as unknown as ExtensionAPI);
	cleanup.push(() => hooks.get("session_shutdown")!());
	if (!registered) throw new Error("Provider not registered");
	const model = registered.getModels().find(model => model.id.includes("sonnet"))!;
	const ctx = normalizeContext({ tools: [{ name: "read", description: "offline read", parameters: Type.Object({ path: Type.String() }) }],
		messages: [{ role: "user", content: "original request", timestamp: 1 }] });
	const first = await registered.streamSimple(model, ctx).result();
	expect(first.stopReason).toBe("toolUse"); expect(fixture.queries).toBe(1);
	await hooks.get(event)!();
	const replay = await registered.streamSimple(model, ctx).result();
	expect(replay).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/Ambiguous previous SDK attempt/) });
	expect(fixture.queries).toBe(1);
	ctx.messages.push(first, { role: "toolResult", toolCallId: "lifecycle-call", toolName: "read", content: [{ type: "text", text: "Pi result" }], isError: false, timestamp: 3 });
	expect((await registered.streamSimple(model, ctx).result()).stopReason).toBe("stop");
	expect(fixture.queries).toBe(2);
});
