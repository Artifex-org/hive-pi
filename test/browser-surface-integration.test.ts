import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildLaunchPlan } from "../extensions/browser/launch.ts";
import { BrowserSurfaceBridge } from "../extensions/browser/surface.ts";

const enabled = process.env.PI_BROWSER_IT === "1";

async function eventually<T>(fn: () => T | null, timeout = 10_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = fn();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for browser surface bridge");
}

describe.skipIf(!enabled)("browser surface FIFO integration", () => {
	let root = "";
	let server: http.Server;
	let browser: Browser;
	let page: Page;
	let bridge: BrowserSurfaceBridge;
	let frameFD = -1;
	let base = "";

	beforeAll(async () => {
		const scratch = path.join(os.homedir(), ".hive", "scratch");
		const relative = path.relative(scratch, process.cwd());
		const first = relative.split(path.sep)[0];
		const writable = first && first !== ".." ? path.join(scratch, first) : scratch;
		root = fs.mkdtempSync(path.join(writable, "browser-surface-it-"));
		const dir = path.join(root, "browser-surface");
		fs.mkdirSync(dir, { mode: 0o700 });
		for (const name of ["frames.fifo", "control.fifo"]) {
			const made = spawnSync("mkfifo", ["-m", "600", path.join(dir, name)]);
			if (made.status !== 0) throw new Error(made.stderr.toString());
		}
		Object.assign(process.env, {
			HIVE_LAUNCH_ID: "browser-surface-integration",
			HIVE_BROWSER_SURFACE_DIR: dir,
			HIVE_BROWSER_FRAME_FIFO: path.join(dir, "frames.fifo"),
			HIVE_BROWSER_CONTROL_FIFO: path.join(dir, "control.fifo"),
			HIVE_BROWSER_SURFACE_MANIFEST: path.join(dir, "manifest.json"),
		});
		frameFD = fs.openSync(process.env.HIVE_BROWSER_FRAME_FIFO!, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		server = http.createServer((req, res) => {
			const next = req.url === "/next";
			res.end(`<html><title>${next ? "next" : "start"}</title><body>${next ? "Arrived" : "Start"}</body></html>`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no test listener");
		base = `http://127.0.0.1:${address.port}`;
		const plan = buildLaunchPlan(process.env);
		browser = await chromium.launch({
			headless: true,
			...(plan.chromiumSandbox === false ? { chromiumSandbox: false } : {}),
			...(plan.args ? { args: plan.args } : {}),
			...(plan.proxy ? { proxy: plan.proxy } : {}),
		});
		const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
		page = await context.newPage();
		bridge = (await BrowserSurfaceBridge.start(page))!;
	});

	afterAll(async () => {
		await bridge?.stop();
		await browser?.close();
		server?.close();
		if (frameFD >= 0) fs.closeSync(frameFD);
		fs.rmSync(root, { recursive: true, force: true });
		for (const key of ["HIVE_BROWSER_SURFACE_DIR", "HIVE_BROWSER_FRAME_FIFO", "HIVE_BROWSER_CONTROL_FIFO", "HIVE_BROWSER_SURFACE_MANIFEST"]) {
			delete process.env[key];
		}
	});

	it("streams a real CDP frame and applies a lease-bound navigation", async () => {
		await page.goto(base);
		let buffered = "";
		const frame = await eventually(() => {
			const chunk = Buffer.allocUnsafe(256 << 10);
			try {
				const n = fs.readSync(frameFD, chunk, 0, chunk.length, null);
				if (n > 0) buffered += chunk.subarray(0, n).toString("utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			}
			const newline = buffered.indexOf("\n");
			if (newline < 0) return null;
			const value = JSON.parse(buffered.slice(0, newline)) as { type: string; data?: string };
			buffered = buffered.slice(newline + 1);
			return value.type === "frame" ? value : null;
		});
		expect(frame.data?.length).toBeGreaterThan(1_000);

		const lease = { id: "lease-browser-surface-it", generation: 1, expires_at: Date.now() + 10_000 };
		fs.writeFileSync(path.join(process.env.HIVE_BROWSER_SURFACE_DIR!, "lease.json"), JSON.stringify(lease), { mode: 0o600 });
		const controlFD = await eventually(() => {
			try {
				return fs.openSync(process.env.HIVE_BROWSER_CONTROL_FIFO!, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENXIO") return null;
				throw error;
			}
		});
		fs.writeSync(controlFD, `${JSON.stringify({
			id: "navigate-next", lease_id: lease.id, generation: 1, kind: "navigate", url: `${base}/next`,
		})}\n`);
		fs.closeSync(controlFD);
		await eventually(() => page.url().endsWith("/next") ? true : null);
		expect(await page.title()).toBe("next");
	}, 30_000);
});
