/**
 * meta-media — pure logic (HIV-3566). No pi imports, so every rule here is
 * testable without a session.
 *
 * THE CONTRACT. pi's content parts are text and image, and its schema will
 * not admit a third kind. So a piece of media rides INSIDE an image part with a
 * private mime type, `application/x-hive-media-ref`, whose base64 body is a
 * small JSON ref: `{kind, url}` for a URL the vendor fetches itself, or
 * `{kind, file_id}` for a file the tool uploaded. pi serialises that part for
 * the Responses API as `input_image` with a data URL — measured 2026-09-15, it
 * does so for ANY mime — and `rewritePayload` turns it back into the block the
 * vendor understands (`input_video` / `input_file`) before the request leaves.
 *
 * TWO PLACEMENT RULES, both measured, both non-obvious:
 *
 *  1. A tool result's parts land in `function_call_output.output[]`, and Meta
 *     refuses anything but a real image THERE ("unsupported media type at
 *     input[5].output[1]: video/mp4"). So a ref is LIFTED out of the tool
 *     output into a following user item, which is where `input_file` and
 *     `input_video` are accepted.
 *  2. The overlay's meta models declare `api: openai-responses`, which routes
 *     them to pi's built-in transport and past any provider `streamSimple`. The
 *     extension therefore re-registers those models under its OWN api id; that
 *     replaces the provider's list, so it must re-register ALL of them, read
 *     from the overlay rather than retyped.
 */

export const MEDIA_REF_MIME = "application/x-hive-media-ref";
export const META_API_ID = "meta-responses";
export const META_BASE_URL = "https://api.meta.ai/v1";

export type MediaKind = "video" | "audio" | "image" | "pdf";

export interface MediaRef {
	kind: MediaKind;
	url?: string;
	file_id?: string;
	/** original mime, when known — audio needs its format on the wire */
	mime?: string;
}

/** Encode a ref as the image part pi will carry. */
export function encodeMediaRef(ref: MediaRef): { type: "image"; mimeType: string; data: string } {
	return { type: "image", mimeType: MEDIA_REF_MIME, data: Buffer.from(JSON.stringify(ref), "utf8").toString("base64") };
}

/** Decode a data URL (`data:<mime>;base64,<body>`) back into a ref, or null when it is not one of ours. */
export function decodeMediaRefDataURL(url: string): MediaRef | null {
	const prefix = `data:${MEDIA_REF_MIME};base64,`;
	if (!url.startsWith(prefix)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(url.slice(prefix.length), "base64").toString("utf8")) as MediaRef;
		if (!parsed || typeof parsed !== "object" || !parsed.kind) return null;
		if (!parsed.url && !parsed.file_id) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** The Responses-API block for a ref. Mirrors hive's mediaunderstand.fileBlock. */
export function refToBlock(ref: MediaRef): Record<string, unknown> {
	if (ref.file_id) return { type: "input_file", file_id: ref.file_id };
	switch (ref.kind) {
		case "video":
			return { type: "input_video", video_url: ref.url };
		case "image":
			return { type: "input_image", image_url: ref.url };
		default:
			return { type: "input_file", file_url: ref.url };
	}
}

/**
 * Rewrite a Responses payload in place: every media-ref image part is removed
 * from where pi put it and re-attached as a user item directly after, so the
 * model sees the media at the point in the conversation it was fetched.
 * Returns how many refs were lifted (0 = payload untouched).
 */
export function rewritePayload(payload: unknown): number {
	const p = payload as { input?: unknown };
	if (!p || !Array.isArray(p.input)) return 0;
	const out: unknown[] = [];
	let lifted = 0;
	for (const item of p.input as Array<Record<string, unknown>>) {
		const refs: MediaRef[] = [];
		const strip = (parts: unknown): unknown => {
			if (!Array.isArray(parts)) return parts;
			return parts.filter((part) => {
				const url = (part as { type?: string; image_url?: unknown })?.image_url;
				if ((part as { type?: string })?.type !== "input_image" || typeof url !== "string") return true;
				const ref = decodeMediaRefDataURL(url);
				if (!ref) return true;
				refs.push(ref);
				return false;
			});
		};
		if (item && typeof item === "object") {
			if ("content" in item) item.content = strip(item.content);
			if ("output" in item) item.output = strip(item.output);
		}
		out.push(item);
		if (refs.length) {
			lifted += refs.length;
			out.push({
				role: "user",
				content: [
					{ type: "input_text", text: `(${refs.length === 1 ? "media" : `${refs.length} media items`} attached by the tool result above)` },
					...refs.map(refToBlock),
				],
			});
		}
	}
	p.input = out;
	return lifted;
}

/** Media kind from a mime type or a file name / URL; null when neither says. */
export function inferKind(contentType: string | undefined, name: string | undefined): MediaKind | null {
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

/** Contributor-tier models train on their inputs; customer media never goes there. */
export function isContributorModel(modelId: string): boolean {
	return modelId.endsWith("-contributor");
}

export interface OverlayModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	cost?: unknown;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: unknown;
	compat?: unknown;
}

/**
 * The overlay's meta models, re-declared on this extension's api id. The
 * overlay is the one source of the model definitions (hive's catalog and its
 * drift test read the same file); this only swaps the transport.
 */
export function modelsFromOverlay(overlayJSON: string | null): OverlayModel[] {
	if (!overlayJSON) return [];
	let doc: { providers?: Record<string, { models?: OverlayModel[] }> };
	try {
		doc = JSON.parse(overlayJSON);
	} catch {
		return [];
	}
	const models = doc?.providers?.meta?.models ?? [];
	return models
		.filter((m) => m && typeof m.id === "string" && m.id)
		.map((m) => {
			// `provider` is not a models.json field; `api` is replaced. Everything
			// else rides through untouched so cost, context and thinking levels
			// stay exactly what the overlay says.
			const { api: _api, baseUrl: _baseUrl, ...rest } = m;
			return { ...rest, api: META_API_ID, baseUrl: META_BASE_URL };
		});
}

/** Text shown when the tool falls back to Hive's watcher for a non-meta session. */
export function fallbackNotice(provider: string | undefined): string {
	return provider === "meta"
		? ""
		: `This session runs on ${provider ?? "an unknown provider"}, which cannot take media directly; Hive's watcher model analysed it and this is its report.`;
}
