/**
 * filerank — the ranker, the store, and the one wiring claim that matters.
 *
 * Two things are being defended here, and only one of them is "the order is
 * good". The other is that the order is the SAME ORDER EVERY TIME: a ranker that
 * reshuffles identical inputs turns every cached prefix of a session into a
 * cache miss, and nothing about that failure points back at this extension. So
 * determinism is tested directly, not assumed from the comparator's shape.
 *
 * The reorder tests are mostly about NOT acting: find's output is the tool's,
 * and every shape this does not fully understand has to come back untouched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import filerankExtension from "../extensions/filerank/index.ts";
import {
	HALF_LIFE_MS,
	MAX_RANKABLE_LINES,
	parseGitStatus,
	rankPaths,
	reorderFindOutput,
	score,
	type GitState,
	type RankContext,
} from "../extensions/filerank/rank.ts";
import {
	emptyStore,
	flushStore,
	loadStore,
	pruneStore,
	recordAccess,
	recordSelection,
	type FilerankStore,
} from "../extensions/filerank/store.ts";
import { createFakePi } from "./fake-pi.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function ctx(store: FilerankStore, over: Partial<RankContext> = {}): RankContext {
	return { store, gitStatus: new Map(), nowMs: NOW, ...over };
}

function storeWith(paths: Record<string, { count: number; agoMs: number }>): FilerankStore {
	const store = emptyStore();
	for (const [path, { count, agoMs }] of Object.entries(paths)) {
		store.paths[path] = { count, lastAccessMs: NOW - agoMs };
	}
	return store;
}

describe("frecency", () => {
	it("decays a count by half over one half-life", () => {
		const fresh = score({ count: 8, lastAccessMs: NOW }, NOW);
		const stale = score({ count: 8, lastAccessMs: NOW - HALF_LIFE_MS }, NOW);
		expect(fresh).toBe(8);
		expect(stale).toBeCloseTo(4, 6);
	});

	// The crossover the half-life argument in rank.ts is chosen around: a file
	// touched once yesterday beats a file touched ten times a month ago.
	it("ranks rare-and-recent above frequent-and-old", () => {
		const store = storeWith({
			"/repo/old.ts": { count: 10, agoMs: 30 * DAY },
			"/repo/new.ts": { count: 1, agoMs: 1 * DAY },
		});
		expect(rankPaths(["/repo/old.ts", "/repo/new.ts"], ctx(store))).toEqual(["/repo/new.ts", "/repo/old.ts"]);
	});

	it("still ranks frequent-and-recent above everything", () => {
		const store = storeWith({
			"/repo/hot.ts": { count: 10, agoMs: 0 },
			"/repo/new.ts": { count: 1, agoMs: 1 * DAY },
		});
		expect(rankPaths(["/repo/new.ts", "/repo/hot.ts"], ctx(store))).toEqual(["/repo/hot.ts", "/repo/new.ts"]);
	});

	// Clock skew, a resumed session, a restored backup. A future timestamp must
	// not become an amplifier.
	it("clamps a future access time to no decay rather than boosting it", () => {
		expect(score({ count: 3, lastAccessMs: NOW + 90 * DAY }, NOW)).toBe(3);
	});
});

describe("signal precedence", () => {
	it("puts a dirty file above a well-worn clean one", () => {
		const store = storeWith({ "/repo/worn.ts": { count: 500, agoMs: 0 } });
		const gitStatus = new Map<string, GitState>([["/repo/touched.ts", "modified"]]);
		expect(rankPaths(["/repo/worn.ts", "/repo/touched.ts"], ctx(store, { gitStatus }))).toEqual([
			"/repo/touched.ts",
			"/repo/worn.ts",
		]);
	});

	it("orders staged above modified above untracked", () => {
		const gitStatus = new Map<string, GitState>([
			["/repo/a.ts", "untracked"],
			["/repo/b.ts", "modified"],
			["/repo/c.ts", "staged"],
		]);
		expect(rankPaths(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"], ctx(emptyStore(), { gitStatus }))).toEqual([
			"/repo/c.ts",
			"/repo/b.ts",
			"/repo/a.ts",
		]);
	});

	// The strongest signal available: this exact question was asked before and
	// THAT is the file it turned out to mean.
	it("puts an exact query→path selection above every other signal", () => {
		const store = storeWith({ "/repo/worn.ts": { count: 500, agoMs: 0 } });
		recordSelection(store, "narrate*", "/repo/answer.ts", NOW - DAY);
		const gitStatus = new Map<string, GitState>([["/repo/staged.ts", "staged"]]);
		const ranked = rankPaths(["/repo/worn.ts", "/repo/staged.ts", "/repo/answer.ts"], ctx(store, { gitStatus, query: "narrate*" }));
		expect(ranked[0]).toBe("/repo/answer.ts");
	});

	it("ignores the selection when a different query is asked", () => {
		const store = emptyStore();
		recordSelection(store, "narrate*", "/repo/answer.ts", NOW);
		const gitStatus = new Map<string, GitState>([["/repo/staged.ts", "staged"]]);
		expect(rankPaths(["/repo/answer.ts", "/repo/staged.ts"], ctx(store, { gitStatus, query: "other*" }))[0]).toBe(
			"/repo/staged.ts",
		);
	});

	it("keeps unknown paths — below what it knows, above nothing, in find's own order", () => {
		const store = storeWith({ "/repo/known.ts": { count: 1, agoMs: 0 } });
		expect(rankPaths(["/repo/z.ts", "/repo/known.ts", "/repo/a.ts"], ctx(store))).toEqual([
			"/repo/known.ts",
			"/repo/z.ts",
			"/repo/a.ts",
		]);
	});

	// Store keys are absolute; find returns paths relative to its search root.
	// Without the mapping the two never meet and the whole extension is a silent
	// no-op — the failure mode that ships green.
	it("maps result paths into the store's key space before looking them up", () => {
		const store = storeWith({ "/repo/src/deep.ts": { count: 9, agoMs: 0 } });
		const ranked = rankPaths(["other.ts", "src/deep.ts"], ctx(store, { resolveKey: (p) => resolve("/repo", p) }));
		expect(ranked).toEqual(["src/deep.ts", "other.ts"]);
	});
});

describe("determinism", () => {
	it("returns the identical order on repeated runs of the same inputs", () => {
		const store = storeWith({
			"/repo/a.ts": { count: 3, agoMs: 2 * DAY },
			"/repo/b.ts": { count: 3, agoMs: 2 * DAY },
			"/repo/c.ts": { count: 1, agoMs: 9 * DAY },
		});
		const paths = ["/repo/c.ts", "/repo/b.ts", "/repo/a.ts", "/repo/unknown.ts"];
		const first = rankPaths(paths, ctx(store));
		for (let i = 0; i < 5; i++) expect(rankPaths(paths, ctx(store))).toEqual(first);
	});

	// Equal scores must fall back on find's order, not on whatever the sort
	// implementation does with a zero comparator.
	it("breaks exact ties on the original order, in both directions", () => {
		const store = storeWith({
			"/repo/a.ts": { count: 4, agoMs: DAY },
			"/repo/b.ts": { count: 4, agoMs: DAY },
		});
		expect(rankPaths(["/repo/a.ts", "/repo/b.ts"], ctx(store))).toEqual(["/repo/a.ts", "/repo/b.ts"]);
		expect(rankPaths(["/repo/b.ts", "/repo/a.ts"], ctx(store))).toEqual(["/repo/b.ts", "/repo/a.ts"]);
	});

	it("never drops or duplicates a path", () => {
		const store = storeWith({ "/repo/b.ts": { count: 2, agoMs: 0 } });
		const paths = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/a.ts"];
		const ranked = rankPaths(paths, ctx(store));
		expect(ranked.length).toBe(paths.length);
		expect([...ranked].sort()).toEqual([...paths].sort());
	});
});

describe("rewriting find's output", () => {
	const rank = (paths: readonly string[]): string[] => [...paths].reverse();

	it("reorders the file list", () => {
		expect(reorderFindOutput("a.ts\nb.ts\nc.ts", rank)).toBe("c.ts\nb.ts\na.ts");
	});

	// The notice is metadata about the SEARCH, not a result. Sorting it into the
	// middle of the list would be a lie about which file it refers to.
	it("keeps find's trailing notice block at the end", () => {
		const text = "a.ts\nb.ts\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]";
		expect(reorderFindOutput(text, rank)).toBe(
			"b.ts\na.ts\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
		);
	});

	it("leaves the empty-result message alone", () => {
		expect(reorderFindOutput("No files found matching pattern", rank)).toBeNull();
	});

	it("leaves a single result alone", () => {
		expect(reorderFindOutput("only.ts", rank)).toBeNull();
	});

	it("returns null when the order did not actually change", () => {
		expect(reorderFindOutput("a.ts\nb.ts", (paths) => [...paths])).toBeNull();
	});

	// find never emits a blank line between results, so one means we are looking
	// at output we do not understand.
	it("bails on a body with blank lines in it", () => {
		expect(reorderFindOutput("a.ts\n\nb.ts", rank)).toBeNull();
	});

	it("bails when the ranker returns the wrong number of paths", () => {
		expect(reorderFindOutput("a.ts\nb.ts", () => ["a.ts"])).toBeNull();
	});

	it("bails above the line cap rather than putting a long sort on the agent loop", () => {
		const many = Array.from({ length: MAX_RANKABLE_LINES + 1 }, (_, i) => `f${i}.ts`).join("\n");
		expect(reorderFindOutput(many, rank)).toBeNull();
	});

	it("bails on empty text", () => {
		expect(reorderFindOutput("", rank)).toBeNull();
	});
});

describe("git porcelain", () => {
	const parse = (text: string): Map<string, GitState> => parseGitStatus(text, "/repo", (a, b) => `${a}/${b}`);

	it("classifies the three states", () => {
		const status = parse(" M src/a.ts\nA  src/b.ts\n?? src/c.ts");
		expect(status.get("/repo/src/a.ts")).toBe("modified");
		expect(status.get("/repo/src/b.ts")).toBe("staged");
		expect(status.get("/repo/src/c.ts")).toBe("untracked");
	});

	it("counts a file that is both staged and dirty as staged", () => {
		expect(parse("MM src/a.ts").get("/repo/src/a.ts")).toBe("staged");
	});

	it("takes the destination of a rename", () => {
		const status = parse("R  src/old.ts -> src/new.ts");
		expect(status.get("/repo/src/new.ts")).toBe("staged");
		expect(status.has("/repo/src/old.ts")).toBe(false);
	});

	it("strips core.quotepath quoting", () => {
		expect(parse(' M "src/ünïcode.ts"').get("/repo/src/ünïcode.ts")).toBe("modified");
	});

	it("skips ignored entries and junk", () => {
		const status = parse("!! build/out.js\n\nxx");
		expect(status.size).toBe(0);
	});
});

describe("store transitions", () => {
	it("counts repeat accesses and moves the clock forward", () => {
		const store = emptyStore();
		recordAccess(store, "/repo/a.ts", NOW - DAY);
		recordAccess(store, "/repo/a.ts", NOW);
		expect(store.paths["/repo/a.ts"]).toEqual({ count: 2, lastAccessMs: NOW });
	});

	// A resumed session replays older timestamps; a file must not get staler.
	it("never moves the clock backwards", () => {
		const store = emptyStore();
		recordAccess(store, "/repo/a.ts", NOW);
		recordAccess(store, "/repo/a.ts", NOW - 5 * DAY);
		expect(store.paths["/repo/a.ts"].lastAccessMs).toBe(NOW);
	});

	// Not a frequency table: the latest answer is where the code lives now.
	it("keeps only the most recent answer to a query", () => {
		const store = emptyStore();
		recordSelection(store, "narrate*", "/repo/old.ts", NOW - DAY);
		recordSelection(store, "narrate*", "/repo/new.ts", NOW);
		expect(store.selections["narrate*"].path).toBe("/repo/new.ts");
	});

	it("ignores empty paths and queries", () => {
		const store = emptyStore();
		recordAccess(store, "", NOW);
		recordSelection(store, "", "/repo/a.ts", NOW);
		recordSelection(store, "q", "", NOW);
		expect(Object.keys(store.paths)).toEqual([]);
		expect(Object.keys(store.selections)).toEqual([]);
	});
});

describe("pruning", () => {
	it("caps paths, keeping the most recently used", () => {
		const store = emptyStore();
		for (let i = 0; i < 50; i++) recordAccess(store, `/repo/f${i}.ts`, NOW - i * DAY);
		pruneStore(store, 10);
		expect(Object.keys(store.paths).length).toBe(10);
		expect(store.paths["/repo/f0.ts"]).toBeDefined();
		expect(store.paths["/repo/f9.ts"]).toBeDefined();
		expect(store.paths["/repo/f10.ts"]).toBeUndefined();
	});

	it("caps selections too", () => {
		const store = emptyStore();
		for (let i = 0; i < 20; i++) recordSelection(store, `q${i}`, `/repo/f${i}.ts`, NOW - i * DAY);
		pruneStore(store, 1000, 5);
		expect(Object.keys(store.selections).length).toBe(5);
		expect(store.selections["q0"]).toBeDefined();
		expect(store.selections["q19"]).toBeUndefined();
	});

	// Two stores holding the SAME entries in OPPOSITE insertion orders. That is
	// what makes the path tiebreak load-bearing: `Object.keys` is insertion
	// ordered, so building both the same way would pass even with the tiebreak
	// deleted. The survivors are asserted by name rather than merely compared,
	// so "both evicted everything" cannot pass either.
	it("evicts the same entries every time, even on a tie", () => {
		const build = (order: number[]): FilerankStore => {
			const store = emptyStore();
			for (const i of order) recordAccess(store, `/repo/f${i}.ts`, NOW);
			return store;
		};
		const ascending = [...Array(20).keys()];
		const a = build(ascending);
		const b = build([...ascending].reverse());
		pruneStore(a, 5);
		pruneStore(b, 5);

		// Every lastAccessMs and count is identical, so the comparator falls all
		// the way through to the path itself: the five lexicographically smallest.
		const expected = ["/repo/f0.ts", "/repo/f1.ts", "/repo/f10.ts", "/repo/f11.ts", "/repo/f12.ts"];
		expect(Object.keys(a.paths).sort()).toEqual(expected);
		expect(Object.keys(b.paths).sort()).toEqual(expected);
	});

	it("leaves a store under the cap untouched", () => {
		const store = storeWith({ "/repo/a.ts": { count: 1, agoMs: 0 } });
		pruneStore(store, 10);
		expect(Object.keys(store.paths)).toEqual(["/repo/a.ts"]);
	});
});

describe("store persistence", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "filerank-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips through the file", () => {
		const path = join(dir, "filerank.json");
		const store = emptyStore();
		recordAccess(store, "/repo/a.ts", NOW);
		recordSelection(store, "*.ts", "/repo/a.ts", NOW);
		expect(flushStore(store, path)).toBe(true);
		expect(loadStore(path)).toEqual(store);
	});

	it("treats a missing file as an empty store", () => {
		expect(loadStore(join(dir, "nope.json"))).toEqual(emptyStore());
	});

	// A half-finished write from a killed process, or a hand-edit. Either way the
	// answer is an empty store, never a throw.
	it("treats a corrupt file as an empty store", () => {
		const path = join(dir, "corrupt.json");
		writeFileSync(path, "{ this is not json");
		expect(loadStore(path)).toEqual(emptyStore());
	});

	// The real hazard is subtler than unparseable JSON: an entry whose count is a
	// string becomes a NaN inside the comparator, and a NaN in a comparator is a
	// nondeterministic sort.
	it("drops entries whose fields are not numbers", () => {
		const path = join(dir, "wrong-types.json");
		writeFileSync(
			path,
			JSON.stringify({
				paths: { "/a.ts": { count: "3", lastAccessMs: NOW }, "/b.ts": { count: 2, lastAccessMs: null }, "/c.ts": { count: 1, lastAccessMs: NOW } },
				selections: { q1: { path: 5, atMs: NOW }, q2: { path: "/c.ts", atMs: NOW } },
			}),
		);
		const store = loadStore(path);
		expect(Object.keys(store.paths)).toEqual(["/c.ts"]);
		expect(Object.keys(store.selections)).toEqual(["q2"]);
	});

	it("creates the directory it writes into", () => {
		const path = join(dir, "nested", "deeper", "filerank.json");
		expect(flushStore(emptyStore(), path)).toBe(true);
		expect(loadStore(path)).toEqual(emptyStore());
	});

	it("enforces the cap on what it writes, not only on what it reads", () => {
		const path = join(dir, "capped.json");
		const store = emptyStore();
		for (let i = 0; i < 30; i++) recordAccess(store, `/repo/f${i}.ts`, NOW - i * DAY);
		flushStore(store, path, 5);
		expect(Object.keys(loadStore(path).paths).length).toBe(5);
	});
});

/**
 * The wiring, with $HOME pointed at a scratch directory.
 *
 * These exist because this repo's three shipped extension bugs all needed the
 * thing running (see fake-pi.ts) — and the first of them was handlers registered
 * behind an `if (!enabled) return`, which is exactly the shape below.
 */
describe("extension wiring", () => {
	let home: string;
	let realHome: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "filerank-home-"));
		realHome = process.env.HOME;
		process.env.HOME = home;
	});
	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	});

	function writeConfig(config: Record<string, unknown>): void {
		// configPathFor("filerank") → ~/.pi/agent/hive-telemetry/filerank.config.json
		const dir = join(home, ".pi", "agent", "hive-telemetry");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "filerank.config.json"), JSON.stringify(config));
	}

	it("registers NOTHING when disabled — not a no-op handler", () => {
		writeConfig({ enabled: false });

		const pi = createFakePi();
		filerankExtension(pi.api);
		expect(pi.handlers.size).toBe(0);
		expect(pi.commands.size).toBe(0);
	});

	it("ranks a find result, learns the pick, and persists it at shutdown", async () => {
		const cwd = process.cwd();
		const store = emptyStore();
		recordAccess(store, resolve(cwd, "b.ts"), Date.now());
		recordAccess(store, resolve(cwd, "b.ts"), Date.now());
		const storeFile = join(home, ".pi", "agent", "filerank.json");
		flushStore(store, storeFile);

		const pi = createFakePi();
		filerankExtension(pi.api);

		const [ranked] = await pi.emit({
			type: "tool_result",
			toolCallId: "t1",
			toolName: "find",
			input: { pattern: "*.ts" },
			content: [{ type: "text", text: "a.ts\nb.ts" }],
			isError: false,
		});
		expect(ranked).toEqual({ content: [{ type: "text", text: "b.ts\na.ts" }] });

		await pi.emit({
			type: "tool_result",
			toolCallId: "t2",
			toolName: "read",
			input: { path: "a.ts" },
			content: [{ type: "text", text: "…" }],
			isError: false,
		});
		await pi.emit({ type: "session_shutdown", reason: "quit" });

		// The read that followed the find is the model answering its own
		// question — that is what makes it a selection rather than an access.
		const persisted = loadStore(storeFile);
		expect(persisted.selections["*.ts"].path).toBe(resolve(cwd, "a.ts"));
		expect(persisted.paths[resolve(cwd, "a.ts")].count).toBe(1);
	});

	// The reorder rewrites the FIRST text block and must hand every later block
	// back untouched. pi replaces the whole `content` array with whatever the
	// handler returns (runner.js: `currentEvent.content = handlerResult.content`),
	// so a dropped trailing block is data the model silently never sees.
	it("preserves content blocks after the first", async () => {
		const store = emptyStore();
		recordAccess(store, resolve(process.cwd(), "b.ts"), Date.now());
		flushStore(store, join(home, ".pi", "agent", "filerank.json"));

		const pi = createFakePi();
		filerankExtension(pi.api);

		const trailing = { type: "image", data: "…" };
		const [ranked] = await pi.emit({
			type: "tool_result",
			toolCallId: "t1",
			toolName: "find",
			input: { pattern: "*.ts" },
			content: [{ type: "text", text: "a.ts\nb.ts" }, trailing],
			isError: false,
		});
		expect(ranked).toEqual({ content: [{ type: "text", text: "b.ts\na.ts" }, trailing] });
	});

	// The negative control for the test above: with nothing learned and no git
	// signal there is nothing to reorder by, so the result must come back
	// untouched. Without this, a rank that silently returned its input reversed
	// — or a store that never loaded — would still look like a pass.
	it("leaves the order alone when it knows nothing", async () => {
		const pi = createFakePi();
		filerankExtension(pi.api);
		const [result] = await pi.emit({
			type: "tool_result",
			toolCallId: "t1",
			toolName: "find",
			input: { pattern: "*.ts" },
			content: [{ type: "text", text: "a.ts\nb.ts" }],
			isError: false,
		});
		expect(result).toBeUndefined();
	});

	// A selection must follow the MOST RECENT find. A second find that this
	// extension declines to touch still moves the model on, and attributing the
	// next read to the older question writes a wrong entry into the strongest
	// ranking tier — and persists it.
	it("stops attributing reads to a find the model has moved on from", async () => {
		const storeFile = join(home, ".pi", "agent", "filerank.json");
		const pi = createFakePi();
		filerankExtension(pi.api);

		const find = (pattern: string, text: string): Promise<unknown[]> =>
			pi.emit({
				type: "tool_result",
				toolCallId: pattern,
				toolName: "find",
				input: { pattern },
				content: [{ type: "text", text }],
				isError: false,
			});

		await find("*.ts", "a.ts\nb.ts");
		// One result: reorderFindOutput bails before ranking, so nothing is armed.
		await find("only*", "only.ts");
		await pi.emit({
			type: "tool_result",
			toolCallId: "r1",
			toolName: "read",
			input: { path: "a.ts" },
			content: [{ type: "text", text: "…" }],
			isError: false,
		});
		await pi.emit({ type: "session_shutdown", reason: "quit" });

		const persisted = loadStore(storeFile);
		expect(Object.keys(persisted.selections)).toEqual([]);
		expect(persisted.paths[resolve(process.cwd(), "a.ts")].count).toBe(1);
	});

	it("leaves a failed find untouched", async () => {
		const pi = createFakePi();
		filerankExtension(pi.api);
		const [result] = await pi.emit({
			type: "tool_result",
			toolCallId: "t1",
			toolName: "find",
			input: { pattern: "*.ts" },
			content: [{ type: "text", text: "a.ts\nb.ts" }],
			isError: true,
		});
		expect(result).toBeUndefined();
	});

	it("leaves a result shape it does not understand untouched", async () => {
		const pi = createFakePi();
		filerankExtension(pi.api);
		const [result] = await pi.emit({
			type: "tool_result",
			toolCallId: "t1",
			toolName: "find",
			input: { pattern: "*.ts" },
			content: [{ type: "image", data: "…" }],
			isError: false,
		});
		expect(result).toBeUndefined();
	});
});
