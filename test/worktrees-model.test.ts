import { describe, expect, it } from "vitest";
import {
	anchorOf,
	formatList,
	isPullOnlyAnchor,
	parseWorktreeList,
	parseWtArgs,
	resolveWorktree,
	type WorktreeInfo,
} from "../extensions/worktrees/model.ts";
import worktreesExtension from "../extensions/worktrees/index.ts";
import { createFakePi } from "./fake-pi.ts";

const LIST: WorktreeInfo[] = [
	{ path: "/home/u/repos/hive-pi.git", branch: "main", isMain: true },
	{ path: "/home/u/repos/hive-pi__worktrees/main", branch: "main", isMain: false },
	{ path: "/home/u/repos/hive-pi__worktrees/feature-hiv-1219", branch: "feature/hiv-1219", isMain: false },
	{ path: "/home/u/repos/hive-pi__worktrees/feature-hiv-1221", branch: "feature/hiv-1221", isMain: false },
];

describe("worktrees model", () => {
	it("parses gwq list --json and drops malformed entries", () => {
		const parsed = parseWorktreeList(
			JSON.stringify([
				{ path: "/a", branch: "b", is_main: true },
				{ path: 42, branch: "bad" },
				"nope",
			]),
		);
		expect(parsed).toEqual([{ path: "/a", branch: "b", isMain: true }]);
		expect(parseWorktreeList("not json")).toEqual([]);
	});

	it("recognizes pull-only anchors, and only those", () => {
		expect(isPullOnlyAnchor("/home/u/repos/hive-pi__worktrees/main")).toBe(true);
		expect(isPullOnlyAnchor("/home/u/repos/Aurora__worktrees/feature")).toBe(true);
		expect(isPullOnlyAnchor("/home/u/repos/hive-pi__worktrees/feature-hiv-1219")).toBe(false);
		expect(isPullOnlyAnchor("/home/u/repos/matwork/main")).toBe(false);
	});

	it("anchorOf prefers the pull-only anchor and never the bare repo", () => {
		expect(anchorOf(LIST)?.path).toBe("/home/u/repos/hive-pi__worktrees/main");
		const plain: WorktreeInfo[] = [
			{ path: "/home/u/repos/matwork", branch: "main", isMain: true },
			{ path: "/home/u/repos/matwork-wt/x", branch: "x", isMain: false },
		];
		expect(anchorOf(plain)?.path).toBe("/home/u/repos/matwork");
	});

	it("resolves exact branch, then unique substring, and refuses ambiguity with names", () => {
		expect(resolveWorktree(LIST, "feature/hiv-1219")).toMatchObject({ ok: true });
		expect(resolveWorktree(LIST, "1221")).toMatchObject({
			ok: true,
			worktree: { branch: "feature/hiv-1221" },
		});
		const ambiguous = resolveWorktree(LIST, "hiv-12");
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.error).toContain("feature/hiv-1219");
		const missing = resolveWorktree(LIST, "zzz");
		expect(missing.ok).toBe(false);
	});

	it("parses /wt argument forms and refuses garbage with usage", () => {
		expect(parseWtArgs("")).toEqual({ sub: "list" });
		expect(parseWtArgs("fork feature/x")).toEqual({ sub: "fork", branch: "feature/x" });
		expect(parseWtArgs("co 1221")).toEqual({ sub: "checkout", pattern: "1221" });
		expect(parseWtArgs("rm")).toEqual({ sub: "rm" });
		expect(parseWtArgs("fork")).toMatchObject({ error: expect.stringContaining("fork") });
		expect(parseWtArgs("frobnicate")).toMatchObject({ error: expect.stringContaining("usage") });
	});

	it("marks the current worktree and labels anchors in the listing", () => {
		const lines = formatList(LIST, "/home/u/repos/hive-pi__worktrees/feature-hiv-1219");
		expect(lines.some((line) => line.startsWith("▶") && line.includes("feature/hiv-1219"))).toBe(true);
		expect(lines.some((line) => line.includes("(pull-only anchor)"))).toBe(true);
		expect(lines.some((line) => line.includes("hive-pi.git"))).toBe(false);
	});
});

describe("worktrees extension behavior", () => {
	it("registers /wt and /mv, and refuses bad input with usage text", async () => {
		const fake = createFakePi();
		worktreesExtension(fake.api);
		await fake.runCommand("wt", "frobnicate");
		expect(fake.notifications.some((note) => note.message.includes("usage"))).toBe(true);
		await fake.runCommand("mv", "");
		expect(fake.notifications.some((note) => note.message.includes("/mv <dir>"))).toBe(true);
	});

	it("reports an empty gwq listing honestly instead of crashing", async () => {
		const fake = createFakePi();
		worktreesExtension(fake.api);
		await fake.runCommand("wt", "list");
		expect(fake.notifications.some((note) => note.message.includes("no worktrees"))).toBe(true);
	});
});
