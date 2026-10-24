import type { AssistantMessage } from "@earendil-works/pi-ai";

export const FALLBACK_PROVIDER = "zai";
export const FALLBACK_MODEL = "glm-5.3-flash";
export const FALLBACK_LABEL = `${FALLBACK_PROVIDER}/${FALLBACK_MODEL}`;

/** Only provider errors, never assistant prose, prompts, or tool output. */
export function isCybersecurityError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const supported = ["openai", "openai-codex", "anthropic", "azure-openai-responses"].includes(message.provider)
		|| (message.provider === "openrouter" && /^(?:openai|anthropic)\//.test(message.model));
	if (!supported) return false;
	const text = message.errorMessage.replaceAll("_", " "); // structured error codes use underscores
	// Explicit cyber-safety codes are sufficient; a bare mention of cybersecurity
	// is not (e.g. "cybersecurity service unavailable" is an infrastructure error).
	return /\bcyber[ -]*safety\b/i.test(text)
		|| (/\bcyber[ -]?security\b/i.test(text)
			&& /\b(?:block(?:ed)?|flagged|refus\w*|policy|policies|safety|disallowed|not allowed)\b/i.test(text));
}
