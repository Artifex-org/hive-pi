/**
 * explore — the transitions, the clamps and the fold, asserted.
 *
 * The state machine has exactly two moves and four ways of being asked for a
 * move that does not exist (start twice, close without starting, close twice,
 * start with nothing to explore). Each of those is a real keystroke sequence an
 * operator will produce on their first day, and each one has to leave the log
 * unchanged and return something printable — a transition that threw would take
 * the command with it and, in the close case, strand an exploration nobody can
 * close.
 */

import { describe, expect, it } from "vitest";

import {
	CONCLUSION_MAX_CHARS,
	PURPOSE_MAX_CHARS,
	close,
	emptyLog,
	formatDuration,
	openExploration,
	parseExploreCommand,
	rehydrate,
	renderList,
	renderReport,
	renderStart,
	start,
	toEntry,
	touchedSince,
	validateSnapshot,
	type ExploreLog,
} from "../extensions/explore/state.ts";

/** Open one and return the log it produced. Fails loudly rather than casting. */
function opened(purpose: string, nowMs = 1_000, entryId: string | null = "entry-7"): ExploreLog {
	const result = start(emptyLog(), { purpose, entryId, nowMs });
	if (!result.ok) throw new Error(`fixture failed to open: ${result.reason}`);
	return result.log;
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

describe("start", () => {
	it("records the purpose, the entry it started from and the clock", () => {
		const result = start(emptyLog(), { purpose: "  where does the retry belong?  ", entryId: "e-42", nowMs: 5_000 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record).toMatchObject({
			id: "e1",
			purpose: "where does the retry belong?",
			entryId: "e-42",
			startedAtMs: 5_000,
			status: "open",
		});
	});

	// The requirement's "(if reachable)": a session with no file has no entry ids,
	// and refusing to open there would lose the purpose over a citation.
	it("opens with a null entry id rather than refusing", () => {
		const result = start(emptyLog(), { purpose: "p", entryId: null, nowMs: 1 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.record.entryId).toBeNull();
	});

	// An exploration with no stated purpose is the thing the extension exists to
	// prevent, so it must not be silently opened with a placeholder.
	it("refuses an empty purpose", () => {
		for (const purpose of ["", "   ", "\n\t"]) {
			const result = start(emptyLog(), { purpose, entryId: null, nowMs: 1 });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("empty-purpose");
		}
	});

	// STARTING TWICE. `/explore done` would otherwise have to guess which one it
	// closes. The refusal has to carry the open record, because the operator who
	// typed `/explore` again is the one who forgot what the first one was for.
	it("refuses a second exploration and hands back the one that is open", () => {
		const log = opened("first purpose", 1_000);
		const result = start(log, { purpose: "second purpose", entryId: "x", nowMs: 2_000 });
		expect(result.ok).toBe(false);
		if (result.ok || result.reason !== "already-open") throw new Error("expected already-open");
		expect(result.open.purpose).toBe("first purpose");
	});

	it("leaves the log untouched when it refuses", () => {
		const log = opened("first", 1_000);
		const result = start(log, { purpose: "second", entryId: null, nowMs: 2_000 });
		expect(result.ok).toBe(false);
		expect(log.explorations).toHaveLength(1);
		expect(log.nextId).toBe(2);
	});

	// A VERY LONG PURPOSE. This string is copied into every fork of the session and
	// reprinted on every listing, so an unclamped paste would be carried forever.
	it("clamps a very long purpose, keeps the head and says it clamped", () => {
		const purpose = `${"A".repeat(50)} ${"B".repeat(600)}`;
		const result = start(emptyLog(), { purpose, entryId: null, nowMs: 1 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.purpose.length).toBeLessThanOrEqual(PURPOSE_MAX_CHARS);
		// The head, not the tail: a long purpose puts its point in the first
		// sentence (the opposite of btw's excerpt, which keeps the tail).
		expect(result.record.purpose.startsWith("A".repeat(50))).toBe(true);
		expect(result.record.purpose.endsWith("…")).toBe(true);
		expect(result.clamped).toBe(true);
	});

	it("does not flag a purpose that fits", () => {
		const result = start(emptyLog(), { purpose: "short", entryId: null, nowMs: 1 });
		expect(result.ok && result.clamped).toBe(false);
	});
});

describe("close", () => {
	it("closes the open exploration with the conclusion, the clock and what was touched", () => {
		const result = close(opened("why is the 429 path silent?", 1_000), {
			conclusion: "the client swallows it; the fix belongs in the caller",
			nowMs: 61_000,
			files: ["src/client.ts"],
			artifacts: ["artifact://3"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record).toMatchObject({
			id: "e1",
			status: "closed",
			endedAtMs: 61_000,
			conclusion: "the client swallows it; the fix belongs in the caller",
			files: ["src/client.ts"],
			artifacts: ["artifact://3"],
		});
		expect(openExploration(result.log)).toBeNull();
	});

	// A detour that ends in "that road is closed" is a result. Demanding prose
	// would train people to skip the close, which loses the duration too.
	it("allows a close with no conclusion at all", () => {
		const result = close(opened("p"), { conclusion: "", nowMs: 2_000 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.record.conclusion).toBeUndefined();
	});

	// CLOSING WITHOUT STARTING.
	it("refuses on an empty log and has no previous one to point at", () => {
		const result = close(emptyLog(), { conclusion: "anything", nowMs: 1 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("nothing-open");
		expect(result.last).toBeNull();
	});

	// CLOSING TWICE. The second close must not resurrect and re-stamp the first
	// record — that would silently rewrite a finished exploration's duration.
	it("refuses a second close and names the one that already closed", () => {
		const first = close(opened("p", 1_000), { conclusion: "found it", nowMs: 5_000 });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const second = close(first.log, { conclusion: "found it again", nowMs: 9_000 });
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.last?.id).toBe("e1");
		expect(second.last?.endedAtMs).toBe(5_000);
		expect(second.last?.conclusion).toBe("found it");
	});

	it("clamps a very long conclusion at its own, larger budget", () => {
		const result = close(opened("p"), { conclusion: "C".repeat(CONCLUSION_MAX_CHARS + 500), nowMs: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.conclusion!.length).toBeLessThanOrEqual(CONCLUSION_MAX_CHARS);
		expect(result.clamped).toBe(true);
	});

	// Reopening after a close is the normal next move, and it must get a fresh id
	// rather than colliding with the closed one.
	it("lets the next exploration open with a new id", () => {
		const closed = close(opened("first", 1_000), { conclusion: "done", nowMs: 2_000 });
		expect(closed.ok).toBe(true);
		if (!closed.ok) return;
		const again = start(closed.log, { purpose: "second", entryId: null, nowMs: 3_000 });
		expect(again.ok).toBe(true);
		if (again.ok) expect(again.record.id).toBe("e2");
	});
});

/* -------------------------------------------------------------------------- */
/* The fold over the session                                                   */
/* -------------------------------------------------------------------------- */

function toolCall(name: string, args: Record<string, unknown>, timestamp: number): unknown {
	return { message: { role: "assistant", timestamp, content: [{ type: "toolCall", id: "c1", name, arguments: args }] } };
}

describe("touchedSince", () => {
	// Both spellings reach pi's real tools (`core/tools/edit.js:91`), so a scan
	// that knew only one would return nothing on half the sessions.
	it("collects edited and written paths under either argument name", () => {
		const facts = touchedSince(
			[toolCall("edit", { file_path: "a.ts" }, 10), toolCall("write", { path: "b.ts" }, 11)],
			5,
		);
		expect(facts.files).toEqual(["a.ts", "b.ts"]);
	});

	// An exploration reads a hundred files and changes two. Listing the hundred
	// would bury the two, and "we looked at these" is not a finding.
	it("ignores reads", () => {
		expect(touchedSince([toolCall("read", { file_path: "a.ts" }, 10)], 5).files).toEqual([]);
	});

	it("dedupes a file edited repeatedly, keeping first-touch order", () => {
		const facts = touchedSince(
			[toolCall("edit", { file_path: "a.ts" }, 10), toolCall("edit", { file_path: "b.ts" }, 11), toolCall("edit", { file_path: "a.ts" }, 12)],
			5,
		);
		expect(facts.files).toEqual(["a.ts", "b.ts"]);
	});

	// The report is about the exploration, not the session. Work from before it
	// opened belongs to whatever the operator was doing then.
	it("excludes anything from before the exploration opened", () => {
		const facts = touchedSince([toolCall("edit", { file_path: "before.ts" }, 1), toolCall("edit", { file_path: "after.ts" }, 100)], 50);
		expect(facts.files).toEqual(["after.ts"]);
	});

	// Being over-inclusive is what makes the line untrustworthy rather than merely
	// thin, so an entry that cannot be dated is dropped.
	it("skips entries with no usable timestamp", () => {
		expect(touchedSince([{ message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "x.ts" } }] } }], 0).files).toEqual([]);
	});

	it("collects artifact refs from any text, deduped", () => {
		const facts = touchedSince(
			[
				{ message: { role: "toolResult", timestamp: 10, content: [{ type: "text", text: "build failed, see artifact://12 and artifact://12" }] } },
				{ message: { role: "assistant", timestamp: 11, content: [{ type: "text", text: "compare with artifact://13" }] } },
			],
			5,
		);
		expect(facts.artifacts).toEqual(["artifact://12", "artifact://13"]);
	});

	// This decoration must never be able to take the command down: the record's
	// load-bearing fields are the purpose and the clock.
	it("returns empty lists for junk rather than throwing", () => {
		expect(touchedSince([null, 7, "x", {}, { message: null }, { message: { role: "assistant" } }], 0)).toEqual({
			files: [],
			artifacts: [],
		});
	});
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe("renderStart", () => {
	// The nudge IS the feature's second half: the command holds the purpose and
	// tells the operator which pi command to type. Losing these lines would leave
	// a bookkeeping command that explains nothing.
	it("names pi's own navigation commands and says it does not run them", () => {
		const result = start(emptyLog(), { purpose: "p", entryId: "e-9", nowMs: 1 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = renderStart(result.record, result.clamped).join("\n");
		expect(text).toContain("/tree");
		expect(text).toContain("/fork");
		expect(text).toContain("does not move you");
		expect(text).toContain("/explore done");
		expect(text).toContain("entry e-9");
	});

	it("says so when there is no entry id to cite", () => {
		const result = start(emptyLog(), { purpose: "p", entryId: null, nowMs: 1 });
		if (!result.ok) throw new Error("unreachable");
		expect(renderStart(result.record, false).join("\n")).toContain("no entry to cite");
	});
});

describe("renderReport", () => {
	it("prints purpose, duration and conclusion, and lists what changed", () => {
		const result = close(opened("does the retry belong in the client?", 0), {
			conclusion: "no — the caller owns it",
			nowMs: 20 * 60_000,
			files: ["src/client.ts", "src/caller.ts"],
			artifacts: ["artifact://4"],
		});
		if (!result.ok) throw new Error("unreachable");
		const text = renderReport(result.record, 20 * 60_000).join("\n");
		expect(text).toContain("does the retry belong in the client?");
		expect(text).toContain("20m");
		expect(text).toContain("src/client.ts, src/caller.ts");
		expect(text).toContain("artifact://4");
		// Last, because it is the only line worth reading a month later.
		expect(text.trimEnd().endsWith("no — the caller owns it")).toBe(true);
	});

	// A report that quietly omits the conclusion reads, later, as one that had
	// nothing to conclude. The record should not decide that silently.
	it("says explicitly when there was no conclusion", () => {
		const result = close(opened("p", 0), { conclusion: "", nowMs: 1_000 });
		if (!result.ok) throw new Error("unreachable");
		expect(renderReport(result.record, 1_000).join("\n")).toContain("without a conclusion");
	});

	it("caps the file list instead of printing forty paths", () => {
		const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
		const result = close(opened("p", 0), { conclusion: "c", nowMs: 1, files });
		if (!result.ok) throw new Error("unreachable");
		const text = renderReport(result.record, 1).join("\n");
		expect(text).toContain("+4 more");
		expect(text).not.toContain("f11.ts");
	});
});

describe("renderList", () => {
	it("teaches the command when nothing has been explored", () => {
		const text = renderList(emptyLog(), 0).join("\n");
		expect(text).toContain("nothing explored");
		expect(text).toContain("/explore done");
	});

	// A list you cannot read the ANSWERS off is the transcript again.
	it("shows each exploration's conclusion, and marks the open one", () => {
		const first = close(opened("closed question", 0), { conclusion: "answered: yes\nplus detail", nowMs: 60_000 });
		if (!first.ok) throw new Error("unreachable");
		const second = start(first.log, { purpose: "open question", entryId: null, nowMs: 70_000 });
		if (!second.ok) throw new Error("unreachable");

		const text = renderList(second.log, 100_000).join("\n");
		expect(text).toContain("closed question");
		expect(text).toContain("answered: yes");
		expect(text).not.toContain("plus detail");
		expect(text).toContain("[open] open question");
	});
});

describe("formatDuration", () => {
	it("is coarse, except where shortness is itself the finding", () => {
		expect(formatDuration(40_000)).toBe("40s");
		expect(formatDuration(20 * 60_000)).toBe("20m");
		expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe("3h05");
	});
});

/* -------------------------------------------------------------------------- */
/* Grammar                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseExploreCommand", () => {
	it("treats a bare /explore as a listing", () => {
		expect(parseExploreCommand("")).toEqual({ kind: "list" });
		expect(parseExploreCommand("   ")).toEqual({ kind: "list" });
	});

	// The deliberate divergence from btw's whole-argument verb rule: this grammar
	// is `/explore done [conclusion]`, so the rest of the line is the conclusion.
	it("takes the rest of the line after `done` as the conclusion", () => {
		expect(parseExploreCommand("done the caller owns the retry")).toEqual({
			kind: "done",
			conclusion: "the caller owns the retry",
		});
		expect(parseExploreCommand("DONE")).toEqual({ kind: "done", conclusion: "" });
	});

	it("treats anything else as a purpose, including multi-line", () => {
		expect(parseExploreCommand("  is the 429 path silent?  ")).toEqual({
			kind: "start",
			purpose: "is the 429 path silent?",
		});
		// `done` only counts on a word boundary, so a purpose may start with a word
		// that merely begins with it.
		expect(parseExploreCommand("doneness of the batch job")).toEqual({
			kind: "start",
			purpose: "doneness of the batch job",
		});
	});
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

describe("persistence", () => {
	it("round-trips a log through the entry shape", () => {
		const result = close(opened("p", 1_000), { conclusion: "c", nowMs: 2_000, files: ["a.ts"] });
		if (!result.ok) throw new Error("unreachable");
		expect(validateSnapshot(toEntry(result.log))).toEqual(result.log);
	});

	// A half-understood log is worse than none: it would let `close` act on a
	// record whose shape this reader guessed at.
	it("rejects junk, a foreign kind and a future schema version", () => {
		expect(validateSnapshot(null)).toBeNull();
		expect(validateSnapshot({ kind: "workflow", schemaVersion: 1, log: {} })).toBeNull();
		expect(validateSnapshot({ ...toEntry(emptyLog()), schemaVersion: 99 })).toBeNull();
	});

	// A persisted counter behind the live maximum would hand the next exploration
	// an id that already exists, which makes `close` ambiguous.
	it("repairs a nextId that trails the ids actually present", () => {
		const log = validateSnapshot({
			kind: "explore",
			schemaVersion: 1,
			log: { nextId: 1, explorations: [{ id: "e7", purpose: "p", status: "closed", startedAtMs: 1 }] },
		});
		expect(log?.nextId).toBe(8);
	});

	it("drops records with no id or no purpose rather than inventing either", () => {
		const log = validateSnapshot({
			kind: "explore",
			schemaVersion: 1,
			log: { nextId: 3, explorations: [{ id: "e1" }, { purpose: "orphan" }, { id: "e2", purpose: "kept", status: "open", startedAtMs: 5 }] },
		});
		expect(log?.explorations.map((entry) => entry.id)).toEqual(["e2"]);
	});
});

describe("rehydrate", () => {
	it("returns an empty log when the session has never explored", () => {
		expect(rehydrate([{ customType: "workflow", data: {} }, { message: { role: "user" } }])).toEqual(emptyLog());
	});

	// Newest wins, and it is safe precisely because there is ONE writer that
	// rehydrates over every entry before each write — so a later snapshot always
	// subsumes an earlier one, whichever branch each was appended on.
	it("takes the newest valid snapshot, ignoring earlier ones and later junk", () => {
		const older = opened("older", 1_000);
		const closedResult = close(older, { conclusion: "done", nowMs: 3_000 });
		if (!closedResult.ok) throw new Error("unreachable");

		const log = rehydrate([
			{ customType: "explore", data: toEntry(older) },
			{ customType: "explore", data: toEntry(closedResult.log) },
			{ customType: "explore", data: { kind: "explore", schemaVersion: 99 } },
		]);
		expect(openExploration(log)).toBeNull();
		expect(log.explorations[0]?.conclusion).toBe("done");
	});
});
