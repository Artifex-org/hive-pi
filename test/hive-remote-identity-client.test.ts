import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionIdentity, putSessionIdentity } from "../extensions/hive-remote/client.ts";

const auth = { url: "https://hive.example", token: "test-token" };
afterEach(() => vi.restoreAllMocks());

describe("Hive session identity transport", () => {
	it("reads identity from the existing canonical conversation endpoint", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			title: "Pinned", description: "Goal: continue.", description_provisional: false, identity_revision: 7, title_pinned: true,
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const result = await getSessionIdentity(auth, "session/1");
		expect(result.body).toMatchObject({ title: "Pinned", identity_revision: 7, title_pinned: true });
		expect(fetch.mock.calls[0][0]).toBe("https://hive.example/api/v1/agent-sessions/session%2F1/conversation");
	});

	it("preserves authoritative metadata on a stale 409 instead of hiding it", async () => {
		const authoritative = { title: "Newer", description: "Goal: authoritative.", description_provisional: false, identity_revision: 12, title_pinned: true };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(authoritative), { status: 409, headers: { "content-type": "application/json" } }));
		const result = await putSessionIdentity(auth, "session-1", {
			revision: 9, title: "Old", description: "Goal: stale.", provisional: false, source: "description",
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(409);
		expect(result.body).toEqual(authoritative);
	});
});
