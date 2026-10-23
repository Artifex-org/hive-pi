/**
 * Secret redaction for text that leaves the process for a model: known
 * secrets verbatim, then the token shapes below.
 *
 * Shared by You Should Know (evidence handed to its scanner) and the agenda's
 * transcript fold (tool-call arguments handed to the goal judge, the drift
 * probe and the recap) — one redactor, so a shape added here covers both.
 */

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
export function redactEvidence(text: string, knownSecrets: readonly string[] = [], maxChars = 32_000): string {
	// Match the ORIGINAL input: replacing a short known value first could hide
	// an inline token's prefix from shape matching, or break an overlapping
	// known secret. Merge overlapping spans, then replace each range once.
	const matches: [number, number][] = [];
	for (const secret of new Set(knownSecrets)) {
		if (!secret) continue;
		for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) matches.push([at, at + secret.length]);
	}
	for (const pattern of SECRET_PATTERNS) {
		for (const match of text.matchAll(pattern)) matches.push([match.index, match.index + match[0].length]);
	}
	matches.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const ranges: [number, number][] = [];
	for (const span of matches) {
		const previous = ranges.at(-1);
		if (previous && span[0] < previous[1]) previous[1] = Math.max(previous[1], span[1]);
		else ranges.push(span);
	}
	const parts: string[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		parts.push(text.slice(cursor, start), "[REDACTED]");
		cursor = end;
	}
	parts.push(text.slice(cursor));
	return parts.join("").slice(0, maxChars);
}
