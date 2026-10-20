/** SDK structured events -> Pi's balanced live block protocol. No HTTP fiction. */
import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Model, type Usage } from "@earendil-works/pi-ai";
import type { SDKAssistantMessageError, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { redactEvidence } from "../hive-common/redact.ts";
import type { PiToolBridge } from "./tool-bridge.ts";

export function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
/** The pinned SDK's `SDKAssistantMessageError` union; any other value is reported as "unrecognized". */
const failureCodes = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error",
	"rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens",
	"cloud_credential_error"] as const satisfies readonly SDKAssistantMessageError[];
export type FailureCode = typeof failureCodes[number] | "unrecognized";
const DETAIL_CHARS = 200;
// The CLI's synthetic API-error message: "API Error: 400 {json}" or "API Error: <text>".
const API_ERROR = /^API Error(?: \([^)\n]{0,80}\))?:\s*(?:(\d{3})\b\s*)?([\s\S]*)$/;

/**
 * The cause of an SDK API failure, sanitized for diagnostics, or undefined when
 * the frame does not carry the CLI's `API Error:` text.
 *
 * Only that shape is read: the status, and from a JSON body only
 * `error.type`/`error.message` (never `request_id` or other fields). Known
 * secrets and token shapes are redacted, URL queries and fragments dropped,
 * long opaque runs removed and the result cut to 200 characters. Any other
 * text in an error frame is not copied at all.
 */
export function sdkFailureDetail(content: unknown, secrets: readonly string[] = []): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap(block => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim();
	const match = API_ERROR.exec(text);
	if (!match) return undefined;
	let body = match[2].trim();
	if (body.startsWith("{")) {
		let parsed: unknown;
		try { parsed = JSON.parse(body); } catch { parsed = undefined; } // a truncated body stays text
		const error = (parsed as { error?: { type?: unknown; message?: unknown } } | undefined)?.error;
		// A body without a readable error.message is not copied: it may carry request_id or other fields.
		body = typeof error?.message === "string" ? `${typeof error.type === "string" ? `${error.type}: ` : ""}${error.message}` : "(unreadable error body)";
	}
	const cleaned = redactEvidence(body, secrets)
		.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
		.replace(/\breq_[A-Za-z0-9]+/g, "[ID]")
		.replace(/[A-Za-z0-9_+/=-]{32,}/g, "[REDACTED]")
		.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
	const detail = `API Error${match[1] ? ` ${match[1]}` : ""}: ${cleaned}`;
	return detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS - 1)}…` : detail;
}

/** A structured SDK assistant error: its code and a sanitized cause, never the raw SDK text. */
export class SdkAssistantFailure extends Error {
	constructor(readonly code: FailureCode, readonly detail: string | undefined) {
		super(`Claude SDK assistant failure (${code})`);
	}
}
interface Block { index: number; json: string; stopped: boolean; invalidArguments?: boolean }
export class EventConverter {
	private blocks = new Map<number, Block>();
	private currentUsage: Record<string, number> = {};
	private baseUsage = emptyUsage();
	private open = false;
	private stop = "end_turn";
	constructor(readonly output: AssistantMessage, private readonly stream: AssistantMessageEventStream,
		private readonly model: Model<string>, private readonly bridge: PiToolBridge, private readonly observedIds = new Set<string>(),
		private readonly secrets: readonly string[] = []) {}

	private usage(value: object): void {
		for (const [key, count] of Object.entries(value)) if (typeof count === "number") {
			if (!Number.isFinite(count) || count < 0) throw new Error("Invalid SDK usage counter");
			this.currentUsage[key] = count;
		}
		const creation = (value as { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation;
		if (creation?.ephemeral_1h_input_tokens !== undefined) this.currentUsage.cache_write_1h = creation.ephemeral_1h_input_tokens;
		const u = this.currentUsage;
		this.output.usage = { ...emptyUsage(), input: this.baseUsage.input + (u.input_tokens ?? 0),
			output: this.baseUsage.output + (u.output_tokens ?? 0), cacheRead: this.baseUsage.cacheRead + (u.cache_read_input_tokens ?? 0),
			cacheWrite: this.baseUsage.cacheWrite + (u.cache_creation_input_tokens ?? 0) };
		const usage = this.output.usage;
		if (u.cache_write_1h !== undefined || this.baseUsage.cacheWrite1h !== undefined) usage.cacheWrite1h = (this.baseUsage.cacheWrite1h ?? 0) + (u.cache_write_1h ?? 0);
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		calculateCost(this.model, usage);
	}
	/** Returns true at a complete model tool batch; SDK is then left parked. */
	consume(message: SDKMessage): "continue" | "tools" | "done" {
		if ("parent_tool_use_id" in message && message.parent_tool_use_id) throw new Error("Unexpected SDK subagent output");
		if (message.type === "system" && message.subtype === "compact_boundary") throw new Error("SDK compaction is forbidden; Pi owns history");
		if (message.type === "result") {
			if (message.is_error || message.subtype !== "success") throw new Error("Claude SDK query failed; no automatic side-effect replay");
			if (this.open) throw new Error("Incomplete Claude SDK stream");
			this.output.stopReason = this.stop === "max_tokens" ? "length" : "stop";
			return "done";
		}
		if (message.type === "assistant") {
			if (message.error) {
				const code = failureCodes.find(code => code === message.error) ?? "unrecognized";
				throw new SdkAssistantFailure(code, sdkFailureDetail(message.message?.content, this.secrets));
			}
			if (this.observedIds.has(message.message.id)) return "continue"; // duplicate may arrive on the next Pi tool turn
			// Canonical frames may carry only one completed block, not a complete response.
			if (message.message.stop_reason == null) throw new Error("Missing Claude SDK partial frames; no complete assistant response");
			// Only an explicit stop reason permits synthesis from a complete response.
			this.raw({ type: "message_start", message: { id: message.message.id, usage: message.message.usage } });
			for (const [index, content_block] of message.message.content.entries()) {
				this.raw({ type: "content_block_start", index, content_block });
				this.raw({ type: "content_block_stop", index });
			}
			this.raw({ type: "message_delta", delta: { stop_reason: message.message.stop_reason }, usage: message.message.usage });
			return this.raw({ type: "message_stop" });
		}
		if (message.type === "stream_event") {
			return this.raw(message.event);
		}
		return "continue";
	}
	private raw(event: unknown): "continue" | "tools" | "done" {
		// SDK event union is deliberately narrowed at this trust boundary. Unknown blocks fail closed.
		const e = event as { type: string; index: number; message?: { id?: string; usage?: object };
			content_block?: { type: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string; input?: unknown };
			delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null }; usage?: object };
		if (e.type === "message_start") {
			if (this.open) throw new Error("Overlapping SDK messages");
			this.open = true; this.stop = "end_turn"; this.blocks.clear(); this.baseUsage = structuredClone(this.output.usage); this.currentUsage = {};
			this.output.responseId = e.message?.id;
			if (e.message?.id) this.observedIds.add(e.message.id);
			this.usage(e.message?.usage ?? {});
		} else if (e.type === "content_block_start") {
			if (!this.open || this.blocks.has(e.index) || !e.content_block) throw new Error("Invalid SDK block start");
			const b = e.content_block;
			const index = this.output.content.length;
			this.blocks.set(e.index, { index, json: "", stopped: false });
			if (b.type === "text") {
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
				if (b.text) this.raw({ type: "content_block_delta", index: e.index, delta: { type: "text_delta", text: b.text } });
			} else if (b.type === "thinking" || b.type === "redacted_thinking") {
				this.output.content.push({ type: "thinking", thinking: "", thinkingSignature: b.type === "redacted_thinking" ? b.data : b.signature,
					...(b.type === "redacted_thinking" ? { redacted: true } : {}) });
				this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
				if (b.thinking) this.raw({ type: "content_block_delta", index: e.index, delta: { type: "thinking_delta", thinking: b.thinking } });
			} else if (b.type === "tool_use") {
				if (!b.id || !b.name?.startsWith("mcp__pi__")) throw new Error("SDK builtin or foreign tool rejected");
				if (b.input !== undefined && (!b.input || typeof b.input !== "object" || Array.isArray(b.input))) throw new Error("Invalid SDK tool arguments");
				this.output.content.push({ type: "toolCall", id: b.id, name: b.name.slice(9), arguments: {} });
				const block = this.blocks.get(e.index)!;
				if (b.input && Object.keys(b.input).length) block.json = JSON.stringify(b.input);
				this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
			} else throw new Error("Unsupported SDK content block");
		} else if (e.type === "content_block_delta") {
			const state = this.blocks.get(e.index);
			if (!state || state.stopped) throw new Error("Invalid SDK block delta");
			const b = this.output.content[state.index]; const d = e.delta;
			if (b.type === "text" && d?.type === "text_delta") {
				b.text += d.text ?? ""; this.stream.push({ type: "text_delta", contentIndex: state.index, delta: d.text ?? "", partial: this.output });
			} else if (b.type === "thinking" && d?.type === "thinking_delta") {
				b.thinking += d.thinking ?? ""; this.stream.push({ type: "thinking_delta", contentIndex: state.index, delta: d.thinking ?? "", partial: this.output });
			} else if (b.type === "thinking" && d?.type === "signature_delta") b.thinkingSignature = (b.thinkingSignature ?? "") + (d.signature ?? "");
			else if (b.type === "toolCall" && d?.type === "input_json_delta") {
				state.json += d.partial_json ?? "";
				this.stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: d.partial_json ?? "", partial: this.output });
			} else throw new Error("Unsupported SDK block delta");
		} else if (e.type === "content_block_stop") {
			const state = this.blocks.get(e.index);
			if (!state || state.stopped) throw new Error("Invalid SDK block stop");
			state.stopped = true;
			const b = this.output.content[state.index];
			if (b.type === "text") this.stream.push({ type: "text_end", contentIndex: state.index, content: b.text, partial: this.output });
			if (b.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: state.index, content: b.thinking, partial: this.output });
			if (b.type === "toolCall") {
				let input: unknown;
				try { input = JSON.parse(state.json || "{}"); }
				catch { state.invalidArguments = true; }
				if (!input || typeof input !== "object" || Array.isArray(input)) state.invalidArguments = true;
				// The stop reason arrives after block stop; truncated JSON must remain non-executable.
				if (!state.invalidArguments) {
					b.arguments = input as typeof b.arguments;
					this.bridge.expectCall(b.id, b.name, b.arguments);
				}
				this.stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall: b, partial: this.output });
			}
		} else if (e.type === "message_delta") {
			if (e.delta?.stop_reason) this.stop = e.delta.stop_reason;
			this.output.rawStopReason = this.stop;
			this.usage(e.usage ?? {});
		} else if (e.type === "message_stop") {
			if (!this.open || [...this.blocks.values()].some(b => !b.stopped)) throw new Error("Incomplete SDK blocks");
			this.open = false;
			// Pi must see length even when the truncated response contains complete tool blocks.
			if (this.stop === "max_tokens") { this.output.stopReason = "length"; return "done"; }
			if ([...this.blocks.values()].some(b => b.invalidArguments)) throw new Error("Invalid SDK tool arguments");
			const tools = [...this.blocks.values()].flatMap(b => {
				const block = this.output.content[b.index]; return block.type === "toolCall" ? [block.id] : [];
			});
			if (tools.length) {
				if (this.stop !== "tool_use") throw new Error("SDK tool handoff requires an explicit tool_use stop reason");
				this.bridge.validateBatch(tools);
				this.output.stopReason = "toolUse"; return "tools";
			}
		} else if (e.type !== "ping") throw new Error("Unsupported SDK stream event");
		return "continue";
	}
}
