/**
 * The session browser and flow tools on the adapter's MCP server: listed with
 * pi's own schemas, then driven over the real stdio transport against a real
 * headless Chromium and a local `http://127.0.0.1` page — navigate, snapshot,
 * screenshot (file + inline image), console, the live-view surface, and the
 * browser's process group gone when the server shuts down.
 *
 * Needs the pinned chromium-headless-shell (`npx playwright-core@<pinned>
 * install chromium-headless-shell`); the real-browser cases skip, saying so,
 * on a host without it. The harness gives the server a temp HOME, so the
 * browser is found through PLAYWRIGHT_BROWSERS_PATH.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, BrowserTools, checkArgs } from "../claude/mcp/browser-tools.ts";
import { browserInstallCommand, describeLaunchError, SessionBrowser } from "../extensions/browser/core.ts";
import browserExtension from "../extensions/browser/index.ts";
import { makeLaunch, McpClient, REPO, startFakeHive, type FakeHive, type LaunchEnv } from "./claude-harness.ts";
import { createFakePi } from "./fake-pi.ts";

const BROWSERS_PATH = join(homedir(), ".cache", "ms-playwright");
const HEADLESS_REVISION = (
	JSON.parse(readFileSync(join(REPO, "node_modules", "playwright-core", "browsers.json"), "utf8")) as { browsers: { name: string; revision: string }[] }
).browsers.find((b) => b.name === "chromium-headless-shell")?.revision;
const BROWSER_INSTALLED = HEADLESS_REVISION !== undefined && existsSync(join(BROWSERS_PATH, `chromium_headless_shell-${HEADLESS_REVISION}`));
if (!BROWSER_INSTALLED) {
	console.warn(`claude-browser: real-browser cases skipped — chromium-headless-shell-${HEADLESS_REVISION} is not installed; run \`${browserInstallCommand()}\``);
}

/**
 * The environment an in-process browser gets: never this test process's own,
 * which may be a Hive launch whose live-view dir must not be written to.
 */
const CLEAN_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the browser prerequisite", () => {
	// CI installs the headless shell (.github/workflows/check.yml); a skip
	// there would hide every real-browser case.
	it.runIf(Boolean(process.env.CI))("is installed on CI", () => {
		expect(BROWSER_INSTALLED, `chromium-headless-shell-${HEADLESS_REVISION} is missing; CI must run \`${browserInstallCommand()}\``).toBe(true);
	});
});

describe("browser tool definitions", () => {
	it("lists pi's browser and flow tools with object JSON schemas whose required keys exist", () => {
		expect(BROWSER_TOOL_NAMES).toEqual([
			"browser_navigate",
			"browser_snapshot",
			"browser_click",
			"browser_type",
			"browser_screenshot",
			"browser_console",
			"browser_evaluate",
			"browser_wait_for",
			"report_dev_server",
			"run_saved_agent_flow",
			"record_playwright_flow",
			"run_playwright_flow_source",
			"author_maestro_flow",
		]);
		for (const tool of BROWSER_TOOLS) {
			const schema = tool.inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
			expect(schema.type).toBe("object");
			expect(typeof schema.properties).toBe("object");
			for (const key of schema.required ?? []) expect(Object.keys(schema.properties)).toContain(key);
			expect(tool.description.length).toBeGreaterThan(20);
		}
	});

	it("serves exactly the names, descriptions and schemas pi registers (typebox, serialised)", async () => {
		const fake = createFakePi();
		await browserExtension(fake.api as unknown as ExtensionAPI);
		const registered = new Map(fake.tools.map((tool) => [tool.name, tool.definition]));
		expect([...registered.keys()].sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
		for (const tool of BROWSER_TOOLS) {
			const pi = registered.get(tool.name) as { description: string; parameters: unknown };
			expect(tool.description).toBe(pi.description);
			expect(tool.inputSchema).toEqual(JSON.parse(JSON.stringify(pi.parameters)));
		}
	});

	it("holds MCP arguments to the schema", () => {
		expect(checkArgs("browser_navigate", {})).toBe('browser_navigate needs "url".');
		expect(checkArgs("browser_navigate", { url: 7 })).toBe('browser_navigate: "url" must be a string.');
		expect(checkArgs("browser_type", { selector: "#a", value: "x", submit: "yes" })).toBe('browser_type: "submit" must be a boolean.');
		expect(checkArgs("browser_wait_for", { selector: "#a", state: "gone" })).toBe('browser_wait_for: "state" must be one of "visible", "hidden".');
		expect(checkArgs("browser_wait_for", { selector: "#a", timeout_ms: 50 })).toBe('browser_wait_for: "timeout_ms" must be at least 100.');
		expect(checkArgs("browser_wait_for", { selector: "#a", timeout_ms: 1.5 })).toBe('browser_wait_for: "timeout_ms" must be an integer.');
		expect(checkArgs("record_playwright_flow", { action: "stop" })).toBeNull();
		expect(checkArgs("browser_snapshot", {})).toBeNull();
	});

	it("names the pinned install command when the browser binary is missing", () => {
		const error = describeLaunchError(new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell\n╔══ run npx playwright install"));
		expect(error.message).toContain(browserInstallCommand());
		expect(browserInstallCommand()).toMatch(/^npx playwright-core@\d+\.\d+\.\d+ install chromium-headless-shell$/);
		const other = new Error("Target page, context or browser has been closed");
		expect(describeLaunchError(other)).toBe(other);
	});
});

/** Processes in process group `pgid` (Linux /proc). */
function groupMembers(pgid: number): number[] {
	const members: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[2]) === pgid) members.push(Number(entry));
		} catch {
			// Exited meanwhile.
		}
	}
	return members;
}

/** The headless shell the server launched: its child that leads its own process group. */
function browserLeader(serverPid: number): number | undefined {
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
			if (Number(fields[1]) === serverPid && Number(fields[2]) === Number(entry) && cmdline.includes("headless")) return Number(entry);
		} catch {
			// Exited meanwhile.
		}
	}
	return undefined;
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

describe.skipIf(!BROWSER_INSTALLED || process.platform !== "linux")("the session browser over MCP", () => {
	let site: Server;
	let base: string;
	let launch: LaunchEnv;
	let hive: FakeHive;
	let client: McpClient | undefined;

	beforeAll(async () => {
		site = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			if (req.url === "/next") {
				res.end("<html><title>next</title><body><h1>Arrived</h1></body></html>");
				return;
			}
			res.end(
				"<html><title>mcp-page</title><body><h1>Claude Browser Heading</h1>" +
					"<script>console.log('hello from the page'); console.error('page error line')</script>" +
					"<input placeholder=\"name\"/><a href=\"/next\">Next</a></body></html>",
			);
		});
		await new Promise<void>((ready) => site.listen(0, "127.0.0.1", () => ready()));
		const address = site.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});
	afterAll(() => {
		site.close();
	});
	beforeEach(async () => {
		launch = makeLaunch();
		hive = await startFakeHive();
		launch.env.HIVE_URL = hive.url;
		launch.env.HIVE_TOKEN = "session-token";
		launch.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
		launch.env.HIVE_PR_ATTACHMENTS_DIR = join(launch.root, "attachments");
	});
	afterEach(async () => {
		await client?.close();
		client = undefined;
		await hive.close();
	});

	async function connect(env: Record<string, string>): Promise<McpClient> {
		client = new McpClient(env);
		const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		expect(init.result?.protocolVersion).toBe("2025-06-18");
		client.notify("notifications/initialized");
		return client;
	}

	it("navigates, snapshots, screenshots, reads the console, and leaves no Chromium behind", async () => {
		const c = await connect(launch.env);
		const nav = await c.call("browser_navigate", { url: `${base}/` });
		expect(nav.isError).toBe(false);
		expect(nav.text).toContain("title: mcp-page");
		expect(nav.text).toContain('heading "Claude Browser Heading"');

		const snap = await c.call("browser_snapshot");
		expect(snap.text).toContain(`url: ${base}/`);
		expect(snap.text).toContain('heading "Claude Browser Heading"');

		const typed = await c.call("browser_type", { selector: "input", value: "Ada" });
		expect(typed.isError).toBe(false);
		const value = await c.call("browser_evaluate", { expression: "document.querySelector('input').value" });
		expect(value.text).toBe('"Ada"');

		const shot = await c.call("browser_screenshot", { label: "after" });
		expect(shot.isError).toBe(false);
		expect(shot.content.map((block) => block.type)).toEqual(["image", "text"]);
		expect(shot.content[0].mimeType).toBe("image/png");
		const file = /Saved to (\S+) \[after\]/.exec(shot.text)?.[1];
		expect(file).toBeDefined();
		expect(readFileSync(file as string).subarray(1, 4).toString()).toBe("PNG");
		expect(Buffer.from(shot.content[0].data as string, "base64").equals(readFileSync(file as string))).toBe(true);
		// The pr-attachments ledger, keyed by the session's run id.
		expect(file).toContain("pi-browser-run-123");
		const manifest = JSON.parse(readFileSync(join(launch.root, "attachments", "pr-attachments.json"), "utf8")) as { path: string; label: string; url: string }[];
		expect(manifest).toEqual([expect.objectContaining({ path: file, label: "after", url: `${base}/` })]);
		// A labelled shot is posted to the Hive chat; the driver folds the trailing id.
		const uploads = () => hive.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/agent-sessions/srv-uuid-1/output-attachments");
		expect(uploads()).toHaveLength(1);
		expect(shot.text.split("\n").at(-1)).toBe(`Posted to the Hive chat: Screenshot · after · ${base}/ (attachment 0f8fad5b-d9cb-469f-a165-70867728950e)`);
		// An unlabelled shot is the agent's own and stays local.
		const own = await c.call("browser_screenshot", {});
		expect(own.text).not.toContain("Hive chat");
		expect(uploads()).toHaveLength(1);

		const consoleOut = await c.call("browser_console", { clear: true });
		expect(consoleOut.text).toContain("[log] hello from the page");
		expect(consoleOut.text).toContain("[error] page error line");
		expect((await c.call("browser_console")).text).toBe("(no console output captured)");

		const clicked = await c.call("browser_click", { selector: "text=Next" });
		expect(clicked.text).toContain('heading "Arrived"');
		const missing = await c.call("browser_wait_for", { selector: "#nope", timeout_ms: 200 });
		expect(missing.isError).toBe(true);

		const leader = browserLeader(c.child.pid as number);
		expect(leader).toBeDefined();
		expect(groupMembers(leader as number).length).toBeGreaterThan(0);
		expect(await c.close()).toBe(0);
		client = undefined;
		// Every process of the browser's group is gone with the server.
		await waitFor(() => groupMembers(leader as number).length === 0, 10_000, "the browser's process group to exit");
	}, 60_000);

	it("finds Chromium's own process group — not another group this process leads — and closes it", async () => {
		// A helper group of this process, started first, that must not be taken for the browser.
		const { spawn } = await import("node:child_process");
		const decoy = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		const { chromium } = await import("playwright-core");
		const browser = new SessionBrowser({ chromium: async () => chromium, env: CLEAN_ENV, handleSignals: false });
		try {
			await browser.navigate({ url: `${base}/` });
			const pid = browser.pid as number;
			expect(pid).not.toBe(decoy.pid);
			expect(browserLeader(process.pid)).toBe(pid);
			await browser.dispose();
			expect(groupMembers(pid)).toEqual([]);
			await expect(browser.snapshot()).rejects.toThrow("shut down");
		} finally {
			decoy.kill("SIGKILL");
		}
	}, 60_000);

	it("never runs a call cancelled while queued; a running call cancelled closes the browser, and the next call relaunches", async () => {
		const c = await connect(launch.env);
		await c.call("browser_navigate", { url: `${base}/` });
		const slow = c.send("tools/call", { name: "browser_evaluate", arguments: { expression: "new Promise((r) => setTimeout(() => r('slow done'), 1500))" } });
		const queued = c.send("tools/call", { name: "browser_type", arguments: { selector: "input", value: "never typed" } });
		c.notify("notifications/cancelled", { requestId: queued.id });
		// browser_console reads the buffer: it does not wait behind the page queue.
		const consoleStarted = Date.now();
		await c.call("browser_console");
		expect(Date.now() - consoleStarted).toBeLessThan(1_000);
		const slowAnswer = (await slow.answer).result?.content as { text: string }[];
		expect(slowAnswer[0].text).toBe('"slow done"');
		expect((await c.call("browser_evaluate", { expression: "document.querySelector('input').value" })).text).toBe('""');

		const leader = browserLeader(c.child.pid as number) as number;
		const stuck = c.send("tools/call", { name: "browser_evaluate", arguments: { expression: "(() => { for (;;) {} })()" } });
		await sleep(500);
		c.notify("notifications/cancelled", { requestId: stuck.id });
		const after = await c.call("browser_navigate", { url: `${base}/` });
		expect(after.isError).toBe(false);
		expect(after.text).toContain('heading "Claude Browser Heading"');
		// A fresh browser: the stuck one's group is gone.
		expect(groupMembers(leader)).toEqual([]);
		expect(browserLeader(c.child.pid as number)).not.toBe(leader);
	}, 60_000);

	it("closes the browser when a call holds the page past its bound, and relaunches on the next call", async () => {
		const tools = new BrowserTools({}, () => {}, CLEAN_ENV, { pageBoundMs: (name) => (name === "browser_evaluate" ? 1_000 : 30_000) });
		const signal = new AbortController().signal;
		try {
			await tools.call("browser_navigate", { url: `${base}/` }, signal);
			await expect(tools.call("browser_evaluate", { expression: "(() => { for (;;) {} })()" }, signal)).rejects.toThrow(
				"browser_evaluate did not finish within 1 s; the session browser was closed and relaunches on the next call.",
			);
			const next = await tools.call("browser_snapshot", {}, signal);
			expect(next.text).toContain("url: about:blank");
		} finally {
			await tools.stop();
		}
	}, 60_000);

	it("runs a claimed saved flow in its turn on the page, never alongside a tool call", async () => {
		hive.flowClaims = [];
		const c = await connect(launch.env);
		await c.call("browser_navigate", { url: `${base}/` });
		const slow = c.send("tools/call", {
			name: "browser_evaluate",
			arguments: { expression: "new Promise((r) => setTimeout(() => { window.order = (window.order || []).concat('tool'); r(1); }, 3000))" },
		});
		// The claim loop polls every 2 s, so this run is claimed while the tool call holds the page.
		hive.flowClaims.push({
			run: { id: "run-1", format: "playwright", source: "await page.evaluate(() => { window.order = (window.order || []).concat('flow'); });" },
			claim_token: "claim-1",
			connection_url: base,
		});
		await slow.answer;
		const complete = await waitFor(() => hive.requests.find((r) => r.path === "/api/v1/agent-sessions/srv-uuid-1/flow-runs/run-1/complete"), 15_000, "the claimed run to complete");
		expect(complete.body).toMatchObject({ claim_token: "claim-1", state: "succeeded" });
		expect(JSON.parse((await c.call("browser_evaluate", { expression: "window.order" })).text)).toEqual(["tool", "flow"]);
	}, 60_000);

	it("on SIGTERM ends the dev-server report and the surface row, and leaves no Chromium", async () => {
		const launchId = randomUUID();
		const dir = join(launch.root, ".hive", "scratch", "launch", "browser");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		execFileSync("mkfifo", ["-m", "600", join(dir, "frames.fifo"), join(dir, "control.fifo")]);
		const c = await connect({
			...launch.env,
			HIVE_LAUNCH_ID: launchId,
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: join(dir, "manifest.json"),
		});
		expect((await c.call("report_dev_server", { base_url: base })).text).toContain(`Reporting dev-server at ${base}`);
		await c.call("browser_navigate", { url: `${base}/` });
		const surface = `/api/v1/agent-sessions/srv-uuid-1/surfaces/${launchId}`;
		await waitFor(() => hive.requests.find((r) => r.method === "PUT" && r.path === surface), 15_000, "the surface row");
		const leader = browserLeader(c.child.pid as number) as number;

		c.child.kill("SIGTERM");
		expect(await c.exited).toBe(0);
		client = undefined;
		const devServer = hive.requests.filter((r) => r.path === "/api/v1/agent-sessions/srv-uuid-1/resources/dev-server").map((r) => (r.body as { state: string }).state);
		expect(devServer.at(-1)).toBe("ended");
		expect(hive.requests.filter((r) => r.method === "PUT" && r.path === surface).at(-1)?.body).toMatchObject({ state: "ended", ttl_seconds: 0 });
		expect((JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { state: string }).state).toBe("ended");
		await waitFor(() => groupMembers(leader).length === 0, 10_000, "the browser's process group to exit");
	}, 60_000);

	it("drops a live-view frame it cannot write, says why once, and keeps serving", async () => {
		const dir = join(launch.root, ".hive", "scratch", "launch", "browser");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		execFileSync("mkfifo", ["-m", "600", join(dir, "frames.fifo"), join(dir, "control.fifo")]);
		const c = await connect({
			...launch.env,
			HIVE_LAUNCH_ID: randomUUID(),
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: join(dir, "manifest.json"),
		});
		await c.call("browser_navigate", { url: `${base}/` });
		// The scratch dir is removed under the running browser.
		rmSync(dir, { recursive: true, force: true });
		for (const page of ["/next", "/", "/next"]) {
			await sleep(2_100);
			await c.call("browser_navigate", { url: `${base}${page}` });
		}
		await waitFor(() => c.stderr.includes("browser live view: dropped a frame"), 10_000, "the dropped-frame line");
		expect((await c.request("ping")).result).toEqual({});
		expect(c.stderr.split("browser live view: dropped a frame").length - 1).toBe(1);
		expect(c.stderr).toContain("ENOENT");
	}, 60_000);

	it("records a Playwright flow from the browser tools and replays it", async () => {
		const c = await connect(launch.env);
		await c.call("browser_navigate", { url: `${base}/` });
		expect((await c.call("record_playwright_flow", { action: "start" })).isError).toBe(false);
		await c.call("browser_navigate", { url: `${base}/` });
		await c.call("browser_click", { selector: "text=Next" });
		const stopped = await c.call("record_playwright_flow", { action: "stop" });
		expect(stopped.text).toContain('await page.goto(new URL("/", baseURL).toString());');
		expect(stopped.text).toContain('await page.click("text=Next");');
		const replay = await c.call("run_playwright_flow_source", { source: stopped.text, base_url: base });
		expect(replay.text).toBe(`Flow completed at ${base}/next`);
		const external = await c.call("run_playwright_flow_source", { source: stopped.text, base_url: "https://example.com" });
		expect(external).toMatchObject({ isError: true, text: "runtime flow base URL must be an HTTP(S) loopback address" });
	}, 60_000);

	it("publishes the live view: surface files for the desktop, the surface row and snapshot to Hive", async () => {
		const launchId = randomUUID();
		const dir = join(launch.root, ".hive", "scratch", "launch", "browser");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		execFileSync("mkfifo", ["-m", "600", join(dir, "frames.fifo"), join(dir, "control.fifo")]);
		const c = await connect({
			...launch.env,
			HIVE_LAUNCH_ID: launchId,
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: join(dir, "manifest.json"),
		});
		await c.call("browser_navigate", { url: `${base}/` });
		const manifest = () => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { kind: string; state: string; launch_id: string };
		expect(manifest()).toMatchObject({ kind: "browser", state: "ready", launch_id: launchId });
		await waitFor(() => existsSync(join(dir, "latest-web.json")), 10_000, "latest-web.json");
		const surface = `/api/v1/agent-sessions/srv-uuid-1/surfaces/${launchId}`;
		await waitFor(() => hive.requests.find((r) => r.method === "PUT" && r.path.startsWith(`${surface}/snapshot?sequence=`)), 15_000, "the snapshot upload");
		expect(hive.requests.find((r) => r.method === "PUT" && r.path === surface)?.body).toMatchObject({ kind: "browser", state: "ready" });
		expect(hive.requests.find((r) => r.path.startsWith(`${surface}/snapshot`))?.body).toMatchObject({ contentType: "image/jpeg" });
		// The first snapshot can catch the page mid-load; a later page shows up
		// once the 2 s snapshot interval has passed.
		await new Promise((r) => setTimeout(r, 2_100));
		await c.call("browser_navigate", { url: `${base}/next` });
		await waitFor(
			() => hive.requests.find((r) => r.method === "PUT" && r.path === surface && (r.body as { url?: string }).url === `${base}/next`),
			15_000,
			"the surface row to show the new page",
		);

		expect(await c.close()).toBe(0);
		client = undefined;
		expect(manifest().state).toBe("ended");
		expect(hive.requests.filter((r) => r.method === "PUT" && r.path === surface).at(-1)?.body).toMatchObject({ state: "ended", ttl_seconds: 0 });
	}, 60_000);
});

describe("the session browser without its binary", () => {
	it("answers isError naming the pinned install command, and the server keeps serving", async () => {
		const launch = makeLaunch();
		const empty = mkdtempSync(join(tmpdir(), "no-browsers-"));
		const c = new McpClient({ ...launch.env, PLAYWRIGHT_BROWSERS_PATH: empty });
		try {
			await c.request("initialize", { protocolVersion: "2025-06-18" });
			const nav = await c.call("browser_navigate", { url: "http://127.0.0.1:9/" });
			expect(nav.isError).toBe(true);
			expect(nav.text).toContain(browserInstallCommand());
			expect((await c.request("ping")).result).toEqual({});
		} finally {
			expect(await c.close()).toBe(0);
		}
	}, 30_000);
});
