/**
 * Non-serving compatibility contract. No credential acquisition, query(), file
 * writes or provider registration. See docs/claude-sdk-compatibility.md.
 */
import { isAbsolute } from "node:path";
import type { McpSdkServerConfigWithInstance, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export const CREDENTIAL_PROVIDER = "anthropic";
export const SDK_VERSION = "0.3.289";

/** Shape already served by Hive's access-only Claude route, not a Pi auth store. */
export interface AccessLease {
	access_token: string;
	expires_at: string;
	credential: string;
	slot: string;
}

/** Validates shape/expiry only. This does NOT authenticate a Hive caller/account. */
export function accessLease(value: unknown, now: number): AccessLease {
	const bad = () => new Error("Invalid access-only Claude lease");
	if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isFinite(now)) throw bad();
	const doc = value as Record<string, unknown>;
	const keys = ["access_token", "expires_at", "credential", "slot"];
	if (Object.keys(doc).length !== keys.length || Object.keys(doc).some(key => !keys.includes(key))) throw bad();
	for (const key of keys) {
		const text = doc[key];
		const max = key === "access_token" ? 16_384 : 128;
		if (typeof text !== "string" || !text || text.length > max || text.trim() !== text || /[\s\p{Cc}]/u.test(text)) throw bad();
	}
	const expires = Date.parse(doc.expires_at as string);
	// A conservative offline acceptance bound, not an upstream lifetime claim.
	if (!Number.isFinite(expires) || expires <= now || expires - now > 24 * 60 * 60_000) throw bad();
	return { access_token: doc.access_token as string, expires_at: doc.expires_at as string,
		credential: doc.credential as string, slot: doc.slot as string };
}

export interface IsolatedRequest {
	executablePath: string;
	cwd: string;
	privateRoot: string;
	model: string;
	systemPrompt: string;
	lease: unknown;
	now: number;
	abortController: AbortController;
	/** Only the in-process Pi bridge is accepted, never a filesystem/remote MCP. */
	bridge: McpSdkServerConfigWithInstance;
	toolNames: readonly string[];
}

/**
 * Builds actual pinned SDK Options without starting the SDK. Callers would have
 * to provision/authorize privateRoot and the executable separately. No ambient
 * login, gateway or API key is consulted. Token-bearing options must not be logged.
 */
export function isolatedOptions(request: IsolatedRequest): Options {
	const { executablePath, cwd, privateRoot, abortController, bridge } = request;
	if (![executablePath, cwd, privateRoot].every(path => isAbsolute(path))) {
		throw new Error("Absolute trusted runtime paths required");
	}
	if (bridge.type !== "sdk" || bridge.name !== "pi") throw new Error("Only the in-process Pi bridge is supported");
	if (request.toolNames.some(name => !/^[a-zA-Z0-9_-]+$/.test(name)) ||
		new Set(request.toolNames).size !== request.toolNames.length) throw new Error("Invalid Pi tool names");
	if (!request.model.trim()) throw new Error("Claude model required");
	const lease = accessLease(request.lease, request.now);
	return {
		pathToClaudeCodeExecutable: executablePath,
		cwd,
		abortController,
		model: request.model,
		systemPrompt: request.systemPrompt,
		verbatimPrompts: true,
		includePartialMessages: true,
		persistSession: false,
		tools: [],
		allowedTools: request.toolNames.map(name => "mcp__pi__" + name),
		mcpServers: { pi: bridge },
		strictMcpConfig: true,
		permissionMode: "default",
		canUseTool: async () => ({ behavior: "deny", message: "Only Pi-checked MCP tools are available" }),
		settingSources: [],
		settings: { disableAllHooks: true, autoMemoryEnabled: false },
		skills: [],
		plugins: [],
		additionalDirectories: [],
		env: {
			// SDK .289 replaces, rather than merges, a supplied environment.
			PATH: "/usr/bin:/bin",
			HOME: privateRoot,
			XDG_CONFIG_HOME: privateRoot,
			CLAUDE_CONFIG_DIR: privateRoot,
			CLAUDE_CODE_OAUTH_TOKEN: lease.access_token,
			CLAUDE_AGENT_SDK_CLIENT_APP: "hive-pi/claude-sdk-compatibility",
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_TELEMETRY: "1",
			DISABLE_ERROR_REPORTING: "1",
		},
	};
}

/** No slash-command or @file expansion; Pi already composed this message. */
export function literalUserMessage(text: string): SDKUserMessage {
	return { type: "user", message: { role: "user", content: text },
		parent_tool_use_id: null, client_composed: true };
}
