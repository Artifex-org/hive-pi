/**
 * pi's own tools, offered to Cursor (HIV-2095).
 *
 * # Why this is not just "execute them like the native ones"
 *
 * exec.ts serves Cursor's NATIVE tools (read/write/ls/grep/shell) by running
 * them here, because pi exports those implementations. Its EXTENSION tools —
 * `factory_finish`, the hive tools, advisor, anything a pi package registers —
 * are different: a provider receives their DECLARATIONS (`Tool` is
 * `{name, description, parameters}`, with no execute) and never their bodies.
 * pi keeps execution to itself deliberately, which is how the transcript, the
 * scope guard and the cost accounting stay truthful.
 *
 * So the flow inverts for these:
 *
 *   1. every pi tool is advertised to Cursor as an MCP tool definition;
 *   2. Cursor calls one, arriving as `execServerMessage.mcpArgs`;
 *   3. we do NOT execute it — the Cursor turn SUSPENDS, holding its stream, and
 *      the call goes to pi as a normal `toolCall` with stopReason "toolUse";
 *   4. pi executes it, appends the result, and calls the provider again;
 *   5. the provider answers `mcpResult` on the parked stream, and the same
 *      Cursor turn carries on where it left off.
 *
 * Steps 1-4 are the ordinary provider contract every other pi provider follows,
 * so the tool shows up in the transcript, counts toward tool-call telemetry,
 * and — for `factory_finish` — actually terminates a factory run. Step 5 is
 * what keeps Cursor's own agent loop intact across that round trip; without it
 * the model re-issues the call it thinks went unanswered (see session.ts).
 *
 * The remaining cost is latency, not correctness: a pi tool round-trips through
 * pi's loop where a native one is served locally in the bridge. That is why
 * native tools are still served locally rather than routed here.
 */

/** The slice of pi's Tool declaration that Cursor needs. */
export interface PiToolDecl {
	name: string;
	description?: string;
	parameters?: unknown;
}

/** One Cursor MCP tool definition, protobuf-JSON shaped. */
export interface McpToolDefinition {
	name: string;
	toolName: string;
	providerIdentifier: string;
	description: string;
	/**
	 * The JSON Schema, as a bare object.
	 *
	 * The field is a `google.protobuf.Struct`, which the JSON codec renders as
	 * the object itself — NOT as base64, and not as a JSON string. Cursor's own
	 * CLI gives it away: it builds the definition with `Struct.fromJson(schema)`.
	 *
	 * MEASURED, because getting this wrong is silent. Sent as base64 (of JSON
	 * text or of a serialized Struct, both tried) the tool is still advertised
	 * and still callable — the model simply never sees any PARAMETERS. It called
	 * the tool with `{}`, pi's validator rejected it, and it retried until the
	 * run timed out. Sent as a bare object the very same prompt produced
	 * `args: {"answer": "42"}` on the first call.
	 */
	inputSchema: Record<string, unknown>;
}

/**
 * Identifies our tools inside Cursor's MCP namespace.
 *
 * A constant rather than a per-session id: it appears in the model's view of
 * the tool, so a stable, meaningful name is worth more than uniqueness we do
 * not need.
 */
export const PI_MCP_PROVIDER = "pi";

/**
 * Advertise pi's tools.
 *
 * Cursor's own native tools are NOT included: it offers those itself, and
 * re-declaring them would give the model two routes to the same capability with
 * different semantics — one served locally, one bounced through pi.
 */
const NATIVE_TO_CURSOR = new Set(["read", "write", "edit", "ls", "grep", "find", "bash"]);

export function toolDefinitions(tools: PiToolDecl[] | undefined): McpToolDefinition[] {
	if (!tools?.length) return [];
	return tools
		.filter((t) => t?.name && !NATIVE_TO_CURSOR.has(t.name))
		.map((t) => ({
			name: t.name,
			toolName: t.name,
			providerIdentifier: PI_MCP_PROVIDER,
			description: t.description ?? "",
			inputSchema: (t.parameters as Record<string, unknown> | undefined) ?? {
				type: "object",
				properties: {},
			},
		}));
}

/**
 * Read `McpArgs.args`.
 *
 * The values are `google.protobuf.Value`, which the JSON codec renders as the
 * JSON value itself — a string stays a string, an object stays an object. So
 * this is a copy, not a decode.
 *
 * It is a named function rather than an inline spread because two earlier
 * versions of it were wrong in ways nothing reported: treating the values as
 * base64 turned `"42"` into a replacement character (`Buffer.from(x, "base64")`
 * never throws — it discards what it cannot map), and `String(value)` flattened
 * a structured argument into `[object Object]`. Both reached the tool as
 * plausible garbage rather than as an error.
 */
export function decodeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
	return { ...(args ?? {}) };
}

/** A pi tool call lifted out of Cursor's stream, ready to hand back to pi. */
export interface PendingPiToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Read one `mcpArgs` request into a pi tool call. */
export function toPiToolCall(mcp: Record<string, any>): PendingPiToolCall | null {
	const name = mcp?.toolName || mcp?.name;
	if (!name) return null;
	return {
		// Cursor's own call id is reused so the two transcripts line up; without
		// one, pi still needs SOMETHING stable to match the result to.
		id: mcp.toolCallId || `cursor-${name}`,
		name,
		arguments: decodeArgs(mcp.args),
	};
}
