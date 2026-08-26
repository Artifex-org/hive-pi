/**
 * Footer layout. A status bar's real failure mode is not a wrong value, it is a
 * row that overflows and wraps — which shifts every line above it and corrupts
 * the whole frame. So the load-bearing assertion in almost every case here is
 * that the rendered width never exceeds the terminal's.
 */

import { describe, expect, it } from "vitest";
import type { HiveSnapshot } from "../extensions/status-footer/hive.ts";
import { mapRun } from "../extensions/status-footer/hive.ts";
import type { LinearIssue, LinearSnapshot } from "../extensions/status-footer/linear.ts";
import {
	describeRun,
	hiveSegments,
	integrationRow,
	issueGlyph,
	linearSegments,
	packSegments,
	runGlyph,
	workspaceRow,
} from "../extensions/status-footer/render.ts";
import type { Workspace } from "../extensions/status-footer/workspace.ts";

/** Wraps every fragment in real SGR codes, so any width math that ignores ANSI fails loudly. */
const theme = { fg: (color: string, text: string) => `\x1B[38;5;${color.length}m${text}\x1B[0m` };
const plain = { fg: (_color: string, text: string) => text };

const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const widthOf = (line: string) => [...line.replace(ansi, "")].length;

const run = (over: Record<string, unknown> = {}) =>
	mapRun({
		id: "r1",
		number: 6684,
		state: "running",
		pipeline: "ci",
		branch: "feature/hiv-1080",
		pr: 2419,
		tasks_summary: { total: 12, succeeded: 5, failed: 0, running: 3, pending: 4 },
		created_at: "2026-08-05T14:00:00Z",
		...over,
	})!;

const hive = (over: Partial<HiveSnapshot> = {}): HiveSnapshot => ({
	status: "ok",
	project: "Aurora",
	defaultBranch: "feature",
	mine: run(),
	active: [run(), run({ id: "r2" }), run({ id: "r3" })],
	trunk: run({ id: "t", state: "succeeded", branch: "feature", pr: null }),
	trunkActive: false,
	health: { passed: 11, total: 12 },
	live: true,
	error: null,
	...over,
});

const issue = (identifier: string, stateType: LinearIssue["stateType"], stateName: string): LinearIssue => ({
	identifier,
	title: `${identifier} title`,
	url: `https://linear.app/x/issue/${identifier}`,
	stateName,
	stateType,
	assignee: "joan",
	priority: 2,
	source: "attachment",
});

const linear = (issues: LinearIssue[] = [issue("HIV-1080", "started", "In Progress")]): LinearSnapshot => ({
	status: "ok",
	issues,
	error: null,
});

describe("packSegments", () => {
	const segments = [
		{ text: "aaaa", priority: 1 },
		{ text: "bbbb", priority: 5 },
		{ text: "cccc", priority: 3 },
	];

	it("keeps everything when it fits", () => {
		expect(packSegments(segments, 80)).toBe("aaaa · bbbb · cccc");
	});

	it("sheds the lowest priority first and preserves the original order", () => {
		expect(packSegments(segments, 12)).toBe("bbbb · cccc");
		expect(packSegments(segments, 4)).toBe("bbbb");
	});

	it("returns empty rather than overflowing when nothing fits", () => {
		expect(packSegments(segments, 1)).toBe("");
		expect(packSegments([], 40)).toBe("");
	});

	it("measures visible width, not byte length", () => {
		const styled = [{ text: theme.fg("accent", "abcd"), priority: 1 }];
		expect(widthOf(packSegments(styled, 4))).toBe(4);
	});
});

describe("describeRun", () => {
	it("shows progress while a run is moving", () => {
		expect(describeRun(run(), plain)).toBe("ci ⟳ 5/12");
	});

	it("surfaces failing tasks before the run itself has failed", () => {
		expect(describeRun(run({ tasks_summary: { total: 12, succeeded: 5, failed: 2, running: 1, pending: 4 } }), plain)).toBe(
			"ci ⟳ 5/12 ✗2",
		);
	});

	it("says queued for a run that has not started", () => {
		expect(describeRun(run({ state: "pending", tasks_summary: null }), plain)).toBe("ci ◌ queued");
	});

	it("reduces to a verdict once the run is over", () => {
		expect(describeRun(run({ state: "succeeded" }), plain)).toBe("ci ✓");
		expect(
			describeRun(run({ state: "failed", tasks_summary: { total: 12, succeeded: 9, failed: 2, running: 0, pending: 0 } }), plain),
		).toBe("ci ✗ 2 failed");
	});
});

describe("glyphs", () => {
	it("colours a failure as an error and a pass as a success", () => {
		expect(runGlyph("failed")).toEqual({ glyph: "✗", color: "error" });
		expect(runGlyph("succeeded")).toEqual({ glyph: "✓", color: "success" });
		expect(runGlyph("evaluating").color).toBe("muted");
		expect(issueGlyph("started").glyph).toBe("▶");
		expect(issueGlyph("backlog").glyph).toBe("○");
	});
});

describe("hiveSegments", () => {
	it("says nothing at all when the repo is not a Hive project", () => {
		expect(hiveSegments(hive({ status: "foreign" }), plain)).toEqual([]);
		expect(hiveSegments(hive({ status: "off" }), plain)).toEqual([]);
		// Nothing is shown before the first resolve, so the row cannot flash.
		expect(hiveSegments(hive({ status: "unresolved" }), plain)).toEqual([]);
	});

	it("ranks a red trunk above the in-flight count, and a green trunk below it", () => {
		const red = hiveSegments(hive({ trunk: run({ id: "t", state: "failed" }) }), plain);
		const green = hiveSegments(hive(), plain);
		const priorityOf = (segments: typeof red, needle: string) =>
			segments.find((s) => s.text.includes(needle))?.priority ?? -1;
		expect(priorityOf(red, "feature")).toBeGreaterThan(priorityOf(red, "running"));
		expect(priorityOf(green, "feature")).toBeLessThan(priorityOf(green, "running"));
	});

	it("counts only the OTHER runs as in flight — mine has its own segment", () => {
		const segments = hiveSegments(hive(), plain);
		expect(segments.some((s) => s.text === "2 running")).toBe(true);
	});

	it("distinguishes a red trunk being retried from a red trunk nobody is on", () => {
		const idle = hiveSegments(hive({ trunk: run({ id: "t", state: "failed" }) }), plain);
		const retrying = hiveSegments(hive({ trunk: run({ id: "t", state: "failed" }), trunkActive: true }), plain);
		expect(idle.some((s) => s.text === "feature ✗")).toBe(true);
		expect(retrying.some((s) => s.text === "feature ✗⟳")).toBe(true);
	});

	it("reports an unreachable server instead of pretending the project is idle", () => {
		const segments = hiveSegments(hive({ status: "error", error: "timeout" }), plain);
		expect(segments[0].text).toContain("timeout");
	});
});

describe("linearSegments", () => {
	const three = linear([
		issue("HIV-1080", "started", "In Progress"),
		issue("HIV-1075", "backlog", "Backlog"),
		issue("TES-7055", "completed", "Done"),
	]);

	it("shows the first two and counts the rest", () => {
		const segments = linearSegments(three, plain);
		expect(segments.map((s) => s.text)).toEqual(["HIV-1080 ▶ In Progress", "HIV-1075 ○ Backlog", "+1"]);
	});

	it("drops state names as the degradation step, keeping identifier and glyph", () => {
		expect(linearSegments(three, plain, 2, false).map((s) => s.text)).toEqual(["HIV-1080 ▶", "HIV-1075 ○", "+1"]);
	});

	it("says nothing when there are no tickets", () => {
		expect(linearSegments(linear([]), plain)).toEqual([]);
		expect(linearSegments({ status: "off", issues: [], error: null }, plain)).toEqual([]);
	});
});

describe("integrationRow", () => {
	it("costs no row when there is nothing to say", () => {
		expect(integrationRow(hive({ status: "foreign" }), linear([]), theme, 120)).toBeNull();
		expect(integrationRow(hive({ status: "off" }), { status: "off", issues: [], error: null }, theme, 120)).toBeNull();
	});

	it("renders Hive left and Linear right", () => {
		const row = integrationRow(hive(), linear(), theme, 120) ?? "";
		const bare = row.replace(ansi, "");
		expect(bare).toMatch(/^hive /);
		expect(bare.trimEnd()).toMatch(/HIV-1080 ▶ In Progress$/);
		expect(widthOf(row)).toBeLessThanOrEqual(120);
	});

	it("never exceeds the terminal width, at any width", () => {
		for (let width = 1; width <= 200; width++) {
			const row = integrationRow(hive(), linear(), theme, width);
			if (row !== null) expect(widthOf(row), `width ${width}`).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the ticket identifier legible when the terminal is narrow", () => {
		// Degradation must shed the state name and the low-priority Hive segments
		// rather than truncate the tail, which is where the verdict lives.
		const row = (integrationRow(hive(), linear(), theme, 44) ?? "").replace(ansi, "");
		expect(row).toContain("HIV-1080");
		expect(row).not.toContain("In Progress");
	});

	it("holds on to my own run's state longest", () => {
		const row = (integrationRow(hive(), linear([]), theme, 20) ?? "").replace(ansi, "");
		expect(row).toContain("ci");
	});

	it("still renders the tickets when the repo is not a Hive project", () => {
		const row = (integrationRow(hive({ status: "foreign" }), linear(), theme, 100) ?? "").replace(ansi, "");
		expect(row).toContain("HIV-1080");
		expect(row).not.toContain("hive ");
	});
});

describe("workspaceRow", () => {
	const workspace: Workspace = {
		cwd: "/home/dev/repos/hive-pi",
		repo: "hive-pi",
		branch: "feature/hiv-1080",
		pr: 2419,
		prUrl: null,
		prTitle: null,
	};

	it("puts the PR's verdict next to its number", () => {
		const row = workspaceRow(workspace, "hive-pi", "feature/hiv-1080", run({ state: "failed", pr: 2419 }), plain);
		expect(row).toContain("PR #2419 ✗");
	});

	it("does not attribute another PR's run to this one", () => {
		const row = workspaceRow(workspace, "hive-pi", "feature/hiv-1080", run({ state: "failed", pr: 9999 }), plain);
		expect(row).toContain("PR #2419 ·");
		expect(row).not.toContain("✗");
	});

	it("renders a branch with no PR", () => {
		const row = workspaceRow({ ...workspace, pr: null }, "hive-pi", "main", null, plain);
		expect(row).toContain("PR —");
	});
});
