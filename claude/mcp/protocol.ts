/**
 * A minimal MCP server over stdio: JSON-RPC 2.0, one message per line.
 *
 * Implements what Claude Code uses from a tool server — `initialize` (with
 * protocol-version negotiation), `notifications/initialized`, `ping`,
 * `tools/list`, `tools/call`, and `notifications/cancelled` for an in-flight
 * call. Requests are served concurrently (a subagent call can run for many
 * minutes, and a ping must still answer); responses go out as they finish.
 * stdout carries protocol only — every log line goes to stderr.
 */

import { createInterface } from "node:readline";

/** Newest first. A client asking for one of these gets it back; anything else gets the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface ToolResult {
	text: string;
	isError?: boolean;
}

export interface ToolServer {
	name: string;
	version: string;
	instructions?: string;
	tools(): Promise<ToolDefinition[]>;
	/** A tool's answer. Throwing reports the error as a tool error (`isError`), not a protocol error. */
	call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
	/** True when `name` is a tool this server has. */
	has(name: string): boolean;
}

type Id = string | number;

interface Request {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

export const ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
} as const;

export function negotiateVersion(requested: unknown): string {
	return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
		? requested
		: SUPPORTED_PROTOCOL_VERSIONS[0];
}

function isId(value: unknown): value is Id {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Serve `server` on `input`/`output` until the input ends. Resolves after
 * every in-flight request has answered (they are aborted first).
 */
export async function serve(
	server: ToolServer,
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	log: (line: string) => void,
	stop?: AbortSignal,
): Promise<void> {
	const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
	// A request the client cancelled gets no response at all (MCP: the
	// receiver SHOULD NOT answer it); its work is aborted.
	const cancelled = new Set<string>();
	let notifications = 0;
	const send = (message: Record<string, unknown>) => {
		output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const reply = (id: Id, result: unknown) => {
		if (!cancelled.has(String(id))) send({ id, result });
	};
	const fail = (id: Id | null, code: number, message: string) => {
		if (id === null || !cancelled.has(String(id))) send({ id, error: { code, message } });
	};

	const handle = async (request: Request, id: Id | undefined, signal: AbortSignal): Promise<void> => {
		const method = request.method;
		const params = (request.params && typeof request.params === "object" ? request.params : {}) as Record<string, unknown>;
		switch (method) {
			case "initialize":
				if (id === undefined) return;
				reply(id, {
					protocolVersion: negotiateVersion(params.protocolVersion),
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: server.name, version: server.version },
					...(server.instructions ? { instructions: server.instructions } : {}),
				});
				return;
			case "ping":
				if (id !== undefined) reply(id, {});
				return;
			case "tools/list":
				if (id !== undefined) reply(id, { tools: await server.tools() });
				return;
			case "tools/call": {
				if (id === undefined) return;
				const name = params.name;
				if (typeof name !== "string" || !server.has(name)) {
					fail(id, ERRORS.invalidParams, `Unknown tool: ${String(name)}`);
					return;
				}
				const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
				let result: ToolResult;
				try {
					result = await server.call(name, args, signal);
				} catch (error) {
					result = { text: error instanceof Error ? error.message : String(error), isError: true };
				}
				reply(id, { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
				return;
			}
			case "notifications/initialized":
				return;
			case "notifications/cancelled": {
				const target = params.requestId;
				if (isId(target) && inflight.has(String(target))) {
					cancelled.add(String(target));
					inflight.get(String(target))?.controller.abort();
				}
				return;
			}
			default:
				if (id !== undefined) fail(id, ERRORS.methodNotFound, `Method not found: ${String(method)}`);
				else if (typeof method === "string" && !method.startsWith("notifications/")) log(`hive-pi mcp: ignoring unknown notification ${method}`);
		}
	};

	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	// Told to stop (a signal, the parent gone): read no further; every
	// in-flight request is then aborted and awaited below, as at end of input.
	stop?.addEventListener("abort", () => lines.close(), { once: true });
	for await (const line of lines) {
		if (!line.trim()) continue;
		let request: Request;
		try {
			request = JSON.parse(line) as Request;
		} catch {
			fail(null, ERRORS.parse, "Parse error");
			continue;
		}
		if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
			fail(isId(request?.id) ? request.id : null, ERRORS.invalidRequest, "Invalid Request");
			continue;
		}
		const id = isId(request.id) ? request.id : undefined;
		const controller = new AbortController();
		const key = id === undefined ? `notification:${++notifications}` : String(id);
		const done = handle(request, id, controller.signal)
			.catch((error: unknown) => {
				log(`hive-pi mcp: ${String(request.method)} failed: ${error instanceof Error ? error.message : String(error)}`);
				if (id !== undefined) fail(id, ERRORS.internal, error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				inflight.delete(key);
				cancelled.delete(key);
			});
		inflight.set(key, { controller, done });
	}
	for (const { controller } of inflight.values()) controller.abort();
	await Promise.allSettled([...inflight.values()].map((entry) => entry.done));
}
