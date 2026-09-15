import { describe, expect, it } from "vitest";
import {
	META_API_ID,
	META_BASE_URL,
	MEDIA_REF_MIME,
	decodeMediaRefDataURL,
	encodeMediaRef,
	inferKind,
	isContributorModel,
	modelsFromOverlay,
	refToBlock,
	rewritePayload,
} from "../extensions/meta-media/logic.ts";

function dataURL(part: { mimeType: string; data: string }): string {
	return `data:${part.mimeType};base64,${part.data}`;
}

describe("meta-media refs", () => {
	it("round-trips a ref through the image-part encoding pi will serialise", () => {
		const part = encodeMediaRef({ kind: "video", url: "https://uploads.linear.app/a?signature=x" });
		expect(part.type).toBe("image");
		expect(part.mimeType).toBe(MEDIA_REF_MIME);
		expect(decodeMediaRefDataURL(dataURL(part))).toEqual({ kind: "video", url: "https://uploads.linear.app/a?signature=x" });
	});

	it("ignores real images and malformed refs", () => {
		expect(decodeMediaRefDataURL("data:image/png;base64,iVBOR")).toBeNull();
		expect(decodeMediaRefDataURL(`data:${MEDIA_REF_MIME};base64,${Buffer.from("{}").toString("base64")}`)).toBeNull();
		expect(decodeMediaRefDataURL(`data:${MEDIA_REF_MIME};base64,not-json`)).toBeNull();
	});

	it("maps refs onto the vendor's blocks", () => {
		expect(refToBlock({ kind: "video", file_id: "file-1" })).toEqual({ type: "input_file", file_id: "file-1" });
		expect(refToBlock({ kind: "video", url: "https://x/a.mp4" })).toEqual({ type: "input_video", video_url: "https://x/a.mp4" });
		expect(refToBlock({ kind: "image", url: "https://x/a.png" })).toEqual({ type: "input_image", image_url: "https://x/a.png" });
		expect(refToBlock({ kind: "pdf", url: "https://x/a.pdf" })).toEqual({ type: "input_file", file_url: "https://x/a.pdf" });
	});
});

describe("rewritePayload", () => {
	// Measured 2026-09-15: pi puts a tool result's image parts in
	// function_call_output.output[], and Meta refuses non-images THERE. The
	// ref must move into a user item that follows the tool output.
	it("lifts a ref out of a tool output into a following user item", () => {
		const ref = encodeMediaRef({ kind: "video", file_id: "file-9" });
		const payload = {
			model: "muse-spark-1.3",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "watch it" }] },
				{ type: "function_call", call_id: "c1", name: "watch_media", arguments: "{}" },
				{
					type: "function_call_output",
					call_id: "c1",
					output: [
						{ type: "input_text", text: "video uploaded" },
						{ type: "input_image", detail: "auto", image_url: dataURL(ref) },
					],
				},
			],
		};
		expect(rewritePayload(payload)).toBe(1);
		expect(payload.input).toHaveLength(4);
		const toolOut = payload.input[2] as { output: unknown[] };
		expect(toolOut.output).toEqual([{ type: "input_text", text: "video uploaded" }]);
		expect(payload.input[3]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "(media attached by the tool result above)" }, { type: "input_file", file_id: "file-9" }],
		});
	});

	it("leaves real images and untouched payloads alone", () => {
		const payload = {
			input: [{ role: "user", content: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,iVBOR" }] }],
		};
		const before = JSON.stringify(payload);
		expect(rewritePayload(payload)).toBe(0);
		expect(JSON.stringify(payload)).toBe(before);
		expect(rewritePayload(null)).toBe(0);
		expect(rewritePayload({ input: "nope" })).toBe(0);
	});

	it("handles refs in a user message and several per item", () => {
		const a = encodeMediaRef({ kind: "video", url: "https://x/a.mp4" });
		const b = encodeMediaRef({ kind: "pdf", url: "https://x/b.pdf" });
		const payload = {
			input: [{ role: "user", content: [{ type: "input_text", text: "two" }, { type: "input_image", image_url: dataURL(a) }, { type: "input_image", image_url: dataURL(b) }] }],
		};
		expect(rewritePayload(payload)).toBe(2);
		const lifted = payload.input[1] as { content: unknown[] };
		expect(lifted.content[0]).toEqual({ type: "input_text", text: "(2 media items attached by the tool result above)" });
		expect(lifted.content.slice(1)).toEqual([
			{ type: "input_video", video_url: "https://x/a.mp4" },
			{ type: "input_file", file_url: "https://x/b.pdf" },
		]);
	});
});

describe("modelsFromOverlay", () => {
	// The overlay's meta models declare api=openai-responses, which routes past
	// a provider streamSimple (measured). They are re-declared on the extension's
	// api id with everything else untouched, so the overlay stays the one source.
	it("re-declares every overlay meta model on the extension's api id", () => {
		const overlay = JSON.stringify({
			providers: {
				meta: {
					baseUrl: "https://api.meta.ai/v1",
					api: "openai-responses",
					apiKey: "$META_API_KEY",
					models: [
						{ id: "muse-spark-1.3", name: "Muse Spark 1.3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: { input: 1.25 } },
						{ id: "muse-spark-1.3-contributor", api: "openai-responses", baseUrl: "https://elsewhere" },
					],
				},
				zai: { models: [{ id: "glm-5.3-flash" }] },
			},
		});
		const models = modelsFromOverlay(overlay);
		expect(models.map((m: { id: string }) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.3-contributor"]);
		for (const m of models) {
			expect(m.api).toBe(META_API_ID);
			expect(m.baseUrl).toBe(META_BASE_URL);
		}
		expect(models[0]).toMatchObject({ name: "Muse Spark 1.3", reasoning: true, contextWindow: 1048576, maxTokens: 131072, cost: { input: 1.25 } });
	});

	it("is empty, never throwing, without an overlay or a meta provider", () => {
		expect(modelsFromOverlay(null)).toEqual([]);
		expect(modelsFromOverlay("not json")).toEqual([]);
		expect(modelsFromOverlay(JSON.stringify({ providers: { zai: {} } }))).toEqual([]);
	});
});

describe("guards", () => {
	it("infers kinds from mime first, then extension, and never guesses", () => {
		expect(inferKind("video/mp4", undefined)).toBe("video");
		expect(inferKind(undefined, "https://uploads.linear.app/a/b/c.mp4?signature=x")).toBe("video");
		expect(inferKind("audio/mpeg; charset=binary", "x")).toBe("audio");
		expect(inferKind(undefined, "shot.PNG")).toBe("image");
		expect(inferKind(undefined, "https://uploads.linear.app/a/b/c?signature=x")).toBeNull();
	});

	it("names contributor models", () => {
		expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
		expect(isContributorModel("muse-spark-1.3")).toBe(false);
	});
});
