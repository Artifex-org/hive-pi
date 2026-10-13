/**
 * advisor — the session entries the advisor sees. Kept out of prompt.ts, which
 * the Claude Code adapter imports and which must stay free of pi runtime imports.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * The session entries the advisor sees, as agent messages. Chat messages pass
 * through. A `custom_message` entry (teammate/lead deliveries `team-message`,
 * `handback`, `agenda` notices, ...) is what carries incoming delegations and
 * grants; dropping it made the advisor object that no authorization existed.
 * It is projected by pi's own entry projection and its text is labelled with
 * its customType, so it reads as a harness-delivered user-role message and not
 * as something the user typed.
 */
export function advisorMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => {
		if (entry.type === "message") return [entry.message];
		if (entry.type !== "custom_message") return [];
		return sessionEntryToContextMessages(entry).map((m) => {
			if (m.role !== "custom") return m;
			const body = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			return { ...m, content: [{ type: "text" as const, text: `[${m.customType} message delivered to the session]` }, ...body] };
		});
	});
}
