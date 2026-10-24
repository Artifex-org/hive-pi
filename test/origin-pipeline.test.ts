import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pipeline = readFileSync(new URL("../.hive/main.star", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("Origin CI parity and isolation declaration", () => {
	it("matches the pinned browser image and enforces Node 24 without runtime apt", () => {
		expect(pipeline).toContain("mcr.microsoft.com/playwright:v" + pkg.dependencies["playwright-core"] + "-noble");
		expect(pipeline).toContain("CI browser image must provide Node 24");
		expect(pipeline).toContain("npm ci --ignore-scripts");
		expect(pipeline).toContain("playwright-core install chromium-headless-shell");
		expect(pipeline).not.toContain("--with-deps");
		expect(pipeline).toContain("npm run check");
	});
	it("requires full history and both secret scans", () => {
		expect(pipeline).toContain("git fetch --unshallow origin");
		expect(pipeline).toContain('test "$(git rev-parse --is-shallow-repository)" = false');
		expect(pipeline).toContain("detect --source . --redact");
		expect(pipeline).toContain("detect --source . --no-git --redact");
		expect(pipeline).toContain("sha256sum -c");
	});
	it("declares only container tasks without org credentials or service accounts", () => {
		expect(pipeline.match(/runtime = "container"/g)).toHaveLength(2);
		expect(pipeline.match(/secrets = \[\]/g)).toHaveLength(2);
		expect(pipeline).not.toContain('runtime = "native"');
		expect(pipeline).not.toContain("service_account =");
		expect(pipeline).not.toContain("allow_failure = True");
	});
});
