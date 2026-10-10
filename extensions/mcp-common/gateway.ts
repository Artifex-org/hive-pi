import { join } from "node:path";
import type * as NativeMcp from "@earendil-works/pi-mcp";
import type { McpTransport, CallToolResult } from "@earendil-works/pi-mcp";
import type * as NativeConfig from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import type * as NativeRuntime from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js";
import type * as NativeTools from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import type * as NativeAuth from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { classifyTool, classifyDiscussionTool, classifyOrchestrateTool } from "../plan/policy.ts";
import type { OpMode } from "../opmode/modes.ts";

/** The pinned native implementation owns config validation and OAuth refresh. */
export interface GatewayRuntime {
	config: typeof NativeConfig;
	runtime: typeof NativeRuntime;
	auth: typeof NativeAuth;
	tools: typeof NativeTools;
}

export async function loadGatewayRuntime(entry: string): Promise<GatewayRuntime> {
	const [config, runtime, auth, tools] = await Promise.all([
		import(new URL("extensions/mcp/config.js", entry).href),
		import(new URL("extensions/mcp/runtime.js", entry).href),
		import(new URL("core/auth-storage.js", entry).href),
		import(new URL("extensions/mcp/tools.js", entry).href),
	]);
	return { config, runtime, auth, tools };
}

export interface GatewayContext {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	mode: OpMode;
	currentMode?: () => OpMode;
	signal?: AbortSignal;
	providerToken?: (provider: string) => Promise<string | undefined>;
}

/** Exact fixed-inventory dispatch, not lookup by a lossy registered name. */
export async function callGateway(input: Record<string, unknown>, context: GatewayContext, modules: GatewayRuntime): Promise<CallToolResult> {
	const authorize = () => {
		const mode = context.currentMode?.() ?? context.mode;
		const classify = mode === "plan" ? classifyTool : mode === "discuss" ? classifyDiscussionTool : classifyOrchestrateTool;
		const verdict = classify("mcp", input);
		if (!verdict.allowed) throw new Error(verdict.reason);
		return verdict;
	};
	const verdict = authorize();
	if (!verdict.updatedInput) throw new Error("MCP gateway requires one reviewed tool call, not discovery or authentication actions.");
	const request = verdict.updatedInput;
	if (typeof request.tool !== "string" || typeof request.server !== "string") throw new Error("Missing reviewed MCP dispatch identity.");
	if (request.args !== undefined && (!request.args || typeof request.args !== "object" || Array.isArray(request.args))) throw new Error("MCP args must be an object.");
	const rawTool = request.tool.slice(request.server.length + 1);
	const loaded = modules.config.loadMcpConfig({ agentDir: context.agentDir, cwd: context.cwd, projectTrusted: context.projectTrusted });
	if (loaded.errors.length) throw new Error(`MCP configuration errors: ${loaded.errors.join("; ")}`);
	const entry = loaded.servers.find(candidate => candidate.name === request.server);
	if (!entry || entry.config.enabled === false) throw new Error(`MCP server "${request.server}" is not configured and enabled in the trusted store.`);
	if (modules.config.getMcpToolExposure(entry.config, rawTool) === "hidden") throw new Error(`MCP tool "${request.server}/${rawTool}" is hidden in the trusted configuration.`);
	if (!("url" in entry.config)) throw new Error(`MCP server "${request.server}" uses stdio; this gateway does not spawn duplicate servers. Configure HTTP for gateway calls.`);
	if (entry.config.auth?.provider && !context.providerToken) throw new Error("Provider-token MCP auth requires the native Pi session; use OAuth or a configured header in Claude.");
	const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(context.signal ? [context.signal] : [])]);
	signal.throwIfAborted();
	const transports = new Set<McpTransport>();
	const connection = new modules.runtime.McpServerConnection({
		entry, cwd: context.cwd,
		credentials: new modules.runtime.McpOAuthCredentialStore(new modules.auth.FileAuthStorageBackend(join(context.agentDir, "mcp-auth.json")), context.agentDir),
		providerToken: context.providerToken,
		createTransport: (server, cwd, auth) => {
			signal.throwIfAborted();
			if (!("url" in server.config)) throw new Error("Gateway requires HTTP transport.");
			// The HTTP-only default factory supplies the pinned SDK class and
			// native resolved options. Its constructor does not open a connection.
			const configured = modules.runtime.createDefaultTransport(server, cwd, auth) as NativeMcp.StreamableHttpTransport;
			const Transport = configured.constructor as typeof NativeMcp.StreamableHttpTransport;
			const nativeFetch = configured.options.fetch ?? globalThis.fetch;
			const transport = new Transport({
				...configured.options,
				// Native headers/OAuth are awaited before this callback, including
				// every 401 retry. Check immediately at the actual egress boundary.
				fetch: (url, init) => {
					if (init?.method === "POST" && typeof init.body === "string" && JSON.parse(init.body).method === "tools/call") {
						signal.throwIfAborted(); authorize();
					}
					return nativeFetch(url, init);
				},
			});
			transports.add(transport);
			return transport;
		},
		onTools: () => {},
	});
	// Native close alone cannot interrupt initialization before it stores its
	// client. Own the HTTP transports too, including reconnect attempts.
	const close = async () => {
		await Promise.all([connection.close(), ...[...transports].map(transport => transport.close())]);
	};
	let abortClose: Promise<void> | undefined;
	const abort = () => { abortClose = close(); void abortClose.catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		const client = await connection.getClient();
		signal.throwIfAborted();
		authorize(); // A posture may tighten while initialization/authentication waits.
		if (!connection.tools.some(tool => tool.name === rawTool)) throw new Error(`MCP server "${request.server}" does not advertise exact raw tool "${rawTool}".`);
		return await client.callTool(rawTool, (request.args ?? {}) as Record<string, unknown>, { signal, timeoutMs: connection.timeoutMs });
	} finally {
		signal.removeEventListener("abort", abort);
		await (abortClose ?? close());
	}
}
