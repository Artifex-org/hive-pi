import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEditTool,
	createReadTool,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queuedRead } from "../extensions/pretty-tools.ts";

/**
 * pi queues its file WRITERS and not its reader.
 *
 * `edit.js:183` and `write.js:149` both wrap their work in
 * `withFileMutationQueue`; `read.js:173`/`:195` calls `ops.readFile` directly.
 * Because a model routinely emits read and edit for the same path in one
 * assistant turn, and pi runs a batch concurrently, the read can land inside
 * edit's truncate-then-write window and observe a zero-length file.
 *
 * Measured 2026-08-22..24: 32 same-path read+mutate batches, 20 wrong — 13
 * reported `Offset N is beyond end of file (1 lines total)` and 7 returned a
 * SUCCESSFUL read of nothing. `internal/readiness/readiness_test.go`, one of
 * the files reported as one line, is 202 lines.
 *
 * These tests are the check on the assumption the fix rests on: that this
 * file's `withFileMutationQueue` import is the same module instance pi's own
 * edit uses. If pi ever hands extensions their own copy of the module-global
 * `fileMutationQueues` Map, the fix silently becomes a no-op and the first
 * test below is what says so.
 */
describe("read participates in the file-mutation queue", () => {
	let dir: string;
	let file: string;
	const LINES = 200;
	const pad = (n: number) => String(n).padStart(4, "0");
	// Zero-padded so every anchor is unique: `line 1` would also match `line 10`
	// and `line 100`, and edit rightly refuses an ambiguous oldText.
	const original = Array.from({ length: LINES }, (_, i) => `line ${pad(i + 1)}`).join("\n");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pretty-read-queue-"));
		file = join(dir, "subject.txt");
		writeFileSync(file, original, "utf8");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	// The negative control for the whole fix. An UNQUEUED read racing an edit is
	// what production does today; this test does not assert that it corrupts
	// (that is a race and would flake), only that the machinery under test is
	// real: the edit tool must actually rewrite the file through the queue.
	it("edit rewrites the file through the queue", async () => {
		const edit = createEditTool(dir);
		await edit.execute(
			"e1",
			{ path: file, edits: [{ oldText: `line ${pad(1)}`, newText: "line one" }] } as never,
			new AbortController().signal,
			undefined as never,
		);
		const after = readFileSync(file, "utf8");
		expect(after.startsWith("line one")).toBe(true);
		expect(after.split("\n").length).toBe(LINES);
	});

	// The real assertion, and it exercises THE WRAPPER, not the queue.
	//
	// An earlier version of this test called `withFileMutationQueue` directly
	// from the test body. It passed — and would have passed just as happily with
	// the pretty-tools change reverted, because it never touched it. A test that
	// cannot fail when the fix is removed is not evidence the fix works.
	it("queuedRead waits for an in-flight mutation on the same path", async () => {
		const read = createReadTool(dir);
		const order: string[] = [];
		let releaseWriter: () => void = () => {};
		const writerDone = new Promise<void>((r) => {
			releaseWriter = r;
		});

		// Occupy the queue for this exact path, the way an edit would.
		const writer = withFileMutationQueue(file, async () => {
			order.push("write:start");
			await writerDone;
			order.push("write:end");
		});

		const reader = queuedRead(
			dir,
			() => {
				order.push("read");
				return read.execute("r1", { path: file } as never, new AbortController().signal, undefined as never);
			},
			{ path: file },
		);

		// Give the reader every chance to jump the queue before releasing.
		await new Promise((r) => setTimeout(r, 25));
		expect(order).toEqual(["write:start"]);

		releaseWriter();
		await Promise.all([writer, reader]);
		expect(order).toEqual(["write:start", "write:end", "read"]);
	});

	// A read of a DIFFERENT path must not be serialised behind an unrelated
	// mutation — the queue is per-file, and making it global would be a new
	// performance bug wearing a correctness fix's clothes.
	it("queuedRead does not block on an unrelated path", async () => {
		const read = createReadTool(dir);
		const other = join(dir, "unrelated.txt");
		writeFileSync(other, "other", "utf8");
		let release: () => void = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const blocker = withFileMutationQueue(file, () => held);

		const out = await queuedRead(
			dir,
			() => read.execute("r2", { path: "unrelated.txt" } as never, new AbortController().signal, undefined as never),
			{ path: "unrelated.txt" },
		);
		expect(out).toBeTruthy();
		release();
		await blocker;
	});

	// Guards the fallback path: params the wrapper cannot make sense of must
	// still read, never throw. A diagnostic that can break the tool it protects
	// is a bad trade.
	it("still reads when the path cannot be resolved", async () => {
		const read = createReadTool(dir);
		const out = await read.execute(
			"r0",
			{ path: "subject.txt" } as never,
			new AbortController().signal,
			undefined as never,
		);
		expect(out).toBeTruthy();
	});
});
