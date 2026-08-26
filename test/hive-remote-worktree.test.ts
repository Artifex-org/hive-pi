import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyStatusCode,
	isSandboxMask,
	parseBranchLine,
	parseNumstat,
	parseStatus,
} from "../extensions/hive-remote/worktree.ts";

// These parsers read git's machine format, so the fixtures below are REAL
// output, captured from a scratch repo with `od -c`:
//
//   git init; commit two files; git mv old.txt new.txt; edit keep.txt;
//   create "un tracked.txt"; git status --porcelain=v1 -b -z
//   → "## main\0 M keep.txt\0R  new.txt\0old.txt\0?? un tracked.txt\0"
//
// The rename ordering is the whole reason for capturing rather than recalling:
// in -z format the record carries the NEW path and the ORIGINAL follows it in
// the next NUL field. Getting that backwards files the original as its own
// entry, with a two-character "status" read off the middle of a path.

describe("parseBranchLine", () => {
	it("reads the upstream and the divergence", () => {
		expect(parseBranchLine("## feat/x...origin/feat/x [ahead 2, behind 1]")).toEqual({
			branch: "feat/x",
			upstream: "origin/feat/x",
			ahead: 2,
			behind: 1,
		});
	});

	// An upstream that exists with no bracket is genuinely in step. This is the
	// ONE case where zero is a measurement rather than the absence of one.
	it("reads a tracked branch with no divergence as a real zero", () => {
		expect(parseBranchLine("## main...origin/main")).toEqual({
			branch: "main",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
		});
	});

	// The distinction the nullable contract exists for: ↑0 reads as delivered,
	// and this work is on one machine and nowhere else.
	it("reports no divergence for a branch that was never pushed", () => {
		expect(parseBranchLine("## main")).toEqual({
			branch: "main",
			upstream: "",
			ahead: null,
			behind: null,
		});
	});

	it("reports no divergence when the upstream is gone", () => {
		expect(parseBranchLine("## feat/x...origin/feat/x [gone]")).toEqual({
			branch: "feat/x",
			upstream: "origin/feat/x",
			ahead: null,
			behind: null,
		});
	});

	it("survives a detached HEAD", () => {
		expect(parseBranchLine("## HEAD (no branch)")).toEqual({
			branch: "",
			upstream: "",
			ahead: null,
			behind: null,
		});
	});

	// A branch name may contain dots; only the "..." separator splits.
	it("does not split a branch name on its own dots", () => {
		expect(parseBranchLine("## release/v1.2.3...origin/release/v1.2.3").upstream).toBe(
			"origin/release/v1.2.3",
		);
	});

	// HIV-2255, and the reason the local branch is reported at all. Every gwq
	// worktree tracks the branch it was cut from until its first push, so the
	// two halves of this line name DIFFERENT branches — and Hive's rail, which
	// reconstructed one from the other, asked trunk's questions about six of
	// seven live sessions. Captured from a real worktree.
	it("keeps the local branch separate from the base branch it tracks", () => {
		const parsed = parseBranchLine("## main-2abaeee9...origin/main [behind 45]");
		expect(parsed.branch).toBe("main-2abaeee9");
		expect(parsed.upstream).toBe("origin/main");
		expect(parsed.behind).toBe(45);
	});

	// Every parenthetical git narrates in this slot — rebase, bisect, detach —
	// is a state, not a branch. A branch name cannot contain a space, so the
	// space is the discriminator rather than a list of spellings to keep current.
	it("reports no branch for git's narrated non-branch states", () => {
		expect(parseBranchLine("## HEAD (no branch)").branch).toBe("");
		expect(parseBranchLine("## (no branch, rebasing feat/x)").branch).toBe("");
		expect(parseBranchLine("## HEAD detached at 1a2b3c4").branch).toBe("");
	});
});

describe("classifyStatusCode", () => {
	it("separates the index from the tree, and keeps the both case", () => {
		expect(classifyStatusCode("M", " ")).toBe("staged");
		expect(classifyStatusCode(" ", "M")).toBe("unstaged");
		// Half of a file staged and the rest not — the state an agent commits a
		// half-fix from, so it must not flatten to either side.
		expect(classifyStatusCode("M", "M")).toBe("both");
		expect(classifyStatusCode("A", " ")).toBe("staged");
	});

	it("recognises every unmerged shape git defines", () => {
		for (const [x, y] of [["U", "U"], ["A", "U"], ["U", "D"], ["D", "D"], ["A", "A"]]) {
			expect(classifyStatusCode(x, y)).toBe("conflicted");
		}
	});

	it("calls an untracked file untracked", () => {
		expect(classifyStatusCode("?", "?")).toBe("untracked");
	});
});

describe("parseStatus", () => {
	// Captured verbatim; see the header.
	const REAL = "## main\0 M keep.txt\0R  new.txt\0old.txt\0?? un tracked.txt\0";

	it("consumes a rename's second path instead of filing it as an entry", () => {
		const { files } = parseStatus(REAL);
		expect(files.map((f) => f.path)).toEqual(["keep.txt", "new.txt", "un tracked.txt"]);
		expect(files.find((f) => f.path === "new.txt")?.state).toBe("staged");
	});

	// -z exists precisely so a space in a path is not quoted. If this ever
	// regresses the path arrives as `"un tracked.txt"`, quotes and all.
	it("keeps a path containing a space, unquoted", () => {
		const { files } = parseStatus(REAL);
		expect(files.find((f) => f.path === "un tracked.txt")?.state).toBe("untracked");
	});

	it("reads the branch header out of the same stream", () => {
		expect(parseStatus(REAL).branch).toEqual({
			branch: "main",
			upstream: "",
			ahead: null,
			behind: null,
		});
	});

	it("answers a clean tree with no files rather than throwing", () => {
		expect(parseStatus("## main...origin/main\0").files).toEqual([]);
	});
});

describe("parseNumstat", () => {
	// Captured from `git diff --numstat -z --no-renames HEAD` on the same repo.
	const REAL = "1\t0\tkeep.txt\x001\t0\tnew.txt\x000\t1\told.txt\x00";

	it("reads the counts per path", () => {
		const churn = parseNumstat(REAL);
		expect(churn.get("keep.txt")).toEqual({ additions: 1, deletions: 0 });
		expect(churn.get("old.txt")).toEqual({ additions: 0, deletions: 1 });
	});

	// A binary file reports "-". Coercing that to 0 would claim it changed by
	// nothing, which is a different fact from "this change is not countable".
	it("leaves a binary file's counts absent", () => {
		expect(parseNumstat("-\t-\tlogo.png\0").get("logo.png")).toEqual({});
	});

	it("keeps a tab inside a path", () => {
		expect(parseNumstat("2\t3\tweird\tname.ts\0").get("weird\tname.ts")).toEqual({
			additions: 2,
			deletions: 3,
		});
	});
});

// `srt` masks project-local config it will not let the agent read by writing
// EMPTY, READ-ONLY placeholders into the checkout. The fixtures below are the
// real thing, measured on a launched worktree
// (hive__worktrees/agents-hive-756fab19, 2026-08-08):
//
//   -r--r--r-- 0 .bashrc  .zshrc  .profile  .zprofile  .bash_profile
//   -r--r--r-- 0 .gitconfig  .gitmodules  .mcp.json  .ripgreprc  .idea  .vscode
//   -rw------- 832 .hive-sandbox.json
//
// Twelve untracked rows on a session that had changed nothing.
describe("isSandboxMask", () => {
	const root = mkdtempSync(join(tmpdir(), "hive-mask-"));
	beforeAll(() => {
		writeFileSync(join(root, ".hive-sandbox.json"), '{"filesystem":{}}', { mode: 0o600 });
		writeFileSync(join(root, ".bashrc"), "");
		chmodSync(join(root, ".bashrc"), 0o444);
		writeFileSync(join(root, "notes.md"), "real work\n");
		writeFileSync(join(root, "empty.ts"), "");
		writeFileSync(join(root, "readonly.ts"), "locked but not empty\n");
		chmodSync(join(root, "readonly.ts"), 0o444);
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("reads an empty read-only placeholder as a mask", () => {
		expect(isSandboxMask(root, ".bashrc")).toBe(true);
	});

	// The config is not a placeholder — it has content and mode 0600 — but it is
	// the launch's own file and no more the agent's work than the masks are.
	it("reads the launch's own sandbox config as a mask", () => {
		expect(isSandboxMask(root, ".hive-sandbox.json")).toBe(true);
	});

	// BOTH halves of the test have to hold. An empty file the agent created is
	// real work it has not written yet; a read-only file with content is real
	// work someone locked. Either one alone would hide the agent's own files.
	it("keeps a file that is only empty, or only read-only", () => {
		expect(isSandboxMask(root, "empty.ts")).toBe(false);
		expect(isSandboxMask(root, "readonly.ts")).toBe(false);
		expect(isSandboxMask(root, "notes.md")).toBe(false);
	});

	// A path that vanished between `git status` and this stat. Not-a-mask keeps
	// a row that may be real rather than hiding one that is.
	it("keeps a path it cannot stat", () => {
		expect(isSandboxMask(root, "gone.ts")).toBe(false);
	});
});
