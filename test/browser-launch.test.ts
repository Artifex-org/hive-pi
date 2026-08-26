import { describe, expect, it } from "vitest";
import { buildLaunchPlan, parseAuthenticatedProxy } from "../extensions/browser/launch.ts";

// The browser extension's pure core: how the srt sandbox environment is
// translated into Playwright launch options (HIV-1636). The browser itself is
// exercised by the gated integration test in browser-integration.test.ts.

describe("parseAuthenticatedProxy", () => {
	it("translates srt proxy userinfo — Chromium ignores env credentials (crbug 16709)", () => {
		const proxy = parseAuthenticatedProxy({
			HTTPS_PROXY: "http://srt.abc%3D%3D:tok123@localhost:3128",
		});
		expect(proxy).toEqual({
			server: "http://localhost:3128",
			username: "srt.abc==",
			password: "tok123",
			bypass: "localhost,127.0.0.1",
		});
	});

	it("ignores a credential-less proxy — Chromium handles those from env itself", () => {
		expect(parseAuthenticatedProxy({ HTTPS_PROXY: "http://proxy.corp:8080" })).toBeNull();
	});

	it("ignores an empty environment and unparseable URLs", () => {
		expect(parseAuthenticatedProxy({})).toBeNull();
		expect(parseAuthenticatedProxy({ HTTP_PROXY: "not a url" })).toBeNull();
	});

	it("reads lowercase variants too", () => {
		expect(parseAuthenticatedProxy({ https_proxy: "http://u:p@h:1" })?.server).toBe("http://h:1");
	});
});

describe("buildLaunchPlan", () => {
	it("stays minimal outside a sandbox: own chromium sandbox, no proxy", () => {
		const plan = buildLaunchPlan({});
		expect(plan).toEqual({ headless: true });
	});

	it("applies sandbox flags plus proxy under an srt launch", () => {
		const plan = buildLaunchPlan({ HTTPS_PROXY: "http://srt.x:t@localhost:3128" });
		expect(plan.chromiumSandbox).toBe(false);
		expect(plan.args).toContain("--disable-dev-shm-usage");
		expect(plan.proxy?.server).toBe("http://localhost:3128");
	});

	it("applies sandbox flags on HIVE_LAUNCH_ID even without a proxy env", () => {
		const plan = buildLaunchPlan({ HIVE_LAUNCH_ID: "launch-123" });
		expect(plan.chromiumSandbox).toBe(false);
		expect(plan.proxy).toBeUndefined();
	});
});
