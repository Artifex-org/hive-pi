// Pure half of session_title (sessionTitle.ts), split out so it is testable
// without pi or typebox installed. Kept alike with hive's cloud copy.

/** pi's own auto-title cap: a headline, not a description. */
export const MAX_SESSION_TITLE = 72;

// Matches store.MaxAgentSessionTitle: the wire limit is UTF-8 bytes, not chars.
export const MAX_SESSION_TITLE_BYTES = 120;
const utf8 = new TextEncoder();

export function manualTitleError(title: string): string | undefined {
	if (utf8.encode(title).length > MAX_SESSION_TITLE_BYTES) {
		return `Manual session names must be at most ${MAX_SESSION_TITLE_BYTES} UTF-8 bytes; the name was not pinned in Hive.`;
	}
	return undefined;
}

/** One line of plain text, at most MAX_SESSION_TITLE characters; null when nothing is left. */
export function normalizeSessionTitle(raw: string): string | null {
	// The same narrow rules as the web's plainTitle: strip markup a model
	// carries into a title, never characters that are content. A blanket
	// [#_>] strip turned "PR #8123" into "PR 8123" and feature_flag into
	// featureflag.
	const flat = raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1")
		.replace(/(?<![*\w])\*(?![*\s])([^*]+?)(?<![\s*])\*(?![*\w])/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	// A title must name something: one made only of markup is no title.
	if (!/[\p{L}\p{N}]/u.test(flat)) return null;
	const chars = Array.from(flat);
	if (chars.length <= MAX_SESSION_TITLE && utf8.encode(flat).length <= MAX_SESSION_TITLE_BYTES) return flat;
	let prefix = "", bytes = 0;
	for (const char of chars.slice(0, MAX_SESSION_TITLE - 1)) {
		const size = utf8.encode(char).length;
		if (bytes + size > MAX_SESSION_TITLE_BYTES - utf8.encode("…").length) break;
		prefix += char;
		bytes += size;
	}
	const title = prefix.trimEnd() + "…";
	return /[\p{L}\p{N}]/u.test(title) ? title : null;
}
