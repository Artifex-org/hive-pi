/**
 * toolhints — a failed tool call carries its next move (HIV-1976).
 *
 * The reasoning, the rules and the evidence for each signature live in
 * `./hints.ts`. This file is the pi wiring and one decision worth stating here:
 * it is a `tool_result` handler, which pi awaits INSIDE the agent loop, so
 * everything it does is a regex over at most 4KB of tail text and a string
 * append. No fs, no network, no model call, nothing that can hang a turn.
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
 * - **Never fires on success.** A hint on a working call is pure context tax.
 * - **At most one hint per result**, and only for a signature in the table.
 *   Silence is the correct output for an error nobody has studied yet.
 * - **Never touches `details` or `isError`.** A hint is not a verdict, and a
 *   consumer that branches on those must see exactly what the tool returned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { matchHint, renderHint, scanTail } from "./hints.ts";

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

	pi.on("tool_result", (event) => {
		// A successful call needs no next move, and scanning every success would
		// put a regex over every tool result in the session for nothing. The
		// `mcp` proxy is the exception: it reports a failed LOOKUP as an ordinary
		// result ("No tools matching …"), which is exactly the case this exists
		// for — a search that found nothing and left the model to guess again.
		const text = scanTail(resultText(event.content));
		if (!event.isError && event.toolName !== "mcp") return;
		if (!text) return;

		const hint = matchHint(event.toolName, text);
		if (!hint) return;

		return { content: appendHint(event.content, renderHint(hint)) };
	});
}
