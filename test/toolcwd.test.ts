/**
 * `bash` now DECLARES `cwd` (see `pretty-tools.ts`), so the rules here are no
 * longer about repairing an argument pi drops — they are the rules the tool
 * itself runs on, plus what to do with the two spellings nothing declares.
 *
 * The history is still the reason the file exists. For eleven papercuts in 48
 * hours (2026-08-17/18) a `cwd` was accepted and thrown away, and the failures
 * were not cosmetic: an unexecuted negative control read as a pass, a `ruff
 * format` reported on another worktree's files, a `git status` answered about
 * the wrong branch and was filed as a bug against the wrong component. Thirty
 * more followed over 2026-08-21..28, seven of them spelled `workdir` — which
 * got no repair and no note at all, so a `git cherry-pick` landed on the wrong
 * checkout and said nothing.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { repairBashCwd, shellQuote } from "../extensions/toolcwd/cwd.ts";

describe("repairBashCwd", () => {
	it("relocates a command that named a directory", () => {
		const repair = repairBashCwd({ command: "uv run pytest tests/", cwd: "/home/dev/.hive/scratch/s/asf-3685" });
		expect(repair.command).toBe("cd '/home/dev/.hive/scratch/s/asf-3685' && uv run pytest tests/");
		// `cwd` is a declared parameter now, so honouring it is not news.
		expect(repair.note).toBeNull();
	});

	/**
	 * A working-directory parameter means the command's own relative paths
	 * resolve against it, and that includes a relative `cd`. `cd '/x' && cd sub`
	 * lands in `/x/sub`, which is what the caller asked for; refusing to prefix
	 * would land in `<session>/sub`, which is not. An absolute inner `cd` wins
	 * either way, so nothing is lost.
	 */
	it("prefixes a declared cwd even when the command begins with cd", () => {
		const repair = repairBashCwd({ command: "cd sub && ls", cwd: "/x" });
		expect(repair.command).toBe("cd '/x' && cd sub && ls");
		expect(repair.note).toBeNull();
	});

	/**
	 * `workdir` is a guess about intent rather than a declared parameter, so it
	 * is honoured AND reported: seven papercuts passed it, got no rewrite and no
	 * word about it, and read the answer from the wrong tree as the truth.
	 */
	it("honours the spellings nothing declares, and says so", () => {
		for (const key of ["workdir", "dir"]) {
			const repair = repairBashCwd({ command: "git status", [key]: "/x" });
			expect(repair.command).toBe("cd '/x' && git status");
			expect(repair.note).toContain("`cwd`");
			expect(repair.note).toContain(`\`${key}\``);
		}
	});

	// For a guessed key the conservative rule stands: `cd a && cd b` lands in
	// `a/b` when b is relative, and nothing declared that this was a directory.
	it("never prefixes a guessed key onto a command that already begins with cd", () => {
		for (const command of ["cd /elsewhere && ls", "  cd /elsewhere && ls", "(cd /elsewhere && ls)"]) {
			const repair = repairBashCwd({ command, workdir: "/somewhere" });
			expect(repair.command).toBeNull();
			expect(repair.note).toContain("already began with `cd`");
		}
	});

	it("prefers the declared key when a call carries both", () => {
		const repair = repairBashCwd({ command: "ls", cwd: "/declared", workdir: "/guessed" });
		expect(repair.command).toBe("cd '/declared' && ls");
		expect(repair.note).toBeNull();
	});

	it("stays out of the way when there is nothing to honour", () => {
		expect(repairBashCwd({ command: "ls" }).command).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: "" }).command).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: "   " }).command).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: 7 }).command).toBeNull();
		expect(repairBashCwd({ cwd: "/somewhere" }).command).toBeNull();
		expect(repairBashCwd(undefined).command).toBeNull();
		expect(repairBashCwd({ command: "ls", workdir: "" }).note).toBeNull();
	});

	// A worktree path is attacker-free but not shell-free, and the failure mode
	// of quoting it wrong is a command that runs somewhere else — the exact bug.
	it("quotes a directory the shell would otherwise split or eat", () => {
		expect(shellQuote("/a/b c")).toBe("'/a/b c'");
		// The POSIX form is close-quote, escaped-quote, reopen. NOT a backslash
		// inside the quotes: single quotes have no escapes in sh, so `'it\'s'`
		// would end the string early and hand `cd` a different path — the exact
		// class of failure this file exists to prevent.
		expect(shellQuote("/a/it's")).toBe("'/a/it'\\''s'");
		const repair = repairBashCwd({ command: "ls", cwd: "/a/b c" });
		expect(repair.command).toBe("cd '/a/b c' && ls");
	});

	// The property that actually matters, checked against a real shell rather
	// than against my idea of one.
	it("survives a round trip through sh", () => {
		for (const dir of ["/a/b c", "/a/it's", "/a/$HOME", "/a/b;rm -rf x", "/a/*"]) {
			const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(dir)}`], { encoding: "utf8" });
			expect(out).toBe(dir);
		}
	});
});
