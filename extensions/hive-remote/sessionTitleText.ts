// Pure half of session_title (sessionTitle.ts), split out so it is testable
// without pi or typebox installed. Kept alike with hive's cloud copy.

/** pi's own auto-title cap: a headline, not a description. */
export const MAX_SESSION_TITLE = 72;

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
	if (flat.length <= MAX_SESSION_TITLE) return flat;
	return flat.slice(0, MAX_SESSION_TITLE - 1).trimEnd() + "…";
}
