import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claimResourceRequests,
	completeResourceRequest,
	reportResource,
} from "../extensions/devservices/resource.ts";

const auth = { token: "token", url: "https://hive.test" };

function response(body: unknown = {}, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("devservices resource API", () => {
	it("claims only through the attached session route", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ items: [] }));
		vi.stubGlobal("fetch", fetch);
		const result = await claimResourceRequests(auth, "session/one");
		expect(result.ok).toBe(true);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://hive.test/api/v1/agent-sessions/session%2Fone/resource-requests/claim");
		expect(init?.method).toBe("POST");
	});

	it("publishes the generation-fenced loopback reading", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ resource: {} }));
		vi.stubGlobal("fetch", fetch);
		const report = {
			generation: "generation-1",
			sequence: 3,
			state: "ready" as const,
			health: "healthy" as const,
			database_name: "app",
			host: "127.0.0.1",
			port: 55432,
			connection_url: "postgresql://dev@127.0.0.1:55432/app",
			process_id: 42,
			ttl_seconds: 45,
		};
		const result = await reportResource(auth, "session-1", "postgres", report);
		expect(result.ok).toBe(true);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://hive.test/api/v1/agent-sessions/session-1/resources/postgres");
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual(report);
	});

	it("completes one claimed request with duration and bounded error", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
		vi.stubGlobal("fetch", fetch);
		const result = await completeResourceRequest(auth, "session-1", "request-1", false, "failed", 123);
		expect(result.ok).toBe(true);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(
			"https://hive.test/api/v1/agent-sessions/session-1/resource-requests/request-1/complete",
		);
		expect(JSON.parse(String(init?.body))).toEqual({
			ok: false,
			error: "failed",
			duration_ms: 123,
		});
	});
});
