/**
 * meta-media (HIV-3566) — pi-native video/audio/pdf on the meta provider, and
 * one `watch_media` tool that works on every other provider too.
 *
 * Two halves:
 *
 *  1. PROVIDER. Re-registers the overlay's `meta` models on this extension's
 *     own api id with a `streamSimple` that wraps pi-ai's Responses transport
 *     and rewrites the request through `onPayload` (see logic.ts for the two
 *     placement rules that were measured, not assumed). Without this, a meta
 *     session is text+image like any other.
 *
 *  2. TOOL. `watch_media {url | path, question?}`:
 *       - on a meta session: the media is attached to the conversation itself
 *         (a URL goes through as-is; a local file is uploaded to Meta's Files
 *         API with a one-hour expiry) and the model reads it on the next turn;
 *       - on any other session: Hive's watcher (`POST /media/describe`,
 *         HIV-3565) analyses it and the tool returns the report as text. The
 *         sandbox allowlist is derived from the launch model's provider, so a
 *         Codex/GLM session cannot reach api.meta.ai and must not try.
 *
 * BOUNDARY. A media ref lives in the session history as an image part with a
 * private mime, rewritten to a real media block only on meta's own transport.
 * It is therefore meta-only by construction. Switching a session that already
 * attached media to another provider is the one unsupported case: that provider
 * would receive an image part it cannot read. We do NOT guard it with a
 * `context` hook — that hook switches on a per-call transform pi otherwise skips
 * and is a prompt-cache hazard the repo forbids (test/no-forbidden-events).
 * Start a fresh session on the other provider, or use watch_media there, which
 * returns Hive's watcher report as plain text and never plants a ref.
 *
 * NEVER a contributor model: the tool refuses to attach media on a session
 * whose model is `*-contributor`, because the vendor trains on that tier's
 * inputs and bug-report media is a customer's screen and voice.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAuth } from "../hive-common/identity.ts";
import {
	META_API_ID,
	META_BASE_URL,
	encodeMediaRef,
	fallbackNotice,
	inferKind,
	isContributorModel,
	modelsFromOverlay,
	rewritePayload,
	type MediaKind,
	type MediaRef,
} from "./logic.ts";

const UPLOAD_TTL_SECONDS = 3600;
const MAX_UPLOAD_BYTES = 50_000_000;
const HIVE_DESCRIBE_TIMEOUT_MS = 4 * 60_000;

function overlayPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "models.json");
}

function readOverlay(): string | null {
	try {
		return fs.readFileSync(overlayPath(), "utf8");
	} catch {
		return null;
	}
}

async function uploadToMeta(filePath: string, kind: MediaKind, signal?: AbortSignal): Promise<MediaRef> {
	const key = process.env.META_API_KEY?.trim();
	if (!key) throw new Error("META_API_KEY is not set in this session; Hive injects it for a meta launch");
	const stat = fs.statSync(filePath);
	if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`${filePath} is ${stat.size} bytes; Meta's inline limit is ${MAX_UPLOAD_BYTES}`);
	const form = new FormData();
	// purpose and expiry BEFORE the file part: Meta documents lower latency for that order.
	form.set("purpose", "user_data");
	form.set("expires_after[anchor]", "created_at");
	form.set("expires_after[seconds]", String(UPLOAD_TTL_SECONDS));
	form.set("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
	const res = await fetch(`${META_BASE_URL}/files`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal });
	const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
	if (!res.ok || !body.id) throw new Error(`upload failed: HTTP ${res.status} ${body.error?.message ?? ""}`.trim());
	return { kind, file_id: body.id };
}

async function describeViaHive(url: string, kind: MediaKind | null, question: string | undefined, signal?: AbortSignal): Promise<string> {
	const auth = resolveAuth();
	if (!auth) throw new Error("no Hive credential is available in this session, so the watcher cannot be asked");
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), HIVE_DESCRIBE_TIMEOUT_MS);
	signal?.addEventListener("abort", () => ctl.abort(), { once: true });
	try {
		const res = await fetch(`${auth.url}/api/v1/media/describe`, {
			method: "POST",
			headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ url, kind: kind ?? undefined, question }),
			signal: ctl.signal,
		});
		const body = (await res.json().catch(() => ({}))) as { text?: string; model?: string; input_tokens?: number; error?: string; skipped?: string[] };
		if (!res.ok) throw new Error(`Hive watcher: HTTP ${res.status} ${body.error ?? ""}`.trim());
		const head = `[watched by ${body.model ?? "?"}, ${body.input_tokens ?? "?"} input tokens]`;
		return `${head}\n\n${body.text ?? ""}`;
	} finally {
		clearTimeout(timer);
	}
}

export default function metaMedia(pi: ExtensionAPI) {
	const inner = getApiProvider("openai-responses")?.streamSimple;
	if (!inner) throw new Error("meta-media: pi-ai registered no openai-responses transport to wrap");
	const models = modelsFromOverlay(readOverlay());

	// 1. The provider. Registered even with an empty model list: a machine whose
	// overlay lacks meta simply has no meta models, exactly as before.
	pi.registerProvider("meta", {
		name: "Meta (Muse Spark, media-capable)",
		baseUrl: META_BASE_URL,
		apiKey: "$META_API_KEY",
		api: META_API_ID as never,
		streamSimple: (model, context, options) =>
			inner({ ...model, api: "openai-responses" }, context, {
				...(options ?? {}),
				onPayload: async (payload: unknown, m: typeof model) => {
					rewritePayload(payload);
					return options?.onPayload ? await options.onPayload(payload, m) : payload;
				},
			}),
		...(models.length ? { models: models as never } : {}),
	});

	// 2. The tool.
	pi.registerTool({
		name: "watch_media",
		label: "Watch media",
		promptSnippet: "Attach a video/audio/PDF (URL or file) so it can be watched, or get Hive's watcher report",
		description: [
			"Give the model a screen recording, voice note, screenshot or PDF to read. Pass `url` (an https URL",
			"such as the signed link in a Linear ticket's 🎥 [Screen recording](…)) or `path` (a local file).",
			"On a meta session the media is attached to the conversation and read on the next turn; on any other",
			"provider Hive's watcher model analyses it and this tool returns a timestamped timeline, transcript",
			"and triage verdict as text. Costs one prompt of the media provider's subscription window.",
		].join(" "),
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "https URL of the media" })),
			path: Type.Optional(Type.String({ description: "local file path (meta sessions only)" })),
			kind: Type.Optional(Type.String({ description: "video | audio | image | pdf; inferred when omitted" })),
			question: Type.Optional(Type.String({ description: "what to look for; appended to the analysis prompt" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const provider = ctx.model?.provider;
			const modelId = ctx.model?.id ?? "";
			const url = params.url?.trim();
			const filePath = params.path?.trim();
			if (!url && !filePath) throw new Error("pass url or path");
			if (url && !url.startsWith("https://")) throw new Error("url must be https://");
			const kind = (params.kind?.trim().toLowerCase() as MediaKind | undefined) || inferKind(undefined, url ?? filePath) || (url ? null : "video");

			if (provider !== "meta") {
				if (!url) throw new Error("a local file can only be attached on a meta session; upload it somewhere reachable and pass url");
				const text = await describeViaHive(url, kind, params.question, signal);
				return { content: [{ type: "text", text: `${fallbackNotice(provider)}\n\n${text}` }], details: { via: "hive", kind } };
			}
			if (isContributorModel(modelId)) {
				throw new Error(
					`this session runs ${modelId}, a contributor-tier model that trains on its inputs; switch to meta/muse-spark-1.3 (standard) before attaching customer media`,
				);
			}
			let ref: MediaRef;
			if (filePath) {
				const abs = path.isAbsolute(filePath) ? filePath : path.join(ctx.cwd, filePath);
				ref = await uploadToMeta(abs, kind ?? "video", signal);
			} else {
				ref = { kind: kind ?? "video", url: url! };
			}
			const where = ref.file_id ? `uploaded as ${ref.file_id} (expires in ${UPLOAD_TTL_SECONDS / 60} min)` : "attached by URL";
			const ask = params.question ? ` Question to answer: ${params.question}` : "";
			return {
				content: [
					{ type: "text", text: `${ref.kind} ${where}. It is part of the conversation now: describe what it shows with timestamps, transcribe any speech, and say what problem it demonstrates.${ask}` },
					encodeMediaRef(ref),
				],
				details: { via: "meta", kind: ref.kind, uploaded: Boolean(ref.file_id) },
			};
		},
	});
}
