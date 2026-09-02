import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FILENAME, ScreenshotLedger, manifestPath } from "../extensions/pr-attachments/manifest.ts";

// browser_screenshot's LABEL RECORDING deliverable (HIV-3240). The full
// page.screenshot -> ledger.record path needs a real Chromium and runs under
// PI_BROWSER_IT (browser-integration.test.ts asserts the recorded label and the
// manifest there). Here we pin the two facts that do not need a browser: the
// tool and the Go consumer agree on the manifest location, and a record written
// through the same ScreenshotLedger the tool constructs round-trips with its
// label intact.

let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-shot-"));
	savedEnv = process.env.HIVE_PR_ATTACHMENTS_DIR;
	process.env.HIVE_PR_ATTACHMENTS_DIR = tmp;
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env.HIVE_PR_ATTACHMENTS_DIR;
	else process.env.HIVE_PR_ATTACHMENTS_DIR = savedEnv;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("browser_screenshot label recording", () => {
	it("writes its manifest where the ledger and the Go consumer agree", () => {
		expect(manifestPath(process.env)).toBe(path.join(tmp, MANIFEST_FILENAME));
	});

	it("round-trips a labelled record through the tool's ledger", () => {
		// The tool constructs `new ScreenshotLedger()` with no args, reading
		// process.env — exactly this, with HIVE_PR_ATTACHMENTS_DIR pointing at tmp.
		const led = new ScreenshotLedger();
		const rec = led.record({ path: "/tmp/pi-browser-9/shot-1.png", label: "before", url: "http://127.0.0.1:3000/" });
		expect(rec.label).toBe("before");
		const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, MANIFEST_FILENAME), "utf8"));
		expect(onDisk).toEqual([rec]);
	});

	it("records an empty label when none is passed (the tool's `label ?? \"\"`)", () => {
		const led = new ScreenshotLedger();
		const rec = led.record({ path: "/tmp/pi-browser-9/shot-2.png", label: "", url: "u" });
		expect(rec.label).toBe("");
	});
});
