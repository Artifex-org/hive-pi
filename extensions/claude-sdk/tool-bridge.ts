/** In-process MCP bridge: correlated calls park; only Pi executes tools. */
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

/** One bounded SDK query. Lifecycle and canonical transcript ownership live in the provider. */
export class PiToolBridge {
	readonly config: McpSdkServerConfigWithInstance;
	readonly toolNames: readonly string[];
	private readonly calls = new Map<string, Call>();
	private readonly registrations = new Map<string, Set<() => void>>();
	private readonly failedRegistrations = new Set<string>();
	private closed = false;
	private readonly abort: () => void;

	constructor(tools: readonly Tool[], private readonly signal: AbortSignal, private readonly registrationTimeout = 0) {
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
			if (typeof id !== "string" || !id || id.length > 256 || /[\s\p{Cc}]/u.test(id)) {
				// No trustworthy ID exists to tombstone: reject the entire query before replying.
				this.close();
				return failure("Missing tool-use correlation");
			}
			if (this.failedRegistrations.has(id)) return failure("Failed tool-use registration");
			if (this.registrations.has(id)) return failure("Duplicate MCP tool request");
			if (!this.calls.has(id) && this.registrationTimeout > 0) await this.waitForRegistration(id, extra.signal);
			if (this.closed || this.failedRegistrations.has(id)) return failure("Failed tool-use registration");
			const call = this.calls.get(id);
			if (!call || call.name !== request.params.name || !isDeepStrictEqual(call.input, request.params.arguments ?? {})) {
				this.failRegistration(id);
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
		if (this.failedRegistrations.has(id)) throw new Error("Failed tool-use registration; reconcile before retrying");
		if (this.calls.has(id)) throw new Error("Duplicate tool-use ID");
		if (!this.registrations.has(id) && this.calls.size + this.failedRegistrations.size + this.registrations.size >= 256) {
			this.close(); throw new Error("SDK query tool-call limit reached");
		}
		this.calls.set(id, { name, input: structuredClone(input), requested: false, completed: false, cancelled: false });
		for (const ready of this.registrations.get(id) ?? []) ready();
	}

	/** SDK MCP dispatch can overtake an awaited Pi stream observer; never execute or trust it early. */
	private async waitForRegistration(id: string, signal: AbortSignal): Promise<void> {
		if (signal.aborted || this.closed) { this.failRegistration(id); return; }
		if (this.calls.size + this.failedRegistrations.size + this.registrations.size >= 256) { this.close(); return; }
		await new Promise<void>(resolve => {
			const ready = () => {
				if (!this.calls.has(id) || signal.aborted) this.failRegistration(id);
				clearTimeout(timer); signal.removeEventListener("abort", ready);
				const waiting = this.registrations.get(id); waiting?.delete(ready);
				if (!waiting?.size) this.registrations.delete(id); resolve(); };
			const timer = setTimeout(ready, this.registrationTimeout);
			const waiting = this.registrations.get(id) ?? new Set(); waiting.add(ready); this.registrations.set(id, waiting);
			signal.addEventListener("abort", ready, { once: true });
			if (this.calls.has(id) || signal.aborted || this.closed) ready();
		});
	}

	private failRegistration(id: string): void {
		if (this.closed) return;
		if (!this.failedRegistrations.has(id) && this.calls.size + this.failedRegistrations.size >= 256) {
			this.close(); return;
		}
		this.failedRegistrations.add(id);
		const call = this.calls.get(id);
		if (call) {
			call.cancelled = true;
			call.resolve?.(failure("Failed tool-use registration"));
		}
	}

	/** Recheck after observers yield: MCP cancellation can settle a registered call before handoff. */
	validateBatch(ids: readonly string[]): void {
		if (this.closed) throw new Error("Pi bridge closed");
		for (const id of ids) {
			const call = this.calls.get(id);
			if (!call || call.cancelled || call.completed || this.failedRegistrations.has(id)) {
				throw new Error("Invalid or cancelled MCP tool batch; reconcile before retrying");
			}
		}
	}

	/** Open, and no tool call was ever observed, requested or refused on this query. */
	get idle(): boolean {
		return !this.closed && this.calls.size === 0 && this.registrations.size === 0 && this.failedRegistrations.size === 0;
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
		for (const waiting of this.registrations.values()) for (const ready of waiting) ready();
		this.registrations.clear(); this.calls.clear(); this.failedRegistrations.clear();
	}
}
