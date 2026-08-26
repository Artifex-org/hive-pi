/**
 * Watching a Hive run instead of polling it (HIV-1998).
 *
 * The behaviour under test is resolution and refusal, because those are the
 * only places this can be silently wrong. Watching the WRONG run is the worst
 * outcome available: it reports a confident verdict about something the caller
 * never asked about, and nothing downstream can tell.
 */

import { describe, expect, it } from "vitest";

import {
	isRunNumber,
	isRunUUID,
	normalizeRunRef,
	resolveRunUUID,
	runStateNote,
	watchCommand,
	type ResolveDeps,
} from "../extensions/background/watch-run.ts";

const UUID = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";

function deps(body: unknown, ok = true, status = 200): ResolveDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		baseURL: "https://hive.example",
		token: "t",
		calls,
		getJSON: async (url) => {
			calls.push(url);
			return { ok, status, body };
		},
	};
}

describe("run references", () => {
	it("tells a UUID from a number from neither", () => {
		expect(isRunUUID(UUID)).toBe(true);
		expect(isRunUUID("2047")).toBe(false);
		expect(isRunNumber("2047")).toBe(true);
		expect(isRunNumber("#2047")).toBe(true);
		expect(isRunNumber(UUID)).toBe(false);
		expect(normalizeRunRef("  #2047 ")).toBe("2047");
	});

	it("resolves a UUID without a round trip", async () => {
		const d = deps(null);
		expect(await resolveRunUUID(UUID, undefined, undefined, d)).toEqual({ uuid: UUID });
		// The lookup is the only network in a tool that promises to return at
		// once; not spending it when the answer is already in hand matters.
		expect(d.calls).toHaveLength(0);
	});

	it("resolves a run NUMBER through the API", async () => {
		const d = deps({ runs: [{ id: UUID, number: 2047, project: "Borealis-Ops", pipeline: "ci" }] });
		expect(await resolveRunUUID("#2047", "Borealis-Ops", "ci", d)).toEqual({ uuid: UUID });
		expect(d.calls[0]).toContain("project=Borealis-Ops");
		expect(d.calls[0]).toContain("pipeline=ci");
	});

	it("accepts a bare array as well as a {runs:[…]} envelope", async () => {
		// Parsed against what the endpoint returns, not against a doc. A shape
		// mismatch here would resolve nothing and read as 'no such run'.
		const d = deps([{ id: UUID, number: 2047 }]);
		expect(await resolveRunUUID("2047", undefined, undefined, d)).toEqual({ uuid: UUID });
	});

	it("REFUSES an ambiguous number rather than guessing", async () => {
		// Numbers are allocated per pipeline. Picking one would watch the wrong
		// run and report its verdict as though it were the right one.
		const d = deps({
			runs: [
				{ id: UUID, number: 2047, project: "a", pipeline: "ci" },
				{ id: "0000aaaa-0000-0000-0000-000000000000", number: 2047, project: "b", pipeline: "ci" },
			],
		});
		const out = await resolveRunUUID("2047", undefined, undefined, d);
		expect(out).toHaveProperty("error");
		expect((out as { error: string }).error).toContain("ambiguous");
		expect((out as { error: string }).error).toContain("a/ci");
	});

	it("ignores rows whose number does not match, rather than taking the first", async () => {
		const d = deps({ runs: [{ id: "0000aaaa-0000-0000-0000-000000000000", number: 9, project: "a" }] });
		const out = await resolveRunUUID("2047", undefined, undefined, d);
		expect(out).toHaveProperty("error");
		expect((out as { error: string }).error).toContain("No run #2047");
	});

	it("reports an unreachable Hive instead of starting a doomed watch", async () => {
		const out = await resolveRunUUID("2047", undefined, undefined, deps(null, false, 0));
		expect((out as { error: string }).error).toContain("unreachable");
	});

	it("rejects a reference that is neither form", async () => {
		for (const bad of ["", "   ", "main", "abc-def"]) {
			expect(await resolveRunUUID(bad, undefined, undefined, deps(null))).toHaveProperty("error");
		}
	});
});

describe("the command", () => {
	it("is `hive watch <uuid>` — the form every CLI version understands", () => {
		// Deliberately NOT `hive watch #2047 --project …`: run-number resolution
		// landed in the CLI on 2026-08-16, and a workstation binary older than
		// that answers `flag provided but not defined: -project` (measured on
		// a linux workstation, binary dated 2026-07-20).
		expect(watchCommand(UUID)).toBe(`hive watch ${UUID}`);
	});

	it("refuses to build a command from anything but a validated UUID", () => {
		// The last gate before a caller-supplied string reaches `bash -lc`.
		for (const bad of ["2047", "$(rm -rf /)", `${UUID}; echo hi`]) {
			expect(() => watchCommand(bad)).toThrow();
		}
	});
});

// "Pass project (and pipeline) to narrow it" was the wrong instruction when a
// project had ALREADY been passed: narrowing cannot find what the filter is
// what excluded. Measured 2026-08-18 — `No run #2150 in project Borealis-Ops.
// Run numbers are per pipeline — pass project (and pipeline) to narrow it.`
describe("a run number that is not in the scope asked for", () => {
	/** Answers the scoped query with nothing and the unscoped one with `rows`. */
	function scopedMiss(rows: unknown[]): ResolveDeps & { calls: string[] } {
		const calls: string[] = [];
		return {
			baseURL: "https://hive.example",
			token: "t",
			calls,
			getJSON: async (url) => {
				calls.push(url);
				const scoped = url.includes("project=");
				return { ok: true, status: 200, body: { runs: scoped ? [] : rows } };
			},
		};
	}

	it("says where the number actually lives", async () => {
		const d = scopedMiss([{ id: UUID, number: 2150, project: "Aurora", pipeline: "ci" }]);
		const got = await resolveRunUUID("2150", "Borealis-Ops", undefined, d);

		expect("error" in got && got.error).toContain("No run #2150 in project Borealis-Ops");
		expect("error" in got && got.error).toContain("Aurora/ci");
		// The widened lookup happens ONLY on the failure path.
		expect(d.calls).toHaveLength(2);
		expect(d.calls[1]).not.toContain("project=");
	});

	it("caps the list rather than pasting every pipeline", async () => {
		const d = scopedMiss(
			["a", "b", "c", "d", "e"].map((p) => ({ id: UUID, number: 7, project: p, pipeline: "ci" })),
		);
		const got = await resolveRunUUID("7", "hive", undefined, d);
		expect("error" in got && got.error).toContain("and 2 more");
	});

	it("gives a definite negative when it exists nowhere visible", async () => {
		const d = scopedMiss([]);
		const got = await resolveRunUUID("999", "hive", undefined, d);
		expect("error" in got && got.error).toContain("any project you can see");
		// And does not tell the caller to narrow a scope that already missed.
		expect("error" in got && got.error).not.toContain("to narrow it");
	});

	// The footnote must never become the failure. A refusal that throws because
	// its extra lookup did is worse than the refusal it was improving.
	it("still refuses cleanly when the widened lookup fails", async () => {
		const calls: string[] = [];
		const d: ResolveDeps & { calls: string[] } = {
			baseURL: "https://hive.example",
			token: "t",
			calls,
			getJSON: async (url) => {
				calls.push(url);
				if (!url.includes("project=")) throw new Error("network down");
				return { ok: true, status: 200, body: { runs: [] } };
			},
		};
		const got = await resolveRunUUID("2150", "Borealis-Ops", undefined, d);
		expect("error" in got && got.error).toContain("No run #2150");
	});

	// No scope was given, so there is nothing to widen — and no second request.
	it("does not make a second request when nothing was scoped", async () => {
		const d = deps({ runs: [] });
		const got = await resolveRunUUID("2150", undefined, undefined, d);
		expect("error" in got && got.error).toContain("any project you can see");
		expect(d.calls).toHaveLength(1);
	});
});

// A watch that hits its wall clock reported "no terminal event" and a tail of
// `task.ready` — which is the same tail whether the run never started or one
// step wedged. Measured 2026-08-18 19:07: a two-hour watch on PR run #9705
// ended exactly there, on a night when hive runs queued 60-90 minutes for
// capacity. The two cases want opposite responses.
describe("what the run was doing when the watch gave up", () => {
	function state(body: unknown, ok = true): ResolveDeps {
		return {
			baseURL: "https://hive.example",
			token: "t",
			getJSON: async () => ({ ok, status: ok ? 200 : 500, body }),
		};
	}

	it("names the never-started case, and points at capacity rather than the run", async () => {
		const note = await runStateNote(
			UUID,
			state({ run: { state: "running", tasks_summary: { total: 8, succeeded: 0, running: 0, pending: 8 } } }),
		);
		expect(note).toContain("had NOT started");
		expect(note).toContain("8 task");
		expect(note).toContain("fleet_status");
	});

	it("reports progress when it did start", async () => {
		const note = await runStateNote(
			UUID,
			state({
				run: {
					state: "running",
					started_at: "2026-08-18T19:17:09Z",
					tasks_summary: { total: 8, succeeded: 3, failed: 0, running: 1, pending: 4 },
				},
			}),
		);
		expect(note).toContain("3/8");
		expect(note).toContain("1 running");
		expect(note).not.toContain("had NOT started");
	});

	it("takes the run either bare or wrapped", async () => {
		const bare = await runStateNote(UUID, state({ state: "failed", started_at: "x", tasks_summary: { total: 2, failed: 1, succeeded: 1 } }));
		expect(bare).toContain("2/2");
	});

	// It is a footnote to a timeout. A footnote that fails must leave the
	// timeout report alone rather than replacing it.
	it("says nothing at all when the lookup fails or the body is unusable", async () => {
		expect(await runStateNote(UUID, state({}, false))).toBe("");
		expect(await runStateNote(UUID, state(null))).toBe("");
		const throws: ResolveDeps = {
			baseURL: "https://hive.example",
			token: "t",
			getJSON: async () => {
				throw new Error("network down");
			},
		};
		expect(await runStateNote(UUID, throws)).toBe("");
	});
});
