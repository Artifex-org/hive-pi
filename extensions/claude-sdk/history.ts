/** Canonical Pi transcript conversion. Never submits old prompts as new turns. */
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, UserMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function imageOrText(block: UserMessage["content"][number] | ToolResultMessage["content"][number]): unknown {
	if (typeof block === "string") throw new Error("Invalid content block");
	return block.type === "text" ? { type: "text", text: block.text } : {
		type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data },
	};
}
export function userMessage(message: UserMessage): SDKUserMessage {
	return { type: "user", message: { role: "user", content: typeof message.content === "string" ? message.content : message.content.map(imageOrText) },
		parent_tool_use_id: null, client_composed: true } as SDKUserMessage;
}
export function nativeMessage(message: Exclude<Message, { role: "system" }>): Record<string, unknown> {
	if (message.role === "user") return { ...userMessage(message).message };
	if (message.role === "toolResult") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId,
		is_error: message.isError, content: message.content.map(imageOrText) }] };
	return { role: "assistant", type: "message", id: randomUUID(), model: message.model,
		content: message.content.map(block => {
			if (block.type === "toolCall") return { type: "tool_use", id: block.id, name: `mcp__pi__${block.name}`, input: block.arguments };
			if (block.type === "thinking") {
				// Foreign/unsigned reasoning has no Anthropic signature. Preserve its visible text,
				// not an invalid signed-thinking claim; the Pi transcript itself is never rewritten.
				if (!block.thinkingSignature || !["claude-sdk", "anthropic-messages"].includes(message.api)) return { type: "text", text: block.thinking };
				return block.redacted ? { type: "redacted_thinking", data: block.thinkingSignature }
					: { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature };
			}
			return { type: "text", text: block.text };
		}), stop_reason: message.rawStopReason ?? (message.stopReason === "toolUse" ? "tool_use" : "end_turn"),
		stop_sequence: null, usage: { input_tokens: message.usage.input, output_tokens: message.usage.output } };
}

/** Unresolved historical side effects must be reconciled, never re-issued. */
export function assertSettledHistory(messages: readonly Message[]): void {
	const pending = new Map<string, string>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") {
			if (seen.has(block.id)) throw new Error("Duplicate historical tool call");
			seen.add(block.id);
			pending.set(block.id, block.name);
		}
		if (message.role === "toolResult") {
			if (pending.get(message.toolCallId) !== message.toolName) throw new Error("Uncorrelated historical tool result");
			pending.delete(message.toolCallId);
		}
	}
	if (pending.size) throw new Error("Unresolved historical tools; reconcile side effects before retrying");
}

/** Pinned CLI JSONL resume chain; no token or auth document is ever written. */
export async function seedHistory(dir: string, messages: readonly Message[], sessionId: string, cwd: string, following: readonly Message[] = []): Promise<string | undefined> {
	assertSettledHistory([...messages, ...following]);
	let parentUuid: string | null = null;
	const entries = messages.filter(message => message.role !== "system").map(message => {
		const uuid = randomUUID();
		const entry = { type: message.role === "assistant" ? "assistant" : "user", uuid, parentUuid,
			sessionId, cwd, version: "2.1.286", isSidechain: false, userType: "external",
			timestamp: new Date(message.timestamp).toISOString(), message: nativeMessage(message) };
		parentUuid = uuid;
		return entry;
	});
	if (!entries.length) return undefined;
	const path = join(dir, "history.jsonl");
	await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
	return path;
}
