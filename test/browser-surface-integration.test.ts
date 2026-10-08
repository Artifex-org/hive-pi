import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Page } from "playwright-core";
import { SessionBrowser } from "../extensions/browser/core.ts";
import { AGENT_PAUSED_MESSAGE } from "../extensions/browser/surface.ts";

// Real-browser integration for the live-view bridge (hive's
// docs/agent-live-browser.md §1–4), driven through the session browser the
// agent's tools use. Gated like browser-integration.test.ts:
//
//   PI_BROWSER_IT=1 npx vitest run test/browser-surface-integration.test.ts

const enabled = process.env.PI_BROWSER_IT === "1";

async function eventually<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeout = 10_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== null && value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for browser surface bridge");
}

interface Message {
	type: string;
	id?: string;
	ok?: boolean;
	error?: string;
	url?: string;
	view?: string;
	operator_tab?: boolean;
	agent_paused?: boolean;
	/** The frame's base64 length; the picture itself is not kept. */
	bytes?: number;
}

/** Drains one frame FIFO into parsed messages, as the desktop app and the relay do. */
class Reader {
	readonly messages: Message[] = [];
	private buffered = "";
	private readonly fd: number;
	private readonly chunk = Buffer.allocUnsafe(1 << 20);

	constructor(file: string) {
		this.fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	}

	drain(): void {
		for (;;) {
			let n = 0;
			try {
				n = fs.readSync(this.fd, this.chunk, 0, this.chunk.length, null);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
				throw error;
			}
			if (n <= 0) return;
			this.buffered += this.chunk.subarray(0, n).toString("utf8");
			let newline = this.buffered.indexOf("\n");
			while (newline >= 0) {
				const value = JSON.parse(this.buffered.slice(0, newline)) as Message & { data?: string };
				this.buffered = this.buffered.slice(newline + 1);
				const { data, ...rest } = value;
				this.messages.push(data === undefined ? rest : { ...rest, bytes: data.length });
				newline = this.buffered.indexOf("\n");
			}
		}
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

describe.skipIf(!enabled)("browser surface FIFO integration", () => {
	let root = "";
	let dir = "";
	let server: http.Server;
	let browser: SessionBrowser;
	let page: Page;
	let desktop: Reader;
	let relay: Reader;
	let drainer: NodeJS.Timeout | undefined;
	let base = "";
	let generation = 1;
	const leaseID = "relay-browser-surface-it-0123";
	let commandSeq = 0;

	function writeLease(fields: { exclusive?: boolean; expires_at?: number } = {}): void {
		const lease = {
			id: leaseID,
			generation,
			expires_at: fields.expires_at ?? Date.now() + 60_000,
			holder: "relay",
			...(fields.exclusive ? { exclusive: true } : {}),
		};
		fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify(lease), { mode: 0o600 });
	}

	async function send(command: Record<string, unknown>, stamp: Record<string, unknown> = {}): Promise<string> {
		const id = `cmd-${++commandSeq}`;
		const controlFD = await eventually(() => {
			try {
				return fs.openSync(path.join(dir, "control.fifo"), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENXIO") return null;
				throw error;
			}
		});
		fs.writeSync(controlFD, `${JSON.stringify({ id, lease_id: leaseID, generation, ...command, ...stamp })}\n`);
		fs.closeSync(controlFD);
		return id;
	}

	/** The command's answer, which both FIFOs must carry identically. */
	async function result(id: string, timeout = 10_000): Promise<Message> {
		const answer = await eventually(() => desktop.messages.find((m) => m.type === "control_result" && m.id === id), timeout);
		const relayed = await eventually(() => relay.messages.find((m) => m.type === "control_result" && m.id === id), timeout);
		expect(relayed).toEqual(answer);
		return answer;
	}

	async function run(command: Record<string, unknown>): Promise<Message> {
		return result(await send(command));
	}

	/** The first frame after `mark` matching `want`, on both FIFOs. */
	async function frame(mark: { desktop: number; relay: number }, want: (m: Message) => boolean): Promise<Message> {
		const match = (m: Message) => m.type === "frame" && want(m);
		const seen = await eventually(() => desktop.messages.slice(mark.desktop).find(match));
		await eventually(() => relay.messages.slice(mark.relay).find(match));
		return seen;
	}

	function mark(): { desktop: number; relay: number } {
		return { desktop: desktop.messages.length, relay: relay.messages.length };
	}

	beforeAll(async () => {
		const scratch = path.join(os.homedir(), ".hive", "scratch");
		const relative = path.relative(scratch, process.cwd());
		const first = relative.split(path.sep)[0];
		const writable = first && first !== ".." ? path.join(scratch, first) : scratch;
		fs.mkdirSync(writable, { recursive: true, mode: 0o700 });
		root = fs.mkdtempSync(path.join(writable, "browser-surface-it-"));
		dir = path.join(root, "browser-surface");
		fs.mkdirSync(dir, { mode: 0o700 });
		for (const name of ["frames.fifo", "relay-frames.fifo", "control.fifo"]) {
			const made = spawnSync("mkfifo", ["-m", "600", path.join(dir, name)]);
			if (made.status !== 0) throw new Error(made.stderr.toString());
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HIVE_LAUNCH_ID: "browser-surface-integration",
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: path.join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: path.join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: path.join(dir, "manifest.json"),
		};
		desktop = new Reader(env.HIVE_BROWSER_FRAME_FIFO!);
		relay = new Reader(path.join(dir, "relay-frames.fifo"));
		drainer = setInterval(() => {
			desktop.drain();
			relay.drain();
		}, 10);
		server = http.createServer((req, res) => {
			if (req.url === "/next") {
				res.end("<html><title>next</title><body>Arrived</body></html>");
			} else if (req.url === "/op") {
				res.end("<html><title>operator</title><body>Operator tab</body></html>");
			} else {
				res.end(
					'<html><title>start</title><body style="height:5000px;margin:0">' +
						'<input id="t"><input id="p" type="password">' +
						'<script>window.wheelY = 0; addEventListener("wheel", (e) => { window.wheelY += e.deltaY; });</script>' +
						"</body></html>",
				);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no test listener");
		base = `http://127.0.0.1:${address.port}`;
		browser = new SessionBrowser({ chromium: async () => chromium, env, handleSignals: false, log: () => {} });
		await browser.navigate({ url: `${base}/` });
		page = await browser.page();
	}, 60_000);

	afterAll(async () => {
		await browser?.dispose();
		if (drainer) clearInterval(drainer);
		server?.close();
		desktop?.close();
		relay?.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("streams real CDP frames to both FIFOs and applies lease-bound navigation and history", async () => {
		const first = await frame({ desktop: 0, relay: 0 }, () => true);
		expect(first.bytes).toBeGreaterThan(1_000);
		expect(first).toMatchObject({ view: "agent", operator_tab: false, agent_paused: false });

		// No lease yet: the command is answered, not dropped.
		expect(await run({ kind: "navigate", url: `${base}/next` })).toMatchObject({ ok: false, error: "no_lease" });

		writeLease();
		expect(await run({ kind: "navigate", url: `${base}/next` })).toMatchObject({ ok: true });
		expect(page.url()).toBe(`${base}/next`);
		expect(await page.title()).toBe("next");
		expect(await run({ kind: "history", action: "back" })).toMatchObject({ ok: true });
		expect(page.url()).toBe(`${base}/`);

		expect(await result(await send({ kind: "navigate", url: `${base}/` }, { generation: generation + 1 })))
			.toMatchObject({ ok: false, error: "invalid" });
		expect(await run({ kind: "mouse", event_type: "Runtime.evaluate", x: 0, y: 0 })).toMatchObject({ ok: false, error: "invalid" });
	}, 30_000);

	it("scrolls with wheel deltas", async () => {
		expect(await run({ kind: "mouse", event_type: "mouseWheel", x: 100, y: 100, delta_x: 0, delta_y: 400 })).toMatchObject({ ok: true });
		await eventually(async () => ((await page.evaluate("window.wheelY")) === 400 ? true : null));
		await eventually(async () => ((await page.evaluate("window.scrollY")) as number) > 0 ? true : null);
	}, 30_000);

	it("pastes and types text, but never into a focused password field", async () => {
		await page.focus("#t");
		expect(await run({ kind: "insert_text", text: "hello" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "keyDown", key: "!", code: "Digit1", text: "!" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "keyUp", key: "!", code: "Digit1" })).toMatchObject({ ok: true });
		expect(await page.inputValue("#t")).toBe("hello!");
		// Editing keys carry no text: they work only with a virtual key code.
		expect(await run({ kind: "key", event_type: "rawKeyDown", key: "Backspace", code: "Backspace" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "keyUp", key: "Backspace", code: "Backspace" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft" })).toMatchObject({ ok: true });
		expect(await run({ kind: "insert_text", text: "X" })).toMatchObject({ ok: true });
		expect(await page.inputValue("#t")).toBe("hellXo");
		await page.fill("#t", "hello!");

		await page.focus("#p");
		expect(await run({ kind: "insert_text", text: "secret" })).toMatchObject({ ok: false, error: "password_field" });
		expect(await run({ kind: "key", event_type: "keyDown", key: "s", code: "KeyS", text: "s" })).toMatchObject({ ok: false, error: "password_field" });
		expect(await run({ kind: "key", event_type: "char", key: "s", text: "s" })).toMatchObject({ ok: false, error: "password_field" });
		// A key without text (a modifier, an arrow) is not text entry, and nor is
		// a control character: Enter must still submit a login form.
		expect(await run({ kind: "key", event_type: "keyDown", key: "Enter", code: "Enter", text: "\r" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "keyDown", key: "Shift", code: "ShiftLeft" })).toMatchObject({ ok: true });
		expect(await run({ kind: "key", event_type: "keyUp", key: "Shift", code: "ShiftLeft" })).toMatchObject({ ok: true });
		expect(await page.inputValue("#p")).toBe("");
		await page.focus("#t");
	}, 30_000);

	it("opens, views and closes an operator tab in the agent's context; the screencast follows the view", async () => {
		let at = mark();
		expect(await run({ kind: "tab", action: "open", url: `${base}/op` })).toMatchObject({ ok: true });
		const operatorFrame = await frame(at, (m) => m.view === "operator");
		expect(operatorFrame).toMatchObject({ operator_tab: true, agent_paused: false });
		expect(operatorFrame.url).toBe(`${base}/op`);
		expect(page.url()).toBe(`${base}/`);
		const operatorPage = page.context().pages().find((p) => p !== page)!;
		expect(operatorPage.url()).toBe(`${base}/op`);

		// Input reaches the page in view.
		expect(await run({ kind: "navigate", url: `${base}/next` })).toMatchObject({ ok: true });
		expect(operatorPage.url()).toBe(`${base}/next`);
		expect(page.url()).toBe(`${base}/`);

		at = mark();
		expect(await run({ kind: "tab", action: "view", view: "agent" })).toMatchObject({ ok: true });
		expect(await frame(at, (m) => m.view === "agent")).toMatchObject({ operator_tab: true, url: `${base}/` });
		at = mark();
		expect(await run({ kind: "tab", action: "view", view: "operator" })).toMatchObject({ ok: true });
		expect(await frame(at, (m) => m.view === "operator")).toMatchObject({ operator_tab: true, url: `${base}/next` });

		at = mark();
		expect(await run({ kind: "tab", action: "close" })).toMatchObject({ ok: true });
		expect(await frame(at, (m) => m.view === "agent")).toMatchObject({ operator_tab: false, url: `${base}/` });
		expect(page.context().pages()).toEqual([page]);
		expect(await run({ kind: "tab", action: "close" })).toMatchObject({ ok: false, error: "no_operator_tab" });
		expect(await run({ kind: "tab", action: "view", view: "operator" })).toMatchObject({ ok: false, error: "no_operator_tab" });

		// An operator tab that closes by itself hands the view back to the agent.
		expect(await run({ kind: "tab", action: "open", url: `${base}/op` })).toMatchObject({ ok: true });
		at = mark();
		await page.context().pages().find((p) => p !== page)!.close();
		expect(await frame(at, (m) => m.view === "agent")).toMatchObject({ operator_tab: false });
	}, 60_000);

	it("pauses the agent's page tools under an exclusive lease on the agent page, and releasing resumes them", async () => {
		let at = mark();
		writeLease({ exclusive: true });
		// A static page paints no new frame: the bridge re-sends the last one with the new status.
		await frame(at, (m) => m.agent_paused === true && m.view === "agent");
		for (const call of [
			() => browser.snapshot(),
			() => browser.navigate({ url: `${base}/next` }),
			() => browser.click({ selector: "#t" }),
			() => browser.type({ selector: "#t", value: "agent" }),
			() => browser.evaluate({ expression: "1 + 1" }),
			() => browser.waitFor({ selector: "#t" }),
			// The flow tools reach the page through page(): a flow is the agent too.
			() => browser.page(),
		]) {
			await expect(call()).rejects.toThrow(AGENT_PAUSED_MESSAGE);
		}
		expect(page.url()).toBe(`${base}/`);
		// The console does not touch the page.
		await expect(browser.console({})).resolves.toBeTruthy();

		at = mark();
		writeLease({ expires_at: 0 });
		await frame(at, (m) => m.agent_paused === false);
		await expect(browser.snapshot()).resolves.toMatchObject({ details: { url: `${base}/` } });

		// With an operator tab in view the agent drives its own page again.
		generation++;
		writeLease({ exclusive: true });
		await expect(browser.snapshot()).rejects.toThrow(AGENT_PAUSED_MESSAGE);
		at = mark();
		expect(await run({ kind: "tab", action: "open", url: `${base}/op` })).toMatchObject({ ok: true });
		await frame(at, (m) => m.view === "operator" && m.agent_paused === false);
		await expect(browser.snapshot()).resolves.toMatchObject({ details: { url: `${base}/` } });

		// No live lease: the view returns to the agent page; the operator tab stays open.
		at = mark();
		writeLease({ expires_at: 0 });
		expect(await frame(at, (m) => m.view === "agent")).toMatchObject({ operator_tab: true, agent_paused: false });
		await expect(browser.snapshot()).resolves.toBeTruthy();
		expect(await run({ kind: "tab", action: "close" })).toMatchObject({ ok: false, error: "no_lease" });
	}, 60_000);
});
