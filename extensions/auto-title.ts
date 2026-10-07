/**
 * Assign a useful, local session name from its first meaningful user prompt.
 *
 * This intentionally uses deterministic text cleanup rather than a model call:
 * title assignment must not add latency, cost, or a second copy of the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMOTE_OPENING_INPUT_CHANNEL, SESSION_IDENTITY_INITIAL_CHANNEL } from "./hive-remote/sessionIdentityBus.ts";

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
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i(?:'d| would) like you to\s+)/i, "")
		.replace(/https?:\/\/\S+/gi, "[url]")
		.replace(/(?:~\/|\/[A-Za-z0-9._-]+\/)[^\s]*/g, "[path]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[secret]")
		.replace(/\s+/g, " ")
		.replace(/[.?!:;]+$/, "")
		.trim();
	if (!normalized) return undefined;
	const chars = Array.from(normalized);
	if (chars.length <= MAX_TITLE_LENGTH) return normalized;

	const limit = MAX_TITLE_LENGTH - 1; // reserve one character for the ellipsis
	const prefix = chars.slice(0, limit + 1).join("");
	const boundary = prefix.lastIndexOf(" ");
	return `${(boundary > 0 ? prefix.slice(0, boundary) : chars.slice(0, limit).join("")).trim()}…`;
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
	let announcedOpening: string | undefined;

	pi.events.on(REMOTE_OPENING_INPUT_CHANNEL, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const text = (payload as { text?: unknown }).text;
		if (typeof text === "string") announcedOpening = text;
	});

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
		const trustedRemoteOpening = event.source === "extension" && announcedOpening === event.text;
		if (trustedRemoteOpening) announcedOpening = undefined;
		if (assigned || (event.source === "extension" && !trustedRemoteOpening)) return;
		const opening = event.text.trim() ? event.text : event.images?.length ? "Review attached image" : event.text;
		const title = deriveTitle(opening);
		if (!title) return;

		// Setting the Pi title emits session_info_changed. Hive Remote listens for
		// that event and refreshes its opted-in conversation independently.
		// Commit provenance before the SDK naming event, so this automatic name
		// is never mistaken for an operator /name pin.
		pi.events.emit(SESSION_IDENTITY_INITIAL_CHANNEL, { title, prompt: opening });
		pi.setSessionName(title);
		pi.appendEntry(ENTRY_TYPE, { assigned: true } satisfies AutoTitleEntry);
		assigned = true;
	});
}
