import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prAttachments, { type VersionProbe } from "../extensions/pr-attachments/index.ts";
import { MANIFEST_FILENAME, ScreenshotLedger, screenshotDir } from "../extensions/pr-attachments/manifest.ts";
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
	const ledger = new ScreenshotLedger({ HIVE_PR_ATTACHMENTS_DIR: tmp }, "fake-session");
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

/** The tool_call verdict for one call — a block `{block, reason}` or undefined. */
async function callVerdict(
	pi: ReturnType<typeof createFakePi>,
	call: { toolName: string; input: Record<string, unknown> },
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const [verdict] = (await pi.emit({ type: "tool_call", ...call })) as ({ block?: boolean; reason?: string } | undefined)[];
	return verdict;
}

/** Signal that a screenshot is possible this session (dev server / page open). */
function makeCapturable(pi: ReturnType<typeof createFakePi>) {
	pi.api.events.emit("pr-attachments.capturable", { source: "test" });
}

describe("the off switch", () => {
	it("registers nothing when PI_PR_ATTACHMENTS=0", () => {
		const pi = load({ env: { PI_PR_ATTACHMENTS: "0" } });
		expect(pi.handlers.size).toBe(0);
	});
});

// The supervisor's correction (PR #45): a hint fires on the tool_RESULT, after
// the edit landed and HMR repainted — too late for a `before` shot. With a live
// dev server the first UI edit must BLOCK on the tool_CALL instead, once.
describe("the BEFORE block (dev server live)", () => {
	it("blocks the first UI-visible edit with the take-a-screenshot message", async () => {
		const pi = load();
		makeCapturable(pi);
		const verdict = await callVerdict(pi, { toolName: "edit", input: { path: "web/App.tsx" } });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("browser_screenshot label:before");
		expect(verdict?.reason).toContain("re-run this edit");
	});

	it("allows the SECOND call — the block fires only once per session", async () => {
		const pi = load();
		makeCapturable(pi);
		expect((await callVerdict(pi, { toolName: "edit", input: { path: "web/A.tsx" } }))?.block).toBe(true);
		expect(await callVerdict(pi, { toolName: "edit", input: { path: "web/B.tsx" } })).toBeUndefined();
	});

	it("does not block a non-UI edit even with a dev server", async () => {
		const pi = load();
		makeCapturable(pi);
		expect(await callVerdict(pi, { toolName: "edit", input: { path: "server/db.ts" } })).toBeUndefined();
	});

	it("does not block when a screenshot already exists", async () => {
		const pi = load({ withShot: true });
		makeCapturable(pi);
		expect(await callVerdict(pi, { toolName: "write", input: { path: "web/App.tsx" } })).toBeUndefined();
	});
});

describe("the BEFORE hint (no dev server — nothing to screenshot)", () => {
	it("does NOT block, and hints on the result instead", async () => {
		const pi = load();
		// no makeCapturable(): nothing is open to screenshot
		const verdict = await callVerdict(pi, { toolName: "edit", input: { path: "web/App.tsx" } });
		expect(verdict).toBeUndefined();
	});

	it("fires the hint on the first UI edit and never again", async () => {
		const pi = load();
		const first = await fire(pi, { toolName: "edit", input: { path: "web/A.tsx" } });
		expect(first).toContain("[harness · pr-attachments]");
		expect(first).toMatch(/label `before`/);
		const second = await fire(pi, { toolName: "edit", input: { path: "web/B.tsx" } });
		expect(second).toBe("ok");
	});

	it("does not fire on a non-UI edit", async () => {
		const pi = load();
		expect(await fire(pi, { toolName: "edit", input: { path: "server/db.ts" } })).toBe("ok");
	});

	it("does not fire when a screenshot already exists", async () => {
		const pi = load({ withShot: true });
		expect(await fire(pi, { toolName: "write", input: { path: "web/App.tsx" } })).toBe("ok");
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

// Papercut 2026-10-02T14:21 (and five more): every sandboxed pi is pid 2 in its
// PID namespace, so a pid-keyed `/tmp/claude/pi-browser-2` was ONE directory for
// every sandboxed session, and `gh pr create` in a session that never opened a
// browser listed another session's QIS/treasury screenshots for attachment.
describe("the ledger is this session's, never the process's", () => {
	let savedTmp: string | undefined;
	let savedDir: string | undefined;
	beforeEach(() => {
		savedTmp = process.env.TMPDIR;
		savedDir = process.env.HIVE_PR_ATTACHMENTS_DIR;
		process.env.TMPDIR = tmp; // os.tmpdir() reads it per call
		delete process.env.HIVE_PR_ATTACHMENTS_DIR;
	});
	afterEach(() => {
		if (savedTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmp;
		if (savedDir === undefined) delete process.env.HIVE_PR_ATTACHMENTS_DIR;
		else process.env.HIVE_PR_ATTACHMENTS_DIR = savedDir;
	});

	/** Another live session's shots, wherever a same-pid neighbour would have put them. */
	function neighbourShots() {
		for (const dir of [path.join(tmp, `pi-browser-${process.pid}`), screenshotDir("other-session")]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "shot-1790638007736.png"), "png");
			fs.writeFileSync(
				path.join(dir, MANIFEST_FILENAME),
				JSON.stringify([{ path: path.join(dir, "shot-1790638007736.png"), label: "after-final-narrow-treasury", url: "u", taken_at: "t" }]),
			);
		}
	}

	async function prCreateIn(sessionId: string) {
		const pi = createFakePi();
		prAttachments(pi.api, { probe: NEW_GH });
		await pi.emit({ type: "tool_call", toolName: "bash", input: { command: "gh pr create --body-file b.md" } }, { sessionId });
		const [patch] = (await pi.emit(
			{ type: "tool_result", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
			{ sessionId },
		)) as ({ content?: { text: string }[] } | undefined)[];
		return patch?.content?.[0]?.text ?? "ok";
	}

	it("does not offer a same-pid neighbour session's screenshots", async () => {
		neighbourShots();
		expect(await prCreateIn("this-session")).toBe("ok");
	});

	it("still offers the screenshots THIS session took", async () => {
		neighbourShots();
		new ScreenshotLedger(process.env, "this-session").record({
			path: path.join(screenshotDir("this-session"), "shot-1.png"),
			label: "before",
			url: "http://127.0.0.1:3000/",
		});
		const text = await prCreateIn("this-session");
		expect(text).toContain("This session has 1 screenshot(s)");
		expect(text).not.toContain("treasury");
	});
});
