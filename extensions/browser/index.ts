/**
 * browser — a dedicated headless Chromium per session (HIV-1636).
 *
 * This is NOT the surface extensions/web refuses: that refusal is about
 * reading the USER's Chrome profile and cookie jar. This extension launches
 * an isolated, in-memory-profile headless Chromium owned by the session —
 * no user state is reachable, and two sessions can never share a profile.
 *
 * In-house on stable playwright-core rather than `@playwright/mcp`, and not
 * only for HIV-1218 reasons: the MCP's current architecture (playwright
 * 1.63-alpha) unconditionally listens on an AF_UNIX socket, and srt's seccomp
 * filter blocks socket(AF_UNIX) — measured 2026-08-09 across the spawn path,
 * older versions and cdpEndpoint. Stable playwright-core drives the browser
 * over pipes and works fully inside the sandbox (see launch.ts for the
 * sandbox-specific launch flags and their measurements).
 *
 * Selectors are Playwright selectors (css, `text=`, `role=button[name="Save"]`,
 * `xpath=`) — snapshots are aria outlines without element refs because stable
 * ariaSnapshot() has none; models resolve the outline to role/name selectors
 * well. Cloud parity note: this extension is a candidate for factory-image
 * vendoring; keep its pi API surface conservative (registerTool + session
 * events only).
 *
 * Host prerequisite (once): `npx playwright-core@<pinned> install
 * chromium-headless-shell` — a sandboxed session cannot download browsers
 * (CDN not allowlisted), and `playwright install` garbage-collects revisions
 * other playwright versions installed, so keep the version in lockstep with
 * package.json.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Browser, BrowserContext, ConsoleMessage, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { buildLaunchPlan } from "./launch.ts";
import { BrowserSurfaceBridge } from "./surface.ts";

// Every tool here shares one capability shape: the first call spawns the
// session's headless Chromium (a subprocess), and nothing writes outside the
// extension's own per-process directory under /tmp.
const BROWSER_CAPABILITY = {
	executes: true,
	writesExemptBecause: "writes only its own per-process screenshot/profile dir under /tmp",
};

const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_CHARS = 30_000;
const CONSOLE_RING_MAX = 200;

const SELECTOR_HINT =
	'Playwright selector: css, `text=Save`, `role=button[name="Save"]`, `xpath=...`. ' +
	"Take browser_snapshot first and derive role/name selectors from the outline.";

interface BrowserState {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	console: string[];
	surface: BrowserSurfaceBridge | null;
}

function text(body: string, details: unknown) {
	return { content: [{ type: "text" as const, text: body }], details };
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: `${s.slice(0, max)}\n… [truncated at ${max} chars — narrow the request]`, truncated: true };
}

export default function (pi: ExtensionAPI) {
	let state: BrowserState | null = null;

	async function ensurePage(): Promise<BrowserState> {
		if (state && state.browser.isConnected()) return state;
		if (state) await state.surface?.stop();
		const plan = buildLaunchPlan(process.env);
		const browser = await chromium.launch({
			headless: plan.headless,
			...(plan.chromiumSandbox === false ? { chromiumSandbox: false } : {}),
			...(plan.args ? { args: plan.args } : {}),
			...(plan.proxy ? { proxy: plan.proxy } : {}),
		});
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
		context.setDefaultTimeout(ACTION_TIMEOUT_MS);
		const page = await context.newPage();
		const ring: string[] = [];
		page.on("console", (msg: ConsoleMessage) => {
			ring.push(`[${msg.type()}] ${msg.text()}`);
			if (ring.length > CONSOLE_RING_MAX) ring.shift();
		});
		page.on("pageerror", (err: Error) => {
			ring.push(`[pageerror] ${err.message}`);
			if (ring.length > CONSOLE_RING_MAX) ring.shift();
		});
		const surface = await BrowserSurfaceBridge.start(page);
		state = { browser, context, page, console: ring, surface };
		return state;
	}

	async function describePage(page: Page): Promise<{ body: string; truncated: boolean }> {
		const outline = await page.locator("body").ariaSnapshot();
		const capped = truncate(outline, SNAPSHOT_MAX_CHARS);
		const body = [`url: ${page.url()}`, `title: ${await page.title()}`, "", capped.text].join("\n");
		return { body, truncated: capped.truncated };
	}

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_navigate",
		label: "Browser: navigate",
		description:
			"Open a URL in the session's own headless Chromium and return the page's aria outline. " +
			"Loopback dev servers work directly; external hosts go through the sandbox's domain allowlist when sandboxed.",
		promptSnippet: "Open a URL in the session browser",
		parameters: Type.Object({
			url: Type.String({ description: "URL to open (http(s); loopback dev servers included)." }),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			const response = await page.goto(params.url);
			const status = response?.status();
			const described = await describePage(page);
			return text(described.body, {
				url: page.url(),
				...(status !== undefined ? { status } : {}),
				truncated: described.truncated,
			});
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_snapshot",
		label: "Browser: snapshot",
		description: "Aria outline (roles, names, values) of the current page — the ground truth for picking selectors.",
		promptSnippet: "Snapshot the current browser page",
		parameters: Type.Object({}),
		async execute() {
			const { page } = await ensurePage();
			const described = await describePage(page);
			return text(described.body, { url: page.url(), truncated: described.truncated });
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_click",
		label: "Browser: click",
		description: `Click an element and return the resulting page outline. ${SELECTOR_HINT}`,
		promptSnippet: "Click an element in the browser",
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			await page.click(params.selector);
			const described = await describePage(page);
			return text(described.body, { url: page.url(), selector: params.selector });
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_type",
		label: "Browser: type",
		description: `Fill an input (replaces its value), optionally pressing Enter. ${SELECTOR_HINT}`,
		promptSnippet: "Type into a browser input",
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
			value: Type.String({ description: "Text to fill." }),
			submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards (default false)." })),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			await page.fill(params.selector, params.value);
			if (params.submit) await page.press(params.selector, "Enter");
			const described = await describePage(page);
			return text(described.body, { url: page.url(), selector: params.selector, submitted: Boolean(params.submit) });
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_screenshot",
		label: "Browser: screenshot",
		description: "Screenshot the current page — returned inline and saved to a file for later reference.",
		promptSnippet: "Screenshot the browser page",
		parameters: Type.Object({
			full_page: Type.Optional(Type.Boolean({ description: "Capture the full scroll height (default viewport only)." })),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			// /tmp is writable in every srt profile but shared between sandboxes,
			// so the directory is per-process.
			const dir = path.join(os.tmpdir(), `pi-browser-${process.pid}`);
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `shot-${Date.now()}.png`);
			const buf = await page.screenshot({ fullPage: Boolean(params.full_page), path: file });
			return {
				content: [
					{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
					{ type: "text" as const, text: `Saved to ${file} (${page.url()})` },
				],
				details: { path: file, url: page.url(), full_page: Boolean(params.full_page) },
			};
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_console",
		label: "Browser: console",
		description: "Recent console messages and page errors from the session browser (ring buffer, newest last).",
		promptSnippet: "Read browser console messages",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading (default false)." })),
		}),
		async execute(_id, params) {
			const s = await ensurePage();
			const body = s.console.length ? s.console.join("\n") : "(no console output captured)";
			const count = s.console.length;
			if (params.clear) s.console.length = 0;
			return text(body, { count, cleared: Boolean(params.clear) });
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_evaluate",
		label: "Browser: evaluate",
		description: "Evaluate a JavaScript expression in the page and return its JSON-serialized result.",
		promptSnippet: "Evaluate JS in the browser page",
		parameters: Type.Object({
			expression: Type.String({ description: "Expression or IIFE body, e.g. `document.querySelectorAll('.row').length`." }),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			const result: unknown = await page.evaluate(params.expression);
			let rendered: string;
			try {
				rendered = JSON.stringify(result, null, 2) ?? "undefined";
			} catch {
				rendered = String(result);
			}
			const capped = truncate(rendered, SNAPSHOT_MAX_CHARS);
			return text(capped.text, { truncated: capped.truncated });
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_wait_for",
		label: "Browser: wait for",
		description: `Wait until an element is visible (or hidden). ${SELECTOR_HINT}`,
		promptSnippet: "Wait for a browser element",
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
			state: Type.Optional(
				Type.Union([Type.Literal("visible"), Type.Literal("hidden")], {
					description: "Target state, default visible.",
				}),
			),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000, description: "Default 10000." })),
		}),
		async execute(_id, params) {
			const { page } = await ensurePage();
			await page.waitForSelector(params.selector, {
				state: params.state ?? "visible",
				timeout: params.timeout_ms ?? ACTION_TIMEOUT_MS,
			});
			const described = await describePage(page);
			return text(described.body, { url: page.url(), selector: params.selector, state: params.state ?? "visible" });
		},
	});

	pi.on("session_shutdown", () => {
		// Best-effort: an orphaned headless Chromium outlives the session and
		// holds memory until the host cleans /tmp.
		const s = state;
		state = null;
		if (s) {
			void (s.surface?.stop() ?? Promise.resolve()).finally(() => s.browser.close().catch(() => {}));
		}
	});
}
