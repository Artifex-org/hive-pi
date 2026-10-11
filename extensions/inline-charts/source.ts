import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import type { ChartDetails, Series } from "./core.ts";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const UPDATE_INTERVAL_MS = 1_000;
const READ_CHUNK = 16 * 1024;
const allowedSnapshotFields = new Set(["series", "title", "subtitle", "unit"]);

function fail(message: string): never {
	throw new Error(`render_chart: ${message}`);
}

// Verify the bounded consumed prefix once at completion, not on every poll.
async function verifyPrefix(handle: FileHandle, length: number, expected: string, signal?: AbortSignal) {
	const actual = createHash("sha256");
	const bytes = Buffer.alloc(READ_CHUNK);
	for (let offset = 0; offset < length;) {
		if (signal?.aborted) fail("source_file observation cancelled");
		const read = await handle.read(bytes, 0, Math.min(bytes.length, length - offset), offset);
		if (!read.bytesRead) fail("source_file consumed content changed; input must be append-only");
		actual.update(bytes.subarray(0, read.bytesRead));
		offset += read.bytesRead;
	}
	if (actual.digest("hex") !== expected) fail("source_file consumed content changed; input must be append-only");
}

export async function watchChartSource(
	path: string,
	input: { type: "line" | "bar"; title: string; subtitle?: string; unit?: string; chart_id: string; timeout_seconds?: number },
	signal: AbortSignal | undefined,
	update: ((value: any) => void) | undefined,
	result: (details: ChartDetails) => unknown,
	buildDetails: (input: { type: "line" | "bar"; title: string; subtitle?: string; unit?: string; chart_id?: string; series: Series[] }) => ChartDetails,
): Promise<ChartDetails> {
	const file = resolve(path);
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		fail("source_file must exist and be a regular file");
	}
	let initial;
	try { initial = await handle.stat(); } catch {
		await handle.close();
		fail("source_file must exist and be a regular file");
	}
	if (!initial.isFile()) {
		await handle.close();
		fail("source_file must be a regular file (FIFO and other special files are not allowed)");
	}
	let offset = 0;
	const consumed = createHash("sha256");
	let buffer = Buffer.alloc(0);
	let latest: ChartDetails | undefined;
	let done = false;
	let lastUpdate = 0;
	let pendingUpdate = false;
	const started = Date.now();
	const timeoutMs = (input.timeout_seconds ?? 60) * 1000;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const checkDeadline = () => {
		if (Date.now() - started >= timeoutMs) fail(`source_file timed out after ${input.timeout_seconds ?? 60} seconds before completion`);
	};
	const publish = (details: ChartDetails) => {
		latest = details;
		if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
			lastUpdate = Date.now();
			pendingUpdate = false;
			update?.(result(details));
		} else {
			pendingUpdate = true;
		}
	};
	const consume = (line: string) => {
		let row: unknown;
		try { row = JSON.parse(line); } catch { fail("source_file contains malformed JSONL"); }
		if (!row || typeof row !== "object" || Array.isArray(row)) fail("each JSONL record must be an object");
		const record = row as Record<string, unknown>;
		if (record.done === true) {
			if (Object.keys(record).length !== 1) fail("done record must contain only the done field");
			done = true;
			return;
		}
		for (const key of Object.keys(record)) {
			if (key === "type" || key === "chart_id") fail(`source metadata cannot change ${key}`);
			if (!allowedSnapshotFields.has(key)) fail(`unknown source metadata field: ${key}`);
		}
		if (!("series" in record) || !Array.isArray(record.series)) fail("each JSONL record must be a full chart snapshot with series");
		for (const key of ["title", "subtitle", "unit"] as const) {
			if (key in record && typeof record[key] !== "string") fail(`${key} metadata must be a string`);
		}
		const details = buildDetails({
			type: input.type,
			chart_id: input.chart_id,
			series: record.series as Series[],
			title: (record.title as string | undefined) ?? latest?.title ?? input.title,
			subtitle: (record.subtitle as string | undefined) ?? latest?.subtitle ?? input.subtitle,
			unit: (record.unit as string | undefined) ?? latest?.unit ?? input.unit,
		});
		if (Buffer.byteLength(JSON.stringify(details, null, 2), "utf8") > 48 * 1024) fail("chart snapshot exceeds 48 KiB display budget; aggregate data");
		publish(details);
	};
	try {
		while (!done) {
			if (signal?.aborted) fail("source_file observation cancelled");
			checkDeadline();
			if (pendingUpdate && latest && Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
				lastUpdate = Date.now();
				pendingUpdate = false;
				update?.(result(latest));
			}
			const current = await stat(file);
			if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino || current.size < offset) fail("source_file was replaced or truncated while being watched");
			if (current.size > MAX_SOURCE_BYTES) fail("source_file exceeded 1 MiB");
			if (current.size > offset) {
				const bytes = Buffer.alloc(Math.min(READ_CHUNK, current.size - offset));
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
				checkDeadline();
				if (!bytesRead) continue;
				consumed.update(bytes.subarray(0, bytesRead));
				offset += bytesRead;
				buffer = Buffer.concat([buffer, bytes.subarray(0, bytesRead)]);
				if (buffer.length > MAX_SOURCE_BYTES) fail("source_file exceeded 1 MiB");
				let newline: number;
				while ((newline = buffer.indexOf(0x0a)) >= 0) {
					const record = buffer.subarray(0, newline);
					if (record.length > MAX_RECORD_BYTES) fail("source JSONL record exceeds 64 KiB");
					let line: string;
					try { line = decoder.decode(record); } catch { fail("source_file contains invalid UTF-8"); }
					consume(line);
					buffer = buffer.subarray(newline + 1);
					if (done && (buffer.length || offset < current.size)) fail("source_file contains data after done record");
				}
				if (buffer.length > MAX_RECORD_BYTES) fail("source JSONL record exceeds 64 KiB");
				continue;
			}
			try {
				await delay(50, undefined, { signal });
			} catch (error) {
				if (signal?.aborted) fail("source_file observation cancelled");
				throw error;
			}
		}
		if (buffer.length) fail("source_file must end records with a newline");
		if (!latest) fail("source_file produced no chart snapshots");
		const final = await stat(file);
		if (final.ino !== initial.ino || final.dev !== initial.dev || final.size !== offset) fail("source_file was replaced or changed after completion");
		await verifyPrefix(handle, offset, consumed.digest("hex"), signal);
		if (signal?.aborted) fail("source_file observation cancelled");
		checkDeadline();
		update?.(result(latest));
		return latest;
	} finally {
		await handle.close();
	}
}
