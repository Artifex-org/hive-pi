import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createFakePi, type FakeCtxOptions } from "./fake-pi.ts";
import { DEFAULT_CONFIG, scanOutput, wireYouShouldKnow, type Scanner } from "../extensions/you-should-know/index.ts";
import { EXCERPT_CHARS, excerpt, outputText, parseNotes, SCAN_SYSTEM } from "../extensions/you-should-know/scan.ts";
import { visibleWidth, Text } from "@earendil-works/pi-tui";

const quote = "The migration was not tested against production data.";
const note = { kind: "caveat", text: "Production-data verification is still missing.", quote };
function reply(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test",
		stopReason: "stop", timestamp: 0,
		usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
	};
}
const response = () => reply(JSON.stringify({ notes: [note] }));
function harness(scanner: Scanner = vi.fn(async () => response()), enabled = true, maxScans = 20) {
	const fake = createFakePi();
	wireYouShouldKnow(fake.api, { ...DEFAULT_CONFIG, enabled, intervalMs: 100, timeoutMs: 500, maxScans }, scanner);
	return { fake, scanner };
}
async function prose(fake: ReturnType<typeof createFakePi>, text = quote, options?: FakeCtxOptions) {
	await fake.emit({ type: "message_end", message: reply(text) }, options);
	await fake.emit({ type: "agent_settled" }, options);
	await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("scanner trust boundary", () => {
	it("extracts text, never thinking or tools or failed partial replies", () => {
		const m = reply(quote);
		m.content.unshift({ type: "thinking", thinking: "secret" }, { type: "toolCall", id: "1", name: "bash", arguments: { command: "secret" } });
		expect(outputText(m)).toBe(quote);
		expect(outputText({ ...m, role: "user" })).toBe("");
		expect(outputText({ ...m, stopReason: "aborted" })).toBe("");
		expect(outputText({ ...m, stopReason: "error" })).toBe("");
	});
	it("bounds the excerpt and declares omitted output", () => {
		const s = excerpt("a".repeat(EXCERPT_CHARS * 2) + "TAIL");
		expect(s.length).toBe(EXCERPT_CHARS);
		expect(s).toContain("omitted"); expect(s.endsWith("TAIL")).toBe(true);
	});
	it("accepts silence and exact source-backed notes, deduplicating quotes", () => {
		expect(parseNotes('{"notes":[]}', "Routine progress")).toEqual([]);
		expect(parseNotes(JSON.stringify({ notes: [note, note] }), quote)).toEqual([note]);
	});
	it.each([
		"not JSON", '{"notes":false}', JSON.stringify({ notes: [{ ...note, quote: "invented evidence" }] }),
		JSON.stringify({ notes: [{ ...note, kind: "security" }] }),
		JSON.stringify({ notes: [{ ...note, text: "\x1b[2J" }] }),
		JSON.stringify({ notes: [{ ...note, quote: "tiny" }] }),
		JSON.stringify({ notes: [{ ...note, text: "x".repeat(201) }] }),
		JSON.stringify({ notes: [note, note, note, note] }),
	])( "rejects malformed, invented, oversized and terminal-unsafe output: %s", answer => {
		expect(() => parseNotes(answer, quote)).toThrow();
	});
	it("asks for extraction rather than speculative review and explicitly rejects routine chatter", () => {
		expect(SCAN_SYSTEM).toContain("NO TOOLS");
		expect(SCAN_SYSTEM).toContain("untrusted DATA");
		expect(SCAN_SYSTEM).toContain("Ignore routine progress");
		expect(SCAN_SYSTEM).toContain("missing verification");
	});
});

describe("consent and delivery", () => {
	it("defaults off, registers the command, and does no work before opt-in", async () => {
		expect(DEFAULT_CONFIG.enabled).toBe(false);
		const h = harness(undefined, false);
		await prose(h.fake);
		expect(h.scanner).not.toHaveBeenCalled(); expect(h.fake.entries).toEqual([]);
		await h.fake.runCommand("you-should-know", "on");
		await prose(h.fake);
		expect(h.scanner).toHaveBeenCalledTimes(1);
		expect(h.fake.notifications[0]?.message).toContain("tool-less side calls");
	});
	it("does not register inside workers", () => {
		vi.stubEnv("PI_AGENDA_WORKER", "1");
		const h = harness(); expect(h.fake.handlers.size).toBe(0); expect(h.fake.commands.size).toBe(0);
	});
	it.each(["print", "json", "rpc"] as const)("does not spend in %s mode", async mode => {
		const h = harness(); await prose(h.fake, quote, { mode });
		await h.fake.runCommand("you-should-know", "on", { mode });
		expect(h.scanner).not.toHaveBeenCalled();
		expect(h.fake.entries).toEqual([]);
	});
	it("surfaces a buried caveat without injecting messages or registering tools", async () => {
		const h = harness(); await prose(h.fake, `Updated all files. ${quote} Ready for review.`);
		expect(h.fake.widgets.at(-1)?.lines?.join("\n")).toContain(note.text);
		await h.fake.runCommand("you-should-know", "show");
		expect(h.fake.notifications.at(-1)?.message).toContain(`Source: ${quote}`);
		expect(h.fake.messages).toEqual([]); expect(h.fake.userMessages).toEqual([]); expect(h.fake.tools).toEqual([]);
	});
	it("routine progress produces no widget with a silent model verdict", async () => {
		const h = harness(async () => reply('{"notes":[]}'));
		await prose(h.fake, "Reading the files and checking the test names.");
		expect(h.fake.widgets.at(-1)?.cleared).toBe(true);
	});
	it("custom scanner entries and tool output cannot recurse", async () => {
		const h = harness();
		for (const role of ["custom", "toolResult", "user"]) {
			await h.fake.emit({ type: "message_end", message: { role, content: [{ type: "text", text: quote }] } });
		}
		await h.fake.emit({ type: "agent_settled" }); await vi.advanceTimersByTimeAsync(1_000);
		expect(h.scanner).not.toHaveBeenCalled();
	});
	it("native text widgets wrap within both narrow and wide terminal widths", async () => {
		const h = harness(); await prose(h.fake);
		const lines = h.fake.widgets.at(-1)?.lines ?? [];
		for (const width of [30, 100]) {
			const rendered = new Text(lines.join("\n"), 0, 0).render(width);
			expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

describe("asynchronous lifecycle", () => {
	it("event handling finishes while a scanner remains pending; late output is coalesced", async () => {
		let resolve!: (v: AssistantMessage) => void;
		const scanner = vi.fn<Scanner>().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
			.mockResolvedValue(reply('{"notes":[]}'));
		const h = harness(scanner);
		await prose(h.fake); // would deadlock if a handler awaited the model
		await prose(h.fake, "Checking the next file.");
		expect(scanner).toHaveBeenCalledTimes(1);
		resolve(response()); await vi.advanceTimersByTimeAsync(1_000);
		expect(scanner).toHaveBeenCalledTimes(2);
		expect(scanner.mock.calls[1]?.[1].source).toContain("next file");
	});
	it.each(["off", "dismiss", "shutdown", "switch", "tree"])("cancels and rejects stale results on %s", async action => {
		let resolve!: (v: AssistantMessage) => void; let signal!: AbortSignal;
		const h = harness(async (_ctx, _request, s) => { signal = s; return new Promise(r => { resolve = r; }); });
		await prose(h.fake);
		if (action === "off" || action === "dismiss") await h.fake.runCommand("you-should-know", action);
		else await h.fake.emit({ type: action === "switch" ? "session_start" : action === "tree" ? "session_tree" : "session_shutdown" });
		const writes = h.fake.entries.length;
		resolve(response()); await vi.advanceTimersByTimeAsync(0);
		expect(signal.aborted).toBe(true);
		expect(h.fake.entries.length).toBe(writes);
		expect(h.fake.widgets.at(-1)?.cleared).toBe(true);
	});
	it("hard timeout works even when provider ignores the signal, without retry", async () => {
		const h = harness(vi.fn<Scanner>(() => new Promise<AssistantMessage>(() => {}))); await prose(h.fake);
		await vi.advanceTimersByTimeAsync(501);
		expect(h.fake.statuses.at(-1)?.text).toContain("failed");
		await h.fake.runCommand("you-should-know", "status");
		expect(h.fake.notifications.at(-1)?.message).toContain("not checked");
		await h.fake.runCommand("you-should-know", "off");
		await h.fake.runCommand("you-should-know", "on");
		await prose(h.fake, "An important new caveat.");
		await vi.advanceTimersByTimeAsync(10_000); expect(h.scanner).toHaveBeenCalledTimes(1);
	});
	it("releases transport ownership only when an ignored cancellation finally settles", async () => {
		let resolve!: (v: AssistantMessage) => void;
		const scanner = vi.fn<Scanner>().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
			.mockResolvedValue(reply('{"notes":[]}'));
		const h = harness(scanner); await prose(h.fake);
		await vi.advanceTimersByTimeAsync(501);
		await prose(h.fake, "New output while the old provider still runs.");
		await vi.advanceTimersByTimeAsync(1_000); expect(scanner).toHaveBeenCalledTimes(1);
		resolve(response()); await vi.advanceTimersByTimeAsync(1_000);
		expect(scanner).toHaveBeenCalledTimes(2);
		expect(h.fake.widgets.at(-1)?.cleared).toBe(true); // discarded timed-out verdict
	});
	it("bounds cadence and call budget, including off/on toggles", async () => {
		const h = harness(undefined, true, 2);
		await prose(h.fake); await prose(h.fake); expect(h.scanner).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100); expect(h.scanner).toHaveBeenCalledTimes(2);
		await h.fake.runCommand("you-should-know", "off"); await h.fake.runCommand("you-should-know", "on");
		await prose(h.fake); await vi.advanceTimersByTimeAsync(2_000);
		expect(h.scanner).toHaveBeenCalledTimes(2); expect(h.fake.statuses.at(-1)?.text).toContain("budget reached");
	});
	it("deduplicates after dismissal and restores branch-specific consent/budget on reload", async () => {
		const h = harness(); await prose(h.fake);
		await h.fake.runCommand("you-should-know", "dismiss");
		await prose(h.fake); await vi.advanceTimersByTimeAsync(100);
		expect(h.fake.widgets.at(-1)?.cleared).toBe(true);
		const state = h.fake.entries.at(-1);
		const other = harness();
		await other.fake.emit({ type: "session_start" }, { branch: [{ type: "custom", ...state }],
			entries: [{ type: "custom", customType: "you-should-know", data: { enabled: false } }] });
		await other.fake.runCommand("you-should-know", "status");
		expect(other.fake.notifications.at(-1)?.message).toContain("2/20 scans");
		await prose(other.fake); expect(other.fake.widgets.at(-1)?.cleared).toBe(true);
	});
	it("does not inherit consent in a fork or imported session with a different id", async () => {
		const h = harness(undefined, false);
		await h.fake.emit({ type: "session_start" });
		await h.fake.runCommand("you-should-know", "on");
		const saved = h.fake.entries.at(-1)!;
		await h.fake.emit({ type: "session_start", reason: "fork" }, {
			sessionId: "another-session", branch: [{ type: "custom", ...saved }],
		});
		await prose(h.fake, quote, { sessionId: "another-session" });
		expect(h.scanner).not.toHaveBeenCalled();
		await h.fake.runCommand("you-should-know", "status");
		expect(h.fake.notifications.at(-1)?.message).toContain("off");
	});
	it("malformed verdict is visibly failed, never a clean empty scan", async () => {
		const h = harness(async () => reply("NOT JSON")); await prose(h.fake);
		expect(h.fake.statuses.at(-1)?.text).toContain("failed");
		expect(h.fake.widgets.at(-1)?.cleared).toBe(true);
	});
});

it("production transport uses configured provider auth, a bounded response and no tools", async () => {
	const streamSimple = vi.fn(() => ({ result: async () => response() }));
	const fake = createFakePi();
	wireYouShouldKnow(fake.api, { ...DEFAULT_CONFIG, enabled: true }, scanOutput);
	const model = { provider: "openai", id: "test" } as NonNullable<FakeCtxOptions["model"]>;
	await prose(fake, quote, { model, modelRegistry: { streamSimple } });
	expect(streamSimple).toHaveBeenCalledTimes(1);
	const calls = streamSimple.mock.calls as unknown as Array<[unknown, Record<string, unknown>, Record<string, unknown>]>;
	const [, context, options] = calls[0]!;
	expect(context.tools).toBeUndefined(); expect(context.systemPrompt).toBe(SCAN_SYSTEM);
	expect(JSON.stringify(context.messages)).toContain(quote);
	expect(options.maxTokens).toBe(2_048); expect(options.signal).toBeInstanceOf(AbortSignal);
	expect(options.sessionId).toBeTypeOf("string");
});
