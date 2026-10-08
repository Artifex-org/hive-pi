import { createHash } from "node:crypto";
import { validFinding, type CapturedFinding } from "../hive-common/you-should-know-findings.ts";
import { fingerprint, type Note } from "./scan.ts";

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

/** One buffered source and the recording state it was captured under. */
export interface CaptureSource {
	evidence: SourceEvidence;
	recording: boolean;
	revision: number;
	serverSessionId?: string;
}

/**
 * Ground a scan's notes in the sources it was given: drop quotes already
 * surfaced, find the source each quote came from, mint the stable finding id
 * (written onto the note, which the caller keeps), and build the wire finding.
 *
 * `recordable(origin)` says whether a finding from that source may be
 * recorded now — the extension and the Claude adapter each know their own
 * recording state; the grounding itself is the same for both.
 */
export function groundNotes(
	extracted: Note[],
	seen: readonly string[],
	captured: readonly CaptureSource[],
	sessionId: string,
	recordable: (origin: CaptureSource) => boolean,
): { notes: Note[]; findings: CapturedFinding[] } {
	const notes = extracted.filter((n) => !seen.includes(fingerprint(n.quote)));
	const findings: CapturedFinding[] = [];
	for (const note of notes) {
		const origin = captured.find((x) => x.evidence.text.includes(note.quote));
		if (!origin) continue;
		note.id = stableFindingID(sessionId, origin.evidence.id, note.quote);
		const finding = {
			id: note.id,
			kind: note.kind,
			classification: note.classification ?? "context",
			text: note.text,
			quote: note.quote,
			source_id: origin.evidence.id,
			source_type: origin.evidence.type,
			provenance: origin.evidence.type === "tool" ? ("observed" as const) : ("assistant_reported" as const),
			context: origin.evidence.context,
			expected: note.expected,
			impact: note.impact,
		};
		if (validFinding(finding)) {
			findings.push({ finding, recording: recordable(origin), revision: origin.revision, serverSessionId: origin.serverSessionId ?? "" });
		}
	}
	return { notes, findings };
}
