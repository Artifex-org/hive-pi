import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { OP_MODE_CONTROL_CHANNEL } from "../extensions/hive-common/channels.ts";
import { registerModeRequestTool } from "../extensions/hive-remote/mode-request.ts";
import opmode from "../extensions/opmode/index.ts";
import plan from "../extensions/plan/index.ts";
import { createFakePi, scopedExtensionApi } from "./fake-pi.ts";

const auth = { url: "https://hive.example", token: "test-token" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(options: { enabled?: boolean; attached?: boolean; start?: string; waitMs?: number; enforce?: boolean } = {}) {
	const pi = createFakePi();
	let session = options.attached === false ? null : "session-1";
	let queued = false;
	registerModeRequestTool(pi.api, {
		enabled: options.enabled ?? true, getAuth: () => auth, getSessionID: () => session,
		pollMs: 1, waitMs: options.waitMs ?? 1000,
	});
	pi.api.registerTool({ name: "edit", label: "edit", description: "edit", parameters: {}, execute: async () => ({ content: [], details: {} }) } as never);
	if (options.enforce !== false) {
		opmode(scopedExtensionApi(pi));
		plan(scopedExtensionApi(pi));
	}
	pi.flags.set("op-mode", options.start ?? "discuss");
	await pi.emit({ type: "session_start", reason: "startup" });
	const definition = pi.tools.find(t => t.name === "request_mode")!.definition;
	const execute = definition.execute as (id: string, args: unknown, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: { text: string }[] }>;
	const ctx = { hasPendingMessages: () => queued } as ExtensionContext;
	let sequence = 0;
	return {
		pi,
		run: async (mode = "build", signal?: AbortSignal, reason = "Implement the requested change") => (await execute(`call-${++sequence}`, { mode, reason }, signal, undefined, ctx)).content[0].text,
		replace: () => { session = "session-2"; }, queue: () => { queued = true; },
	};
}

function server(options: {
	verdict?: string; creationVerdict?: string; mutate?: (row: Record<string, unknown>) => void;
	onPoll?: () => void | Promise<void>; onCatalog?: (count: number) => void; unavailable?: boolean; failed?: boolean;
	stall?: "poll" | "cleanup";
} = {}) {
	let row: Record<string, unknown> = {};
	let catalogs = 0;
	const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		const body = init.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method: init.method!, url, body });
		if (url.endsWith("/agent-op-modes")) {
			options.onCatalog?.(++catalogs);
			return json({ modes: options.unavailable ? [] : ["build", "plan", "discuss", "bugfix", "orchestrate"].map(key => ({ key })) });
		}
		if (url.endsWith("/approvals")) {
			row = { ...body, session_id: "session-1", verdict: options.creationVerdict ?? "pending", expires_at: new Date(Date.now() + 60_000).toISOString() };
			return json(row);
		}
		const cleanup = url.endsWith("/decide");
		if ((cleanup && options.stall === "cleanup") || (!cleanup && options.stall === "poll")) {
			return new Response(new ReadableStream({ start(controller) {
				init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
			} }));
		}
		if (cleanup) return json({}, 409);
		await options.onPoll?.();
		if (options.failed) return json({ error: "forbidden" }, 403);
		const polled = { ...row, verdict: options.verdict ?? "approve", decided_by: "human-owner" };
		options.mutate?.(polled);
		return json(polled);
	}));
	return calls;
}

it.each(["build", "orchestrate", "plan", "bugfix"])("requests human consent from discuss and actually enforces %s", async target => {
	const fixture = await setup();
	const calls = server();
	const before = await fixture.pi.emit({ type: "tool_call", toolName: "edit", input: {} });
	expect(before.some(v => (v as { block?: boolean })?.block)).toBe(true);
	const allowed = await fixture.pi.emit({ type: "tool_call", toolName: "request_mode", input: { mode: target, reason: "implement" } });
	expect(allowed.some(v => (v as { block?: boolean })?.block)).toBe(false);
	expect(await fixture.run(target)).toContain(`switched from discuss to ${target}`);
	const posted = calls.find(c => c.url.endsWith("/approvals"))!.body;
	expect(posted.tool_name).toBe("request_mode");
	expect(JSON.parse(String(posted.tool_args))).toMatchObject({ from_mode: "discuss", mode: target, reason: "Implement the requested change", enforces: expect.any(String) });
	const after = await fixture.pi.emit({ type: "tool_call", toolName: "edit", input: {} });
	expect(after.some(v => (v as { block?: boolean })?.block)).toBe(target !== "build");
});

it.each(["plan", "orchestrate", "bugfix"])("keeps the consent tool callable in %s", async start => {
	const { pi, run } = await setup({ start });
	server();
	const verdicts = await pi.emit({ type: "tool_call", toolName: "request_mode", input: { mode: "build", reason: "implement" } });
	expect(verdicts.some(v => (v as { block?: boolean })?.block)).toBe(false);
	expect(await run()).toContain(`switched from ${start} to build`);
	expect(pi.api.getActiveTools()).toContain("edit");
});

it.each(["deny", "expired", "answered_locally", "auto"])("never switches on %s", async verdict => {
	const { pi, run } = await setup();
	server({ verdict });
	expect(await run()).toContain("Mode unchanged");
	expect(pi.busEvents.filter(e => e.name === OP_MODE_CONTROL_CHANNEL)).toHaveLength(0);
});

it.each(["session_id", "client_call_id", "tool_name", "tool_args", "expires_at", "decided_by"])("rejects an invalid approval %s", async field => {
	const { pi, run } = await setup();
	server({ mutate: row => { row[field] = field === "decided_by" ? undefined : "wrong"; } });
	expect(await run()).toContain("Mode unchanged");
	expect(pi.busEvents.filter(e => e.name === OP_MODE_CONTROL_CHANNEL)).toHaveLength(0);
});

it("rejects an approval for a different target", async () => {
	const { run } = await setup();
	server({ mutate: row => { row.tool_args = JSON.stringify({ from_mode: "discuss", mode: "orchestrate" }); } });
	expect(await run()).toContain("Mode unchanged");
});

it.each(["mode", "roundtrip", "noop", "session", "message", "interrupt"])("does not override an intervening %s", async change => {
	const fixture = await setup();
	const abort = new AbortController();
	server({ onPoll: async () => {
		if (change === "mode") await fixture.pi.runCommand("mode", "orchestrate");
		if (change === "roundtrip") { await fixture.pi.runCommand("mode", "build"); await fixture.pi.runCommand("mode", "discuss"); }
		if (change === "noop") fixture.pi.api.events.emit(OP_MODE_CONTROL_CHANNEL, { mode: "discuss" });
		if (change === "session") fixture.replace();
		if (change === "message") fixture.queue();
		if (change === "interrupt") abort.abort();
	} });
	expect(await fixture.run("build", abort.signal)).toContain("Mode unchanged");
	expect(fixture.pi.busEvents.filter(e => e.name === OP_MODE_CONTROL_CHANNEL && (e.payload as { mode: string }).mode === "build")).toHaveLength(0);
});

it.each([{ enabled: false }, { attached: false }, { enforce: false }])("fails closed when unavailable: %j", async options => {
	const { run } = await setup(options);
	const calls = server();
	expect(await run()).toContain("Mode unchanged");
	expect(calls).toHaveLength(0);
});

it("rejects modes not offered by the server", async () => {
	const { run } = await setup();
	const calls = server({ unavailable: true });
	expect(await run("orchestrate")).toContain("Mode unchanged");
	expect(calls.some(c => c.url.endsWith("/approvals"))).toBe(false);
});

it.each(["security-audit", "BUILD", ""])("rejects unknown mode %j", async mode => {
	const { run } = await setup();
	const calls = server();
	expect(await run(mode)).toContain("Mode unchanged");
	expect(calls).toHaveLength(0);
});

it("rejects blank reasons and already active modes without a request", async () => {
	const { run } = await setup();
	const calls = server();
	expect(await run("build", undefined, "   ")).toContain("Mode unchanged");
	expect(await run("discuss")).toContain("Already in discuss");
	expect(calls).toHaveLength(0);
});

it("rechecks server expiry after the final catalog request", async () => {
	let clock = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	const { pi, run } = await setup({ waitMs: 10_000 });
	server({
		mutate: row => { row.expires_at = new Date(clock + 1000).toISOString(); },
		onCatalog: count => { if (count === 2) clock += 2000; },
	});
	expect(await run()).toContain("Mode unchanged");
	expect(pi.busEvents.filter(e => e.name === OP_MODE_CONTROL_CHANNEL)).toHaveLength(0);
});

it("never replays an already approved invocation", async () => {
	const { run } = await setup();
	server({ creationVerdict: "approve" });
	expect(await run()).toContain("Mode unchanged");
});

it("fails closed on HTTP failure and retires unanswered cards", async () => {
	const { run } = await setup();
	const calls = server({ failed: true });
	expect(await run()).toContain("Mode unchanged");
	expect(calls.at(-1)).toMatchObject({ method: "POST", body: { verdict: "answered_locally" } });
});

it.each(["cancel", "deadline", "cleanup"] as const)("bounds stalled bodies on %s and releases the request latch", async kind => {
	const { run } = await setup({ waitMs: 1000 });
	const abort = new AbortController();
	server({ stall: kind === "cleanup" ? "cleanup" : "poll", verdict: "deny" });
	const pending = run("build", abort.signal);
	if (kind === "cancel") setTimeout(() => abort.abort(), 10);
	expect(await pending).toContain("Mode unchanged");
	server();
	expect(await run()).toContain("switched from discuss to build");
});

it("bounds pending waits and refuses concurrent requests", async () => {
	const { run } = await setup({ waitMs: 15 });
	server({ verdict: "pending" });
	const pending = run();
	expect(await run()).toContain("already waiting");
	expect(await pending).toContain("Mode unchanged");
});
