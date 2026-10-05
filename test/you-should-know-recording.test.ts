import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { YSK_POLICY_CHANNEL, YSK_REMOTE_CHANNEL, YSK_STATE_CHANNEL, YSK_RECORDING_CHANNEL, YSK_FINDINGS_CHANNEL } from "../extensions/hive-common/you-should-know.ts";
import { wireYouShouldKnow, DEFAULT_CONFIG, type Scanner } from "../extensions/you-should-know/index.ts";
import { createFakePi } from "./fake-pi.ts";

const answer = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const quote = "The migration was not tested against production data.";
const rpc = { mode: "rpc" as const, hasUI: false };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("You Should Know recording consent", () => {
	it("captures source revision at message_end and scan start; late policy cannot restamp buffered prose", async () => {
		vi.useFakeTimers(); vi.stubEnv("PI_AGENDA_WORKER", "");
		const pi = createFakePi(); let release!: (m: AssistantMessage) => void;
		const scanner = vi.fn<Scanner>(() => new Promise(resolve => { release = resolve; }));
		wireYouShouldKnow(pi.api, { ...DEFAULT_CONFIG, intervalMs: 100, timeoutMs: 10_000 }, scanner);
		await pi.emit({ type: "session_start" }, rpc);
		pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "server-1" });
		pi.api.events.emit(YSK_POLICY_CHANNEL, { serverSessionId: "server-1", version: 1, recording: true, recording_revision: 3 });
		const message = answer(quote);
		await pi.emit({ type: "message_end", message }, rpc);
		pi.api.events.emit(YSK_POLICY_CHANNEL, { serverSessionId: "server-1", version: 1, recording: false, recording_revision: 4 });
		await pi.emit({ type: "agent_settled" }, rpc);
		await vi.advanceTimersByTimeAsync(0);
		expect(scanner).toHaveBeenCalledTimes(1);
		release(answer(JSON.stringify({ notes: [{ kind: "caveat", classification: "friction", text: "Production verification is missing.", quote }] })));
		await vi.advanceTimersByTimeAsync(0);
		const findings = pi.busEvents.filter(e => e.name === YSK_FINDINGS_CHANNEL).at(-1)?.payload as unknown[];
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ recording: false, revision: 3, serverSessionId: "server-1" });
		expect(pi.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload).toMatchObject({ recording: false, recording_revision: 4 });
	});

	it("records controls as local requests without treating them as delivery receipts", async () => {
		const pi = createFakePi();
		wireYouShouldKnow(pi.api, DEFAULT_CONFIG, vi.fn<Scanner>());
		await pi.emit({ type: "session_start" }, rpc);
		pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "s" });
		pi.api.events.emit(YSK_POLICY_CHANNEL, { serverSessionId: "s", version: 1, recording: false, recording_revision: 8 });
		await pi.runCommand("you-should-know", "record-on", rpc);
		const control = pi.busEvents.filter(e => e.name === YSK_RECORDING_CHANNEL).at(-1)?.payload;
		expect(control).toMatchObject({ recording: true, expected_revision: 8, serverSessionId: "s" });
		expect(pi.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload).toMatchObject({ recording: true, recording_revision: 8 });
	});
});
