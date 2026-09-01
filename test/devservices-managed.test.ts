import { afterEach, describe, expect, it, vi } from "vitest";
import devservicesExtension from "../extensions/devservices/index.ts";
import { HIVE_SESSION_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi } from "./fake-pi.ts";

const savedEnv = { ...process.env };

type ToolExecute = (id: string, params: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text?: string }>;
	details: unknown;
}>;

function response(body: unknown = {}, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function managedHarness(status = 200) {
	process.env.HIVE_LAUNCH_ID = "launch-1";
	process.env.HIVE_TOKEN = "token";
	process.env.HIVE_TELEMETRY_URL = "https://hive.test";
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/agent-sessions/by-run/run-1")) return response({ id: "session-1" });
		if (url.endsWith("/agent-sessions/session-1/resources")) return response({ resources: [] }, status);
		return response({}, 404);
	});
	vi.stubGlobal("fetch", fetch);
	const fake = createFakePi();
	devservicesExtension(fake.api);
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-1" });
	const tool = fake.tools.find((candidate) => candidate.name === "dev_db_start");
	return { fake, execute: tool?.definition.execute as ToolExecute };
}

afterEach(() => {
	process.env = { ...savedEnv };
	vi.unstubAllGlobals();
});

describe("managed devservices posture", () => {
	it("redirects the compatibility tool when the managed API exists", async () => {
		const { execute } = managedHarness();
		const result = await execute("call-1", { database: "app" });
		expect(result.details).toEqual({ managed: true, resource: "postgres", action: "start" });
		expect(result.content[0].text).toContain("request_resource");
	});

	it("refuses an untracked start during a transient Hive outage", async () => {
		const { execute } = managedHarness(503);
		await expect(execute("call-1", { database: "app" })).rejects.toThrow("temporarily unavailable");
	});

	it("keeps standalone pi sessions on the direct local tool surface", () => {
		delete process.env.HIVE_LAUNCH_ID;
		const fake = createFakePi();
		devservicesExtension(fake.api);
		expect(fake.tools.map((tool) => tool.name)).toContain("dev_db_start");
		expect(fake.tools.map((tool) => tool.name)).toContain("dev_db_stop");
	});
});
