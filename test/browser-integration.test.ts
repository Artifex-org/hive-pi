import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import browserExtension from "../extensions/browser/index.ts";

// Real-browser integration for extensions/browser — launches headless
// Chromium through the extension's own tool surface. Gated: CI containers
// have no browser install, and a sandboxed run additionally proves the
// srt-compatibility claims in launch.ts. Run with:
//
//   PI_BROWSER_IT=1 npx vitest run test/browser-integration.test.ts
//
// (inside an srt sandbox for the full claim; see HIV-1636).

const enabled = process.env.PI_BROWSER_IT === "1";

interface RegisteredTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text?: string; data?: string }>;
		details: unknown;
	}>;
}

function loadTools(): { tools: Map<string, RegisteredTool>; shutdown: () => void } {
	const tools = new Map<string, RegisteredTool>();
	let onShutdown: (() => void) | undefined;
	const fakePi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") onShutdown = handler;
		},
	};
	// The extension only uses registerTool + on(session_shutdown); the fake
	// covers exactly that surface.
	(browserExtension as unknown as (pi: typeof fakePi) => void)(fakePi);
	return { tools, shutdown: () => onShutdown?.() };
}

describe.skipIf(!enabled)("extensions/browser integration", () => {
	let srv: http.Server;
	let base: string;
	let harness: ReturnType<typeof loadTools>;

	beforeAll(async () => {
		srv = http.createServer((req, res) => {
			if (req.url === "/next") {
				res.end("<html><title>next</title><body><h1>Arrived</h1></body></html>");
				return;
			}
			res.end(
				'<html><title>it-page</title><body><h1>Browser IT</h1>' +
					'<button onclick="console.log(\'clicked!\'); location.href=\'/next\'">Go</button>' +
					'<input placeholder="name"/></body></html>',
			);
		});
		await new Promise<void>((r) => srv.listen(8199, "127.0.0.1", () => r()));
		base = "http://127.0.0.1:8199";
		harness = loadTools();
	});

	afterAll(() => {
		harness?.shutdown();
		srv?.close();
	});

	it("navigates and returns the aria outline", async () => {
		const out = await harness.tools.get("browser_navigate")!.execute("t1", { url: `${base}/` });
		const body = out.content[0]?.text ?? "";
		expect(body).toContain("title: it-page");
		expect(body).toContain('button "Go"');
	}, 30_000);

	it("clicks through and captures console output", async () => {
		const out = await harness.tools.get("browser_click")!.execute("t2", { selector: 'role=button[name="Go"]' });
		expect(out.content[0]?.text).toContain("Arrived");
		const consoleOut = await harness.tools.get("browser_console")!.execute("t3", {});
		expect(consoleOut.content[0]?.text).toContain("clicked!");
	}, 30_000);

	it("screenshots to an inline image + file", async () => {
		const out = await harness.tools.get("browser_screenshot")!.execute("t4", {});
		expect(out.content[0]?.type).toBe("image");
		expect((out.content[0]?.data ?? "").length).toBeGreaterThan(1000);
	}, 30_000);

	it("evaluates JS in the page", async () => {
		const out = await harness.tools.get("browser_evaluate")!.execute("t5", {
			expression: "document.title",
		});
		expect(out.content[0]?.text).toContain("next");
	}, 30_000);
});
