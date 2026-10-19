import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fingerprint, transcript } from "../extensions/claude-sdk/history.ts";

const assistant = {
	role: "assistant", api: "claude-sdk", provider: "claude-sdk", model: "claude-opus-5", stopReason: "toolUse", timestamp: 1,
	content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "x" } }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as unknown as Message;

describe("transcript identity", () => {
	// pi-ai 1.1.0 stamps durationMs on the final assistant message after the
	// provider emitted it; without this the continuation never matched and a
	// fresh query replayed the same tool calls.
	it("ignores Pi's durationMs stamp on assistant messages", () => {
		const stamped = { ...assistant, durationMs: 14 } as Message;
		expect(transcript([stamped])).toEqual(transcript([assistant]));
		expect(fingerprint(transcript([stamped]))).toBe(fingerprint(transcript([assistant])));
		expect(stamped).toHaveProperty("durationMs", 14);
	});
	it("still distinguishes any content difference", () => {
		const changed = { ...assistant, content: [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "x" } }] } as Message;
		expect(transcript([changed])).not.toEqual(transcript([assistant]));
		const user = { role: "user", content: "hi", timestamp: 1, durationMs: 3 } as unknown as Message;
		expect(transcript([user])).toEqual([user]);
	});
});
