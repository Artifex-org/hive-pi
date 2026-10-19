import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { accessLease, CREDENTIAL_PROVIDER, isolatedOptions, literalUserMessage, sandboxEgressEnv, SDK_VERSION } from "../extensions/claude-sdk/options.ts";
import { PiToolBridge } from "../extensions/claude-sdk/tool-bridge.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const synthetic = { access_token: "synthetic-access-NOT-A-REAL-CREDENTIAL",
	expires_at: "2026-10-15T13:00:00Z", credential: "claude-fixture", slot: "claude-fixture" };

afterEach(() => vi.unstubAllEnvs());

describe("access-only shape (not authorization)", () => {
	it("keeps the existing authd account shape without adding a login/provider", () => {
		expect(CREDENTIAL_PROVIDER).toBe("anthropic");
		expect(accessLease(synthetic, now)).toEqual(synthetic);
		expect(accessLease(synthetic, now)).not.toBe(synthetic);
	});
	it.each([
		null, [], { anthropic: synthetic }, { ...synthetic, refresh: "not-accepted" },
		{ ...synthetic, type: "api_key" }, { ...synthetic, access_token: "" },
		{ ...synthetic, access_token: "a b" }, { ...synthetic, access_token: "a\nvalue" },
		{ ...synthetic, access_token: "a".repeat(16_385) },
		{ ...synthetic, credential: "bad\u0000name" }, { ...synthetic, slot: " x" },
		{ ...synthetic, expires_at: "not-a-date" }, { ...synthetic, expires_at: new Date(now).toISOString() },
		{ ...synthetic, expires_at: "2026-10-17T13:00:00Z" },
	])("rejects malformed, stale or full credential documents %# without echoing secrets", value => {
		expect(() => accessLease(value, now)).toThrow("Invalid access-only Claude lease");
		try { accessLease(value, now); } catch (error) {
			expect(String(error)).not.toContain(synthetic.access_token);
		}
	});
	it("rejects an invalid validation clock", () => {
		expect(() => accessLease(synthetic, Number.NaN)).toThrow();
	});
});

describe("typed SDK options, never dispatched", () => {
	it("imports the real pinned SDK without calling query or starting Claude", async () => {
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		expect(typeof sdk.query).toBe("function");
		expect(typeof sdk.createSdkMcpServer).toBe("function");
		const pkg = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8"));
		expect(pkg.version).toBe(SDK_VERSION);
	});
	it("preserves the real prompt and isolates auth, settings and tool execution", async () => {
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK", "NODE_OPTIONS", "HIVE_TOKEN", "CLAUDE_CODE_ENTRYPOINT"]) {
			vi.stubEnv(key, "ambient-value-must-not-leak");
		}
		const abortController = new AbortController();
		const bridge = new PiToolBridge([{ name: "read", description: "Pi-owned read", parameters: Type.Object({}) }], abortController.signal);
		try {
			const prompt = "Actual Pi identity and Hive instructions\n@path /compact — unchanged.";
			const options = isolatedOptions({ executablePath: "/trusted/claude", cwd: "/worktree",
				privateRoot: "/private/session/account", model: "claude-fixture", systemPrompt: prompt,
				lease: synthetic, now, abortController, bridge: bridge.config, toolNames: bridge.toolNames });
			expect(options.systemPrompt).toBe(prompt);
			expect(options.verbatimPrompts).toBe(true);
			expect(options.persistSession).toBe(false);
			expect(options.includePartialMessages).toBe(true);
			expect(options.tools).toEqual([]);
			expect(options.allowedTools).toEqual(["mcp__pi__read"]);
			expect(options.mcpServers).toEqual({ pi: bridge.config });
			expect(options.settingSources).toEqual([]);
			expect(options.settings).toEqual({ disableAllHooks: true, autoMemoryEnabled: false });
			expect(options.plugins).toEqual([]);
			expect(options.skills).toEqual([]);
			expect(options.strictMcpConfig).toBe(true);
			expect(options.permissionMode).toBe("default");
			expect(options.env).toMatchObject({ HOME: "/private/session/account",
				CLAUDE_CONFIG_DIR: "/private/session/account", CLAUDE_CODE_OAUTH_TOKEN: synthetic.access_token,
				CLAUDE_AGENT_SDK_CLIENT_APP: "hive-pi/claude-sdk", ENABLE_CLAUDEAI_MCP_SERVERS: "0" });
			expect(Object.values(options.env ?? {})).not.toContain("ambient-value-must-not-leak");
			expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(options.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
			expect(options.env).not.toHaveProperty("HIVE_TOKEN");
			expect(options.env).not.toHaveProperty("NODE_OPTIONS");
			const denial = await options.canUseTool!("Bash", { command: "must-not-run" },
				{ signal: abortController.signal, toolUseID: "denied", requestId: "fixture-permission" });
			expect(denial).toMatchObject({ behavior: "deny" });
		} finally { bridge.close(); await bridge.config.instance.close(); }
	});
	it("requires explicit trusted absolute paths and a usable access lease", async () => {
		const controller = new AbortController();
		const bridge = new PiToolBridge([], controller.signal);
		const request = { executablePath: "/trusted/claude", cwd: "/worktree", privateRoot: "/private",
			model: "claude-fixture", systemPrompt: "unaltered", lease: synthetic, now,
			abortController: controller, bridge: bridge.config, toolNames: [] };
		try {
			for (const key of ["executablePath", "cwd", "privateRoot"]) {
				expect(() => isolatedOptions({ ...request, [key]: "relative" })).toThrow("Absolute");
			}
			expect(() => isolatedOptions({ ...request, lease: undefined })).toThrow("access-only");
			expect(() => isolatedOptions({ ...request, toolNames: ["bad.name"] })).toThrow("tool names");
		} finally { bridge.close(); await bridge.config.instance.close(); }
	});
	it("makes literal SDK messages, not command or file expansions", () => {
		const text = "/compact\n@secret-file\nUnicode: ü\n";
		const message = literalUserMessage(text);
		expect(message.message.content).toBe(text);
		expect(message.client_composed).toBe(true);
		expect(message.parent_tool_use_id).toBeNull();
	});
	it("keeps the prototype outside every declared extension resource root", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const root = resolve(new URL("..", import.meta.url).pathname);
		const prototype = resolve(root, "prototypes/claude-sdk");
		for (const path of manifest.pi.extensions as string[]) {
			const discovered = resolve(root, path);
			expect(prototype === discovered || prototype.startsWith(discovered + "/")).toBe(false);
		}
	});
});

describe("sandbox egress for the replaced CLI environment", () => {
	const proxy = "http://sandbox-user:synthetic-proxy-secret@localhost:3128";
	const request = (controller: AbortController, bridge: PiToolBridge) => ({ executablePath: "/trusted/claude", cwd: "/worktree",
		privateRoot: "/private", model: "claude-fixture", systemPrompt: "unaltered", lease: synthetic, now,
		abortController: controller, bridge: bridge.config, toolNames: [] });
	it("hands on exactly the HTTP proxy settings, in both spellings", () => {
		const env = { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
			ALL_PROXY: "socks5h://localhost:1080", NO_PROXY: "169.254.0.0/16", no_proxy: "169.254.0.0/16",
			ANTHROPIC_API_KEY: "ambient-value-must-not-leak", NODE_OPTIONS: "--require=unsafe", HIVE_TOKEN: "launch" };
		expect(Object.keys(sandboxEgressEnv(env)).sort()).toEqual(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
			"http_proxy", "https_proxy", "no_proxy"]);
		expect(sandboxEgressEnv({})).toEqual({});
	});
	it("puts the sandbox proxy into the CLI environment without overriding its fixed keys", async () => {
		const controller = new AbortController();
		const bridge = new PiToolBridge([], controller.signal);
		try {
			const options = isolatedOptions({ ...request(controller, bridge), egress: { HTTPS_PROXY: proxy, NO_PROXY: "169.254.0.0/16" } });
			expect(options.env).toMatchObject({ HTTPS_PROXY: proxy, NO_PROXY: "169.254.0.0/16", PATH: "/usr/bin:/bin",
				HOME: "/private", CLAUDE_CODE_OAUTH_TOKEN: synthetic.access_token });
		} finally { bridge.close(); await bridge.config.instance.close(); }
	});
	it.each([
		["HTTPS_PROXY", "http://proxy.corp.example:8080"],
		["HTTP_PROXY", "socks5://localhost:1080"],
		["https_proxy", "http://localhost:3128/path"],
		["http_proxy", "not a url"],
		["NO_PROXY", "a\nb"],
	])("refuses %s that is not the sandbox's loopback proxy, without echoing it", async (key, value) => {
		const controller = new AbortController();
		const bridge = new PiToolBridge([], controller.signal);
		try {
			expect(() => isolatedOptions({ ...request(controller, bridge), egress: { [key]: value } })).toThrow(new RegExp(`egress setting ${key}`));
			try { isolatedOptions({ ...request(controller, bridge), egress: { [key]: value } }); } catch (error) { expect(String(error)).not.toContain(value); }
		} finally { bridge.close(); await bridge.config.instance.close(); }
	});
	it("accepts nothing but proxy settings through egress", async () => {
		const controller = new AbortController();
		const bridge = new PiToolBridge([], controller.signal);
		try {
			const smuggled: Record<string, string>[] = [{ ANTHROPIC_BASE_URL: "http://localhost:1" }, { HTTPS_PROXY: proxy, HOME: "/elsewhere" }, { ALL_PROXY: proxy }];
			for (const egress of smuggled) {
				expect(() => isolatedOptions({ ...request(controller, bridge), egress })).toThrow("Only proxy settings");
			}
		} finally { bridge.close(); await bridge.config.instance.close(); }
	});
});
