import { afterEach, expect, it, vi } from "vitest";
import { request } from "../extensions/hive-common/http.ts";

const auth = { token: "test", url: "https://hive.example" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Like fetch, the body stays attached to the request's signal after headers.
// A headers-only timeout would never abort this stream.
function stalledBody(signal: AbortSignal, status: number) {
	return new Response(new ReadableStream({ start(controller) {
		signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
	} }), { status, headers: { "Retry-After": "30" } });
}

it.each([200, 400, 403, 409, 429, 503])("bounds a stalled %s body without discarding known rejection metadata", async status => {
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => stalledBody(init.signal!, status)));
	const result = await request(auth, "GET", "/x", undefined, 20);
	expect(result).toMatchObject({ ok: false, error: "timeout" });
	expect(result.body).toBeUndefined();
	if (status >= 400) {
		expect(result).toMatchObject({
			status, authFailed: status === 403,
			permanent: status < 500 && status !== 403 && status !== 429,
			retryAfterMs: 30_000,
		});
	} else {
		expect(result).toMatchObject({ status: null, authFailed: false, permanent: false, retryAfterMs: null });
	}
});

it("propagates caller cancellation through body decoding", async () => {
	const caller = new AbortController();
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
		setTimeout(() => caller.abort(), 5);
		return stalledBody(init.signal!, 200);
	}));
	expect(await request(auth, "GET", "/x", undefined, 10_000, caller.signal)).toMatchObject({ ok: false, error: "timeout" });
});

it.each(["deadline", "caller"] as const)("rejects a late success from a non-cooperative transport after %s cancellation", async kind => {
	vi.useFakeTimers();
	let release!: (response: Response) => void;
	const held = new Promise<Response>(resolve => { release = resolve; });
	const fetch = vi.fn(() => held); // Intentionally ignores init.signal.
	vi.stubGlobal("fetch", fetch);
	const caller = new AbortController();
	const pending = request(auth, "GET", "/late", undefined, 20, caller.signal);
	expect(fetch).toHaveBeenCalledTimes(1);
	if (kind === "caller") caller.abort();
	else await vi.advanceTimersByTimeAsync(21);

	release(new Response("{}"));
	expect(await pending).toMatchObject({ ok: false, error: "timeout" });
});

it("does not send a request whose caller already aborted", async () => {
	const caller = new AbortController();
	caller.abort();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(await request(auth, "GET", "/x", undefined, 10_000, caller.signal)).toMatchObject({ ok: false, error: "timeout" });
	expect(fetch).not.toHaveBeenCalled();
});
