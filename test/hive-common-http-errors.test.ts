import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../extensions/hive-common/http.ts";

const auth = { token: "hive_test", url: "https://hive.example" };

function respondWith(status: number, body: string, contentType = "application/problem+json") {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// A rejection the caller cannot explain is a rejection nobody can fix.
//
// This dropped the server's problem+json body and returned the status alone, so
// an attach refused for a nameable reason ("agent capability description is too
// long") surfaced as nothing but `attached: no`. Diagnosing one meant replaying
// the request by hand with curl to read a message the client had already
// received (HIV-1163).
describe("request error reporting", () => {
	it("keeps Hive's explanation of a 400", async () => {
		respondWith(
			400,
			JSON.stringify({ code: "bad_request", detail: "agent capability description is too long" }),
		);

		const res = await request(auth, "PUT", "/agent-sessions/x/conversation", {});

		expect(res.ok).toBe(false);
		expect(res.status).toBe(400);
		expect(res.permanent).toBe(true);
		expect(res.error).toBe("agent capability description is too long");
	});

	it("falls back to the `error` field when there is no detail", async () => {
		respondWith(400, JSON.stringify({ error: "too many agent capabilities" }));

		expect((await request(auth, "PUT", "/x")).error).toBe("too many agent capabilities");
	});

	it("bounds the message so a proxy's error page cannot become one", async () => {
		respondWith(502, JSON.stringify({ detail: "x".repeat(5_000) }));

		const res = await request(auth, "GET", "/x");
		expect(res.error!.length).toBeLessThanOrEqual(200);
	});

	it("reports no message when the body is not JSON", async () => {
		respondWith(502, "<html>Bad Gateway</html>", "text/html");

		const res = await request(auth, "GET", "/x");
		expect(res.error).toBeUndefined();
		expect(res.status).toBe(502);
	});

	// The opposite case, and the reason `redact` exists: a THROWN error can embed
	// the request URL, and a URL can carry a token. Only a response body Hive
	// itself wrote is ever surfaced verbatim.
	it("still redacts a thrown network error rather than surfacing it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError(`fetch failed for ${auth.url}/api/v1/x?token=hive_secret`);
			}),
		);

		const res = await request(auth, "GET", "/x");
		expect(res.error).toBe("TypeError");
		expect(res.error).not.toContain("hive_secret");
	});
});
