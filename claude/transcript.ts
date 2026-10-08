/**
 * A Claude Code transcript, read as pi session entries.
 *
 * Every reader the adapter reuses — the judge's and recap's transcript fold
 * (`recapTranscript`), the hand-back guard (`classifyHandback`), the
 * turn-failure check (`turnFailureOf`), the advisor's serializer — reads pi's
 * entry shape: `{ message: { role, content[], stopReason } }` with roles
 * `user` / `assistant` / `toolResult` and content parts `text` / `thinking` /
 * `toolCall`. So the Claude JSONL is translated ONCE, here, and those readers
 * run unchanged; there is no second implementation of any of them.
 *
 * The Claude format, as measured on real transcripts:
 *   - one JSON object per line; conversation lines are `type: "user"` and
 *     `type: "assistant"`, each with a `uuid` and a `message`;
 *   - an assistant MESSAGE is split across several lines, one content block
 *     per line, sharing `message.id` — they are merged back into one;
 *   - tool results ride `type: "user"` lines as `tool_result` blocks;
 *   - `isSidechain` lines belong to Claude's own subagents and `isMeta` user
 *     lines are harness-injected context; neither is the conversation;
 *   - a failed API call is a synthetic assistant line flagged
 *     `isApiErrorMessage` (e.g. "You've hit your session limit"), which
 *     becomes `stopReason: "error"`.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

export type PiPart =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type PiMessage =
	| { role: "user"; content: PiPart[] }
	| { role: "assistant"; content: PiPart[]; stopReason?: string; model?: string }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: PiPart[]; isError: boolean };

export interface PiEntry {
	type: "message";
	/** The Claude line uuid that opened this message — a stable source id. */
	id: string;
	message: PiMessage;
}

/** Claude's stop reasons in pi's vocabulary (what turn-outcome/handback read). */
const STOP_REASONS: Record<string, string> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "toolUse",
	max_tokens: "length",
	refusal: "error",
	pause_turn: "stop",
};

interface ClaudeBlock {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
	is_error?: unknown;
}

interface ClaudeLine {
	type?: string;
	uuid?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	/** Claude's synthetic assistant line for a failed API call (quota, overload, …). */
	isApiErrorMessage?: boolean;
	message?: { id?: string; role?: string; content?: unknown; stop_reason?: unknown; model?: unknown };
}

function blocksOf(content: unknown): ClaudeBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as ClaudeBlock[]) : [];
}

function textOf(content: unknown): string {
	return blocksOf(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/**
 * Translate parsed Claude lines into pi entries. `toolNames` is threaded so a
 * result can name the tool that produced it (pi's hand-back guard asks).
 */
export function toPiEntries(lines: readonly unknown[]): PiEntry[] {
	const entries: PiEntry[] = [];
	const toolNames = new Map<string, string>();
	let openAssistant: { entry: PiEntry; messageId: string | undefined } | null = null;

	for (const raw of lines) {
		const line = raw as ClaudeLine;
		if (!line || typeof line !== "object" || line.isSidechain) continue;
		if (line.type !== "user" && line.type !== "assistant") continue;
		const message = line.message;
		if (!message) continue;
		const id = typeof line.uuid === "string" ? line.uuid : "";

		if (line.type === "assistant") {
			const parts: PiPart[] = [];
			for (const block of blocksOf(message.content)) {
				if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
				else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
					parts.push({ type: "thinking", thinking: block.thinking });
				} else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
					toolNames.set(block.id, block.name);
					const args = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
					parts.push({ type: "toolCall", id: block.id, name: block.name, arguments: args });
				}
			}
			// A failed API call is a turn that did not RUN: pi's `error` stop reason,
			// which turnFailureOf reads, whatever stop_reason the synthetic line carries.
			const stop = line.isApiErrorMessage
				? "error"
				: typeof message.stop_reason === "string"
					? STOP_REASONS[message.stop_reason] ?? message.stop_reason
					: undefined;
			if (openAssistant && message.id !== undefined && openAssistant.messageId === message.id) {
				const target = openAssistant.entry.message as Extract<PiMessage, { role: "assistant" }>;
				target.content.push(...parts);
				if (stop) target.stopReason = stop;
				continue;
			}
			const entry: PiEntry = {
				type: "message",
				id,
				message: {
					role: "assistant",
					content: parts,
					...(stop ? { stopReason: stop } : {}),
					...(typeof message.model === "string" ? { model: message.model } : {}),
				},
			};
			entries.push(entry);
			openAssistant = { entry, messageId: message.id };
			continue;
		}

		openAssistant = null;
		if (line.isMeta) continue;
		const blocks = blocksOf(message.content);
		const results = blocks.filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
		for (const result of results) {
			const callId = result.tool_use_id as string;
			entries.push({
				type: "message",
				id,
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: toolNames.get(callId) ?? "",
					content: [{ type: "text", text: textOf(result.content) }],
					isError: result.is_error === true,
				},
			});
		}
		const text = textOf(blocks.filter((b) => b.type === "text"));
		if (text.trim()) entries.push({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
	}
	return entries;
}

/** Where a skipped line is reported. Hooks and the MCP server log to stderr. */
export type Warn = (line: string) => void;
const stderrWarn: Warn = (line) => process.stderr.write(`${line}\n`);

/**
 * Parse COMPLETE JSONL lines. A corrupt line is skipped with one stderr line
 * and the rest is read: one bad line must not make every later settle unable
 * to read the session (the Stop hook would exit non-zero on every stop, and
 * the goal would silently go unenforced for the rest of it).
 */
export function parseJsonl(text: string, firstLineNumber = 1, warn: Warn = stderrWarn): unknown[] {
	const out: unknown[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch (error) {
			warn(`hive-pi: transcript line ${firstLineNumber + i} skipped — not JSON: ${(error as Error).message}`);
		}
	}
	return out;
}

/** The text up to and including the last newline: a line Claude is still writing is not read yet. */
function completeLines(text: string): string {
	const last = text.lastIndexOf("\n");
	return last < 0 ? "" : text.slice(0, last + 1);
}

export function readClaudeTranscript(path: string, warn: Warn = stderrWarn): PiEntry[] {
	return toPiEntries(parseJsonl(completeLines(readFileSync(path, "utf8")), 1, warn));
}

/**
 * The COMPLETE lines appended since byte `offset`, and the offset after the
 * last of them. A trailing partial line (Claude mid-write) is left for the
 * next read; a corrupt complete line is skipped and the cursor moves past it.
 */
export function readAppendedLines(path: string, offset: number, warn: Warn = stderrWarn): { lines: unknown[]; next: number } {
	const size = statSync(path).size;
	// A transcript that shrank was replaced (rewritten, rotated): start over.
	const from = offset > size ? 0 : offset;
	if (size === from) return { lines: [], next: from };
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size - from);
		readSync(fd, buffer, 0, buffer.length, from);
		const lastNewline = buffer.lastIndexOf(0x0a);
		if (lastNewline < 0) return { lines: [], next: from };
		return { lines: parseJsonl(buffer.subarray(0, lastNewline + 1).toString("utf8"), 1, warn), next: from + lastNewline + 1 };
	} finally {
		closeSync(fd);
	}
}

/**
 * The Stop hook is handed the final assistant text directly
 * (`last_assistant_message`), and it can be newer than the transcript on
 * disk. Appended as a closing assistant turn when the transcript's last
 * assistant text is not already it, so the judge grades the turn that just
 * ended.
 */
export function withFinalAssistant(entries: PiEntry[], finalText: string | undefined): PiEntry[] {
	const text = finalText?.trim();
	if (!text) return entries;
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i].message;
		if (message.role !== "assistant") continue;
		const last = message.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("\n")
			.trim();
		if (last.endsWith(text)) return entries;
		break;
	}
	return [...entries, { type: "message", id: "", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }];
}
