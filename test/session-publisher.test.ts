import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { SessionPublisher } from "../extensions/hive-common/session-publisher.ts";
import { createFakePi } from "./fake-pi.ts";

const savedEnv = { ...process.env };

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	process.env.HIVE_LAUNCH_ID = "launch-1";
	process.env.HIVE_TOKEN = "launch-token";
	process.env.HIVE_TELEMETRY_URL = "https://hive.test";
	process.env.HIVE_URL = "https://hive.test";
	delete process.env.PI_HIVE_RUN_ID;
});

afterEach(() => {
	process.env = { ...savedEnv };
	vi.unstubAllGlobals();
});

describe("SessionPublisher", () => {
	it("resolves the announced run id with the launched session credential", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ id: "session-1" }));
		vi.stubGlobal("fetch", fetch);
		const fake = createFakePi();
		const publisher = new SessionPublisher(fake.api);

		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
		const binding = await publisher.binding();
		expect(binding).toEqual({
			auth: { token: "launch-token", url: "https://hive.test", source: "$HIVE_TOKEN" },
			sessionID: "session-1",
		});
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://hive.test/api/v1/agent-sessions/by-run/run-1");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer launch-token" });

		await publisher.binding();
		expect(fetch).toHaveBeenCalledTimes(1);
		publisher.dispose();
	});

	it("drops the cached binding when telemetry announces a new run", async () => {
		const fetch = vi
			.fn(async (_input: string | URL | Request, _init?: RequestInit) => response({ id: "unused" }))
			.mockResolvedValueOnce(response({ id: "session-1" }))
			.mockResolvedValueOnce(response({ id: "session-2" }));
		vi.stubGlobal("fetch", fetch);
		const fake = createFakePi();
		const publisher = new SessionPublisher(fake.api);

		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
		expect((await publisher.binding())?.sessionID).toBe("session-1");
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-2" });
		expect((await publisher.binding())?.sessionID).toBe("session-2");
		expect(fetch.mock.calls[1][0]).toBe("https://hive.test/api/v1/agent-sessions/by-run/run-2");
		publisher.dispose();
	});
});
