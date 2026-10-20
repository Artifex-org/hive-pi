/** Pinned SDK isolation contract. No credential lookup or inference in this module. */
import { isAbsolute } from "node:path";
import { getSupportedThinkingLevels, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { McpSdkServerConfigWithInstance, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkProviderError } from "./diagnostics.ts";

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
	const bad = () => new SdkProviderError("Invalid access-only Claude lease");
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

/** The HTTP proxy variables the Claude CLI honors, in both spellings. */
const EGRESS_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
/** Hosts that name this machine's own loopback: the Hive URL and the sandbox proxy. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The egress settings of this Pi process. The SDK replaces the Claude CLI's
 * environment, and inside the sandbox runtime its loopback proxy is the only
 * network path, so these are handed on; isolatedOptions validates them.
 */
export function sandboxEgressEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(EGRESS_KEYS.flatMap(key => env[key] ? [[key, env[key]!]] : []));
}

/** Only the sandbox's own loopback http(s) proxy is forwarded. Refusals name
 *  the key, never the value: it may carry the proxy's credential. */
function validatedEgress(egress: Readonly<Record<string, string>>): Record<string, string> {
	for (const [key, value] of Object.entries(egress)) {
		if (!EGRESS_KEYS.includes(key)) throw new SdkProviderError("Only proxy settings are forwarded to Claude");
		const bad = () => new SdkProviderError(`Unsupported Claude SDK egress setting ${key}: only the Hive sandbox's loopback proxy is forwarded`);
		if (typeof value !== "string" || !value || /[\s\p{Cc}]/u.test(value)) throw bad();
		if (key.toLowerCase() === "no_proxy") continue;
		const url = URL.canParse(value) ? new URL(value) : undefined;
		if (!url || !["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.includes(url.hostname) ||
			!["", "/"].includes(url.pathname) || url.search || url.hash) throw bad();
	}
	return { ...egress };
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
	/** sandboxEgressEnv output: the sandbox proxy the CLI must use to reach the network, validated here. */
	egress?: Readonly<Record<string, string>>;
}

/**
 * Builds pinned SDK Options without starting the SDK. The runtime provisions
 * privateRoot and validates the trusted executable separately. No ambient
 * login, gateway or API key is consulted. Token-bearing options must not be logged.
 */
export function isolatedOptions(request: IsolatedRequest): Options {
	const { executablePath, cwd, privateRoot, abortController, bridge } = request;
	if (![executablePath, cwd, privateRoot].every(path => isAbsolute(path))) {
		throw new SdkProviderError("Absolute trusted runtime paths required");
	}
	if (bridge.type !== "sdk" || bridge.name !== "pi") throw new SdkProviderError("Only the in-process Pi bridge is supported");
	if (request.toolNames.some(name => !/^[a-zA-Z0-9_-]+$/.test(name)) ||
		new Set(request.toolNames).size !== request.toolNames.length) throw new SdkProviderError("Invalid Pi tool names");
	if (!request.model.trim()) throw new SdkProviderError("Claude model required");
	const lease = accessLease(request.lease, request.now);
	const egress = validatedEgress(request.egress ?? {});
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
			...egress,
			PATH: "/usr/bin:/bin",
			HOME: privateRoot,
			XDG_CONFIG_HOME: privateRoot,
			CLAUDE_CONFIG_DIR: privateRoot,
			CLAUDE_CODE_OAUTH_TOKEN: lease.access_token,
			CLAUDE_AGENT_SDK_CLIENT_APP: "hive-pi/claude-sdk",
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

/** Translate catalog capabilities only; no native Anthropic transport/auth/conversion. */
export function reasoningOptions(model: Model<"anthropic-messages">, options: SimpleStreamOptions): Pick<Options, "thinking" | "effort"> {
	const supported = getSupportedThinkingLevels(model);
	const level = options.reasoning ?? (supported.includes("off") ? "off" : "high");
	if (!supported.includes(level)) throw new SdkProviderError(`Unsupported Claude SDK thinking level: ${level}`);
	const adaptive = model.compat?.forceAdaptiveThinking === true;
	if (options.thinkingBudgets && (adaptive || level === "off")) {
		throw new SdkProviderError("Claude SDK thinking budgets require budget-based reasoning");
	}
	if (level === "off") return { thinking: { type: "disabled" } };
	if (adaptive) {
		const effort = model.thinkingLevelMap?.[level] ?? (level === "minimal" ? "low" : level);
		if (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max") {
			throw new SdkProviderError("Unsupported Claude SDK effort mapping");
		}
		return { thinking: { type: "adaptive" }, effort };
	}
	const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...options.thinkingBudgets };
	if (options.thinkingBudgets && Object.entries(options.thinkingBudgets).some(([key, value]) =>
		!supported.includes(key as typeof level) || !Number.isSafeInteger(value) || value < 1024)) {
		throw new SdkProviderError("Unsupported Claude SDK thinking budget");
	}
	const budgetTokens = budgets[level as keyof typeof budgets];
	if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1024 || budgetTokens >= (options.maxTokens ?? model.maxTokens)) {
		throw new SdkProviderError("Claude SDK thinking budget must fit within the output token limit");
	}
	return { thinking: { type: "enabled", budgetTokens } };
}

/** No slash-command or @file expansion; Pi already composed this message. */
export function literalUserMessage(text: string): SDKUserMessage {
	return { type: "user", message: { role: "user", content: text },
		parent_tool_use_id: null, client_composed: true };
}
