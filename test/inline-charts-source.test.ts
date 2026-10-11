import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

// Observe real FileHandle reads without replacing their implementation.
const io = vi.hoisted(() => ({ firstRead: undefined as (() => Promise<number> | undefined) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
		const handle = await actual.open(...args);
		const read = vi.spyOn(handle, "read");
		io.firstRead = () => {
			const first = read.mock.results[0];
			return first?.type === "return" ? first.value.then((value) => value.bytesRead) : undefined;
		};
		return handle;
	} };
});
import inlineCharts from "../extensions/inline-charts.ts";
import { ARGS_BUDGET, budgeted } from "../extensions/hive-remote/budget.ts";

function registeredTool() {
	let tool: any;
	inlineCharts({ registerTool: (definition: any) => { tool = definition; } } as never);
	return tool;
}
const snapshot = (y: number, fields: Record<string, unknown> = {}) => JSON.stringify({ ...fields, series: [{ name: "metric", points: [{ x: "t", y }] }] });
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "chart-feed-"));
	const file = join(dir, "feed.jsonl");
	await writeFile(file, "");
	return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const call = (tool: any, file: string, cwd: string, extra: Record<string, unknown> = {}, signal?: AbortSignal, update?: (value: any) => void) =>
	tool.execute("call", { type: "line", title: "feed", chart_id: "stable", source_file: file, timeout_seconds: 3, ...extra }, signal, update, { cwd });

describe("live inline chart source", () => {
	it("resolves relative paths from ctx.cwd and publishes newline-terminated snapshots", async () => {
		const f = await fixture();
		try {
			const updates: any[] = [];
			const pending = call(registeredTool(), "feed.jsonl", f.dir, {}, undefined, (value) => updates.push(value));
			await new Promise((resolve) => setTimeout(resolve, 80));
			await appendFile(f.file, `${snapshot(7, { title: "updated" })}\n{"done":true}\n`);
			const result = await pending;
			expect(result.details.title).toBe("updated");
			expect(result.details.chart_id).toBe("stable");
			expect(updates.at(-1).details).toEqual(result.details);
		} finally { await f.cleanup(); }
	});

	it("claims a chart ID before awaiting and releases it after completion", async () => {
		const f = await fixture();
		try {
			const tool = registeredTool();
			const active = call(tool, f.file, f.dir);
			await expect(call(tool, f.file, f.dir)).rejects.toThrow(/already has an active/);
			await expect(tool.execute("static", { type: "line", title: "snapshot", chart_id: "stable", series: [{ name: "v", points: [{ x: "a", y: 1 }] }] })).rejects.toThrow(/already has an active/);
			await appendFile(f.file, `${snapshot(1)}\n{"done":true}\n`);
			await active;
			await writeFile(f.file, `${snapshot(2)}\n{"done":true}\n`);
			expect((await call(tool, f.file, f.dir)).details.series[0].points[0].y).toBe(2);
		} finally { await f.cleanup(); }
	});

	it("validates optional metadata, protected keys, done records, and unterminated rows", async () => {
		const f = await fixture();
		try {
			const tool = registeredTool();
			for (const row of [
				{ title: 3, series: [{ name: "v", points: [{ x: "x", y: 1 }] }] },
				{ type: "bar", series: [{ name: "v", points: [{ x: "x", y: 1 }] }] },
				{ mystery: true, series: [{ name: "v", points: [{ x: "x", y: 1 }] }] },
				{ done: true, extra: 1 },
			]) {
				await writeFile(f.file, `${JSON.stringify(row)}\n`);
				await expect(call(tool, f.file, f.dir)).rejects.toThrow();
			}
			await writeFile(f.file, snapshot(1));
			await expect(call(tool, f.file, f.dir, { timeout_seconds: 1 })).rejects.toThrow(/timed out/);
			await expect(call(tool, f.file, f.dir, { chart_id: ` ${"x".repeat(120)} ` })).rejects.toThrow(/chart_id/);
		} finally { await f.cleanup(); }
	});

	it("rejects feeds larger than one MiB and non-finite timeout values", async () => {
		const f = await fixture();
		try {
			await writeFile(f.file, " ".repeat(1024 * 1024 + 1));
			await expect(call(registeredTool(), f.file, f.dir)).rejects.toThrow(/1 MiB/);
			await expect(call(registeredTool(), f.file, f.dir, { timeout_seconds: Infinity })).rejects.toThrow(/finite/);
		} finally { await f.cleanup(); }
	});

	it("bounds complete and partial records, decodes split UTF-8, and rejects empty/nonregular feeds", async () => {
		const f = await fixture();
		try {
			const tool = registeredTool();
			for (const row of [" ".repeat(64 * 1024 + 1) + "\n", " ".repeat(64 * 1024 + 1)]) {
				await writeFile(f.file, row);
				await expect(call(tool, f.file, f.dir)).rejects.toThrow(/64 KiB/);
			}
			// Valid source records must also fit the smaller unpruned display budget.
			const series = Array.from({ length: 8 }, () => ({ name: "s".repeat(80), points: Array.from({ length: 80 }, () => ({ x: "x".repeat(80), y: 1 })) }));
			const row = JSON.stringify({ series });
			expect(Buffer.byteLength(row)).toBeLessThan(64 * 1024);
			await writeFile(f.file, row + '\n{"done":true}\n');
			await expect(call(tool, f.file, f.dir)).rejects.toThrow(/display budget/);
			const boundedSeries = Array.from({ length: 8 }, () => ({ name: "metric", points: Array.from({ length: 100 }, () => ({ x: "x".repeat(35), y: 1 })) }));
			await writeFile(f.file, JSON.stringify({ series: boundedSeries }) + '\n{"done":true}\n');
			await expect(call(tool, f.file, f.dir)).rejects.toThrow(/display budget/);
			await writeFile(f.file, JSON.stringify({ series: boundedSeries.slice(0, 2) }) + '\n{"done":true}\n');
			const result = await call(tool, f.file, f.dir);
			expect(JSON.parse(budgeted(result.details, ARGS_BUDGET)!)).toEqual(result.details);
			for (const row of ["not-json\n", '{"done":true}\n']) {
				await writeFile(f.file, row);
				await expect(call(tool, f.file, f.dir)).rejects.toThrow();
			}
			await mkdir(join(f.dir, "directory"));
			await expect(call(tool, join(f.dir, "directory"), f.dir)).rejects.toThrow(/regular file/);
			await writeFile(f.file, "");
			const bytes = Buffer.from(snapshot(1, { title: "café" }) + '\n{"done":true}\n');
			const split = bytes.indexOf(Buffer.from("é")) + 1;
			io.firstRead = undefined;
			const watching = call(tool, f.file, f.dir);
			await appendFile(f.file, bytes.subarray(0, split));
			const firstRead = await vi.waitFor(async () => {
				const read = io.firstRead?.();
				expect(read).toBeDefined();
				return await read;
			});
			expect(firstRead).toBe(split);
			await appendFile(f.file, bytes.subarray(split));
			expect((await watching).details.title).toBe("café");
		} finally { await f.cleanup(); }
	});

	it("refuses truncation and path replacement after reading a snapshot", async () => {
		const f = await fixture();
		try {
			for (const replace of [false, true]) {
				await writeFile(f.file, snapshot(1) + "\n");
				let sawSnapshot: () => void = () => {};
				const ready = new Promise<void>((resolve) => { sawSnapshot = resolve; });
				const watching = call(registeredTool(), f.file, f.dir, {}, undefined, sawSnapshot);
				const assertion = expect(watching).rejects.toThrow(/replaced or truncated/);
				await ready;
				if (replace) await rename(f.file, join(f.dir, "old.jsonl"));
				await writeFile(f.file, "");
				await assertion;
			}
		} finally { await f.cleanup(); }
	});

	it("rejects unread trailing data at a chunk boundary and equal-length rewrites", async () => {
		const f = await fixture();
		try {
			const row = snapshot(1);
			const done = '{"done":true}\n';
			const padding = 16 * 1024 - Buffer.byteLength(row + "\n" + done);
			await writeFile(f.file, row + " ".repeat(padding) + "\n" + done + "malformed\n");
			await expect(call(registeredTool(), f.file, f.dir)).rejects.toThrow(/after done/);
			await writeFile(f.file, row + "\n");
			let sawSnapshot: () => void = () => {};
			const ready = new Promise<void>((resolve) => { sawSnapshot = resolve; });
			const watching = call(registeredTool(), f.file, f.dir, {}, undefined, sawSnapshot);
			const assertion = expect(watching).rejects.toThrow(/append-only/);
			await ready;
			expect(Buffer.byteLength(snapshot(2))).toBe(Buffer.byteLength(row));
			await writeFile(f.file, snapshot(2) + "\n" + done);
			await assertion;
		} finally { await f.cleanup(); }
	});

	it("scopes active chart claims to the execution session", async () => {
		const f = await fixture();
		try {
			const tool = registeredTool();
			const first = call(tool, f.file, f.dir);
			const second = tool.execute("second", { type: "line", title: "feed", chart_id: "stable", source_file: f.file, timeout_seconds: 3 }, undefined, undefined, { cwd: f.dir, sessionManager: { getSessionId: () => "other-session" } });
			await appendFile(f.file, snapshot(1) + '\n{"done":true}\n');
			expect((await first).details.chart_id).toBe("stable");
			expect((await second).details.chart_id).toBe("stable");
		} finally { await f.cleanup(); }
	});

	it("settles abortable waits without retaining abort listeners", async () => {
		const f = await fixture();
		try {
			const controller = new AbortController();
			const events = controller.signal as AbortSignal & { addEventListener: AbortSignal["addEventListener"]; removeEventListener: AbortSignal["removeEventListener"] };
			let activeListeners = 0;
			const add = events.addEventListener.bind(events);
			const remove = events.removeEventListener.bind(events);
			events.addEventListener = ((type: string, listener: any, options?: any) => { if (type === "abort") activeListeners++; return add(type, listener, options); }) as typeof events.addEventListener;
			events.removeEventListener = ((type: string, listener: any, options?: any) => { if (type === "abort") activeListeners--; return remove(type, listener, options); }) as typeof events.removeEventListener;
			const pending = call(registeredTool(), f.file, f.dir, {}, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 150));
			controller.abort();
			await expect(pending).rejects.toThrow(/cancelled/);
			expect(activeListeners).toBe(0);
		} finally { await f.cleanup(); }
	});
});
