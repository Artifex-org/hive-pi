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
	return boundedDetail(`API Error${match[1] ? ` ${match[1]}` : ""}: ${sanitizeDiagnosticText(body, secrets)}`);
}

/**
 * The one sanitizer for SDK failure text that reaches `output.diagnostics`:
 * known secrets and token shapes redacted, URL queries and fragments dropped,
 * request ids replaced, opaque runs of 32+ characters removed and control
 * characters/whitespace collapsed. It does not bound the length; callers cut
 * the sanitized text, so a cut never splits a secret before it is matched.
 */
export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = []): string {
	return redactEvidence(text, secrets)
		.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
		.replace(/\breq_[A-Za-z0-9]+/g, "[ID]")
		.replace(/[A-Za-z0-9_+/=-]{32,}/g, "[REDACTED]")
		.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
}
/** Sanitized text cut to `max` characters, keeping the head. */
export function boundedDetail(text: string, max = DETAIL_CHARS): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The pinned SDK's `SDKResultError` subtypes; any other value is reported as "unrecognized". */
const resultSubtypes = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"] as const;
/** The pinned SDK's `SDKStartupFailureReason` values; anything else is not copied. */
const startupFailures = ["org_pin_api_key_conflict", "provider_not_allowed", "org_verify_failed", "org_pin_mismatch", "managed_settings_invalid",
	"remote_settings_required_unavailable", "gateway_signin_required", "gateway_access_denied", "proxy_invalid", "temp_dir_unusable",
	"cwd_unavailable", "shell_tool_missing", "session_held_by_background", "worktree_resume_refused", "worktree_unverified",
	"cli_version_too_old", "bypass_root"] as const;
/** Enumerated SDK values are copied only when they are a known member. */
export const known = <T extends string>(values: readonly T[], value: unknown): T | "unrecognized" | undefined =>
	value === undefined || value === null ? undefined : values.find(v => v === value) ?? "unrecognized";

/**
 * An SDK `result` that ended the query in error (`is_error`, or a non-success
 * subtype). Its fields are already sanitized: enumerated values only when
 * known, `errors` and an `API Error:` result text through the shared sanitizer.
 */
export class SdkResultFailure extends Error {
	readonly subtype: string;
	readonly isError: boolean;
	readonly stopReason?: string;
	readonly startupFailure?: string;
	readonly numTurns?: number;
	readonly errors?: string;
	readonly apiError?: string;
	constructor(result: Extract<SDKMessage, { type: "result" }>, secrets: readonly string[]) {
		super("Claude SDK query failed; no automatic side-effect replay");
		this.subtype = known(resultSubtypes, result.subtype) ?? "unrecognized";
		this.isError = result.is_error === true;
		if (typeof result.stop_reason === "string" && /^[a-z_]{1,40}$/.test(result.stop_reason)) this.stopReason = result.stop_reason;
		if (Number.isSafeInteger(result.num_turns)) this.numTurns = result.num_turns;
		if (result.subtype !== "success") {
			this.startupFailure = known(startupFailures, result.startup_failure_reason);
			const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
			if (errors.length) this.errors = boundedDetail(sanitizeDiagnosticText(errors.join("; "), secrets));
		} else if (typeof result.result === "string") this.apiError = sdkFailureDetail([{ type: "text", text: result.result }], secrets);
	}
}

/** The shape of the SDK frame a stream failure happened on: allowlisted names only, never content or ids. */
export interface FrameShape { type: string; subtype?: string; parentToolUseId?: true }
const FRAME_NAME = /^[a-z][a-z0-9_]{0,40}$/;
export function frameShape(message: unknown): FrameShape {
	const frame = (message && typeof message === "object" ? message : {}) as { type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown };
	const name = (value: unknown) => typeof value === "string" && FRAME_NAME.test(value) ? value : "unrecognized";
	return { type: name(frame.type), ...(frame.subtype !== undefined ? { subtype: name(frame.subtype) } : {}),
		...(frame.parent_tool_use_id ? { parentToolUseId: true as const } : {}) };
}

/**
 * The SDK stream broke the provider's protocol contract (`stream_protocol`), or
 * ended without a result (`stream_ended`). Messages are fixed provider text.
 */
export class SdkProtocolError extends Error {
	constructor(message: string, readonly kind: "stream_protocol" | "stream_ended" = "stream_protocol", readonly frame?: FrameShape) { super(message); }
}

/**
 * Classifies a failure `EventConverter.consume` raised on `message`, for
 * diagnostics only: the converter's own plain errors (fixed text) become
 * `SdkProtocolError` with the frame's shape, and an error result becomes
 * `SdkResultFailure`. Structured assistant and bridge failures pass through.
 */
export function streamFailure(error: unknown, message: SDKMessage, secrets: readonly string[]): unknown {
	if (message.type === "result" && (message.is_error || message.subtype !== "success")) return new SdkResultFailure(message, secrets);
	return error instanceof Error && error.constructor === Error ? new SdkProtocolError(error.message, "stream_protocol", frameShape(message)) : error;
}

/** A refusal or failure raised by this provider itself; its message is fixed provider text. */
export class SdkProviderError extends Error {}

/** Hive refused the launch's lease; `retryable` only for its marked temporary 503. */
export class SdkLeaseRefused extends SdkProviderError {
	constructor(readonly status: number, readonly retryable = false, readonly retryAfterMs?: number) { super(`Claude SDK launch lease refused (HTTP ${status})`); }
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
		// The CLI reports a Pi tool call that has run for 30 s or more with heartbeat
		// `tool_progress` frames whose parent_tool_use_id is that in-flight call, not a
		// subagent. They carry no content (only elapsed time), so skip them before the
		// subagent guard, which still rejects real nested output.
		if (message.type === "tool_progress") return "continue";
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
