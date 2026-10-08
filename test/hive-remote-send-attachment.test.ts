import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenshotDir } from "../extensions/pr-attachments/manifest.ts";
import { publishLabelledScreenshot, registerSendAttachmentTool } from "../extensions/hive-remote/sendAttachment.ts";
import { screenshotCaption } from "../extensions/hive-common/output-attachment.ts";
import { createFakePi } from "./fake-pi.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fsPromises>();
	return { ...actual, open: vi.fn(actual.open) };
});

const auth = { url: "https://hive.test", token: "secret" };
const sessionID = "session/1";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(overrides: { getAuth?: () => typeof auth | null; getSessionID?: () => string | null; current?: () => boolean } = {}) {
	const pi = createFakePi();
	const onUploaded = vi.fn();
	registerSendAttachmentTool(pi.api, {
		getAuth: overrides.getAuth ?? (() => auth), getSessionID: overrides.getSessionID ?? (() => sessionID),
		getGeneration: () => 4, isUploadTargetCurrent: overrides.current ?? (() => true), onUploaded,
	});
	return { tool: pi.tools.find((entry) => entry.name === "send_attachment")!.definition, onUploaded };
}
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), "hive-output-att-")); dirs.push(dir); return dir; }
async function execute(tool: Record<string, unknown>, path: string, cwd: string) {
	return (tool.execute as (...args: unknown[]) => Promise<unknown>)("call", { path }, undefined, undefined, { cwd, sessionManager: { getSessionId: () => "session/1" } });
}
function text(result: unknown): string { return (result as { content: Array<{ text: string }> }).content[0]!.text; }

describe("send_attachment", () => {
	it("uploads a regular file beneath cwd with session auth", async () => {
		const { tool, onUploaded } = setup(); const cwd = tempDir(); const path = join(cwd, "out.png"); writeFileSync(path, "png-bytes");
		let captured: RequestInit | undefined;
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { expect(url).toContain("session%2F1/output-attachments"); captured = init; return Response.json({ attachment: { id: "att-123" } }); });
		const result = await execute(tool, path, cwd) as { isError?: boolean };
		expect(result.isError).toBeUndefined(); expect(captured?.headers).toEqual({ Authorization: "Bearer secret", Accept: "application/json" }); expect(onUploaded).toHaveBeenCalledWith(sessionID, expect.any(String), ["att-123"]);
	});

	it("keeps reading short descriptor reads until the complete file is uploaded", async () => {
		const { tool } = setup(); const cwd = tempDir(); const path = join(cwd, "out.png"); const content = "complete-image-bytes"; writeFileSync(path, content);
		const { open: realOpen } = await vi.importActual<typeof fsPromises>("node:fs/promises");
		vi.spyOn(fsPromises, "open").mockImplementationOnce(async (...args) => {
			const handle = await realOpen(...args);
			const read = handle.read.bind(handle);
			handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 3), position)) as typeof handle.read;
			return handle;
		});
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const uploaded = (init.body as FormData).get("file") as Blob;
			expect(await uploaded.text()).toBe(content);
			return Response.json({ attachment: { id: "att" } });
		});
		expect((await execute(tool, path, cwd) as { isError?: boolean }).isError).toBeUndefined();
	});

	it("allows this session's browser screenshot outside cwd", async () => {
		const { tool } = setup(); const dir = screenshotDir("session/1"); mkdirSync(dir, { recursive: true }); dirs.push(dir); const path = join(dir, "shot.png"); writeFileSync(path, "png");
		vi.stubGlobal("fetch", async () => Response.json({ attachment: { id: "a" } }));
		expect((await execute(tool, path, tempDir()) as { isError?: boolean }).isError).toBeUndefined();
	});

	it("rejects traversal and symlink escapes", async () => {
		const { tool } = setup(); const cwd = tempDir(); const elsewhere = tempDir(); writeFileSync(join(elsewhere, "secret"), "secret"); symlinkSync(join(elsewhere, "secret"), join(cwd, "escape"));
		vi.stubGlobal("fetch", vi.fn());
		for (const path of ["../secret", join(cwd, "escape")]) { const r = await execute(tool, path, cwd) as { isError?: boolean }; expect(r.isError).toBe(true); }
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("rejects empty, oversized, and nonregular files", async () => {
		const { tool } = setup(); const cwd = tempDir(); const empty = join(cwd, "empty"); writeFileSync(empty, ""); const large = join(cwd, "large"); writeFileSync(large, Buffer.alloc(5 * 1024 * 1024 + 1)); const fifo = join(cwd, "pipe"); execFileSync("mkfifo", [fifo]);
		vi.stubGlobal("fetch", vi.fn());
		for (const path of [empty, large, fifo]) expect((await execute(tool, path, cwd) as { isError?: boolean }).isError).toBe(true);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("rejects negative auth/session contexts", async () => {
		const cwd = tempDir(); const path = join(cwd, "file"); writeFileSync(path, "x");
		for (const overrides of [{ getAuth: () => null }, { getSessionID: () => null }]) {
			const { tool } = setup(overrides); expect((await execute(tool, path, cwd) as { isError?: boolean }).isError).toBe(true);
		}
	});

	it("does not claim publication after the session or lifecycle changes during upload", async () => {
		let finish!: (response: Response) => void; const { tool, onUploaded } = setup({ current: () => false }); const cwd = tempDir(); const path = join(cwd, "file"); writeFileSync(path, "x");
		vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
		const pending = execute(tool, path, cwd); await vi.waitFor(() => expect(finish).toBeTypeOf("function")); finish(Response.json({ attachment: { id: "a" } }));
		const result = await pending as { isError?: boolean }; expect(result.isError).toBe(true); expect(text(result)).toContain("not published"); expect(onUploaded).not.toHaveBeenCalled();
	});
});

describe("labelled screenshot auto-post", () => {
	function deps(current = true) {
		const onUploaded = vi.fn();
		return { onUploaded, deps: { getAuth: () => auth, getSessionID: () => sessionID, getGeneration: () => 4, isUploadTargetCurrent: () => current, onUploaded } };
	}
	function shot(name: string): string {
		const dir = screenshotDir("pi-session"); mkdirSync(dir, { recursive: true }); dirs.push(dir);
		const path = join(dir, name); writeFileSync(path, "png"); return path;
	}

	it("posts a labelled shot from this session's screenshot directory with a page caption", async () => {
		const { deps: d, onUploaded } = deps(); const path = shot("shot-1.png");
		vi.stubGlobal("fetch", async () => Response.json({ attachment: { id: "att-9" } }));
		const failure = await publishLabelledScreenshot(d, "pi-session", { details: { path, label: " before ", url: "http://127.0.0.1:5173/orders?token=x#top" } });
		expect(failure).toBeNull();
		expect(onUploaded).toHaveBeenCalledWith(sessionID, "Screenshot · before · http://127.0.0.1:5173/orders", ["att-9"]);
	});

	it("leaves an unlabelled shot with the agent", async () => {
		const { deps: d, onUploaded } = deps(); const path = shot("shot-2.png");
		vi.stubGlobal("fetch", vi.fn());
		expect(await publishLabelledScreenshot(d, "pi-session", { details: { path, label: "", url: "" } })).toBeNull();
		expect(vi.mocked(fetch)).not.toHaveBeenCalled(); expect(onUploaded).not.toHaveBeenCalled();
	});

	it("refuses a path outside the screenshot directory, even beneath the working tree", async () => {
		const { deps: d, onUploaded } = deps(); const cwd = tempDir(); const path = join(cwd, "secret.png"); writeFileSync(path, "x");
		vi.stubGlobal("fetch", vi.fn());
		expect(await publishLabelledScreenshot(d, "pi-session", { details: { path, label: "after" } })).toContain("Could not post the after screenshot");
		expect(vi.mocked(fetch)).not.toHaveBeenCalled(); expect(onUploaded).not.toHaveBeenCalled();
	});

	it("reports an upload failure and does not publish after the session changed", async () => {
		const failing = deps(); const path = shot("shot-3.png");
		vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
		expect(await publishLabelledScreenshot(failing.deps, "pi-session", { details: { path, label: "after" } })).toContain("HTTP 500");
		const stale = deps(false);
		vi.stubGlobal("fetch", async () => Response.json({ attachment: { id: "a" } }));
		expect(await publishLabelledScreenshot(stale.deps, "pi-session", { details: { path, label: "after" } })).toBeNull();
		expect(stale.onUploaded).not.toHaveBeenCalled();
	});

	it("bounds the label and omits an unparseable page", () => {
		expect(screenshotCaption("x".repeat(200), "not a url")).toBe(`Screenshot · ${"x".repeat(79)}…`);
	});
});
