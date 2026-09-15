/**
 * meta-media — pure logic (HIV-3566). No pi or network imports, so every rule
 * here is testable without a session.
 *
 * The extension is a thin, guarded pi-native front for Hive's media watcher
 * (POST /media/describe, HIV-3565): a `watch_media` tool that hands a media URL
 * to a video-capable model server-side and returns its timeline + transcript +
 * verdict as text. That works on EVERY provider, because the watching happens
 * in hive-server, not in this session's model.
 *
 * WHY NOT ATTACH THE MEDIA TO THE MODEL DIRECTLY. pi's content parts are text
 * and image only; carrying a video would mean rewriting the provider payload,
 * which needs either the forbidden `before_provider_request`/`context` hooks or
 * a wrap of pi's built-in transport reached through `@earendil-works/pi-ai/compat`
 * — a non-root subpath the repo bans (test/pi-api-surface). Reimplementing the
 * Responses streaming protocol in an extension just to rewrite one payload is
 * disproportionate, so native in-conversation attachment is deferred and the
 * watcher runs server-side instead. The user-visible result is the same text.
 */

export type MediaKind = "video" | "audio" | "image" | "pdf";

/** Media kind from an explicit hint, a mime type, or a file name / URL; null when none says. */
export function inferKind(explicit: string | undefined, contentType: string | undefined, name: string | undefined): MediaKind | null {
	const hint = (explicit ?? "").trim().toLowerCase();
	if (hint === "video" || hint === "audio" || hint === "image" || hint === "pdf") return hint;
	const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
	if (ct.startsWith("video/")) return "video";
	if (ct.startsWith("audio/")) return "audio";
	if (ct.startsWith("image/")) return "image";
	if (ct === "application/pdf") return "pdf";
	const bare = (name ?? "").split(/[?#]/)[0].toLowerCase();
	const ext = bare.includes(".") ? bare.slice(bare.lastIndexOf(".")) : "";
	if ([".mp4", ".webm", ".mov", ".m4v", ".mkv"].includes(ext)) return "video";
	if ([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
	if (ext === ".pdf") return "pdf";
	return null;
}

export interface DescribeBody {
	url: string;
	kind?: string;
	question?: string;
}

/** The JSON body for POST /media/describe. Pure, so the wire shape is tested. */
export function describeRequestBody(url: string, kind: MediaKind | null, question: string | undefined): DescribeBody {
	const body: DescribeBody = { url };
	if (kind) body.kind = kind;
	const q = (question ?? "").trim();
	if (q) body.question = q;
	return body;
}

/** The header line prepended to the watcher's report so the reader knows how it was produced. */
export function reportHeader(model: string | undefined, inputTokens: number | undefined): string {
	return `[watched server-side by ${model ?? "a video-capable model"}${inputTokens ? `, ${inputTokens} input tokens` : ""}]`;
}
