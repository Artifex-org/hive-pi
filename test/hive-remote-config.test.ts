import { beforeEach, describe, expect, it, vi } from "vitest";

const raw = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock("../extensions/hive-common/identity.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../extensions/hive-common/identity.ts")>(),
	readJSON: () => raw.value,
	atomicWrite: vi.fn(),
}));
import { loadConfig } from "../extensions/hive-remote/config.ts";

beforeEach(() => { raw.value = undefined; });

describe("grant request defaults", () => {
	it("defaults workspace requests on without enabling remote reporting", () => {
		const cfg = loadConfig();
		expect(cfg.allowAddWorkspace).toBe(true);
		expect(cfg.enabled).toBe(false);
	});
	it("upgrades existing enabled configurations that omit the grant flag", () => {
		raw.value = { enabled: true, url: "https://hive.test" };
		expect(loadConfig().allowAddWorkspace).toBe(true);
	});
	it.each([false, null, "true", "false", 0])("does not enable an explicitly disabled or malformed flag: %s", (value) => {
		raw.value = { enabled: true, allowAddWorkspace: value };
		expect(loadConfig().allowAddWorkspace).toBe(false);
	});
	it("preserves explicit enablement", () => {
		raw.value = { enabled: true, allowAddWorkspace: true };
		expect(loadConfig().allowAddWorkspace).toBe(true);
	});
});
