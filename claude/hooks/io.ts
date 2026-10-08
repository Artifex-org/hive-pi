/**
 * Claude Code hook I/O: the stdin event and the stdout decision.
 *
 * Field names are Claude Code's own (snake_case), passed through untouched.
 */

export interface HookInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	hook_event_name?: string;
	stop_hook_active?: boolean;
	last_assistant_message?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	tool_use_id?: string;
	prompt?: string;
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
	return Buffer.concat(chunks).toString("utf8");
}

/** The hook event. An empty stdin is an empty event; a malformed one throws. */
export function parseHookInput(text: string): HookInput {
	if (!text.trim()) return {};
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input is not a JSON object");
	return parsed as HookInput;
}

/** What a hook prints: a JSON decision, or nothing (allow / no comment). */
export type HookOutput = Record<string, unknown> | null;

export function denyToolUse(reason: string): HookOutput {
	return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function additionalContext(event: "PostToolUse" | "UserPromptSubmit", text: string): HookOutput {
	return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

export function blockStop(reason: string): HookOutput {
	return { decision: "block", reason };
}
