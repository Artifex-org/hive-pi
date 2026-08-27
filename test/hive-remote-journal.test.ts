import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	JOURNAL_DIR_ENV,
	JOURNAL_MAX_BYTES,
	journalPath,
	openJournal,
	safeName,
} from "../extensions/hive-remote/journal.ts";

// The journal is written from the agent loop's event handlers. Everything below
// is really one assertion in several shapes: it delivers the text in order when
// it can, and it never throws at the caller when it cannot.

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hive-journal-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Wait for the stream's buffered writes to reach disk. */
async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 50));
}

function lines(dir: string, session: string): Record<string, unknown>[] {
	const path = journalPath(dir, session);
	if (!path) throw new Error("unusable session id");
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("openJournal", () => {
	it("writes each delta as its own line, in order, uncoalesced", async () => {
		const dir = tempDir();
		const j = openJournal("sess-1", { [JOURNAL_DIR_ENV]: dir });
		expect(j).not.toBeNull();
		// Three pushes in one tick — the burst the network queue would collapse
		// into a single request. Locally they stay three, because that is the
		// whole point: the reader wants them as they were produced.
		j?.delta("Hel");
		j?.delta("lo ");
		j?.delta("there");
		j?.close();
		await settle();

		const got = lines(dir, "sess-1");
		expect(got.map((r) => r.text)).toEqual(["Hel", "lo ", "there"]);
		expect(got.every((r) => r.kind === "delta")).toBe(true);
	});

	// Absent means text, mirroring the wire. A reader that predates the split
	// treats an unlabelled delta as the answer; labelling everything "text"
	// would be the change that breaks it.
	it("labels reasoning and leaves ordinary text unlabelled", async () => {
		const dir = tempDir();
		const j = openJournal("sess-2", { [JOURNAL_DIR_ENV]: dir });
		j?.delta("answer");
		j?.delta("reasoning", "thinking");
		j?.close();
		await settle();

		const got = lines(dir, "sess-2");
		expect(got[0]).not.toHaveProperty("channel");
		expect(got[1]?.channel).toBe("thinking");
	});

	it("is off unless a sink is configured", () => {
		expect(openJournal("sess-3", {})).toBeNull();
		expect(openJournal("sess-3", { [JOURNAL_DIR_ENV]: "   " })).toBeNull();
	});

	// The id becomes a filename. "It is a UUID" is an expectation, not a check.
	it("refuses a session id that is not a plain identifier", () => {
		const dir = tempDir();
		for (const bad of ["../../.ssh/authorized_keys", "a/b", "", "x".repeat(129), "a b"]) {
			expect(safeName(bad)).toBeNull();
			expect(openJournal(bad, { [JOURNAL_DIR_ENV]: dir })).toBeNull();
		}
		expect(safeName("0f7a-BC_9")).toBe("0f7a-BC_9");
	});

	it("creates the directory it was pointed at, private", async () => {
		const parent = tempDir();
		const dir = join(parent, "nested", "journal");
		const j = openJournal("sess-4", { [JOURNAL_DIR_ENV]: dir });
		expect(j).not.toBeNull();
		j?.delta("x");
		j?.close();
		await settle();
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(lines(dir, "sess-4")).toHaveLength(1);
	});

	// Past the cap it says so once and stops, rather than filling the operator's
	// disk with text the reader was only ever going to tail the end of.
	it("caps what one session may write, and records that it did", async () => {
		const dir = tempDir();
		const j = openJournal("sess-5", { [JOURNAL_DIR_ENV]: dir });
		const chunk = "x".repeat(1024 * 1024);
		for (let i = 0; i < JOURNAL_MAX_BYTES / chunk.length + 2; i++) j?.delta(chunk);
		j?.delta("after the cap");
		j?.close();
		await settle();

		const got = lines(dir, "sess-5");
		expect(got.some((r) => r.kind === "capped")).toBe(true);
		expect(got.some((r) => r.text === "after the cap")).toBe(false);
		expect(statSync(join(dir, "sess-5.ndjson")).size).toBeLessThanOrEqual(JOURNAL_MAX_BYTES);
	});

	// The negative control for the cap: without a burst that large, nothing is
	// capped and everything is written. A cap that fired always would pass the
	// test above and lose every session's text.
	it("does not cap an ordinary session", async () => {
		const dir = tempDir();
		const j = openJournal("sess-6", { [JOURNAL_DIR_ENV]: dir });
		for (let i = 0; i < 500; i++) j?.delta("token ");
		j?.close();
		await settle();

		const got = lines(dir, "sess-6");
		expect(got.some((r) => r.kind === "capped")).toBe(false);
		expect(got).toHaveLength(500);
	});

	it("never throws at the caller, whatever it is handed", async () => {
		const dir = tempDir();
		const j = openJournal("sess-7", { [JOURNAL_DIR_ENV]: dir });
		expect(() => {
			j?.delta("");
			j?.delta("ok");
			j?.close();
			j?.close();
			j?.delta("after close");
		}).not.toThrow();
		await settle();
		expect(lines(dir, "sess-7").map((r) => r.text)).toEqual(["ok"]);
	});
});
