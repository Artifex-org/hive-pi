import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as identity from "../extensions/hive-common/identity.ts";
import * as modes from "../extensions/advisor/modes.ts";
import { aideUsageMailbox } from "../extensions/hive-remote/communication-usage.ts";
import { HIVE_METRIC_READY_CHANNEL } from "../extensions/hive-telemetry/types.ts";
import { createFakePi, type FakeCtxOptions } from "./fake-pi.ts";
import { createWaker } from "../extensions/hive-common/waker.ts";
import { aideDeps, registerCommunicationAide, type AideDeps, type AideRequest } from "../extensions/hive-remote/communication-aide.ts";
import type { TeamMessage } from "../extensions/hive-remote/team.ts";

function reply(summary = "Worker: PR #42 green", escalate: string[] = []): AssistantMessage {
	return { role: "assistant", provider: "test", model: "cheap", api: "anthropic-messages", timestamp: 0, stopReason: "stop",
		content: [{ type: "text", text: JSON.stringify({ summary, escalate }) }],
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } };
}
const message = (text = "PR #42 green"): TeamMessage => ({ category: "message", text, fromSessionID: "worker", fromTitle: "Worker", selfSessionID: "lead" });
function setup(complete?: AideDeps["complete"]) {
	vi.useFakeTimers();
	const fake = createFakePi();
	const waker = createWaker(fake.api, "aide-test");
	const requests: AideRequest[] = [];
	const select = vi.fn<AideDeps["select"]>(async () => "test/cheap");
	const aide = registerCommunicationAide(fake.api, notice => waker.deliver(notice, "message"), {
		archiveReady: () => true, select, complete: complete ?? (async (_ctx, _model, request) => { requests.push(request); return reply(); }),
	}, { debounceMs: 10, timeoutMs: 100 });
	// Unit tests model an opted-in telemetry subscriber. The real subscriber
	// and both registration orders are covered in hive-telemetry-wiring.
	fake.api.on("session_start", (_event, ctx) => {
		fake.api.events.emit(HIVE_METRIC_READY_CHANNEL, { sessionId: ctx.sessionManager.getSessionId(), ready: true });
	});
	return { fake, aide, requests, select };
}
afterEach(() => {
	vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
	const box = aideUsageMailbox(); box.pending.clear(); box.owners.clear(); box.metrics.clear(); box.requests.clear();
});

describe("orchestrator communications aide", () => {
	it("declines pilot interception after restoring enabled settings, leaving normal delivery responsible", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "0");
		const { fake, aide, select, requests } = setup();
		const manager = SessionManager.inMemory();
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "on", { sessionManager: manager });
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		await fake.emit({ type: "session_tree" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "status", { sessionManager: manager });
		expect(fake.notifications.at(-1)?.message).toContain("Enabled");
		select.mockClear();
		expect(aide.receive("must-deliver-normally", message("Worker blocked"))).toBe(false);
		await vi.advanceTimersByTimeAsync(20);
		expect(select).not.toHaveBeenCalled(); expect(requests).toEqual([]);
		await fake.emit({ type: "session_shutdown" }, { sessionManager: manager });
	});
	it("retains the aide tool but refuses pilot activation before selecting credentials or inferring", async () => {
		vi.stubEnv("HIVE_CLAUDE_SDK_PILOT", "1");
		const { fake, aide, select, requests } = setup();
		await fake.emit({ type: "session_start" });
		expect(fake.tools.some(t => t.name === "orchestrator_mode")).toBe(true);
		await expect(fake.runCommand("orchestrator", "on")).rejects.toThrow("Helper inference disabled for bounded SDK pilot");
		expect(select).not.toHaveBeenCalled(); expect(requests).toEqual([]);
		expect(aide.receive("offline", message())).toBe(false);
		await fake.runCommand("orchestrator", "status");
		await fake.emit({ type: "session_shutdown" });
	});

	it("does not activate after the tool is canceled during catalog selection", async () => {
		let resolve!: (model: string) => void;
		const { fake, aide, select, requests } = setup();
		select.mockImplementation(async () => await new Promise<string>(r => { resolve = r; }));
		let context!: ExtensionContext;
		fake.api.on("session_start", (_event, ctx) => { context = ctx; });
		await fake.emit({ type: "session_start" });
		const tool = fake.tools.find(t => t.name === "orchestrator_mode");
		const execute = tool?.definition.execute as (id: string, args: { action: string }, signal: AbortSignal,
			update: undefined, ctx: ExtensionContext) => Promise<unknown>;
		const controller = new AbortController();
		const activation = execute("activate", { action: "on" }, controller.signal, undefined, context);
		const rejected = expect(activation).rejects.toMatchObject({ name: "AbortError" });
		expect(select).toHaveBeenCalled(); controller.abort(); resolve("test/cheap");
		await rejected;
		expect(aide.receive("later", message())).toBe(false); expect(requests).toHaveLength(0);
		expect(fake.entries.some(e => {
			const data = e.data as { kind: string; settings?: { enabled: boolean } };
			return data.kind === "settings" && data.settings?.enabled;
		})).toBe(false);
	});
	it("revokes SDK-buffered activation after mutate-then-throw persistence and tree recovery", async () => {
		const { fake, aide } = setup(); const manager = SessionManager.inMemory();
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data); // actual SDK retains data before writing
			throw new Error("Disk unavailable after entry mutation");
		});
		await expect(fake.runCommand("orchestrator", "on", { sessionManager: manager })).rejects.toThrow("Disk unavailable");
		await fake.emit({ type: "session_tree" }, { sessionManager: manager });
		expect(aide.receive("must-deliver-normally", message())).toBe(false);
	});
	it("reconciles successfully delivered fallback after received-entry mutation and write failure", async () => {
		const { fake, aide } = setup(); const manager = SessionManager.inMemory();
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data);
			if ((data as { kind: string }).kind === "received") throw new Error("Receipt write failed after mutation");
		});
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "on", { sessionManager: manager });
		expect(() => aide.receive("fallback", message("Delivered normally"))).toThrow("Receipt write failed");
		manager.appendCustomMessageEntry("team-message", "Delivered normally", true, { communicationAideIds: ["fallback"] });
		await fake.emit({ type: "session_tree" }, { sessionManager: manager });
		expect(fake.messages).toHaveLength(0);
		await fake.runCommand("orchestrator", "status", { sessionManager: manager });
		expect(fake.notifications.at(-1)?.message).toContain("Enabled");
	});
	it("off remains disabled after mutate-then-throw persistence and tree recovery", async () => {
		const { fake, aide } = setup(); const manager = SessionManager.inMemory();
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "on", { sessionManager: manager });
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data); throw new Error("Disk unavailable after entry mutation");
		});
		await fake.runCommand("orchestrator", "off", { sessionManager: manager });
		await fake.emit({ type: "session_tree" }, { sessionManager: manager });
		expect(aide.receive("must-deliver-normally", message())).toBe(false);
	});
	it("declines fresh custom-only disk sessions and archives only after native conversation persistence", async () => {
		vi.useFakeTimers();
		const dir = mkdtempSync(join(tmpdir(), "pi-aide-session-"));
		const fake = createFakePi(); const manager = SessionManager.create(dir, dir);
		const complete = vi.fn<AideDeps["complete"]>(async () => reply());
		const aide = registerCommunicationAide(fake.api, () => {}, { ...aideDeps, select: async () => "test/cheap", complete });
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
		try {
			await fake.emit({ type: "session_start" }, { sessionManager: manager });
			await fake.runCommand("orchestrator", "on", { sessionManager: manager });
			const file = manager.getSessionFile(); if (!file) throw new Error("Expected disk-backed native session");
			expect(existsSync(file)).toBe(false);
			expect(aide.receive("before", message("Original must take normal delivery"))).toBe(false);
			expect(existsSync(file)).toBe(false); expect(complete).not.toHaveBeenCalled();
			manager.appendMessage({ role: "user", content: "Native conversation fixture", timestamp: 0 });
			expect(aide.receive("after", message("Durably received original"))).toBe(true);
			const reopened = SessionManager.open(file, dir);
			expect(reopened.getEntries().some(e => e.type === "custom" && e.customType === "orchestrator-aide" &&
				(e.data as { kind: string; item?: { id: string } }).kind === "received" &&
				(e.data as { item: { id: string } }).item.id === "after")).toBe(true);
			await fake.emit({ type: "session_shutdown" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("paginates forty maximum-sized originals into bounded complete-message pages", async () => {
		const { fake, aide } = setup(); let context!: ExtensionContext;
		fake.api.on("session_start", (_event, ctx) => { context = ctx; });
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		for (let i = 0; i < 40; i++) {
			expect(aide.receive(`large-${i}`, message("x".repeat(16_384)))).toBe(true);
			await vi.advanceTimersByTimeAsync(10);
		}
		await fake.runCommand("orchestrator", "inbox");
		const first = String(fake.messages.at(-1)?.content);
		expect(first.length).toBeLessThanOrEqual(32_000);
		expect(first).toContain("Message large-0"); expect(first).not.toContain("Message large-1");
		expect(first).toContain("Next: inbox offset 1");
		await fake.runCommand("orchestrator", "inbox 1");
		expect(String(fake.messages.at(-1)?.content)).toContain("Message large-1");
		const execute = fake.tools.find(t => t.name === "orchestrator_mode")?.definition.execute as
			(id: string, args: { action: string; offset: number }, signal: AbortSignal, update: undefined,
			ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }>;
		const result = await execute("page", { action: "inbox", offset: 39 }, new AbortController().signal, undefined, context);
		expect(result.content[0].text).toContain("Message large-39");
		expect(result.content[0].text.length).toBeLessThanOrEqual(32_000);
	});
	it("restores a disk-backed oversized original and advances with a bounded explicit preview", async () => {
		vi.useFakeTimers(); const dir = mkdtempSync(join(tmpdir(), "pi-aide-inbox-"));
		try {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({ role: "user", content: "Native conversation fixture", timestamp: 0 });
			manager.appendCustomEntry("orchestrator-aide", { kind: "received", item: {
				id: "oversized", message: { ...message("Body remains archived"), fromTitle: "t".repeat(64_000) },
			} });
			manager.appendCustomEntry("orchestrator-aide", { kind: "processed", ids: ["oversized"], escalated: [], summary: "Legacy original" });
			const file = manager.getSessionFile(); if (!file) throw new Error("Expected disk-backed native session");
			const reopened = SessionManager.open(file, dir); const { fake } = setup();
			await fake.emit({ type: "session_start" }, { sessionManager: reopened });
			await fake.runCommand("orchestrator", "inbox", { sessionManager: reopened });
			const page = String(fake.messages.at(-1)?.content);
			expect(page.length).toBeLessThanOrEqual(32_000);
			expect(page).toContain("preview only"); expect(page).toContain("0–1 of 1");
			expect(page).toContain("End of retained inbox");
			await fake.emit({ type: "session_shutdown" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("does nothing until explicitly enabled; ignores non-direct and anonymous messages", async () => {
		const { fake, aide, select } = setup();
		await fake.emit({ type: "session_start" });
		expect(aide.receive("1", message())).toBe(false);
		expect(select).not.toHaveBeenCalled();
		await fake.runCommand("orchestrator", "on medium");
		expect(select.mock.calls[0]?.[1]).toBe("medium");
		expect(aide.receive("2", { ...message(), category: "digest" })).toBe(false);
		expect(aide.receive("3", { ...message(), fromSessionID: undefined })).toBe(false);
	});
	it("archives burst updates outside lead context and reuses bounded background memory", async () => {
		const { fake, aide, requests } = setup();
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); aide.receive("b", message("CI is green"));
		expect(requests).toHaveLength(0);
		expect(fake.entries.filter(e => (e.data as { kind: string }).kind === "received")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(10);
		expect(requests).toHaveLength(1); expect(requests[0].messages).toHaveLength(2);
		expect(fake.messages).toHaveLength(0);
		aide.receive("c", message("Docs committed")); await vi.advanceTimersByTimeAsync(10);
		expect(requests[1].summary).toBe("Worker: PR #42 green");
		expect(requests[1].conversation).toBe(requests[0].conversation);
		await fake.runCommand("orchestrator", "digest");
		expect(fake.messages[0].content).toContain("PR #42 green");
		expect(fake.messages[0].options?.triggerTurn).toBe(false);
		expect(fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(2);
	});
	it("escalates only selected originals once, preserving sender and wording", async () => {
		const { fake, aide } = setup(async () => reply("Progress noted", ["b"]));
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); aide.receive("b", message("Blocked: should we change the schema?"));
		await vi.advanceTimersByTimeAsync(10);
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0].content).toContain("Blocked: should we change the schema?");
		expect(fake.messages[0].content).toContain("Worker");
		expect(fake.messages[0].content).not.toContain("PR #42 green");
		expect(fake.messages[0].options?.triggerTurn).toBe(true);
		expect(aide.receive("b", message("duplicate"))).toBe(true);
		await vi.advanceTimersByTimeAsync(100); expect(fake.messages).toHaveLength(1);
	});
	it.each(["bad-json", "foreign-id", "truncated", "provider-error", "timeout"])("fails open on %s without leaking provider errors", async failure => {
		const { fake, aide } = setup(async () => {
			if (failure === "timeout") return await new Promise(() => {});
			if (failure === "provider-error") throw new Error("secret provider detail");
			if (failure === "foreign-id") return reply("ok", ["not-in-batch"]);
			if (failure === "truncated") return { ...reply(), stopReason: "length" };
			return { ...reply(), content: [{ type: "text", text: "not json" }] };
		});
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message("Needs a decision")); await vi.advanceTimersByTimeAsync(120);
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0].content).toContain("Needs a decision");
		expect(fake.messages[0].content).toContain("mode disabled");
		expect(fake.messages[0].content).not.toContain("secret provider detail");
		expect(aide.receive("b", message())).toBe(false);
	});
	it("serializes batches and includes messages arriving during a request", async () => {
		let release!: (response: AssistantMessage) => void;
		let concurrent = 0, max = 0;
		const complete = vi.fn(async () => { concurrent++; max = Math.max(max, concurrent);
			const r = await new Promise<AssistantMessage>(resolve => { release = resolve; }); concurrent--; return r; });
		const { fake, aide } = setup(complete);
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		aide.receive("b", message()); await vi.advanceTimersByTimeAsync(10);
		expect(complete).toHaveBeenCalledTimes(1);
		release(reply()); await vi.advanceTimersByTimeAsync(10);
		expect(complete).toHaveBeenCalledTimes(2); expect(max).toBe(1);
		release(reply()); await vi.advanceTimersByTimeAsync(0);
	});
	it("off aborts in-flight work, returns pending originals, and fences late completion", async () => {
		let release!: (response: AssistantMessage) => void;
		let signal: AbortSignal | undefined;
		const { fake, aide } = setup(async (_ctx, _model, _request, s) => { signal = s; return await new Promise(resolve => { release = resolve; }); });
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message("pending")); await vi.advanceTimersByTimeAsync(10);
		await fake.runCommand("orchestrator", "off");
		expect(signal?.aborted).toBe(true); expect(fake.messages).toHaveLength(1);
		release(reply("incorrect late summary", ["a"])); await vi.advanceTimersByTimeAsync(0);
		expect(fake.messages).toHaveLength(1);
		await fake.runCommand("orchestrator", "digest"); expect(fake.messages[1].content).not.toContain("incorrect");
	});
	it.each(["off", "timeout", "reload"])("waits for real provider settlement across %s, returning new originals instead of overlapping", async path => {
		let release!: (response: AssistantMessage) => void;
		const complete = vi.fn<AideDeps["complete"]>(async () => {
			if (complete.mock.calls.length === 1) return await new Promise(resolve => { release = resolve; });
			return reply();
		});
		const old = setup(complete);
		await old.fake.emit({ type: "session_start" }, { sessionId: "origin" });
		await old.fake.runCommand("orchestrator", "on", { sessionId: "origin" });
		old.aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		let next = old;
		if (path === "off") await old.fake.runCommand("orchestrator", "off", { sessionId: "origin" });
		if (path === "timeout") await vi.advanceTimersByTimeAsync(120);
		if (path === "reload") {
			await old.fake.emit({ type: "session_shutdown" }); next = setup(complete);
			await next.fake.emit({ type: "session_start" }, { sessionId: "origin" });
		}
		await next.fake.runCommand("orchestrator", "on", { sessionId: "origin" });
		expect(next.aide.receive("b", message("New blocker"))).toBe(false); // normal delivery hook handles the original
		await vi.advanceTimersByTimeAsync(200); expect(complete).toHaveBeenCalledTimes(1);
		release(reply("discarded late decision")); await vi.advanceTimersByTimeAsync(0);
		await next.fake.runCommand("orchestrator", "on", { sessionId: "origin" });
		expect(next.aide.receive("c", message())).toBe(true);
		await vi.advanceTimersByTimeAsync(10); expect(complete).toHaveBeenCalledTimes(2);
	});
	it("recovers unfinished originals from the session archive without another model call", async () => {
		const old = setup(); await old.fake.emit({ type: "session_start" }); await old.fake.runCommand("orchestrator", "on");
		old.aide.receive("a", message("Uncommitted work is in src/foo"));
		const branch = old.fake.entries.map(e => ({ type: "custom", ...e }));
		await old.fake.emit({ type: "session_shutdown" });
		const next = setup(); await next.fake.emit({ type: "session_start" }, { branch }); await vi.advanceTimersByTimeAsync(0);
		expect(next.requests).toHaveLength(0); expect(next.fake.messages[0].content).toContain("src/foo");
		expect(next.aide.receive("b", message())).toBe(false);
	});
	it("restores completed summary, avoids replay, and fences completions across session replacement", async () => {
		const old = setup(); await old.fake.emit({ type: "session_start" }); await old.fake.runCommand("orchestrator", "on");
		old.aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		const branch = old.fake.entries.map(e => ({ type: "custom", ...e }));
		await old.fake.emit({ type: "session_shutdown" });
		let release!: (response: AssistantMessage) => void;
		const next = setup(async () => await new Promise(resolve => { release = resolve; }));
		await next.fake.emit({ type: "session_start" }, { branch }); await vi.advanceTimersByTimeAsync(0);
		expect(next.fake.messages).toHaveLength(0);
		await next.fake.runCommand("orchestrator", "digest"); expect(next.fake.messages[0].content).toContain("PR #42 green");
		next.aide.receive("b", message()); await vi.advanceTimersByTimeAsync(10);
		await next.fake.emit({ type: "session_start" }, { sessionId: "different" });
		release(reply("stale", ["b"])); await vi.advanceTimersByTimeAsync(100);
		expect(next.fake.messages).toHaveLength(1);
	});
	it("does not wake through structured human handback, even on triage failure", async () => {
		const { fake, aide } = setup(async () => { throw new Error("offline"); });
		const branch = [
			{ type: "message", message: { role: "user", content: "plan it" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "plan_ready", arguments: {} }], stopReason: "toolUse" } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "plan_ready", content: [{ type: "text", text: "Plan is ready and awaiting approval:\n\nX" }] } },
			{ type: "message", message: { role: "assistant", content: "Here is the plan.", stopReason: "stop" } },
		];
		const options: FakeCtxOptions = { branch };
		await fake.emit({ type: "session_start" }, options); await fake.runCommand("orchestrator", "on", options);
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0].options?.triggerTurn).toBe(false);
	});
	it("recovers an escalation classified while streaming until its notice is actually persisted", async () => {
		const old = setup(async () => reply("", ["a"]));
		await old.fake.emit({ type: "session_start" }); await old.fake.runCommand("orchestrator", "on");
		await old.fake.emit({ type: "agent_start" });
		old.aide.receive("a", message("Blocking schema question")); await vi.advanceTimersByTimeAsync(10);
		expect(old.fake.messages[0].options?.triggerTurn).toBe(false);
		const branch = old.fake.entries.map(e => ({ type: "custom", ...e }));
		await old.fake.emit({ type: "session_shutdown" });
		const replay = setup(); await replay.fake.emit({ type: "session_start" }, { branch });
		await vi.advanceTimersByTimeAsync(0);
		expect(replay.fake.messages[0].content).toContain("Blocking schema question");
		await replay.fake.emit({ type: "session_shutdown" });
		const deliveredBranch = [...branch, { type: "custom_message", customType: "team-message", details: old.fake.messages[0].details }];
		const delivered = setup(); await delivered.fake.emit({ type: "session_start" }, { branch: deliveredBranch });
		await vi.advanceTimersByTimeAsync(0); expect(delivered.fake.messages).toHaveLength(0);
	});
	it.each(["off", "timeout", "recovery"])("still returns originals when archive writes fail during %s", async path => {
		const { fake, aide } = setup(async () => await new Promise(() => {}));
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message("Archived blocker"));
		const branch = fake.entries.map(e => ({ type: "custom", ...e }));
		vi.spyOn(fake.api, "appendEntry").mockImplementation(() => { throw new Error("disk full"); });
		if (path === "off") await fake.runCommand("orchestrator", "off");
		else if (path === "recovery") { await fake.emit({ type: "session_start" }, { branch }); await vi.advanceTimersByTimeAsync(0); }
		else await vi.advanceTimersByTimeAsync(120);
		expect(fake.messages).toHaveLength(1); expect(fake.messages[0].content).toContain("Archived blocker");
		expect(fake.notifications.some(n => n.message.includes("archive write failed"))).toBe(true);
		expect(aide.receive("b", message())).toBe(false);
	});
	it.each([false, true])("uses the real session-wide ledger across navigation, delivered=%s", async delivered => {
		const { fake, aide } = setup(async () => reply("", ["a"]));
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "Original task", timestamp: 0 });
		vi.spyOn(fake.api, "appendEntry").mockImplementation((type, data) => { manager.appendCustomEntry(type, data); });
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "on", { sessionManager: manager });
		aide.receive("a", message("Blocker on an abandoned leaf"));
		if (delivered) {
			await vi.advanceTimersByTimeAsync(10);
			const notice = fake.messages[0];
			manager.appendCustomMessageEntry("team-message", notice.content, true, notice.details);
			fake.messages.length = 0;
		}
		manager.branch(root);
		expect(manager.getBranch().some(e => e.type === "custom")).toBe(false);
		await fake.emit({ type: "session_tree" }, { sessionManager: manager }); await vi.advanceTimersByTimeAsync(0);
		if (delivered) expect(fake.messages).toHaveLength(0); // navigating history does not replay delivered mail
		else expect(fake.messages[0].content).toContain("Blocker on an abandoned leaf");
	});
	it("accounts for late canceled responses without applying their decisions or resetting spend", async () => {
		let release!: (response: AssistantMessage) => void;
		const { fake, aide } = setup(async () => await new Promise(resolve => { release = resolve; }));
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10); await fake.runCommand("orchestrator", "off");
		const r = reply("stale", ["a"]); r.usage.cost.total = 2;
		release(r); await vi.advanceTimersByTimeAsync(0);
		expect(fake.messages).toHaveLength(1); expect(fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(1);
		await fake.runCommand("orchestrator", "status"); expect(fake.notifications.at(-1)?.message).toContain("$2.000/2");
		await fake.runCommand("orchestrator", "on"); aide.receive("b", message()); await vi.advanceTimersByTimeAsync(10);
		expect(fake.messages[1].content).toContain("budget reached");
	});
	it("defers replacement-session usage until its origin resumes, without mutating a read-only manager", async () => {
		let release!: (response: AssistantMessage) => void;
		const { fake, aide } = setup(async () => await new Promise(resolve => { release = resolve; }));
		const manager = SessionManager.inMemory();
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		await fake.runCommand("orchestrator", "on", { sessionManager: manager });
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		await fake.emit({ type: "session_start" }, { sessionId: "replacement" });
		release(reply("stale", ["a"])); await vi.advanceTimersByTimeAsync(0);
		expect(manager.getEntries()).toHaveLength(0); // no unsupported writes to an old manager
		expect(fake.messages).toHaveLength(0);
		expect(fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(0);
		expect(fake.notifications.at(-1)?.message).toContain("resume it to record the charge");
		await fake.emit({ type: "session_start" }, { sessionManager: manager });
		expect(fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(1);
		expect(fake.entries.at(-1)?.data).toMatchObject({ kind: "usage", tokens: 20, cost: 0.01 });
	});
	it.each([false, true])("recovers late usage in a distinct instance, resumes before response=%s", async resumeBefore => {
		let release!: (response: AssistantMessage) => void;
		const old = setup(async () => await new Promise(resolve => { release = resolve; }));
		await old.fake.emit({ type: "session_start" }, { sessionId: "origin" });
		await old.fake.runCommand("orchestrator", "on", { sessionId: "origin" });
		old.aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		await old.fake.emit({ type: "session_shutdown" });
		const next = setup(); await next.fake.emit({ type: "session_start" }, { sessionId: "replacement" });
		const resumed = setup();
		if (resumeBefore) await resumed.fake.emit({ type: "session_start" }, { sessionId: "origin" });
		const billed = reply("private discarded result", ["a"]); billed.usage.cost.total = 2;
		release(billed); await vi.advanceTimersByTimeAsync(0);
		expect(next.fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(0);
		if (!resumeBefore) {
			expect(aideUsageMailbox().pending.get("origin")?.[0]).not.toHaveProperty("content");
			await resumed.fake.emit({ type: "session_start" }, { sessionId: "origin" });
		}
		expect(resumed.fake.entries.at(-1)?.data).toMatchObject({ kind: "usage", tokens: 20, cost: 2 });
		expect(resumed.fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(1);
		expect(resumed.fake.messages).toHaveLength(0); expect(aideUsageMailbox().pending.has("origin")).toBe(false);
		await resumed.fake.runCommand("orchestrator", "on", { sessionId: "origin" });
		resumed.aide.receive("b", message()); await vi.advanceTimersByTimeAsync(10);
		expect(resumed.fake.messages[0].content).toContain("budget reached");
	});
	it("accounts for a billed response even after its timeout has already won", async () => {
		let release!: (response: AssistantMessage) => void;
		const { fake, aide } = setup(async () => await new Promise(resolve => { release = resolve; }));
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(120);
		expect(fake.messages).toHaveLength(1);
		const r = reply("stale", ["a"]); r.usage.cost.total = 2;
		release(r); await vi.advanceTimersByTimeAsync(0);
		expect(fake.messages).toHaveLength(1);
		await fake.runCommand("orchestrator", "status"); expect(fake.notifications.at(-1)?.message).toContain("$2.000/2");
		expect(fake.busEvents.filter(e => e.name === "hive.metric")).toHaveLength(1);
	});
	it("enforces cheap-model availability, persistent-session mode, and backlog limits", async () => {
		const { fake, aide, select } = setup();
		await fake.emit({ type: "session_start" });
		select.mockRejectedValueOnce(new Error("No low credential"));
		await expect(fake.runCommand("orchestrator", "on")).rejects.toThrow("No low credential");
		expect(aide.receive("0", message())).toBe(false);
		await expect(fake.runCommand("orchestrator", "on", { mode: "json" })).rejects.toThrow("persistent");
		await fake.runCommand("orchestrator", "on");
		for (let i = 0; i < 32; i++) expect(aide.receive(String(i), message())).toBe(true);
		expect(aide.receive("overflow", message())).toBe(false); expect(fake.messages[0].content).toContain("backlog limit");
		await fake.runCommand("orchestrator", "inbox"); expect(fake.messages[1].content).toContain("Message 31");
	});
	it("returns originals at the cumulative spend limit and never resets it by toggling mode", async () => {
		const { fake, aide } = setup(async () => { const r = reply(); r.usage.cost.total = 2; return r; });
		await fake.emit({ type: "session_start" }); await fake.runCommand("orchestrator", "on");
		aide.receive("a", message()); await vi.advanceTimersByTimeAsync(10);
		aide.receive("b", message()); await vi.advanceTimersByTimeAsync(10);
		expect(fake.messages[0].content).toContain("budget reached");
		await fake.runCommand("orchestrator", "on"); aide.receive("c", message()); await vi.advanceTimersByTimeAsync(10);
		expect(fake.messages[1].content).toContain("budget reached");
	});
	it("does not enable filtering if activation cannot be persisted", async () => {
		const { fake, aide } = setup(); await fake.emit({ type: "session_start" });
		vi.spyOn(fake.api, "appendEntry").mockImplementation(() => { throw new Error("disk full"); });
		await expect(fake.runCommand("orchestrator", "on")).rejects.toThrow("disk full");
		expect(aide.receive("a", message())).toBe(false);
	});
	it.each(["low", "medium"] as const)("selects the actual catalog %s model and validates credentials", async tier => {
		const { fake } = setup();
		vi.spyOn(identity, "resolveAuth").mockReturnValue({ url: "https://hive.test", token: "fixture", source: "test" });
		vi.spyOn(modes, "fetchAgentModeCatalog").mockResolvedValue({ subagentKey: undefined, modes: [
			{ key: "high", model: "test/lead" }, { key: "medium", model: "test/medium" }, { key: "low", model: "test/low" },
		] });
		const registry = { find: vi.fn((_provider, id) => ({ provider: "test", id })), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })) };
		let ctx!: Parameters<AideDeps["select"]>[0]; fake.api.on("agent_start", (_event, next) => { ctx = next; });
		await fake.emit({ type: "agent_start" }, { modelRegistry: registry });
		expect(await aideDeps.select(ctx, tier)).toBe(`test/${tier}`);
		expect(registry.find).toHaveBeenCalledWith("test", tier);
		registry.getApiKeyAndHeaders.mockResolvedValue({ ok: false });
		await expect(aideDeps.select(ctx, tier)).rejects.toThrow("configure its provider");
		vi.mocked(modes.fetchAgentModeCatalog).mockResolvedValue({ subagentKey: undefined, modes: [{ key: "high", model: "test/lead" }] });
		await expect(aideDeps.select(ctx, tier)).rejects.toThrow(`no ${tier} model`);
	});
	it("uses the selected low model with no tools, no lead context, and a stable session id", async () => {
		const { fake } = setup();
		const streamSimple = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({ result: async () => reply() }));
		const registry = { find: vi.fn(() => ({ provider: "test", id: "cheap" })), streamSimple };
		let ctx!: Parameters<AideDeps["complete"]>[0];
		fake.api.on("agent_start", (_event, next) => { ctx = next; });
		await fake.emit({ type: "agent_start" }, { modelRegistry: registry });
		await aideDeps.complete(ctx, "test/cheap", { summary: "prior", messages: [{ id: "a", message: message() }], conversation: "stable" }, new AbortController().signal);
		expect(registry.find).toHaveBeenCalledWith("test", "cheap");
		expect(streamSimple.mock.calls[0]?.[1]).not.toHaveProperty("tools");
		expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ sessionId: "stable", maxTokens: 2048 });
	});
});
