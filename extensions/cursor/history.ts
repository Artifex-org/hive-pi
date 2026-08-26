/**
 * Turning a pi conversation into one Cursor prompt (HIV-2095).
 *
 * Split from provider.ts for a mechanical reason worth stating: provider.ts
 * imports pi-ai for VALUES (createAssistantMessageEventStream), so anything
 * importing it needs pi resolvable at runtime — which the vendored extension
 * tree in the factory image does not have. This module is pure and type-only,
 * so its tests run wherever the tree is checked out.
 *
 * Cursor carries prior turns in `ConversationStateStructure.turns`, a
 * `repeated bytes` of blob ids addressing NESTED protobuf. Rather than pull in a
 * protobuf runtime to author one, history is flattened into the outgoing text
 * with explicit role labels.
 *
 * This is the COLD-START path. A tool call no longer comes through here at all:
 * the Cursor stream is now held open across pi's execution and the result is
 * answered inline (see session.ts), so within one conversation the model keeps
 * its own history. Flattening is what a turn gets when there is no live stream
 * to resume — a fresh pi session, a restarted process, an expired suspension.
 */

import type { Message } from "@earendil-works/pi-ai";

/** Pull plain text out of one pi message, whatever its content shape. */
export function messageText(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string; output?: unknown };
			// A toolResult MESSAGE carries TextContent blocks like any other, so the
			// text branch covers it. There is no `toolResult` content block in pi —
			// an earlier version looked for one, and silently returned "" for every
			// tool result.
			if (b.type === "text" && typeof b.text === "string") return b.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** A tool result pi has just produced, ready to feed back into a parked turn. */
export interface TrailingToolResult {
	/** Cursor's own tool-call id, which this provider reuses as pi's. */
	callId: string;
	text: string;
	isError: boolean;
}

/**
 * The tool result pi is calling us back with, if that is why we were called.
 *
 * Only a result at the very END of the conversation counts. Anything earlier
 * belongs to a turn that has already been answered, and feeding it to a parked
 * stream would answer the wrong call.
 */
export function trailingToolResult(messages: Message[]): TrailingToolResult | null {
	const last = messages[messages.length - 1] as
		| { role?: string; toolCallId?: string; isError?: boolean }
		| undefined;
	if (!last || last.role !== "toolResult" || !last.toolCallId) return null;
	return {
		callId: last.toolCallId,
		text: messageText(last as Message),
		isError: Boolean(last.isError),
	};
}

/** Tool calls carried on one message, if any. */
function toolCallsOf(message: Message): Array<{ name: string; arguments: unknown }> {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => (b as { type?: string })?.type === "toolCall")
		.map((b) => {
			const c = b as { name?: string; arguments?: unknown };
			return { name: c.name ?? "tool", arguments: c.arguments ?? {} };
		});
}

/**
 * Flatten a conversation into one prompt.
 *
 * Exported for testing: the labelling is the whole of the fidelity story, so it
 * is asserted rather than assumed.
 */
export function flattenConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const role = (message as { role?: string }).role ?? "user";
		if (role === "system") continue; // carried separately, as the prompt blob

		// Tool CALLS must survive the flattening, not just their results. A
		// resumed conversation that shows a result with no call reads as an
		// answer to a question nobody asked.
		//
		// This does NOT explain the re-call loop, though it was once claimed to:
		// the loop was a missing tool RESULT on the wire, and it survived this
		// fix. Kept because it is right about fidelity, not because it was the
		// cure.
		const calls = toolCallsOf(message);
		if (calls.length) {
			parts.push(
				`[assistant called]\n${calls
					.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
					.join("\n")}`,
			);
		}

		const text = messageText(message).trim();

		// A TOOL RESULT is its own role in pi, carrying the tool's name — it is not
		// a content block on the user's message. Flattened as `[user]` it read as
		// the user saying "recorded: 42", which is wrong on its face; labelling it
		// is right regardless of the loop it did not fix.
		if (role === "toolResult") {
			const r = message as { toolName?: string; isError?: boolean };
			const name = r.toolName ?? "tool";
			parts.push(
				r.isError
					? `[tool ${name} FAILED]\n${text || "(no detail)"}`
					: `[tool ${name} returned]\n${text || "(no output)"}`,
			);
			continue;
		}

		if (!text) continue;
		parts.push(role === "assistant" ? `[assistant]\n${text}` : `[user]\n${text}`);
	}
	// A single trailing user message needs no scaffolding — the common case
	// should look like an ordinary prompt, not a transcript.
	if (parts.length === 1) return parts[0].replace(/^\[user\]\n/, "");
	return parts.join("\n\n");
}

