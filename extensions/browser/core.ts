/**
 * The session browser's core: the headless Chromium a session owns and what
 * each browser tool does with it, free of pi's ExtensionAPI.
 *
 * Two hosts run it: `index.ts` (pi's tools, typebox schemas, the
 * pr-attachments event) and the Claude adapter's MCP server
 * (`claude/mcp/browser-tools.ts`, plain JSON Schema). Both take the tool
 * names, wording and schemas from `BROWSER_TOOL_SPECS` here, so the two
 * surfaces cannot drift (`test/claude-browser.test.ts` pins pi's typebox
 * schemas to these).
 *
 * Erasable TypeScript only, and no runtime import of pi or typebox: the
 * adapter loads this file under Node's type stripping. Chromium is handed in
 * by the host (`SessionBrowserOptions.chromium`): pi imports playwright-core
 * statically as it always has, the adapter only when the first browser
 * launches, so loading its MCP server never depends on the package.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType, ConsoleMessage, Page } from "playwright-core";
import type { RecordedAction } from "../flows/core.ts";
import type { ScreenshotLedger } from "../pr-attachments/manifest.ts";
import { buildLaunchPlan } from "./launch.ts";
import { BrowserSurfaceBridge } from "./surface.ts";

export const NAV_TIMEOUT_MS = 20_000;
export const ACTION_TIMEOUT_MS = 10_000;
export const SNAPSHOT_MAX_CHARS = 30_000;
export const CONSOLE_RING_MAX = 200;
/** How long `close()` waits for Chromium to exit before killing its process group. */
const CLOSE_TIMEOUT_MS = 10_000;

export const SELECTOR_HINT =
	'Playwright selector: css, `text=Save`, `role=button[name="Save"]`, `xpath=...`. ' +
	"Take browser_snapshot first and derive role/name selectors from the outline.";

export const SCREENSHOT_LABEL_HINT =
	"Free-text label recorded with the shot. Convention: `before` for the state before a UI change " +
	"and `after` for the state after it, so a PR can attach both. Recorded in pr-attachments.json, and a " +
	"labelled shot is posted to the Hive chat (and its Media section) automatically. Omit the label for a " +
	"shot that is only for you.";

export interface ToolSpec {
	label: string;
	description: string;
	promptSnippet: string;
	/** JSON Schema of the parameters — exactly what pi's typebox schema serialises to. */
	inputSchema: Record<string, unknown>;
}

const selector = { type: "string", description: SELECTOR_HINT };

export const BROWSER_TOOL_SPECS = {
	browser_navigate: {
		label: "Browser: navigate",
		description:
			"Open a URL in the session's own headless Chromium and return the page's aria outline. " +
			"Loopback dev servers work directly; external hosts go through the sandbox's domain allowlist when sandboxed. " +
			"Load the browser-use skill before a browser task.",
		promptSnippet: "Open a URL in the session browser",
		inputSchema: {
			type: "object",
			required: ["url"],
			properties: { url: { type: "string", description: "URL to open (http(s); loopback dev servers included)." } },
		},
	},
	browser_snapshot: {
		label: "Browser: snapshot",
		description: "Aria outline (roles, names, values) of the current page — the ground truth for picking selectors.",
		promptSnippet: "Snapshot the current browser page",
		inputSchema: { type: "object", properties: {} },
	},
	browser_click: {
		label: "Browser: click",
		description: `Click an element and return the resulting page outline. ${SELECTOR_HINT}`,
		promptSnippet: "Click an element in the browser",
		inputSchema: { type: "object", required: ["selector"], properties: { selector } },
	},
	browser_type: {
		label: "Browser: type",
		description: `Fill an input (replaces its value), optionally pressing Enter. ${SELECTOR_HINT}`,
		promptSnippet: "Type into a browser input",
		inputSchema: {
			type: "object",
			required: ["selector", "value"],
			properties: {
				selector,
				value: { type: "string", description: "Text to fill." },
				submit: { type: "boolean", description: "Press Enter afterwards (default false)." },
			},
		},
	},
	browser_screenshot: {
		label: "Browser: screenshot",
		description: "Screenshot the current page — returned inline and saved to a file for later reference.",
		promptSnippet: "Screenshot the browser page",
		inputSchema: {
			type: "object",
			properties: {
				full_page: { type: "boolean", description: "Capture the full scroll height (default viewport only)." },
				label: { type: "string", description: SCREENSHOT_LABEL_HINT },
			},
		},
	},
	browser_console: {
		label: "Browser: console",
		description: "Recent console messages and page errors from the session browser (ring buffer, newest last).",
		promptSnippet: "Read browser console messages",
		inputSchema: {
			type: "object",
			properties: { clear: { type: "boolean", description: "Clear the buffer after reading (default false)." } },
		},
	},
	browser_evaluate: {
		label: "Browser: evaluate",
		description: "Evaluate a JavaScript expression in the page and return its JSON-serialized result.",
		promptSnippet: "Evaluate JS in the browser page",
		inputSchema: {
			type: "object",
			required: ["expression"],
			properties: {
				expression: { type: "string", description: "Expression or IIFE body, e.g. `document.querySelectorAll('.row').length`." },
			},
		},
	},
	browser_wait_for: {
		label: "Browser: wait for",
		description: `Wait until an element is visible (or hidden). ${SELECTOR_HINT}`,
		promptSnippet: "Wait for a browser element",
		inputSchema: {
			type: "object",
			required: ["selector"],
			properties: {
				selector,
				state: {
					anyOf: [
						{ type: "string", const: "visible" },
						{ type: "string", const: "hidden" },
					],
					description: "Target state, default visible.",
				},
				timeout_ms: { type: "integer", minimum: 100, maximum: 60_000, description: "Default 10000." },
			},
		},
	},
} satisfies Record<string, ToolSpec>;

export type BrowserToolName = keyof typeof BROWSER_TOOL_SPECS;

/** A tool's answer, host-neutral: pi wraps it in `content`/`details`, MCP in content blocks. */
export interface BrowserOutput {
	text: string;
	details: Record<string, unknown>;
	/** A PNG, base64 — shown inline next to the text. */
	image?: { data: string; mimeType: "image/png" };
}

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: `${s.slice(0, max)}\n… [truncated at ${max} chars — narrow the request]`, truncated: true };
}

/** The pinned playwright-core version — the one the install command must name. */
export function playwrightVersion(): string {
	return (createRequire(import.meta.url)("playwright-core/package.json") as { version: string }).version;
}

/** The exact one-time install for the browser this checkout's playwright-core drives. */
export function browserInstallCommand(): string {
	return `npx playwright-core@${playwrightVersion()} install chromium-headless-shell`;
}

/**
 * A launch failure in words an agent can act on. A missing binary names the
 * pinned install: Playwright's own hint says `npx playwright install`, which
 * fetches a different revision and garbage-collects the pinned one.
 */
export function describeLaunchError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/Executable doesn't exist/.test(message)) {
		const first = message.split("\n")[0];
		return new Error(
			`The session browser is not installed on this host. Install it once, as the user the agent runs as: ` +
				`\`${browserInstallCommand()}\` (a sandboxed session cannot download it). Launch said: ${first}`,
		);
	}
	return error instanceof Error ? error : new Error(message);
}

interface BrowserState {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	console: string[];
	surface: BrowserSurfaceBridge | null;
	/** Chromium's pid — the leader of its own process group — when it could be found (Linux). */
	pid: number | null;
}

export interface SessionBrowserOptions {
	/** playwright-core's `chromium`, resolved by the host. */
	chromium: () => Promise<BrowserType>;
	env?: NodeJS.ProcessEnv;
	/**
	 * Let Playwright install its SIGINT/SIGTERM/SIGHUP handlers (its default).
	 * Its SIGINT handler exits the process, so a host that owns its own
	 * shutdown (the adapter's MCP server) passes false and calls `close()`.
	 */
	handleSignals?: boolean;
	/** Each recordable action, for the flow recorder. */
	onAction?: (action: RecordedAction) => void;
	/** Called once per launched browser. */
	onLaunch?: () => void;
	/** Where the live view reports a dropped frame (default: console.warn). */
	log?: (line: string) => void;
}

/** The binaries Playwright launches as Chromium (the headless shell, or a full build). */
const CHROMIUM_BINARY = /^(chrome|chrome-headless-shell|headless_shell|chromium)$/;

interface ProcessInfo {
	pid: number;
	ppid: number;
	pgrp: number;
	chromium: boolean;
}

/** Every process /proc lists (Linux; empty elsewhere), with whether it runs a Chromium binary. */
function processes(): ProcessInfo[] {
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return [];
	}
	const found: ProcessInfo[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			// pid (comm) state ppid pgrp … — comm may hold spaces, so split after ")".
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			let chromium = false;
			try {
				chromium = CHROMIUM_BINARY.test(path.basename(fs.readlinkSync(`/proc/${entry}/exe`)));
			} catch {
				// Another user's process, or a zombie: its binary is unreadable.
			}
			found.push({ pid: Number(entry), ppid: Number(fields[1]), pgrp: Number(fields[2]), chromium });
		} catch {
			// The process exited between readdir and read.
		}
	}
	return found;
}

/**
 * Chromium processes whose parent is this process and that lead their own
 * group — the browser Playwright spawned, and not a helper group this
 * process started meanwhile (the adapter's workers lead groups too). Matched
 * on the binary (`/proc/<pid>/exe`): Chromium rewrites its argv, and
 * `executablePath()` names the full build, not the headless shell.
 */
function ownChromiumLeaders(): Set<number> {
	return new Set(processes().filter((p) => p.chromium && p.ppid === process.pid && p.pgrp === p.pid).map((p) => p.pid));
}

/**
 * True while process group `pgid` still holds a Chromium process — checked
 * before killing it. The kernel does not reuse a pid while a group of that id
 * has members, so a group with Chromium in it is still the browser's; a
 * group that emptied and whose id now names something else is left alone.
 */
function groupHoldsChromium(pgid: number): boolean {
	return processes().some((p) => p.pgrp === pgid && p.chromium);
}

/**
 * Stop a browser's live view, close it, and — if it has not exited within
 * CLOSE_TIMEOUT_MS or left helpers behind — SIGKILL its process group.
 */
async function closeBrowser(s: Pick<BrowserState, "browser" | "surface" | "pid">): Promise<void> {
	await (s.surface?.stop() ?? Promise.resolve()).catch(() => {});
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		s.browser.close().catch(() => {}),
		new Promise<void>((done) => {
			timer = setTimeout(done, CLOSE_TIMEOUT_MS);
		}),
	]);
	clearTimeout(timer);
	if (s.pid !== null && groupHoldsChromium(s.pid)) {
		try {
			process.kill(-s.pid, "SIGKILL");
		} catch {
			// Gone between the check and the kill.
		}
	}
}

/**
 * One headless Chromium for one session: launched lazily on first use,
 * relaunched if it died, closed by `close()`. Playwright spawns Chromium as
 * the leader of its own process group and kills that group when this
 * process exits; `close()` also kills it when Chromium does not exit in time.
 */
export class SessionBrowser {
	private state: BrowserState | null = null;
	private launching: Promise<BrowserState> | null = null;
	private disposed = false;
	private readonly options: SessionBrowserOptions;

	constructor(options: SessionBrowserOptions) {
		this.options = options;
	}

	/** Chromium's process-group id, once launched (null off Linux or before launch). */
	get pid(): number | null {
		return this.state?.pid ?? null;
	}

	async page(): Promise<Page> {
		return (await this.ensure()).page;
	}

	private async ensure(): Promise<BrowserState> {
		if (this.disposed) throw new Error("The session browser has been shut down.");
		if (this.state && this.state.browser.isConnected()) return this.state;
		// Concurrent first calls share one launch: two would leave an orphan.
		this.launching ??= this.launch().finally(() => {
			this.launching = null;
		});
		return this.launching;
	}

	private async launch(): Promise<BrowserState> {
		// A browser that died: its live view ends and any helper left in its
		// group goes with it.
		const dead = this.state;
		this.state = null;
		if (dead) await closeBrowser(dead);
		const env = this.options.env ?? process.env;
		const plan = buildLaunchPlan(env);
		let browser: Browser;
		const before = ownChromiumLeaders();
		try {
			const chromium = await this.options.chromium();
			browser = await chromium.launch({
				headless: plan.headless,
				...(plan.chromiumSandbox === false ? { chromiumSandbox: false } : {}),
				...(plan.args ? { args: plan.args } : {}),
				...(plan.proxy ? { proxy: plan.proxy } : {}),
				...(this.options.handleSignals === false ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
			});
		} catch (error) {
			throw describeLaunchError(error);
		}
		const fresh = [...ownChromiumLeaders()].filter((candidate) => !before.has(candidate));
		// Two candidates means a concurrent launch elsewhere in this process: no guess.
		const pid = fresh.length === 1 ? fresh[0] : null;
		let state: BrowserState;
		try {
			state = await this.openPage(browser, pid, env);
		} catch (error) {
			// Launched but unusable: never leave it running untracked.
			await closeBrowser({ browser, surface: null, pid });
			throw error;
		}
		this.state = state;
		if (this.disposed) {
			// Disposed while launching: do not leave this browser behind.
			await this.close();
			throw new Error("The session browser has been shut down.");
		}
		this.options.onLaunch?.();
		return this.state;
	}

	private async openPage(browser: Browser, pid: number | null, env: NodeJS.ProcessEnv): Promise<BrowserState> {
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
		const surface = await BrowserSurfaceBridge.start(page, env, this.options.log);
		return { browser, context, page, console: ring, surface, pid };
	}

	private async describePage(page: Page): Promise<{ body: string; truncated: boolean }> {
		const outline = await page.locator("body").ariaSnapshot();
		const capped = truncate(outline, SNAPSHOT_MAX_CHARS);
		const body = [`url: ${page.url()}`, `title: ${await page.title()}`, "", capped.text].join("\n");
		return { body, truncated: capped.truncated };
	}

	async navigate(params: { url: string }): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		const response = await page.goto(params.url);
		this.options.onAction?.({ kind: "navigate", url: params.url });
		const status = response?.status();
		const described = await this.describePage(page);
		return { text: described.body, details: { url: page.url(), ...(status !== undefined ? { status } : {}), truncated: described.truncated } };
	}

	async snapshot(): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		const described = await this.describePage(page);
		return { text: described.body, details: { url: page.url(), truncated: described.truncated } };
	}

	async click(params: { selector: string }): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		await page.click(params.selector);
		this.options.onAction?.({ kind: "click", selector: params.selector });
		const described = await this.describePage(page);
		return { text: described.body, details: { url: page.url(), selector: params.selector } };
	}

	async type(params: { selector: string; value: string; submit?: boolean }): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		await page.fill(params.selector, params.value);
		if (params.submit) await page.press(params.selector, "Enter");
		this.options.onAction?.({ kind: "fill", selector: params.selector, value: params.value, submit: Boolean(params.submit) });
		const described = await this.describePage(page);
		return { text: described.body, details: { url: page.url(), selector: params.selector, submitted: Boolean(params.submit) } };
	}

	/**
	 * Screenshot into the ledger's directory and record it in the
	 * pr-attachments manifest (see ../pr-attachments/manifest.ts). The caller
	 * builds the ledger, keyed by its session.
	 */
	async screenshot(params: { full_page?: boolean; label?: string }, ledger: ScreenshotLedger): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		const dir = ledger.shotDir;
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `shot-${Date.now()}.png`);
		const buf = await page.screenshot({ fullPage: Boolean(params.full_page), path: file });
		const url = page.url();
		const label = params.label ?? "";
		// Best-effort: a manifest write that fails must never fail the screenshot.
		let recorded;
		try {
			recorded = ledger.record({ path: file, label, url });
		} catch {
			recorded = undefined;
		}
		const labelNote = label ? ` [${label}]` : "";
		return {
			text: `Saved to ${file}${labelNote} (${url})`,
			image: { data: buf.toString("base64"), mimeType: "image/png" },
			details: {
				path: file,
				url,
				full_page: Boolean(params.full_page),
				...(label ? { label } : {}),
				...(recorded ? { taken_at: recorded.taken_at } : {}),
			},
		};
	}

	async console(params: { clear?: boolean }): Promise<BrowserOutput> {
		const s = await this.ensure();
		const body = s.console.length ? s.console.join("\n") : "(no console output captured)";
		const count = s.console.length;
		if (params.clear) s.console.length = 0;
		return { text: body, details: { count, cleared: Boolean(params.clear) } };
	}

	async evaluate(params: { expression: string }): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		const result: unknown = await page.evaluate(params.expression);
		let rendered: string;
		try {
			rendered = JSON.stringify(result, null, 2) ?? "undefined";
		} catch {
			rendered = String(result);
		}
		const capped = truncate(rendered, SNAPSHOT_MAX_CHARS);
		return { text: capped.text, details: { truncated: capped.truncated } };
	}

	async waitFor(params: { selector: string; state?: "visible" | "hidden"; timeout_ms?: number }): Promise<BrowserOutput> {
		const { page } = await this.ensure();
		const state = params.state ?? "visible";
		const timeout = params.timeout_ms ?? ACTION_TIMEOUT_MS;
		await page.waitForSelector(params.selector, { state, timeout });
		this.options.onAction?.({ kind: "wait", selector: params.selector, state, timeoutMS: timeout });
		const described = await this.describePage(page);
		return { text: described.body, details: { url: page.url(), selector: params.selector, state } };
	}

	/**
	 * Stop the live view, close Chromium, and — if it has not exited within
	 * CLOSE_TIMEOUT_MS or left helpers behind — SIGKILL its process group. The
	 * next tool call launches a fresh browser (pi keeps the extension across
	 * `/new`); `dispose()` is the end of the host.
	 */
	async close(): Promise<void> {
		const s = this.state;
		this.state = null;
		if (s) await closeBrowser(s);
	}

	/** Close for good: a launch in flight is closed when it lands, and no call launches again. */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.launching?.catch(() => {});
		await this.close();
	}
}
