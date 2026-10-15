/**
 * In-memory protocol prototype only. The bridge never executes a Pi tool.
 * A future provider must register stream-observed calls and let Pi run its
 * validation/guards before supplying a result. No provider imports this module.
 */
import { isDeepStrictEqual } from "node:util";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface Call {
	name: string;
	input: Record<string, unknown>;
	requested: boolean;
	completed: boolean;
	cancelled: boolean;
	result?: CallToolResult;
	resolve?: (result: CallToolResult) => void;
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** One bounded query-step fixture, not a persistent multi-turn session manager. */
export class PiToolBridge {
	readonly config: McpSdkServerConfigWithInstance;
	readonly toolNames: readonly string[];
	private readonly calls = new Map<string, Call>();
	private closed = false;
	private readonly abort: () => void;

	constructor(tools: readonly Tool[], private readonly signal: AbortSignal) {
		this.toolNames = tools.map(tool => tool.name);
		if (new Set(this.toolNames).size !== tools.length || tools.some(tool => !/^[a-zA-Z0-9_-]+$/.test(tool.name))) {
			throw new Error("Invalid Pi tool names");
		}
		const server = new McpServer({ name: "pi", version: "0.0.0" }, { capabilities: { tools: {} } });
		this.config = { type: "sdk", name: "pi", instance: server };
		server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map(tool => ({ name: tool.name, description: tool.description,
				inputSchema: { ...tool.parameters, type: "object" as const } })),
		}));
		server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			if (this.closed) return failure("Pi bridge closed");
			const id = request.params._meta?.["claudecode/toolUseId"];
			if (typeof id !== "string") return failure("Missing tool-use correlation");
			const call = this.calls.get(id);
			if (!call || call.name !== request.params.name || !isDeepStrictEqual(call.input, request.params.arguments ?? {})) {
				return failure("Unknown tool-use correlation");
			}
			if (call.requested) return failure("Duplicate MCP tool request");
			call.requested = true;
			if (extra.signal.aborted) {
				call.cancelled = true;
				return failure("MCP tool request cancelled");
			}
			if (call.result) return call.result;
			return new Promise<CallToolResult>(resolve => {
				const settle = (result: CallToolResult) => {
					extra.signal.removeEventListener("abort", cancel);
					call.resolve = undefined;
					resolve(result);
				};
				const cancel = () => {
					call.cancelled = true;
					settle(failure("MCP tool request cancelled"));
				};
				call.resolve = settle;
				extra.signal.addEventListener("abort", cancel, { once: true });
				if (extra.signal.aborted) cancel();
			});
		});
		this.abort = () => this.close();
		if (signal.aborted) this.close();
		else signal.addEventListener("abort", this.abort, { once: true });
	}

	/** Called only for tool-use IDs observed in the model's stream. */
	expectCall(id: string, name: string, input: Record<string, unknown> = {}): void {
		if (this.closed) throw new Error("Pi bridge closed");
		if (!id || id.length > 256 || /[\s\p{Cc}]/u.test(id) || !this.toolNames.includes(name)) {
			throw new Error("Invalid Pi tool call");
		}
		if (this.calls.has(id)) throw new Error("Duplicate tool-use ID");
		if (this.calls.size >= 256) throw new Error("Prototype query-step limit reached");
		this.calls.set(id, { name, input: structuredClone(input), requested: false, completed: false, cancelled: false });
	}

	get pendingCallIds(): string[] {
		return [...this.calls].filter(([, call]) => call.requested && !call.completed && !call.cancelled).map(([id]) => id);
	}

	/** A guard rejection is an ordinary error result supplied by Pi, not a tool run. */
	complete(result: Pick<ToolResultMessage, "toolCallId" | "toolName" | "content" | "isError">): void {
		if (this.closed) throw new Error("Pi bridge closed");
		const call = this.calls.get(result.toolCallId);
		if (!call || call.name !== result.toolName) throw new Error("Unknown tool-use correlation");
		if (call.cancelled) throw new Error("MCP tool request cancelled; reconcile before retrying");
		if (call.completed) throw new Error("Duplicate Pi tool result");
		const content: CallToolResult["content"] = result.content.map(item => item.type === "text"
			? { type: "text", text: item.text }
			: { type: "image", data: item.data, mimeType: item.mimeType });
		const output: CallToolResult = { content: content.length ? content : [{ type: "text", text: "(no output)" }],
			isError: result.isError };
		call.completed = true;
		call.result = output;
		call.resolve?.(output);
		call.resolve = undefined;
	}

	/** Settles parked MCP promises. Transport/process termination is separate. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.signal.removeEventListener("abort", this.abort);
		for (const call of this.calls.values()) call.resolve?.(failure("Pi bridge closed"));
		this.calls.clear();
	}
}
