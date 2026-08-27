/**
 * Assign a useful, local session name from its first meaningful user prompt.
 *
 * This intentionally uses deterministic text cleanup rather than a model call:
 * title assignment must not add latency, cost, or a second copy of the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_LENGTH = 72;
const ENTRY_TYPE = "auto-title";

interface AutoTitleEntry {
	assigned: true;
}

/** Return a concise title for a normal user request, or nothing for commands. */
export function deriveTitle(prompt: string): string | undefined {
	const firstLine = prompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine || firstLine.startsWith("/")) return undefined;

	const normalized = firstLine
		.replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i(?:'d| would) like you to\s+)/i, "")
		.replace(/https?:\/\/\S+/gi, "[url]")
		.replace(/(?:~\/|\/[A-Za-z0-9._-]+\/)[^\s]*/g, "[path]")
		.replace(/\s+/g, " ")
		.replace(/[.?!:;]+$/, "")
		.trim();
	if (!normalized) return undefined;
	if (normalized.length <= MAX_TITLE_LENGTH) return normalized;

	const limit = MAX_TITLE_LENGTH - 1; // reserve one character for the ellipsis
	const prefix = normalized.slice(0, limit + 1);
	const boundary = prefix.lastIndexOf(" ");
	return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix.slice(0, limit)).trim()}…`;
}

function wasAssigned(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== ENTRY_TYPE) return false;
		return (record.data as Partial<AutoTitleEntry> | undefined)?.assigned === true;
	});
}

export default function (pi: ExtensionAPI) {
	let assigned = false;

	pi.on("session_start", (_event, ctx) => {
		try {
			assigned = wasAssigned(ctx.sessionManager.getEntries());
			if (pi.getSessionName()) assigned = true;
		} catch {
			// A missing session manager only occurs in ephemeral startup paths. The
			// first normal input remains eligible for a local title.
			assigned = false;
		}
	});

	pi.on("input", (event) => {
		if (assigned || event.source === "extension") return;
		const title = deriveTitle(event.text);
		if (!title) return;

		// Setting the Pi title emits session_info_changed. Hive Remote listens for
		// that event and refreshes its opted-in conversation independently.
		pi.setSessionName(title);
		pi.appendEntry(ENTRY_TYPE, { assigned: true } satisfies AutoTitleEntry);
		assigned = true;
	});
}
