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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright-core";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { registerFlowTools } from "../flows/register.ts";
import { ScreenshotLedger } from "../pr-attachments/manifest.ts";
import { CAPTURABLE_CHANNEL } from "../pr-attachments/logic.ts";
import type { RecordedAction } from "../flows/core.ts";
import { BROWSER_TOOL_SPECS, SCREENSHOT_LABEL_HINT, SELECTOR_HINT, SessionBrowser, type BrowserOutput } from "./core.ts";

// Every tool here shares one capability shape: the first call spawns the
// session's headless Chromium (a subprocess), and nothing writes outside the
// extension's own per-process directory under /tmp.
const BROWSER_CAPABILITY = {
	executes: true,
	writesExemptBecause: "writes only its own per-process screenshot/profile dir under /tmp",
};

function text(output: BrowserOutput) {
	return { content: [{ type: "text" as const, text: output.text }], details: output.details };
}

/**
 * pi's registration of the session browser. What each tool does is
 * `core.ts` (shared with the Claude adapter's MCP server); this file adds the
 * typebox schemas, the capability guard and the pr-attachments event.
 */
export default function (pi: ExtensionAPI) {
	let flows: { record(action: RecordedAction): void } | null = null;
	const browser = new SessionBrowser({ chromium: async () => chromium, onAction: (action) => flows?.record(action) });
	flows = registerFlowTools(pi, { page: () => browser.page() });
	const spec = BROWSER_TOOL_SPECS;

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_navigate",
		label: spec.browser_navigate.label,
		description: spec.browser_navigate.description,
		promptSnippet: spec.browser_navigate.promptSnippet,
		parameters: Type.Object({
			url: Type.String({ description: spec.browser_navigate.inputSchema.properties.url.description }),
		}),
		async execute(_id, params) {
			const output = await browser.navigate(params);
			// A page is open, so a `before` screenshot is now possible — let
			// pr-attachments upgrade its BEFORE reminder to a just-in-time block.
			pi.events.emit(CAPTURABLE_CHANNEL, { source: "browser_navigate", url: params.url });
			return text(output);
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_snapshot",
		label: spec.browser_snapshot.label,
		description: spec.browser_snapshot.description,
		promptSnippet: spec.browser_snapshot.promptSnippet,
		parameters: Type.Object({}),
		async execute() {
			return text(await browser.snapshot());
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_click",
		label: spec.browser_click.label,
		description: spec.browser_click.description,
		promptSnippet: spec.browser_click.promptSnippet,
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
		}),
		async execute(_id, params) {
			return text(await browser.click(params));
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_type",
		label: spec.browser_type.label,
		description: spec.browser_type.description,
		promptSnippet: spec.browser_type.promptSnippet,
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
			value: Type.String({ description: spec.browser_type.inputSchema.properties.value.description }),
			submit: Type.Optional(Type.Boolean({ description: spec.browser_type.inputSchema.properties.submit.description })),
		}),
		async execute(_id, params) {
			return text(await browser.type(params));
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_screenshot",
		label: spec.browser_screenshot.label,
		description: spec.browser_screenshot.description,
		promptSnippet: spec.browser_screenshot.promptSnippet,
		parameters: Type.Object({
			full_page: Type.Optional(Type.Boolean({ description: spec.browser_screenshot.inputSchema.properties.full_page.description })),
			label: Type.Optional(Type.String({ description: SCREENSHOT_LABEL_HINT })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Backed by the on-disk pr-attachments.json manifest, so the record
			// survives compaction and is visible to extensions/pr-attachments — a
			// separate entrypoint with its own module cache. Keyed by THIS session:
			// /tmp is shared between sandboxes and every sandboxed pi is pid 2, so a
			// per-process directory was one directory for all of them. See
			// ../pr-attachments/manifest.ts. Read from ctx before the first await.
			const ledger = new ScreenshotLedger(process.env, ctx.sessionManager.getSessionId());
			const output = await browser.screenshot(params, ledger);
			return {
				content: [
					...(output.image ? [{ type: "image" as const, data: output.image.data, mimeType: output.image.mimeType }] : []),
					{ type: "text" as const, text: output.text },
				],
				details: output.details,
			};
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_console",
		label: spec.browser_console.label,
		description: spec.browser_console.description,
		promptSnippet: spec.browser_console.promptSnippet,
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: spec.browser_console.inputSchema.properties.clear.description })),
		}),
		async execute(_id, params) {
			return text(await browser.console(params));
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_evaluate",
		label: spec.browser_evaluate.label,
		description: spec.browser_evaluate.description,
		promptSnippet: spec.browser_evaluate.promptSnippet,
		parameters: Type.Object({
			expression: Type.String({ description: spec.browser_evaluate.inputSchema.properties.expression.description }),
		}),
		async execute(_id, params) {
			return text(await browser.evaluate(params));
		},
	});

	registerGuardedTool(pi, {
		capability: BROWSER_CAPABILITY,
		name: "browser_wait_for",
		label: spec.browser_wait_for.label,
		description: spec.browser_wait_for.description,
		promptSnippet: spec.browser_wait_for.promptSnippet,
		parameters: Type.Object({
			selector: Type.String({ description: SELECTOR_HINT }),
			state: Type.Optional(
				Type.Union([Type.Literal("visible"), Type.Literal("hidden")], {
					description: spec.browser_wait_for.inputSchema.properties.state.description,
				}),
			),
			timeout_ms: Type.Optional(
				Type.Integer({ minimum: 100, maximum: 60_000, description: spec.browser_wait_for.inputSchema.properties.timeout_ms.description }),
			),
		}),
		async execute(_id, params) {
			return text(await browser.waitFor(params));
		},
	});

	pi.on("session_shutdown", () => {
		// Best-effort: an orphaned headless Chromium outlives the session and
		// holds memory until the host cleans /tmp.
		void browser.close();
	});
}
