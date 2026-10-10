import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import gateway from "../extensions/mcp-gateway/index.ts";
import { createFakePi } from "./fake-pi.ts";
import planExtension from "../extensions/plan/index.ts";
import { OP_MODE_STATE_CHANNEL, PLAN_MODE_STATE_CHANNEL, PLAN_CONTROL_CHANNEL, QUESTION_REMOTE_CHANNEL } from "../extensions/hive-common/channels.ts";
import { dispatchNativeMcp } from "../claude/mcp/native-gateway.ts";
import { runMcpServer } from "../claude/mcp/server.ts";
import { DEFAULT_CONTROL } from "../claude/state.ts";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

let dir: string, calls: string[], closed: number, pending: number, stall: string | undefined;
let headers: string[];
let replyContent: CallToolResult["content"];
let releaseResponse: (() => void) | undefined;
const piBin = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
function config(server: Record<string, unknown> = { url: "https://hive.invalid/mcp", headers: { Authorization: "Bearer test-header" } }) {
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { hive: server, linear: { url: "https://linear.invalid/mcp" } } }));
}
function control(mode: string) {
	mkdirSync(join(dir, "hive-pi"), { recursive: true });
	writeFileSync(join(dir, "hive-pi", "control.json"), JSON.stringify({ ...DEFAULT_CONTROL, opMode: mode }));
}
const env = () => ({ piBin, piAgentDir: dir, configDir: dir });
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gateway-")); calls = []; closed = 0; pending = 0; headers = []; stall = undefined; releaseResponse = undefined;
	replyContent = [{ type: "text", text: "live-read" }];
	config(); control("plan"); vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "DELETE") { closed++; return new Response(null, { status: 200 }); }
		if (init?.method !== "POST") return new Response(null, { status: 405 });
		headers.push(new Headers(init.headers).get("Authorization") ?? "");
		const message = JSON.parse(String(init.body));
		if (message.method === "tools/call") calls.push(message.params.name);
		if (message.method === stall) {
			pending++;
			return new Promise<Response>((resolve, reject) => {
				releaseResponse = () => {
					pending--; init.signal?.removeEventListener("abort", abort);
					resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: replyContent } }), { headers: { "Content-Type": "application/json" } }));
				};
				const abort = () => { pending--; reject(new DOMException("aborted", "AbortError")); };
				if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (message.id === undefined) return new Response(null, { status: 202 });
		const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
			: message.method === "tools/list" ? { tools: ["get_run", "get-run", "get_issue", "steer_agent", "trigger_run"].map(name => ({ name, inputSchema: { type: "object" } })) }
			: { content: replyContent };
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "fixture" } });
	});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function piGateway(mode = "plan", trusted = false) {
	const pi = createFakePi(); gateway(pi.api); pi.api.events.emit(OP_MODE_STATE_CHANNEL, { mode });
	const ctx = { cwd: dir, isProjectTrusted: () => trusted, modelRegistry: { getApiKeyForProvider: async () => "provider-fixture" } } as unknown as ExtensionToolContext;
	const tool = pi.tools.find(tool => tool.name === "mcp")!.definition as unknown as ToolDefinition;
	return { pi, execute: (input: Record<string, unknown>, signal?: AbortSignal) => tool.execute("id", input, signal, undefined, ctx) };
}
it("shipped Pi registration calls exact raw names, not the sanitized mutating collider", async () => {
	const { execute } = piGateway();
	expect(await execute({ tool: "mcp__hive__get_run" })).not.toHaveProperty("isError", true);
	expect(await execute({ tool: "linear_get_issue" })).not.toHaveProperty("isError", true);
	expect(calls).toEqual(["get_run", "get_issue"]); expect(closed).toBe(2);
	expect(await execute({ tool: "hive_get-run" })).toHaveProperty("isError", true);
	expect(await execute({ tool: "hive_get_run", server: "hive_get" })).toHaveProperty("isError", true);
	expect(calls).toEqual(["get_run", "get_issue"]);
});
it("shipped Pi gateway enforces mode changes and retains fixed coordination", async () => {
	const { execute, pi } = piGateway("discuss");
	expect(await execute({ tool: "hive_steer_agent" })).toHaveProperty("isError", true);
	pi.api.events.emit(OP_MODE_STATE_CHANNEL, { mode: "orchestrate" });
	expect(await execute({ tool: "mcp__hive__steer_agent" })).not.toHaveProperty("isError", true);
	expect(calls).toEqual(["steer_agent"]);
});
it("uses native provider-token authentication in Pi", async () => {
	config({ url: "https://hive.invalid/mcp", auth: { provider: "fixture" } });
	expect(await piGateway().execute({ tool: "hive_get_run" })).not.toHaveProperty("isError", true);
	expect(headers.length).toBeGreaterThan(0); expect(headers.every(header => header === "Bearer provider-fixture")).toBe(true);
});
it("honors disabled servers, refuses stdio, and ignores untrusted project overrides", async () => {
	mkdirSync(join(dir, ".pi")); writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { hive: { enabled: false } } }));
	expect(await piGateway("plan", false).execute({ tool: "hive_get_run" })).not.toHaveProperty("isError", true);
	expect(await piGateway("plan", true).execute({ tool: "hive_get_run" })).toHaveProperty("isError", true);
	config({ command: "do-not-spawn" });
	expect(await piGateway().execute({ tool: "hive_get_run" })).toHaveProperty("isError", true);
	expect(calls).toEqual(["get_run"]);
});
it("preserves hidden server/tool restrictions before authentication or dispatch", async () => {
	config({ url: "https://hive.invalid/mcp", exposure: "hidden" });
	expect(await piGateway().execute({ tool: "hive_get_run" })).toHaveProperty("isError", true);
	config({ url: "https://hive.invalid/mcp", toolExposure: { get_run: "hidden" } });
	expect(await piGateway().execute({ tool: "hive_get_run" })).toHaveProperty("isError", true);
	expect(await dispatchNativeMcp(env(), dir, { tool: "hive_get_run" }, new AbortController().signal)).toHaveProperty("isError", true);
	expect(headers).toEqual([]); expect(calls).toEqual([]);
});
it.each(["initialize", "tools/call"])("cancels %s and closes the owned HTTP transport", async method => {
	stall = method; const controller = new AbortController();
	const result = piGateway().execute({ tool: "hive_get_run" }, controller.signal);
	await vi.waitFor(() => expect(pending).toBe(1)); controller.abort();
	expect(await result).toHaveProperty("isError", true); expect(pending).toBe(0);
});
it("the shipped Claude tools/list and tools/call dispatch through the leased native transport", async () => {
	const input = new PassThrough(), output = new PassThrough(); let lines = "";
	output.on("data", chunk => { lines += chunk.toString(); });
	const serving = runMcpServer(env(), input, output, () => {});
	const request = (id: number, method: string, params: unknown = {}) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	request(1, "tools/list");
	await vi.waitFor(() => expect(lines).toContain('"name":"mcp"'));
	request(2, "tools/call", { name: "mcp", arguments: { tool: "mcp__hive__get_run" } });
	await vi.waitFor(() => expect(calls).toEqual(["get_run"]));
	await vi.waitFor(() => expect(lines).toContain("live-read"));
	input.end(); await serving; expect(closed).toBe(1);
});
it("Claude validates its actual mode and never falls back to a machine store", async () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "machine-store"));
	expect(await dispatchNativeMcp(env(), dir, { tool: "linear_get_issue" }, new AbortController().signal)).not.toHaveProperty("isError", true);
	expect(existsSync(join(dir, "machine-store"))).toBe(false);
	expect(await dispatchNativeMcp({ piBin }, dir, { tool: "hive_get_run" }, new AbortController().signal)).toHaveProperty("isError", true);
	control("orchestrate");
	expect(await dispatchNativeMcp(env(), dir, { tool: "hive_steer_agent" }, new AbortController().signal)).not.toHaveProperty("isError", true);
	expect(calls).toEqual(["get_issue", "steer_agent"]);
});

it("cancels queued coordination when the real mode channel tightens", async () => {
	stall = "initialize";
	const { execute, pi } = piGateway("orchestrate");
	const result = execute({ tool: "hive_steer_agent" });
	await vi.waitFor(() => expect(pending).toBe(1));
	pi.api.events.emit(OP_MODE_STATE_CHANNEL, { mode: "plan" });
	expect(await result).toHaveProperty("isError", true);
	expect(calls).toEqual([]); expect(pending).toBe(0);
});
it("Claude rechecks control state after asynchronous initialization", async () => {
	control("orchestrate");
	const fetcher = globalThis.fetch;
	let release: (() => void) | undefined;
	vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (init?.method === "POST" && JSON.parse(String(init.body)).method === "initialize") await new Promise<void>(resolve => { release = resolve; });
		return fetcher(url, init);
	});
	const input = { tool: "hive_steer_agent" };
	const result = dispatchNativeMcp(env(), dir, input, new AbortController().signal);
	await vi.waitFor(() => expect(release).toBeDefined());
	input.tool = "hive_get_run"; // A safe-looking caller update cannot authorize the pinned coordination RPC.
	control("plan"); release!();
	expect(await result).toHaveProperty("isError", true); expect(calls).toEqual([]);
});
it("Claude reads leased OAuth credentials, never the machine store", async () => {
	const url = "https://linear.invalid/mcp", key = `mcp__linear|${url}`;
	const state = (token: string) => JSON.stringify({ [key]: { serverUrl: url, tokens: { access_token: token, token_type: "Bearer" }, tokensExpireAt: Date.now() + 3_600_000 } });
	writeFileSync(join(dir, "mcp-auth.json"), state("lease-fixture"));
	const machine = join(dir, "machine"); mkdirSync(machine);
	writeFileSync(join(machine, "mcp-auth.json"), state("machine-fixture"));
	vi.stubEnv("PI_CODING_AGENT_DIR", machine);
	expect(await dispatchNativeMcp(env(), dir, { tool: "linear_get_issue" }, new AbortController().signal)).not.toHaveProperty("isError", true);
	expect(headers.length).toBeGreaterThan(0);
	expect(headers.every(header => header === "Bearer lease-fixture")).toBe(true);
	expect(calls).toEqual(["get_issue"]);
});

it("Claude forbids coordination retries after posture tightens during OAuth refresh", async () => {
	control("orchestrate"); config({ url: "https://hive.invalid/mcp", oauth: { authServerMetadataUrl: "https://oauth.invalid/metadata" } });
	const url = "https://hive.invalid/mcp";
	writeFileSync(join(dir, "mcp-auth.json"), JSON.stringify({ [`mcp__hive|${url}`]: {
		serverUrl: url, clientInformation: { client_id: "fixture" },
		tokens: { access_token: "old", refresh_token: "refresh-fixture", token_type: "Bearer" }, tokensExpireAt: Date.now() + 3_600_000,
	} }));
	const fetcher = globalThis.fetch; let attempts = 0, release: (() => void) | undefined;
	vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const address = String(url);
		const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
		if (address === "https://oauth.invalid/token") {
			await new Promise<void>(resolve => { release = resolve; });
			return json({ access_token: "fresh-lease-token", refresh_token: "fresh-refresh", token_type: "Bearer", expires_in: 3600 });
		}
		if (address === "https://oauth.invalid/metadata") return json({ issuer: "https://oauth.invalid", authorization_endpoint: "https://oauth.invalid/auth", token_endpoint: "https://oauth.invalid/token", response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"] });
		if (address.includes(".well-known/oauth-protected-resource")) return json({ resource: "https://hive.invalid/mcp", authorization_servers: ["https://oauth.invalid"] });
		if (init?.method === "POST" && JSON.parse(String(init.body)).method === "tools/call") {
			attempts++; return new Response("expired", { status: 401 });
		}
		return fetcher(url, init);
	});
	const result = dispatchNativeMcp(env(), dir, { tool: "hive_steer_agent" }, new AbortController().signal);
	await vi.waitFor(() => expect(release).toBeDefined());
	control("plan"); release!();
	expect(await result).toHaveProperty("isError", true);
	expect(attempts).toBe(1); expect(calls).toEqual([]);
	expect(readFileSync(join(dir, "mcp-auth.json"), "utf8")).toContain("fresh-lease-token");
});
it("real build-mode plan_ready cancels already queued coordination before approval", async () => {
	vi.stubEnv("HIVE_LAUNCH_ID", "11111111-2222-3333-4444-555555555555");
	const { pi, execute } = piGateway("build"); planExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "new" });
	pi.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });
	const ctx = {
		cwd: dir, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
		ui: { confirm: async () => true, select: async () => undefined, notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionToolContext;
	const tool = (name: string) => pi.tools.find(tool => tool.name === name)!.definition as unknown as ToolDefinition;
	await tool("plan_write").execute("write", { ops: [{ op: "header", title: "Queue", goal: "Approval is a hard gate" }, { op: "upsert", id: "steps", block: { type: "steps", steps: [{ title: "wire" }, { title: "test" }] } }] }, undefined, undefined, ctx);
	stall = "initialize"; const queued = execute({ tool: "hive_steer_agent" });
	await vi.waitFor(() => expect(pending).toBe(1));
	const approval = tool("plan_ready").execute("ready", {}, undefined, undefined, ctx);
	await Promise.resolve();
	expect(await queued).toHaveProperty("isError", true); expect(calls).toEqual([]);
	pi.api.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" }); await approval;
});

it.each(["build", "bugfix"])("preserves unrestricted %s MCP dispatch in both shipped gateways", async mode => {
	control(mode);
	expect(await piGateway(mode).execute({ tool: "hive_trigger_run" })).not.toHaveProperty("isError", true);
	expect(await dispatchNativeMcp(env(), dir, { tool: "mcp__hive__trigger_run" }, new AbortController().signal)).not.toHaveProperty("isError", true);
	expect(calls).toEqual(["trigger_run", "trigger_run"]);
	control("plan");
	expect(await dispatchNativeMcp(env(), dir, { tool: "hive_trigger_run" }, new AbortController().signal)).toHaveProperty("isError", true);
	expect(calls).toHaveLength(2);
});
it("rejects unsupported discovery and UI envelopes through the shipped registration", async () => {
	for (const input of [{ search: "hive", includeSchemas: true }, { action: "ui-messages" }, {}]) {
		expect(await piGateway().execute(input)).toHaveProperty("isError", true);
		expect(await dispatchNativeMcp(env(), dir, input, new AbortController().signal)).toHaveProperty("isError", true);
	}
	expect(calls).toEqual([]); expect(headers).toEqual([]);
});
it("requires an explicit server for ambiguous unrestricted raw boundaries", async () => {
	const data = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
	data.mcpServers.hive_get = { url: "https://collider.invalid/mcp" };
	writeFileSync(join(dir, "mcp.json"), JSON.stringify(data));
	const { execute } = piGateway("build");
	expect(await execute({ tool: "hive_get_run" })).toHaveProperty("isError", true);
	expect(calls).toEqual([]);
	expect(await execute({ tool: "hive_get_run", server: "hive" })).not.toHaveProperty("isError", true);
	expect(calls).toEqual(["get_run"]);
});

it("preserves embedded resources, text blobs and links through Claude stdio framing", async () => {
	replyContent = [
		{ type: "resource", resource: { uri: "report://42", text: "Diagnostic evidence" } },
		{ type: "resource", resource: { uri: "report://43", mimeType: "text/plain", blob: Buffer.from("Blob evidence").toString("base64") } },
		{ type: "resource_link", uri: "report://44", name: "Follow-up", description: "More evidence" },
	];
	const input = new PassThrough(), output = new PassThrough(); let lines = "";
	output.on("data", chunk => { lines += chunk; });
	const serving = runMcpServer({ ...env(), configDir: dir }, input, output, () => {});
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mcp", arguments: { tool: "hive_get_run" } } })}\n`);
	await vi.waitFor(() => expect(lines).toContain("Diagnostic evidence"));
	expect(lines).toContain("Blob evidence"); expect(lines).toContain("report://44"); expect(lines).toContain("More evidence");
	input.end(); await serving;
});

it.each([
	["build", "bugfix", "hive_trigger_run"],
	["plan", "build", "hive_get_run"],
	["orchestrate", "plan", "hive_get_run"],
])("preserves still-authorized delayed responses across %s to %s", async (from, to, tool) => {
	const { pi, execute } = piGateway(from);
	if (from === "plan") pi.api.events.emit(PLAN_MODE_STATE_CHANNEL, { active: true, readOnly: true });
	stall = "tools/call"; const result = execute({ tool });
	await vi.waitFor(() => expect(pending).toBe(1));
	pi.api.events.emit(OP_MODE_STATE_CHANNEL, { mode: to });
	if (from === "plan") pi.api.events.emit(PLAN_MODE_STATE_CHANNEL, { active: false, readOnly: false });
	expect(pending).toBe(1);
	releaseResponse!();
	expect(await result).not.toHaveProperty("isError", true);
	expect(calls).toEqual([tool.slice("hive_".length)]); expect(pending).toBe(0);
});
