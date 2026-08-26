/**
 * hive-common — one JSON-RPC call against Hive's MCP endpoint.
 *
 * Sibling to `request()` in `http.ts`, which is REST-only by construction: it
 * hardcodes `/api/v1` and `Accept: application/json`. `/mcp` needs neither.
 *
 * **Why the MCP endpoint rather than the REST knowledge routes.** Hive exposes
 * both (`GET /api/v1/knowledge/search` and the `knowledge_search` MCP tool), and
 * they are not equivalent:
 *
 * - The MCP handlers record provenance — `RecordSessionRefs`,
 *   `RecordSessionQuery`, `RecordRetrieval` — which is what fills the `/agents`
 *   knowledge rail (HIV-1194). **The REST routes record nothing.** Building on
 *   REST would have given subagents knowledge access while silently emptying a
 *   shipped feature, which is the exact failure class this wave exists to close.
 * - `knowledge_multi_get` has **no REST route at all**; it exists only as an MCP
 *   tool.
 * - The MCP tool contract is the one the main session already uses through the
 *   adapter, so workers and the orchestrator read the same corpus the same way.
 *
 * Hive's handler is `Stateless: true` (verified against the running server), so
 * a single POST carries a whole `tools/call` — no `initialize` handshake, no
 * `Mcp-Session-Id` round trip. That is what makes this ~100 lines instead of an
 * MCP client, and it is a property of the server: if it ever becomes stateful
 * this breaks loudly on the first call rather than degrading.
 *
 * This is NOT a replacement for `pi-mcp-adapter` (HIV-1226 keeps it). The
 * adapter carries OAuth, a keyring, session recovery and an MCP-UI host for the
 * five other servers. This carries one bearer header to one endpoint.
 */

import { redact, withTimeout, type HiveAuth } from "./http.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpCallResult {
	ok: boolean;
	/** The tool's text content, concatenated. */
	text: string;
	error?: string;
}

/**
 * Pull the JSON-RPC payload out of a streamable-HTTP response.
 *
 * The server answers SSE-framed (`event: message` / `data: {…}`) when the client
 * accepts `text/event-stream`, and plain JSON otherwise. Accepting both means
 * this keeps working if the negotiation changes; taking the LAST `data:` line
 * matters because a stream may carry progress notifications before the result.
 */
export function parseStreamableBody(body: string): unknown | null {
	const trimmed = body.trim();
	if (!trimmed) return null;
	if (!trimmed.includes("data:")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}
	const payloads: unknown[] = [];
	for (const line of trimmed.split("\n")) {
		const match = /^data:\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		try {
			payloads.push(JSON.parse(match[1]));
		} catch {
			/* a partial or non-JSON frame is not the result */
		}
	}
	// Prefer the last frame carrying a JSON-RPC result or error.
	for (let i = payloads.length - 1; i >= 0; i--) {
		const p = payloads[i] as { result?: unknown; error?: unknown } | null;
		if (p && (p.result !== undefined || p.error !== undefined)) return p;
	}
	return payloads.length > 0 ? payloads[payloads.length - 1] : null;
}

/** Flatten an MCP tool result's content blocks to text. */
export function textFromToolResult(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const p = part as { type?: unknown; text?: unknown };
			return p?.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

/**
 * Call one MCP tool. Never throws — every failure comes back as `ok:false`.
 *
 * `sessionId` becomes the `X-Hive-Session` header, which Hive's middleware turns
 * into the default for each knowledge tool's optional `session` argument. It is
 * a claim, not an identity: the server resolves it against sessions the
 * authenticated user owns, so it can only ever attribute to the caller's own
 * work. Omitting it is explicitly fine — the server treats an absent session as
 * "not attributed", not as a failed attribution.
 */
export async function callMcpTool(
	auth: HiveAuth,
	name: string,
	args: Record<string, unknown>,
	options: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<McpCallResult> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	try {
		const res = await withTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (timeoutSignal) =>
			fetch(`${auth.url}/mcp`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.token}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...(options.sessionId ? { "X-Hive-Session": options.sessionId } : {}),
				},
				body,
				signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
			}),
		);
		if (!res.ok) {
			return { ok: false, text: "", error: `hive returned ${res.status}` };
		}
		const parsed = parseStreamableBody(await res.text()) as
			| { result?: { isError?: boolean; content?: unknown }; error?: { message?: string } }
			| null;
		if (!parsed) return { ok: false, text: "", error: "unreadable response from hive" };
		if (parsed.error) return { ok: false, text: "", error: parsed.error.message || "hive rejected the call" };
		const text = textFromToolResult(parsed.result);
		// A tool-level error is still a 200 with isError — surfacing it as success
		// would hand the model an error message formatted as an answer.
		if (parsed.result?.isError) return { ok: false, text: "", error: text || "the tool reported an error" };
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: "", error: redact(err) };
	}
}
