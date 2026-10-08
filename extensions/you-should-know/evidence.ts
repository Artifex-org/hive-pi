import { createHash } from "node:crypto";
import { redactEvidence } from "../hive-common/redact.ts";
import { validFinding, type CapturedFinding } from "../hive-common/you-should-know-findings.ts";
import { fingerprint, type Note } from "./scan.ts";

export interface SourceEvidence {
	id: string;
	type: "assistant" | "tool";
	text: string;
	context?: string;
}

// The redactor is shared (hive-common/redact.ts): the agenda's transcript fold
// runs tool-call arguments through it too. Re-exported for existing importers.
export { redactEvidence };

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
