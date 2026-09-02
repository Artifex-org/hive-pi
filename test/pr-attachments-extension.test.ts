import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prAttachments, { type VersionProbe } from "../extensions/pr-attachments/index.ts";
import { ScreenshotLedger } from "../extensions/pr-attachments/manifest.ts";
import { createFakePi } from "./fake-pi.ts";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-attach-ext-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const NEW_GH: VersionProbe = () => ({ major: 2, minor: 99, patch: 0 });
const OLD_GH: VersionProbe = () => ({ major: 2, minor: 98, patch: 0 });

function load(opts: { probe?: VersionProbe; withShot?: boolean; env?: Record<string, string | undefined> } = {}) {
	const ledger = new ScreenshotLedger({ HIVE_PR_ATTACHMENTS_DIR: tmp });
	if (opts.withShot) {
		ledger.record({ path: "/tmp/pi-browser-1/shot-1.png", label: "before", url: "http://127.0.0.1:3000/" });
	}
	const saved = process.env.PI_PR_ATTACHMENTS;
	if (opts.env?.PI_PR_ATTACHMENTS === undefined) delete process.env.PI_PR_ATTACHMENTS;
	else process.env.PI_PR_ATTACHMENTS = opts.env.PI_PR_ATTACHMENTS;
	const pi = createFakePi();
	prAttachments(pi.api, { probe: opts.probe ?? NEW_GH, ledger });
	if (saved === undefined) delete process.env.PI_PR_ATTACHMENTS;
	else process.env.PI_PR_ATTACHMENTS = saved;
	return pi;
}

/** Drive a tool_call then a tool_result and return the injected note, or null. */
async function fire(
	pi: ReturnType<typeof createFakePi>,
	call: { toolName: string; input: Record<string, unknown> },
): Promise<string | null> {
	await pi.emit({ type: "tool_call", ...call });
	const [patch] = (await pi.emit({
		type: "tool_result",
		toolName: call.toolName,
		isError: false,
		content: [{ type: "text", text: "ok" }],
	})) as ({ content?: { text: string }[] } | undefined)[];
	// No patch means the result was passed through unchanged — i.e. "ok".
	return patch?.content?.[0]?.text ?? "ok";
}

describe("the off switch", () => {
	it("registers nothing when PI_PR_ATTACHMENTS=0", () => {
		const pi = load({ env: { PI_PR_ATTACHMENTS: "0" } });
		expect(pi.handlers.size).toBe(0);
	});
});

describe("the BEFORE nudge", () => {
	it("fires on the first UI-visible edit when no screenshot exists", async () => {
		const pi = load();
		const text = await fire(pi, { toolName: "edit", input: { path: "web/App.tsx" } });
		expect(text).toContain("[harness · pr-attachments]");
		expect(text).toMatch(/label `before`/);
	});

	it("does not fire on a non-UI edit", async () => {
		const pi = load();
		expect(await fire(pi, { toolName: "edit", input: { path: "server/db.ts" } })).toBe("ok");
	});

	it("does not fire when a screenshot already exists", async () => {
		const pi = load({ withShot: true });
		expect(await fire(pi, { toolName: "write", input: { path: "web/App.tsx" } })).toBe("ok");
	});

	it("fires at most once per session", async () => {
		const pi = load();
		const first = await fire(pi, { toolName: "edit", input: { path: "web/A.tsx" } });
		expect(first).toContain("pr-attachments");
		const second = await fire(pi, { toolName: "edit", input: { path: "web/B.tsx" } });
		expect(second).toBe("ok");
	});
});

describe("the PR nudge", () => {
	it("fires on gh pr create without --attach when screenshots exist", async () => {
		const pi = load({ withShot: true });
		const text = await fire(pi, { toolName: "bash", input: { command: "gh pr create --body-file b.md" } });
		expect(text).toContain("[harness · pr-attachments]");
		expect(text).toContain("--attach '/tmp/pi-browser-1/shot-1.png#before");
	});

	it("does not fire when the command already has --attach", async () => {
		const pi = load({ withShot: true });
		expect(
			await fire(pi, { toolName: "bash", input: { command: "gh pr create --attach 'x.png#before'" } }),
		).toBe("ok");
	});

	it("does not fire when the session has no screenshots", async () => {
		const pi = load();
		expect(await fire(pi, { toolName: "bash", input: { command: "gh pr create --body-file b.md" } })).toBe("ok");
	});

	it("fires for gh issue and for background_bash too", async () => {
		const pi = load({ withShot: true });
		expect(
			await fire(pi, { toolName: "background_bash", input: { command: "gh issue create --title x" } }),
		).toContain("--attach");
	});

	it("fires inside a compound && command", async () => {
		const pi = load({ withShot: true });
		const text = await fire(pi, {
			toolName: "bash",
			input: { command: "git commit -m x && git push && gh pr create --body-file b.md" },
		});
		expect(text).toContain("--attach");
	});

	it("nudges once per command shape, not on every retry", async () => {
		const pi = load({ withShot: true });
		const first = await fire(pi, { toolName: "bash", input: { command: "gh pr create --body-file b.md" } });
		expect(first).toContain("--attach");
		const retry = await fire(pi, { toolName: "bash", input: { command: "gh pr create --body-file b2.md" } });
		expect(retry).toBe("ok");
	});

	it("gives the too-old guidance when gh < 2.99.0", async () => {
		const pi = load({ withShot: true, probe: OLD_GH });
		const text = await fire(pi, { toolName: "bash", input: { command: "gh pr create --body-file b.md" } });
		expect(text).toMatch(/without images/i);
		expect(text).toContain("2.98.0");
		expect(text).not.toContain("--attach '");
	});
});
