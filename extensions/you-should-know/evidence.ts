import { createHash } from "node:crypto";

export interface SourceEvidence {
	id: string;
	type: "assistant" | "tool";
	text: string;
	context?: string;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
	/\b(?:sk-ant|ant-api03)-[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:ts|typesafe)[_-](?:key|token)[_-][A-Za-z0-9_-]{16,}\b/gi,
	/\b(?:[A-Za-z_][A-Za-z0-9_]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|secret[_-]?access[_-]?key)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&#"']+)/gi,
	/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/https?:\/\/[^\s?#]+\?[^\s#]*(?:token|key|secret|auth)[^\s#]*/gi,
];

/** Redact before any evidence can be sent outside the process. */
export function redactEvidence(text: string, knownSecrets: readonly string[] = []): string {
	let result = text;
	for (const secret of knownSecrets) if (secret) result = result.split(secret).join("[REDACTED]");
	for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
	return result.slice(0, 32_000);
}

/** Remove terminal/control sequences while retaining ordinary line boundaries. */
function safeText(value: string): string {
	return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function assistantEvidence(id: string, text: string, knownSecrets: readonly string[] = []): SourceEvidence {
	return { id: id.slice(0, 128), type: "assistant", text: redactEvidence(safeText(text), knownSecrets) };
}

/** Accept only explicit failed SDK tool results and their text content. */
export function failedToolEvidence(event: unknown, knownSecrets: readonly string[] = []): SourceEvidence | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; content?: unknown };
	if (value.isError !== true || typeof value.toolCallId !== "string" || typeof value.toolName !== "string" || !Array.isArray(value.content)) return undefined;
	if (/papercut|you[-_ ]should[-_ ]know|helper ack|recording_control|advisor|compact_schedule|goal_set|TodoWrite|plan_ready/i.test(value.toolName)) return undefined;
	const chunks: string[] = [];
	for (const item of value.content) {
		if (item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string") {
			chunks.push((item as { text: string }).text);
		}
	}
	const text = redactEvidence(safeText(chunks.join("\n")), knownSecrets).slice(0, 2_000);
	if (!text.trim()) return undefined;
	// An expected unsuccessful lookup is not an operational defect. Preserve
	// real permission/network/runtime failures even from a lookup tool.
	if (/^(?:find|grep|read_symbol|knowledge_search|knowledge_get)$/.test(value.toolName) &&
		/^(?:no (?:matches|results)|(?:symbol|document|file) not found)\b/i.test(text.trim()) &&
		!/permission|denied|timeout|connection|exception|error code/i.test(text)) return undefined;
	const id = safeText(value.toolCallId).replace(/[\r\n\u2028\u2029]/g, "").slice(0, 128);
	if (!id) return undefined;
	return { id, type: "tool", text, context: safeText(value.toolName).replace(/[\r\n\u2028\u2029]/g, "").slice(0, 128) };
}

export function stableFindingID(sessionId: string, sourceId: string, quote: string): string {
	return createHash("sha256").update(`${sessionId}\0${sourceId}\0${quote}`).digest("hex");
}
