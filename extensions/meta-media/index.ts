/**
 * meta-media (HIV-3566) — a pi-native `watch_media` tool so an agent on any
 * model can have a video-capable model watch a screen recording, voice note,
 * screenshot or PDF and get back a timeline, transcript and triage verdict.
 *
 * The watching runs SERVER-SIDE (Hive's POST /media/describe, HIV-3565), which
 * is why it works on every provider — a Codex or GLM session cannot take video
 * itself, and its sandbox cannot even reach api.meta.ai, but it can ask Hive to
 * run the watcher on its behalf and return text. See logic.ts for why the media
 * is not attached to this session's own model directly.
 *
 * This is the ergonomic twin of the `describe_media` MCP tool: same endpoint,
 * but a first-class entry in the toolset with a task-shaped prompt, so a
 * low-tier agent does not have to reach it through the `mcp` meta-tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAuth } from "../hive-common/identity.ts";
import { describeRequestBody, inferKind, reportHeader, type MediaKind } from "./logic.ts";
import { META_BASE_URL, metaModels } from "./provider.ts";

const DESCRIBE_TIMEOUT_MS = 4 * 60_000;

interface DescribeResponse {
	text?: string;
	model?: string;
	input_tokens?: number;
	skipped?: string[];
	error?: string;
}

async function describeViaHive(url: string, kind: MediaKind | null, question: string | undefined, signal?: AbortSignal): Promise<string> {
	const auth = resolveAuth();
	if (!auth) throw new Error("no Hive credential is available in this session, so the media watcher cannot be reached");
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), DESCRIBE_TIMEOUT_MS);
	signal?.addEventListener("abort", () => ctl.abort(), { once: true });
	try {
		const res = await fetch(`${auth.url}/api/v1/media/describe`, {
			method: "POST",
			headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(describeRequestBody(url, kind, question)),
			signal: ctl.signal,
		});
		const body = (await res.json().catch(() => ({}))) as DescribeResponse;
		if (!res.ok) throw new Error(`Hive media watcher: HTTP ${res.status} ${body.error ?? ""}`.trim());
		const skipped = body.skipped?.length ? `\n\n(skipped: ${body.skipped.join("; ")})` : "";
		return `${reportHeader(body.model, body.input_tokens)}\n\n${body.text ?? ""}${skipped}`;
	} finally {
		clearTimeout(timer);
	}
}

export default function metaMedia(pi: ExtensionAPI) {
	// Declare the Meta provider in the base harness so Muse Spark is launchable
	// wherever pi runs — workstation and the factory image alike (HIV-3563).
	// Models only: Muse Spark speaks OpenAI Responses, so pi's built-in transport
	// serves it and no /compat transport wrap is needed.
	pi.registerProvider("meta", {
		name: "Meta (Muse Spark)",
		baseUrl: META_BASE_URL,
		apiKey: "$META_API_KEY",
		api: "openai-responses",
		models: metaModels as never,
	});

	// A network read that returns text: no filesystem write, no subprocess, so it
	// is registered plain and listed in the tool-capability conformance READ_ONLY
	// map (like fetch_content). Egress is governed server-side by /media/describe's
	// trigger scope, not here.
	pi.registerTool({
		name: "watch_media",
		label: "Watch media",
		promptSnippet: "Have a video-capable model watch a media URL and return a timeline, transcript and triage verdict",
		description: [
			"Give a video-capable model a screen recording, voice note, screenshot or PDF to watch and get back a",
			"timestamped timeline, a speaker-separated transcript, and a triage verdict as text. Pass `url` — an",
			"https URL, such as the signed link in a Linear ticket's 🎥 [Screen recording](…) or a Sentry replay.",
			"Works on any model: the watching runs server-side on Hive's media provider. Costs one prompt of that",
			"provider's subscription window (≈265 input tokens per second of video), so use it once per clip, not per turn.",
		].join(" "),
		parameters: Type.Object({
			url: Type.String({ description: "https URL of the media to watch" }),
			kind: Type.Optional(Type.String({ description: "video | audio | image | pdf; inferred from the URL when omitted" })),
			question: Type.Optional(Type.String({ description: "a specific question to answer; appended to the standard triage prompt" })),
		}),
		async execute(_id, params, signal) {
			const url = params.url?.trim();
			if (!url) throw new Error("url is required");
			if (!url.startsWith("https://")) throw new Error("url must be an https:// address the watcher can fetch");
			const kind = inferKind(params.kind, undefined, url);
			const text = await describeViaHive(url, kind, params.question, signal);
			return { content: [{ type: "text", text }], details: { kind: kind ?? "unknown" } };
		},
	});
}
