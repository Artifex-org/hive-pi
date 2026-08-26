import { describe, expect, it } from "vitest";

import {
	createFrameDecoder,
	encodeFrame,
	extractError,
	formatError,
	FLAG_END_STREAM,
	isEndStream,
} from "./protocol.ts";

describe("connect framing", () => {
	it("round-trips a message", () => {
		const decode = createFrameDecoder();
		const frames = decode(encodeFrame({ hello: "world" }));
		expect(frames).toHaveLength(1);
		expect(frames[0].message).toEqual({ hello: "world" });
		expect(isEndStream(frames[0])).toBe(false);
	});

	// The bug this exists for: HTTP/2 data events have NO relationship to frame
	// boundaries. A decoder that assumes one event is one frame passes every
	// small-response test and then silently truncates long completions in
	// production — a short answer with no error, the worst shape of failure for
	// a streaming provider.
	it("reassembles a frame split across chunks, byte by byte", () => {
		const decode = createFrameDecoder();
		const buf = encodeFrame({ text: "a reasonably long streamed answer" });

		const collected = [];
		for (const byte of buf) collected.push(...decode(Buffer.from([byte])));

		expect(collected).toHaveLength(1);
		expect(collected[0].message).toEqual({ text: "a reasonably long streamed answer" });
	});

	it("splits several frames arriving in one chunk", () => {
		const decode = createFrameDecoder();
		const chunk = Buffer.concat([
			encodeFrame({ n: 1 }),
			encodeFrame({ n: 2 }),
			encodeFrame({ done: true }, FLAG_END_STREAM),
		]);
		const frames = decode(chunk);
		expect(frames.map((f) => f.message)).toEqual([{ n: 1 }, { n: 2 }, { done: true }]);
		expect(isEndStream(frames[2])).toBe(true);
	});

	it("holds back a partial trailing frame instead of emitting a truncated one", () => {
		const decode = createFrameDecoder();
		const whole = encodeFrame({ value: "complete" });
		const first = decode(Buffer.concat([encodeFrame({ n: 1 }), whole.subarray(0, 4)]));
		expect(first.map((f) => f.message)).toEqual([{ n: 1 }]);

		const second = decode(whole.subarray(4));
		expect(second.map((f) => f.message)).toEqual([{ value: "complete" }]);
	});

	it("surfaces an unparsable payload rather than dropping it", () => {
		const decode = createFrameDecoder();
		const payload = Buffer.from("not json", "utf8");
		const head = Buffer.alloc(5);
		head.writeUInt8(0, 0);
		head.writeUInt32BE(payload.length, 1);

		const [frame] = decode(Buffer.concat([head, payload]));
		expect(frame.message).toEqual({ __unparsable: "not json" });
	});
});

describe("error extraction", () => {
	// THE trap. Sending a stale/malformed client version is reported as
	// ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT with actionRequired "payment", while
	// the human-readable detail says "Update Required". Any retry logic keyed off
	// the code would retry an unsupported client forever as a rate limit.
	const updateRequired = {
		error: {
			code: "resource_exhausted",
			message: "Error",
			details: [
				{
					type: "aiserver.v1.ErrorDetails",
					debug: {
						error: "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
						details: {
							title: "Update Required",
							detail: "Your version of Cursor is no longer supported.",
							isRetryable: false,
						},
					},
				},
			],
		},
	};

	it("reports the human-readable cause, not the misleading code", () => {
		const err = extractError(updateRequired);
		expect(err).not.toBeNull();
		expect(err?.title).toBe("Update Required");
		expect(err?.detail).toContain("no longer supported");
		// The code says rate-limit; it must not be what a caller reads as the cause.
		expect(err?.code).toBe("resource_exhausted");
		expect(err?.retryable).toBe(false);
	});

	it("formats leading with the true cause and demotes the symbol", () => {
		const text = formatError(extractError(updateRequired)!);
		expect(text.startsWith("Update Required")).toBe(true);
		// Present for diagnosis, but parenthesised and last -- never the headline.
		expect(text).toContain("(ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT)");
	});

	it("returns null for a clean end-of-stream", () => {
		expect(extractError({})).toBeNull();
		expect(extractError({ metadata: {} })).toBeNull();
	});

	it("never claims retryable when the server did not say so", () => {
		// Absent isRetryable must read as NOT retryable: retrying a permanent
		// failure burns the account's allowance for nothing.
		const err = extractError({
			error: { code: "internal", details: [{ debug: { error: "X", details: { title: "T" } } }] },
		});
		expect(err?.retryable).toBe(false);
	});
});
