import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { YSK_POLICY_CHANNEL, YSK_REMOTE_CHANNEL, YSK_STATE_CHANNEL, YSK_RECORDING_CHANNEL, YSK_FINDINGS_CHANNEL, YSK_CONTROL_CHANNEL, YSK_POLICY_REQUEST_CHANNEL } from "../extensions/hive-common/you-should-know.ts";
import { wireYouShouldKnow, DEFAULT_CONFIG, type Scanner } from "../extensions/you-should-know/index.ts";
import { createFakePi } from "./fake-pi.ts";
import { createYouShouldKnowRemoteBridge } from "../extensions/hive-remote/you-should-know.ts";
import type { FindingsRequest } from "../extensions/hive-common/you-should-know-findings.ts";

const answer = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const quote = "The migration was not tested against production data.";
vi.mock("../extensions/typesafe-common/config.ts", () => ({ loadConfig: () => ({ enabled: false, timeoutMs: 3000, model: "fixture", endpoint: "https://jev.invalid" }) }));
vi.mock("../extensions/typesafe-common/key.ts", () => ({ readApiKey: () => null }));

const rpc = { mode: "rpc" as const, hasUI: false };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function attached(scanner?: Scanner, request?: FindingsRequest) {
	vi.useFakeTimers(); vi.stubEnv("PI_AGENDA_WORKER", "");
	const pi = createFakePi();
	wireYouShouldKnow(pi.api, { ...DEFAULT_CONFIG, intervalMs: 10, timeoutMs: 1000 }, scanner ?? (async () => answer(JSON.stringify({ notes: [{ kind: "blocker", classification: "friction", text: "Production verification is missing.", quote }] }))));
	const calls: { method: string; body?: unknown }[] = [];
	const bridge = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => true, request: () => request ?? (async (method, _path, body) => {
		calls.push({ method, body });
		return { status: 200, body: { version: 1, recording: true, recording_revision: 0, findings: method === "POST" ? [{ id: (body as { findings: { id: string }[] }).findings[0].id, deliveries: [{ destination: "papercut", state: "delivered" }] }] : [] } };
	}) });
	const start = async () => {
		await pi.emit({ type: "session_start" }, rpc);
		pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "server-1" });
		bridge.attach({ url: "https://hive.test", token: "fixture" }, "server-1");
		await vi.advanceTimersByTimeAsync(0);
	};
	const prose = async (text = quote) => { await pi.emit({ type: "message_end", message: answer(text) }, rpc); await pi.emit({ type: "agent_settled" }, rpc); await vi.advanceTimersByTimeAsync(0); };
	return { pi, calls, bridge, start, prose };
}

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

	it("persists a bound durable finding and actual receipt through the real local bus", async () => {
		const h = attached(); await h.start(); await h.prose(); await vi.advanceTimersByTimeAsync(1);
		expect(h.calls.filter(c => c.method === "POST")).toHaveLength(1);
		const saved = h.pi.entries.filter(e => e.customType === "you-should-know.findings").at(-1)?.data as { findings: { finding: { id: string }; revision: number; serverSessionId: string }[] };
		expect(saved.findings[0]).toMatchObject({ revision: 0, serverSessionId: "server-1" });
		expect(saved.findings[0].finding.id).toMatch(/^[a-f0-9]{64}$/);
		expect(h.pi.entries.some(e => e.customType === "you-should-know.receipts" && JSON.stringify(e.data).includes('"delivered"'))).toBe(true);
		await h.pi.runCommand("you-should-know", "dismiss", rpc);
		expect(h.pi.entries.filter(e => e.customType === "you-should-know.findings").at(-1)?.data).toEqual(saved);
		expect(h.pi.userMessages).toEqual([]); expect(h.pi.messages).toEqual([]);
		h.bridge.detach();
	});
	it("acknowledges allocated remote recording revisions without issuing another PUT", async () => {
		const h = attached(); await h.start();
		h.bridge.applyRecording(false, 1);
		h.pi.api.events.emit(YSK_CONTROL_CHANNEL, { action: "record_off", command_id: "off-command", recording_revision: 1 });
		expect(h.pi.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload).toMatchObject({ command_id: "off-command", recording: false, recording_revision: 1 });
		h.pi.api.events.emit(YSK_CONTROL_CHANNEL, { action: "record_on", command_id: "old-command", recording_revision: 0 });
		expect(h.pi.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload).toMatchObject({ command_id: "off-command", recording: false, recording_revision: 1 });
		await h.prose(); expect(h.calls.some(c => c.method === "PUT" || c.method === "POST")).toBe(false);
		h.bridge.detach();
	});
	it("never uploads an in-flight finding across off and a newer enable revision", async () => {
		let release!: (m: AssistantMessage) => void;
		const h = attached(() => new Promise(resolve => { release = resolve; })); await h.start(); await h.prose();
		h.bridge.applyRecording(false, 1); h.pi.api.events.emit(YSK_CONTROL_CHANNEL, { action: "record_off", command_id: "off", recording_revision: 1 });
		h.bridge.applyRecording(true, 2); h.pi.api.events.emit(YSK_CONTROL_CHANNEL, { action: "record_on", command_id: "on", recording_revision: 2 });
		release(answer(JSON.stringify({ notes: [{ kind: "blocker", classification: "friction", text: "Production verification is missing.", quote }] }))); await vi.advanceTimersByTimeAsync(0);
		expect(h.calls.some(c => c.method === "POST")).toBe(false);
		const saved = h.pi.entries.filter(e => e.customType === "you-should-know.findings").at(-1)?.data as { findings: { recording: boolean; revision: number }[] };
		expect(saved.findings[0]).toMatchObject({ recording: false, revision: 0 });
		expect(h.pi.busEvents.filter(e => e.name === YSK_STATE_CHANNEL).at(-1)?.payload).toMatchObject({ notes: [{ text: "Production verification is missing." }] });
		h.bridge.detach();
	});
	it("restores active-branch captures after dismissal without transplanting a foreign fork", async () => {
		const h = attached(); await h.start(); await h.prose(); await h.pi.runCommand("you-should-know", "dismiss", rpc);
		const branch = h.pi.entries.map(entry => ({ type: "custom", ...entry }));
		h.calls.length = 0; h.pi.busEvents.length = 0;
		await h.pi.emit({ type: "session_tree" }, { ...rpc, branch }); await vi.advanceTimersByTimeAsync(0);
		expect(h.pi.busEvents.some(e => e.name === YSK_POLICY_REQUEST_CHANNEL)).toBe(true);
		expect(h.pi.busEvents.filter(e => e.name === YSK_FINDINGS_CHANNEL).at(-1)?.payload).toHaveLength(1);
		h.pi.busEvents.length = 0;
		await h.pi.emit({ type: "session_start", reason: "fork" }, { ...rpc, sessionId: "forked-session", branch });
		h.pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "new-server" });
		h.pi.api.events.emit(YSK_POLICY_CHANNEL, { version: 1, recording: true, recording_revision: 0, serverSessionId: "new-server" });
		expect(h.pi.busEvents.filter(e => e.name === YSK_FINDINGS_CHANNEL).at(-1)?.payload).toEqual([]);
		h.bridge.detach();
	});
	it("only captures explicitly failed tool text under opt-in, with redacted provenance", async () => {
		vi.stubEnv("PI_YOU_SHOULD_KNOW_CAPTURE_TOOLS", "1");
		const errorText = "Provider request failed: token=do-not-persist-this";
		const redactedQuote = "Provider request failed: [REDACTED]";
		const h = attached(async () => answer(JSON.stringify({ notes: [{ kind: "blocker", classification: "friction", text: "Provider authorization failed.", quote: redactedQuote }] }))); await h.start();
		await h.pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "tool-1", isError: true, content: [{ type: "text", text: errorText }], input: { command: "private raw arguments" }, details: { private: "private details" } }, rpc);
		await h.pi.emit({ type: "agent_settled" }, rpc); await vi.advanceTimersByTimeAsync(1);
		const post = h.calls.find(c => c.method === "POST")?.body;
		expect(JSON.stringify(post)).not.toContain("do-not-persist-this"); expect(JSON.stringify(post)).not.toContain("private");
		expect(post).toMatchObject({ findings: [{ source_id: "tool-1", source_type: "tool", provenance: "observed" }] });
		h.bridge.detach();
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
