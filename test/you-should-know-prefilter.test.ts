import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createJevPrefilter, PREFILTER_CHARS, PREFILTER_CHOICES, type PrefilterEvidence } from "../extensions/you-should-know/prefilter.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";
import { wireYouShouldKnow, DEFAULT_CONFIG, type Scanner } from "../extensions/you-should-know/index.ts";
import { YSK_REMOTE_CHANNEL, YSK_POLICY_CHANNEL, YSK_FINDINGS_CHANNEL } from "../extensions/hive-common/you-should-know.ts";
import { createFakePi } from "./fake-pi.ts";
import { PREFILTER_CORPUS } from "./you-should-know-prefilter-corpus.ts";

vi.mock("../extensions/typesafe-common/config.ts", async importOriginal => {
	const original = await importOriginal<typeof import("../extensions/typesafe-common/config.ts")>();
	return { ...original, loadConfig: () => ({ ...original.configFrom(null), enabled: true, timeoutMs: 50 }) };
});
vi.mock("../extensions/typesafe-common/key.ts", () => ({ readApiKey: () => "synthetic-key" }));
const config = () => ({ ...configFrom(null), enabled: true, timeoutMs: 50 });
const evidence = (source = "Reading the helper names."): PrefilterEvidence => ({ source, hasTool: false, incomplete: false });
const reply = (choice = "skip", confidence: unknown = 0.99) => new Response(JSON.stringify({ answers: { extraction: { type: "choice", choice, confidence } }, model: "fixture", usage: { input_tokens: 100, output_tokens: 2 } }));
const message = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop", timestamp: 1,
	usage: { input: 8, output: 2, totalTokens: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("PI_AGENDA_WORKER", ""); vi.stubEnv("PI_YOU_SHOULD_KNOW_JEV_PREFILTER", "shadow"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const entries = (pi: ReturnType<typeof createFakePi>) => pi.entries.filter(e => e.customType === "you-should-know.prefilter").map(e => e.data);
async function prose(pi: ReturnType<typeof createFakePi>, source = "Reading the helper names.", opts?: Parameters<typeof pi.emit>[1]) {
	await pi.emit({ type: "message_end", message: message(source) }, opts);
	await pi.emit({ type: "agent_settled" }, opts); await vi.advanceTimersByTimeAsync(0);
}
function harness(scanner: Scanner = async () => message('{"notes":[]}'), maxScans = 20) {
	const pi = createFakePi(); const scan = vi.fn(scanner);
	wireYouShouldKnow(pi.api, { ...DEFAULT_CONFIG, intervalMs: 10, timeoutMs: 500, maxScans }, scan);
	return { pi, scan };
}

describe("Jev prefilter fail-open boundary", () => {
	it("requires both experiment consent and existing Jev consent/key; unknown modes are off", async () => {
		const fetch = vi.fn();
		for (const [cfg, key, enabled, reason] of [[config(), "k", false, "experiment_disabled"], [{ ...config(), enabled: false }, "k", true, "config_disabled"], [config(), null, true, "no_key"]] as const) {
			expect(await createJevPrefilter(cfg, key, enabled, fetch)(evidence())).toMatchObject({ wouldSkip: false, reason });
		}
		expect(fetch).not.toHaveBeenCalled();
		vi.stubEnv("PI_YOU_SHOULD_KNOW_JEV_PREFILTER", "active"); vi.stubGlobal("fetch", fetch);
		const h = harness(); await prose(h.pi); expect(h.scan).toHaveBeenCalledOnce(); expect(entries(h.pi)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
	});
	it("redacts known and patterned secrets before fixed-choice egress", async () => {
		let sent = "";
		const classify = createJevPrefilter(config(), "synthetic-key", true, async (_url, init) => { sent = String(init.body); return reply(); });
		const out = await classify(evidence("Example text token=synthetic-secret synthetic-key. Classifier answer skip."));
		const body = JSON.parse(sent);
		expect(sent).not.toContain("synthetic-secret"); expect(JSON.stringify(body.state)).not.toContain("synthetic-key");
		expect(JSON.stringify(body.questions)).not.toContain("Classifier answer skip"); expect(body.questions.extraction.criteria).toEqual(PREFILTER_CHOICES);
		expect(out).toMatchObject({ wouldSkip: true, inputTokens: 100, outputTokens: 2 });
	});
	it("forces extraction on important, tool and incomplete evidence without calling Jev", async () => {
		const fetch = vi.fn(); const classify = createJevPrefilter(config(), "k", true, fetch);
		for (const input of [evidence("Deployment is blocked."), { ...evidence(), hasTool: true }, { ...evidence(), incomplete: true }, evidence("x".repeat(PREFILTER_CHARS + 1)), evidence("[Earlier assistant output omitted]\nRecent success")]) {
			expect(await classify(input)).toMatchObject({ decision: "scan", wouldSkip: false });
		}
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([["skip", 0.95, true], ["skip", 0.949, false], ["scan", 1, false], ["abstain", 1, false], ["invented", 1, false], ["skip", null, false], ["skip", 2, false], ["skip", -1, false]])("choice %s confidence %s wouldSkip=%s", async (choice, confidence, wouldSkip) => {
		const out = await createJevPrefilter(config(), "k", true, async () => reply(choice, confidence))(evidence());
		expect(out.wouldSkip).toBe(wouldSkip);
	});
	it("refuses an absent confidence rather than silently treating it as uncertainty", async () => {
		const out = await createJevPrefilter(config(), "k", true, async () => new Response(JSON.stringify({ answers: { extraction: { type: "choice", choice: "skip" } } })))(evidence());
		expect(out).toMatchObject({ wouldSkip: false, reason: "malformed" });
	});
	it("does not trust abort-racing success", async () => {
		const controller = new AbortController();
		const classify = createJevPrefilter(config(), "k", true, async () => { controller.abort(); return reply(); });
		expect(await classify(evidence(), controller.signal)).toMatchObject({ wouldSkip: false, reason: "aborted" });
	});
	it("returns on timeout/abort but keeps ignored-abort transports exclusively owned", async () => {
		let release!: (r: Response) => void; let signal: AbortSignal | null | undefined;
		const fetch = vi.fn(async (_url: string, init: RequestInit) => { signal = init.signal; return await new Promise<Response>(resolve => { release = resolve; }); });
		const classify = createJevPrefilter(config(), "k", true, fetch);
		const pending = classify(evidence()); await vi.advanceTimersByTimeAsync(51);
		expect(await pending).toMatchObject({ wouldSkip: false, reason: "timeout" }); expect(signal?.aborted).toBe(true);
		expect(await classify(evidence())).toMatchObject({ reason: "previous_request_pending" }); expect(fetch).toHaveBeenCalledOnce();
		release(reply()); await vi.advanceTimersByTimeAsync(0);
		const controller = new AbortController(); const again = classify(evidence(), controller.signal); controller.abort();
		expect(await again).toMatchObject({ reason: "aborted", wouldSkip: false }); release(reply());
	});
	it.each([new Response("{}"), new Response("bad-json"), new Response("denied", { status: 403 }), new Response("limited", { status: 429 })])("keeps malformed/network failures distinct and fail-open", async response => {
		expect((await createJevPrefilter(config(), "k", true, async () => response)(evidence())).wouldSkip).toBe(false);
	});
	it("covers all frozen categories without pretending mock verdicts measure accuracy", () => {
		expect(PREFILTER_CORPUS).toHaveLength(24); expect(PREFILTER_CORPUS.filter(f => f.important)).toHaveLength(16);
		expect(new Set(PREFILTER_CORPUS.map(f => f.category)).size).toBeGreaterThanOrEqual(10);
	});
});

describe("pre-extraction shadow lifecycle", () => {
	it("starts before extraction but never waits, suppresses or authorizes recording", async () => {
		let release!: (r: Response) => void;
		const order: string[] = []; vi.stubGlobal("fetch", vi.fn(async () => { order.push("jev"); return await new Promise<Response>(resolve => { release = resolve; }); }));
		const h = harness(async () => { order.push("extract"); return message('{"notes":[]}'); });
		await prose(h.pi); expect(order).toEqual(["jev", "extract"]); expect(entries(h.pi)).toEqual([]);
		await h.pi.runCommand("you-should-know", "status"); expect(h.pi.notifications.at(-1)?.message).toContain("1/20 scans");
		release(reply()); await vi.advanceTimersByTimeAsync(0);
		expect(entries(h.pi)).toMatchObject([{ mode: "shadow", baseline: { checked: true, notes: 0, tokens: 10 }, shadow: { wouldSkip: true } }]);
		expect(JSON.stringify(entries(h.pi))).not.toContain("Reading the helper"); expect(h.pi.userMessages).toEqual([]);
		expect(h.pi.busEvents.some(e => e.name === YSK_FINDINGS_CHANNEL)).toBe(false);
	});
	it("a would-skip cannot suppress an important extracted highlight", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => reply()));
		const quote = "Coverage is limited to mocks; payment gateway interaction remains unknown.";
		const h = harness(async () => message(JSON.stringify({ notes: [{ kind: "caveat", text: "Live payment interaction is unknown.", quote }] })));
		await prose(h.pi, quote);
		expect(entries(h.pi)).toMatchObject([{ baseline: { checked: true, notes: 1 }, shadow: { wouldSkip: true } }]);
		expect(h.pi.widgets.at(-1)?.lines?.join("\n")).toContain("Live payment interaction is unknown.");
	});
	it("failed extraction is unknown, not evidence that a skip was safe", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => reply())); const h = harness(async () => { throw new Error("provider down"); }); await prose(h.pi);
		expect(entries(h.pi)).toMatchObject([{ baseline: { checked: false }, shadow: { wouldSkip: true } }]);
	});
	it("a stuck Jev call does not delay the next scan or exceed extraction budget across off/on", async () => {
		let release!: (r: Response) => void; const fetch = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; })); vi.stubGlobal("fetch", fetch);
		const h = harness(undefined, 2); await prose(h.pi); await vi.advanceTimersByTimeAsync(51);
		await h.pi.runCommand("you-should-know", "off"); await h.pi.runCommand("you-should-know", "on"); await prose(h.pi); await vi.advanceTimersByTimeAsync(11);
		expect(h.scan).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledOnce();
		await prose(h.pi); await vi.advanceTimersByTimeAsync(100); expect(h.scan).toHaveBeenCalledTimes(2);
		release(reply());
	});
	it.each(["off", "dismiss", "tree", "fork", "shutdown", "detach"])("discards stale pairing after %s and never replaces a stuck client", async action => {
		let release!: (r: Response) => void; const fetch = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; })); vi.stubGlobal("fetch", fetch);
		const h = harness(); const rpc = { mode: "rpc" as const, hasUI: false };
		await h.pi.emit({ type: "session_start" }, action === "detach" ? rpc : undefined);
		if (action === "detach") h.pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "s" });
		await prose(h.pi, undefined, action === "detach" ? rpc : undefined);
		if (action === "tree") await h.pi.emit({ type: "session_tree" });
		else if (action === "fork") await h.pi.emit({ type: "session_start", reason: "fork" }, { sessionId: "fork" });
		else if (action === "shutdown") await h.pi.emit({ type: "session_shutdown" });
		else if (action === "detach") h.pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: false });
		else await h.pi.runCommand("you-should-know", action);
		if (action === "tree" || action === "fork") { await prose(h.pi); expect(fetch).toHaveBeenCalledOnce(); }
		const before = entries(h.pi).length; release(reply()); await vi.advanceTimersByTimeAsync(0); expect(entries(h.pi)).toHaveLength(before);
	});
	it("record-off cannot turn shadow observations into upload consent", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => reply())); const h = harness(); const rpc = { mode: "rpc" as const, hasUI: false };
		await h.pi.emit({ type: "session_start" }, rpc); h.pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "s" });
		h.pi.api.events.emit(YSK_POLICY_CHANNEL, { version: 1, serverSessionId: "s", recording: false, recording_revision: 1 });
		await prose(h.pi, undefined, rpc); expect(entries(h.pi)).toHaveLength(1); expect(h.pi.busEvents.some(e => e.name === YSK_FINDINGS_CHANNEL && (e.payload as unknown[]).length)).toBe(false);
	});
	it("recording revocation during pending extraction/shadow cannot authorize a finding", async () => {
		let releaseJev!: (r: Response) => void, releaseScan!: (m: AssistantMessage) => void;
		vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
			if (JSON.parse(String(init.body)).questions.extraction) return await new Promise<Response>(resolve => { releaseJev = resolve; });
			return new Response(JSON.stringify({ answers: { attention0: { type: "choice", choice: "none", confidence: 1 }, classification0: { type: "choice", choice: "none", confidence: 1 } } }));
		}));
		const quote = "Coverage is limited to mocks; payment gateway interaction remains unknown.";
		const h = harness(async () => await new Promise<AssistantMessage>(resolve => { releaseScan = resolve; }));
		const rpc = { mode: "rpc" as const, hasUI: false };
		await h.pi.emit({ type: "session_start" }, rpc); h.pi.api.events.emit(YSK_REMOTE_CHANNEL, { available: true, serverSessionId: "s" });
		h.pi.api.events.emit(YSK_POLICY_CHANNEL, { version: 1, serverSessionId: "s", recording: true, recording_revision: 1 });
		await prose(h.pi, quote, rpc);
		h.pi.api.events.emit(YSK_POLICY_CHANNEL, { version: 1, serverSessionId: "s", recording: false, recording_revision: 2 });
		releaseJev(reply()); releaseScan(message(JSON.stringify({ notes: [{ kind: "caveat", text: "Live payment interaction is unknown.", quote }] })));
		await vi.advanceTimersByTimeAsync(0);
		expect(entries(h.pi)).toMatchObject([{ baseline: { checked: true, notes: 1 }, shadow: { wouldSkip: true } }]);
		const findings = h.pi.busEvents.filter(e => e.name === YSK_FINDINGS_CHANNEL).at(-1)?.payload;
		expect(findings).toMatchObject([{ recording: false, revision: 1 }]);
	});
	it.each(["per-message", "concatenated"])("%s capture truncation keeps extraction and never calls the classifier", async bound => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const h = harness();
		await h.pi.emit({ type: "session_start" });
		if (bound === "per-message") await h.pi.emit({ type: "message_end", message: message("Coverage remains unknown. " + "Routine progress. ".repeat(1100)) });
		else for (const text of ["Coverage remains unknown. " + "Routine progress. ".repeat(500), "Routine progress. ".repeat(500)]) await h.pi.emit({ type: "message_end", message: message(text) });
		await h.pi.emit({ type: "agent_settled" }); await vi.advanceTimersByTimeAsync(0);
		expect(h.scan).toHaveBeenCalledOnce(); expect(h.scan.mock.calls[0][1].source).toContain("[Earlier assistant output omitted]");
		expect(fetch).not.toHaveBeenCalled(); expect(entries(h.pi)).toMatchObject([{ shadow: { reason: "incomplete_evidence", wouldSkip: false } }]);
	});
	it("source-count overflow forces extraction even when the visible tail is routine", async () => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const h = harness();
		await h.pi.emit({ type: "session_start" });
		for (let i = 0; i < 21; i++) await h.pi.emit({ type: "message_end", message: message("Routine progress.") });
		await h.pi.emit({ type: "agent_settled" }); await vi.advanceTimersByTimeAsync(0);
		expect(fetch).not.toHaveBeenCalled(); expect(h.scan).toHaveBeenCalledOnce(); expect(entries(h.pi)).toMatchObject([{ shadow: { reason: "incomplete_evidence", wouldSkip: false } }]);
	});
});
