import { afterEach, describe, expect, it } from "vitest";
import devservicesExtension from "../extensions/devservices/index.ts";
import { createFakePi } from "./fake-pi.ts";

const savedLaunch = process.env.HIVE_LAUNCH_ID;

afterEach(() => {
	if (savedLaunch === undefined) delete process.env.HIVE_LAUNCH_ID;
	else process.env.HIVE_LAUNCH_ID = savedLaunch;
});

describe("managed devservices posture", () => {
	it("removes the local start/stop bypass from Hive-launched sessions", () => {
		process.env.HIVE_LAUNCH_ID = "launch-1";
		const fake = createFakePi();
		devservicesExtension(fake.api);
		expect(fake.tools.map((tool) => tool.name)).not.toContain("dev_db_start");
		expect(fake.tools.map((tool) => tool.name)).not.toContain("dev_db_stop");
	});

	it("keeps standalone pi sessions working without Hive", () => {
		delete process.env.HIVE_LAUNCH_ID;
		const fake = createFakePi();
		devservicesExtension(fake.api);
		expect(fake.tools.map((tool) => tool.name)).toContain("dev_db_start");
		expect(fake.tools.map((tool) => tool.name)).toContain("dev_db_stop");
	});
});
