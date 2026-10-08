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
export function redactEvidence(text: string, knownSecrets: readonly string[] = []): string {
	let result = text;
	for (const secret of knownSecrets) if (secret) result = result.split(secret).join("[REDACTED]");
	for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
	return result.slice(0, 32_000);
}
