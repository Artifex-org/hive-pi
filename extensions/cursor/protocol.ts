/**
 * Connect protocol framing for Cursor's agent API (HIV-2086).
 *
 * Cursor's `api2.cursor.sh` is a Connect (connectrpc.com) server. Every public
 * integration talks to it in protobuf and therefore carries ~15k lines of
 * generated code. It also accepts **JSON** — measured on both RPC shapes:
 *
 *   unary      POST /agent.v1.AgentService/GetUsableModels   application/json
 *   streaming  POST /agent.v1.AgentService/Run               application/connect+json
 *
 * Connect's stream framing is codec-independent, so the whole wire format is
 * the ~40 lines below and the generated module is unnecessary. That is the
 * single biggest reason this extension has no runtime dependencies.
 *
 * Frame layout, from the Connect streaming spec:
 *
 *   ┌────────┬────────────────┬─────────────┐
 *   │ flags  │ length         │ payload     │
 *   │ 1 byte │ 4 bytes, BE    │ `length` B  │
 *   └────────┴────────────────┴─────────────┘
 *
 * `flags` is a bitset; only bit 1 (0x02, END_STREAM) is meaningful to us. The
 * end-of-stream frame's payload carries trailers and, on failure, an `error`.
 */

/** A normal message frame. */
export const FLAG_MESSAGE = 0x00;
/** Terminal frame; its payload holds trailers and any error. */
export const FLAG_END_STREAM = 0x02;

export interface ConnectFrame {
	flags: number;
	/** Parsed payload. Connect always sends a JSON object under this codec. */
	message: unknown;
}

/**
 * Encode one value as a Connect frame.
 *
 * The return type is the loose `Buffer<ArrayBufferLike>` that `Buffer.concat`
 * actually produces, rather than the stricter `Buffer` alias — narrowing it
 * would be a claim about the backing store that concat does not make.
 */
export function encodeFrame(value: unknown, flags: number = FLAG_MESSAGE): Uint8Array {
	const payload = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(5);
	header.writeUInt8(flags, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/**
 * Incremental frame decoder.
 *
 * Deliberately a stateful reader rather than a pure `decode(buffer)`: HTTP/2
 * data events have no relationship to frame boundaries, so a single read can
 * carry half a frame, three frames, or a frame's header split from its body.
 * Treating one `data` event as one frame appears to work in testing — small
 * responses usually do arrive whole — and then truncates long completions in
 * production, which is the worst possible failure shape for a streaming
 * provider (a silently short answer, no error).
 */
export function createFrameDecoder(): (chunk: Uint8Array) => ConnectFrame[] {
	// Typed loosely on purpose: Buffer.alloc yields Buffer<ArrayBuffer> while
	// Buffer.concat yields Buffer<ArrayBufferLike>, and the narrower annotation
	// makes the reassignment below a type error.
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	return (chunk: Uint8Array): ConnectFrame[] => {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		pending = pending.length === 0 ? incoming : Buffer.concat([pending, incoming]);
		const frames: ConnectFrame[] = [];

		for (;;) {
			if (pending.length < 5) break;
			const flags = pending.readUInt8(0);
			const length = pending.readUInt32BE(1);
			if (pending.length < 5 + length) break;

			const body = pending.subarray(5, 5 + length).toString("utf8");
			pending = pending.subarray(5 + length);

			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				// A frame we cannot parse is reported rather than dropped: silently
				// skipping it would turn a protocol change into missing output.
				message = { __unparsable: body };
			}
			frames.push({ flags, message });
		}
		return frames;
	};
}

/** True when this frame terminates the stream. */
export function isEndStream(frame: ConnectFrame): boolean {
	return (frame.flags & FLAG_END_STREAM) !== 0;
}

/**
 * The error Cursor reports inside an end-of-stream frame.
 *
 * Shape (measured):
 *   {"error":{"code":"resource_exhausted","message":"Error","details":[
 *      {"type":"aiserver.v1.ErrorDetails","debug":{"error":"ERROR_...",
 *       "details":{"title":"...","detail":"...","isRetryable":false}}}]}}
 */
export interface CursorError {
	/** Connect-level code, e.g. `resource_exhausted`. */
	code: string;
	/** Cursor's own symbol, e.g. `ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT`. */
	symbol: string;
	title: string;
	detail: string;
	retryable: boolean;
}

/**
 * Extract a usable error from an end-of-stream payload.
 *
 * THE TRAP THIS EXISTS FOR: Cursor's error CODE lies about its cause. Sending a
 * stale or malformed `x-cursor-client-version` is reported as
 * `ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT` with `actionRequired: "payment"`,
 * while the human-readable detail says "Update Required". Anything that keys
 * retry or backoff behaviour off the code will retry an unsupported client
 * forever as though it were a rate limit.
 *
 * So `title`/`detail` are the trustworthy fields, and `retryable` comes from
 * the server's own `isRetryable` rather than being inferred from the code.
 */
export function extractError(payload: unknown): CursorError | null {
	if (!payload || typeof payload !== "object") return null;
	const err = (payload as { error?: unknown }).error;
	if (!err || typeof err !== "object") return null;

	const e = err as { code?: string; message?: string; details?: unknown[] };
	const debug = (e.details ?? [])
		.map((d) => (d as { debug?: unknown })?.debug)
		.find((d): d is Record<string, unknown> => !!d && typeof d === "object");

	const inner = (debug?.details ?? {}) as {
		title?: string;
		detail?: string;
		isRetryable?: boolean;
	};

	return {
		code: e.code ?? "unknown",
		symbol: typeof debug?.error === "string" ? debug.error : "",
		title: inner.title ?? "",
		detail: inner.detail ?? e.message ?? "",
		retryable: inner.isRetryable === true,
	};
}

/** Render a Cursor error for a human, leading with the fields that are true. */
export function formatError(err: CursorError): string {
	const head = [err.title, err.detail].filter(Boolean).join(": ");
	// The symbol goes last and parenthesised — it is diagnostic, not the reason.
	return head ? `${head}${err.symbol ? ` (${err.symbol})` : ""}` : err.symbol || err.code;
}
