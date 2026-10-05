import { afterEach, describe, expect, it, vi } from "vitest";
import { createYouShouldKnowRemoteBridge } from "../extensions/hive-remote/you-should-know.ts";
import { YSK_FINDINGS_CHANNEL, YSK_POLICY_CHANNEL, YSK_REMOTE_CHANNEL } from "../extensions/hive-common/you-should-know.ts";
import type { CapturedFinding } from "../extensions/hive-common/you-should-know-findings.ts";
import { createFakePi } from "./fake-pi.ts";

const record = (serverSessionId = "session-1", revision = 2): CapturedFinding => ({ recording: true, revision, serverSessionId, finding: { id: "finding-1", kind: "caveat", classification: "friction", text: "Production verification is missing.", quote: "The migration was not tested against production data.", source_id: "turn-1", source_type: "assistant", provenance: "assistant_reported" } });
afterEach(() => { vi.useRealTimers(); });

describe("You Should Know remote findings bridge", () => {
	it("discovers policy then uploads only matching-session records and publishes actual receipts", async () => {
		vi.useFakeTimers();
		const pi = createFakePi(); const calls: { method: string; path: string; body?: unknown }[] = [];
		const bridge = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => true, request: () => async (method, path, body) => {
			calls.push({ method, path, body });
			if (method === "GET") return { status: 200, body: { version: 1, recording: true, recording_revision: 2, findings: [] } };
			return { status: 200, body: { version: 1, recording: true, recording_revision: 2, findings: [{ id: "finding-1", deliveries: [{ destination: "papercut", state: "delivered" }] }] } };
		} });
		bridge.attach({ url: "https://hive.test", token: "test" }, "session-1");
		pi.api.events.emit(YSK_FINDINGS_CHANNEL, [record(), record("foreign-session")]);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.filter(c => c.method === "GET")).toHaveLength(1);
		expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
		expect((calls.find(c => c.method === "POST")?.body as { findings: unknown[] }).findings).toHaveLength(1);
		expect(pi.busEvents.some(e => e.name === YSK_POLICY_CHANNEL && e.payload && (e.payload as { recording_revision?: number }).recording_revision === 2)).toBe(true);
		expect(pi.busEvents.some(e => e.name === "hive.you-should-know.receipts" && JSON.stringify(e.payload).includes('"delivered"'))).toBe(true);
		bridge.detach();
	});

	it("applies newer policy without PUT, ignores stale policy, and never uploads old revisions", async () => {
		vi.useFakeTimers();
		const pi = createFakePi(); const calls: string[] = []; let recording = false, revision = 9;
		const bridge = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => true, request: () => async method => {
			calls.push(method);
			return { status: 200, body: { version: 1, recording, recording_revision: revision, findings: [] } };
		} });
		bridge.attach({ url: "https://hive.test", token: "test" }, "session-1");
		await vi.advanceTimersByTimeAsync(0);
		recording = true; revision = 10; pi.busEvents.length = 0;
		bridge.applyRecording(true, 10);
		bridge.applyRecording(false, 9);
		expect(pi.busEvents.filter(e => e.name === YSK_POLICY_CHANNEL).at(-1)?.payload).toMatchObject({ recording: true, recording_revision: 10 });
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).not.toContain("PUT");
		pi.api.events.emit(YSK_FINDINGS_CHANNEL, [record("session-1", 8)]);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).not.toContain("POST");
		expect(pi.busEvents.filter(e => e.name === YSK_REMOTE_CHANNEL)).toHaveLength(0);
		bridge.detach();
	});

	it("flushes a new capture ahead of an existing retry and stops after five attempts", async () => {
		vi.useFakeTimers();
		const pi = createFakePi(); const calls: { method: string; at: number }[] = []; let uploaded = false;
		const bridge = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => true, request: () => async method => {
			calls.push({ method, at: Date.now() }); if (method === "POST") uploaded = true;
			return { status: 200, body: { version: 1, recording: true, recording_revision: 2, findings: uploaded ? [{ id: "finding-1", deliveries: [{ destination: "papercut", state: "queued" }] }] : [] } };
		} });
		bridge.attach({ url: "https://hive.test", token: "fixture" }, "session-1"); await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
		const capturedAt = Date.now(); pi.api.events.emit(YSK_FINDINGS_CHANNEL, [record()]); await vi.advanceTimersByTimeAsync(0);
		expect(calls.find(c => c.method === "POST")?.at).toBe(capturedAt);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(calls.filter(c => c.method === "POST")).toHaveLength(5);
		const exhausted = calls.length; await vi.advanceTimersByTimeAsync(60_000); expect(calls).toHaveLength(exhausted);
		bridge.detach();
	});

	it("does no transport work while denied or when server does not support the contract", async () => {
		vi.useFakeTimers();
		const pi = createFakePi(); const denied = vi.fn();
		const bridge = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => false, request: () => denied });
		bridge.attach({ url: "https://hive.test", token: "test" }, "session-1");
		pi.api.events.emit(YSK_FINDINGS_CHANNEL, [record()]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(denied).not.toHaveBeenCalled();
		bridge.detach();

		const unsupportedRequest = vi.fn(async (_method: string, _path: string, _body?: unknown, _signal?: AbortSignal) => ({ status: 404, body: undefined }));
		const unsupported = createYouShouldKnowRemoteBridge(pi.api, { allowed: () => true, request: () => unsupportedRequest });
		unsupported.attach({ url: "https://hive.test", token: "test" }, "session-2");
		await vi.advanceTimersByTimeAsync(0);
		pi.api.events.emit(YSK_FINDINGS_CHANNEL, [record("session-2")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(unsupportedRequest.mock.calls.every(call => call.length > 0 && call[0] === "GET")).toBe(true);
		unsupported.detach();
	});
});
