import { describe, expect, it } from "vitest";
import { describeRequestBody, inferKind, reportHeader } from "../extensions/meta-media/logic.ts";

describe("inferKind", () => {
	it("takes an explicit hint first, then mime, then extension", () => {
		expect(inferKind("VIDEO", undefined, undefined)).toBe("video");
		expect(inferKind(undefined, "audio/mpeg; charset=binary", "x")).toBe("audio");
		expect(inferKind(undefined, undefined, "https://uploads.linear.app/a/b/c.mp4?signature=x")).toBe("video");
		expect(inferKind(undefined, undefined, "shot.PNG")).toBe("image");
		expect(inferKind("nonsense", undefined, "file.pdf")).toBe("pdf");
	});
	it("never guesses when nothing says", () => {
		expect(inferKind(undefined, undefined, "https://uploads.linear.app/a/b/c?signature=x")).toBeNull();
		expect(inferKind(undefined, "application/octet-stream", "blob")).toBeNull();
	});
});

describe("describeRequestBody", () => {
	it("carries url always, kind and question only when present", () => {
		expect(describeRequestBody("https://x/a.mp4", "video", "what broke?")).toEqual({
			url: "https://x/a.mp4",
			kind: "video",
			question: "what broke?",
		});
		expect(describeRequestBody("https://x/a", null, "   ")).toEqual({ url: "https://x/a" });
	});
});

describe("reportHeader", () => {
	it("names the model and token count, with fallbacks", () => {
		expect(reportHeader("meta/muse-spark-1.3", 8555)).toBe("[watched server-side by meta/muse-spark-1.3, 8555 input tokens]");
		expect(reportHeader(undefined, undefined)).toBe("[watched server-side by a video-capable model]");
	});
});
