/**
 * toolhints — a failed tool call carries its next move (HIV-1976).
 *
 * The reasoning, the rules and the evidence for each signature live in
 * `./hints.ts`. This file is the pi wiring and one decision worth stating here:
 * it is a `tool_result` handler, which pi awaits INSIDE the agent loop, so
 * static signatures scan at most 4KB. The three contextual checks in
 * contextual.ts have separate byte/time budgets; no network or model calls.
 *
 * ## Why annotate rather than teach
 *
 * The instruction usually exists. Session `efb2830c` had `readiness` telling it
 * `gh` was unauthenticated at session start, and forty turns later it went
 * looking for a Hive tool to open a pull request — twice — before falling back
 * to `hive --help`. Guidance that is true and forty turns away is guidance that
 * is not there. This puts the same sentence in the failing tool result.
 *
 * ## What it will not do
 *
 * - **Never replaces the original output.** The error is the evidence; the hint
 *   is appended after it, tagged, so the model can tell ours from the tool's.
 * - **Success stays quiet** except proven codemode truncation or Go -run
 *   omissions (and the MCP proxy's error-as-success lookup response).
 * - **At most one hint per result.** Unknown signatures stay silent;
 *   a budgeted contextual check reports NOT checked rather than guessing.
 * - **Never touches `details` or `isError`.** A hint is not a verdict, and a
 *   consumer that branches on those must see exactly what the tool returned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { EMPTY_CORPUS, corpusFromRegistry } from "../mcp-common/search.ts";
import { matchHint, renderHint, scanTail } from "./hints.ts";
import { codemodeTruncationHint, goRunPatterns, goTestHint, SCAN_BYTES, socketTimeoutHint, type ObservedRead } from "./contextual.ts";

/** Off switch, for a session where the extra sentences are unwanted. */
function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_TOOLHINTS === "0";
}

/** The text a hint is matched against: the tool's own output, tail-capped. */
export function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/**
 * Append the hint to the LAST text part, rather than adding a part.
 *
 * A tool result's parts are not always rendered as one block, and a hint that
 * arrived as its own part could be displayed — or truncated — separately from
 * the error it explains. Keeping them in one part keeps them together wherever
 * the result goes.
 */
export function appendHint(content: unknown, text: string): { type: "text"; text: string }[] {
	const parts = Array.isArray(content) ? [...content] : [{ type: "text" as const, text: resultText(content) }];
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i] as { type?: string; text?: string } | undefined;
		if (part && part.type === "text" && typeof part.text === "string") {
			parts[i] = { ...part, text: part.text + text };
			return parts as { type: "text"; text: string }[];
		}
	}
	parts.push({ type: "text" as const, text: text.trimStart() });
	return parts as { type: "text"; text: string }[];
}

export default function (pi: ExtensionAPI) {
	if (disabled(process.env)) return;

	// Parent ids are provided by pi for nested calls. Keep only bounded read
	// evidence, and discard it when the parent finishes or the session changes.
	const reads = new Map<string, { items: ObservedRead[]; omitted: number }>();
	pi.on("session_start", () => reads.clear());
	pi.on("session_shutdown", () => reads.clear());
	pi.on("tool_call", (event) => {
		if (event.toolName === "codemode") {
			if (reads.size >= 8) reads.delete(reads.keys().next().value!);
			reads.set(event.toolCallId, { items: [], omitted: 0 });
		}
	});
	pi.on("tool_result", async (event, ctx) => {
		const raw = resultText(event.content);
		const annotated = (hint: string) => ({ content: appendHint(event.content, hint),
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) });
		if (event.toolName === "read" && event.parentToolCallId) {
			const observed = reads.get(event.parentToolCallId);
			const bytes = observed?.items.reduce((n, r) => n + Buffer.byteLength(r.text), 0) ?? 0;
			if (observed && observed.items.length < 16 && bytes + Buffer.byteLength(raw) <= SCAN_BYTES) {
				observed.items.push({ path: String(event.input.path ?? "(read)"), text: raw });
			} else if (observed) observed.omitted++;
		}
		if (event.toolName === "codemode") {
			const observed = reads.get(event.toolCallId) ?? { items: [], omitted: 0 };
			reads.delete(event.toolCallId);
			const details = event.details as { fullOutputPath?: string } | undefined;
			const hint = await codemodeTruncationHint(raw, details?.fullOutputPath, observed.items);
			if (hint) return annotated(hint + (observed.omitted ? ` ${observed.omitted} additional read(s) beyond the observation budget NOT attributed.` : ""));
		}
		if (event.toolName === "bash" || event.toolName === "background_bash") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			// Capture ctx before awaiting: it can become stale during the scan.
			const cwd = typeof event.input?.cwd === "string" ? event.input.cwd : ctx.cwd;
			if (goRunPatterns(command).length > 0) {
				const hint = await goTestHint(command, cwd);
				if (hint) return annotated(hint);
			}
			if (event.isError) {
				const hint = await socketTimeoutHint(raw, cwd, Boolean(process.env.SANDBOX_RUNTIME));
				if (hint) return annotated(hint);
			}
		}
		if (!event.isError) return;
		const text = scanTail(raw);
		if (!text) return;

		const hint = matchHint(event.toolName, text);
		if (!hint) return;

		// The corpus is built only when a hint fires, from pi's live registry:
		// MCP servers connect in the background, so a snapshot taken at session
		// start would miss every server still connecting. A failed call is rare
		// enough that one pass over the registry costs nothing that matters.
		const corpus = hint.amend ? corpusFromRegistry(pi.getAllTools()) : EMPTY_CORPUS;
		return annotated(renderHint(hint, text, { corpus }));
	});
}
