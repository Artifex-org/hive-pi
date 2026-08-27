/**
 * The pure half of `readiness/`: folding results, ordering, rendering, and the
 * snapshot block.
 *
 * The assertions worth keeping are the ones that pin a DECISION rather than an
 * implementation: `unknown` is not `absent`, a re-probe that found nothing new
 * does not bump the revision, and the deck hides ready rows while the snapshot
 * shows them.
 */

import { describe, expect, it } from "vitest";

import {
	applyResults,
	countByStatus,
	emptyReadiness,
	isEmpty,
	orderedResults,
	READINESS_ENTRY_TYPE,
	rehydrateReadiness,
	renderLines,
	snapshotBlock,
	summaryLine,
	toEntry,
	type ProbeResult,
} from "../extensions/readiness/state.ts";

const NOW = 1_700_000_000_000;

function result(overrides: Partial<ProbeResult> & Pick<ProbeResult, "id" | "status">): ProbeResult {
	return { label: overrides.id, at: NOW, ...overrides } as ProbeResult;
}

describe("applyResults", () => {
	it("adds a result and bumps the revision", () => {
		const { state, changed } = applyResults(emptyReadiness(NOW), [result({ id: "hive", status: "ready" })]);
		expect(changed).toBe(true);
		expect(state.revision).toBe(1);
		expect(state.results.hive?.status).toBe("ready");
	});

	it("does NOT bump the revision when a re-probe found the same verdict", () => {
		const first = applyResults(emptyReadiness(NOW), [result({ id: "gh", status: "ready", detail: "octocat" })]);
		const second = applyResults(first.state, [result({ id: "gh", status: "ready", detail: "octocat", at: NOW + 60_000 })]);
		// Every revision is an appendEntry: a fresh timestamp is not news.
		expect(second.changed).toBe(false);
		expect(second.state.revision).toBe(1);
		expect(second.state).toBe(first.state);
	});

	it("treats a changed detail as news even when the status held", () => {
		const first = applyResults(emptyReadiness(NOW), [result({ id: "openrouter", status: "ready", detail: "$9 left" })]);
		const second = applyResults(first.state, [result({ id: "openrouter", status: "ready", detail: "$3 left" })]);
		expect(second.changed).toBe(true);
		expect(second.state.results.openrouter?.detail).toBe("$3 left");
	});

	it("drops a malformed status rather than storing it", () => {
		const { state, changed } = applyResults(emptyReadiness(NOW), [
			{ id: "bogus", label: "bogus", status: "on-fire" as never, at: NOW },
		]);
		expect(changed).toBe(false);
		expect(isEmpty(state)).toBe(true);
	});
});

describe("ordering and summary", () => {
	const state = applyResults(emptyReadiness(NOW), [
		result({ id: "browser", status: "ready" }),
		result({ id: "devservices.postgres", status: "absent" }),
		result({ id: "openrouter", status: "degraded" }),
		result({ id: "mcp.hive", status: "warming" }),
		result({ id: "repo", status: "unknown" }),
	]).state;

	it("sorts what is wrong above what is fine", () => {
		expect(orderedResults(state).map((r) => r.id)).toEqual([
			"devservices.postgres",
			"openrouter",
			"mcp.hive",
			"repo",
			"browser",
		]);
	});

	it("counts by status", () => {
		expect(countByStatus(state)).toEqual({ ready: 1, warming: 1, degraded: 1, absent: 1, unknown: 1 });
	});

	it("summarises ready as a fraction of the whole", () => {
		expect(summaryLine(state)).toBe("env 1/5 ready · 1 warming · 1 degraded · 1 absent · 1 unknown");
	});

	it("says it is probing before anything reported", () => {
		expect(summaryLine(emptyReadiness(NOW))).toBe("env probing");
	});
});

describe("renderLines", () => {
	const state = applyResults(emptyReadiness(NOW), [
		result({ id: "browser", label: "browser", status: "ready", detail: "chromium_headless_shell-1200" }),
		result({
			id: "devservices.postgres",
			label: "dev postgres",
			status: "absent",
			detail: "server binaries not installed",
			hint: "run `install-devservices-postgres`",
		}),
	]).state;

	it("hides ready rows from the deck", () => {
		const lines = renderLines(state);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("dev postgres");
		expect(lines[0]).toContain("install-devservices-postgres");
	});

	it("shows everything when asked", () => {
		expect(renderLines(state, { all: true })).toHaveLength(2);
	});

	it("never renders a hint for a ready row", () => {
		const ready = applyResults(emptyReadiness(NOW), [
			result({ id: "gh", label: "gh auth", status: "ready", hint: "should not appear" }),
		]).state;
		expect(renderLines(ready, { all: true })[0]).not.toContain("should not appear");
	});
});

describe("snapshotBlock", () => {
	const state = applyResults(emptyReadiness(NOW), [
		result({ id: "devservices.postgres", label: "dev postgres", status: "absent", tool: "dev_db_start", hint: "install it" }),
		result({ id: "browser", label: "browser", status: "ready", tool: "browser_*" }),
	]).state;

	it("names the tool for each capability", () => {
		const block = snapshotBlock(state, NOW);
		expect(block).toContain("[Environment Snapshot]");
		expect(block).toContain("tool: dev_db_start");
		expect(block).toContain("tool: browser_*");
	});

	it("says it is a snapshot, not a live view", () => {
		expect(snapshotBlock(state, NOW)).toContain("snapshot, not a live view");
	});

	it("is empty when nothing has been probed — nothing to inject", () => {
		expect(snapshotBlock(emptyReadiness(NOW), NOW)).toBe("");
	});
});

describe("persistence", () => {
	it("round-trips through an entry", () => {
		const state = applyResults(emptyReadiness(NOW), [
			result({ id: "hive", label: "hive", status: "ready", detail: "https://hive.example", tool: "mcp__hive__*" }),
			result({ id: "gh", label: "gh auth", status: "degraded", hint: "gh auth login" }),
		]).state;
		const entries = [{ customType: READINESS_ENTRY_TYPE, data: toEntry(state) }];
		const restored = rehydrateReadiness(entries);
		expect(restored?.revision).toBe(state.revision);
		expect(restored?.results.hive).toEqual(state.results.hive);
		expect(restored?.results.gh?.hint).toBe("gh auth login");
	});

	it("takes the newest snapshot, not a merge of all of them", () => {
		const older = applyResults(emptyReadiness(NOW), [result({ id: "gh", status: "degraded" })]).state;
		const newer = applyResults(older, [result({ id: "gh", status: "ready" })]).state;
		const restored = rehydrateReadiness([
			{ customType: READINESS_ENTRY_TYPE, data: toEntry(older) },
			{ customType: "plan", data: { irrelevant: true } },
			{ customType: READINESS_ENTRY_TYPE, data: toEntry(newer) },
		]);
		expect(restored?.results.gh?.status).toBe("ready");
	});

	it("returns null when no snapshot is present", () => {
		expect(rehydrateReadiness([{ customType: "plan", data: {} }])).toBeNull();
	});

	it("skips a malformed row rather than failing the whole restore", () => {
		const restored = rehydrateReadiness([
			{
				customType: READINESS_ENTRY_TYPE,
				data: { revision: 3, startedAtMs: NOW, results: [{ id: "ok", status: "ready", at: NOW }, { nope: true }] },
			},
		]);
		expect(Object.keys(restored?.results ?? {})).toEqual(["ok"]);
		expect(restored?.revision).toBe(3);
	});
});
