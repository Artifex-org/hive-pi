/**
 * A pager in an agent's command tree is a hang with a name.
 *
 * `less` never blocks in `read(0)` — it waits in the poll/select family on the
 * terminal, and those syscalls are excluded from the proven tier on purpose, so
 * the commonest hang of all used to land in the weak `quiet` tier that only
 * describes. Measured 2026-08-29 on a pyERP session: `git diff --stat` opened
 * `less` under the pty and the tool call sat for 25 minutes, taking the turn —
 * and every steer queued behind it — with it (HIV-3053).
 */

import { describe, expect, it } from "vitest";

import {
	type ProcSnapshot,
	classify,
	describeVerdict,
} from "../extensions/pty-exec/stdinWatch.ts";

function proc(p: Partial<ProcSnapshot> & { pid: number }): ProcSnapshot {
	return {
		comm: "sh",
		state: "S",
		syscall: null,
		arg0: null,
		fd0: null,
		children: [],
		...p,
	};
}

/** The tree as measured: git waiting on its pager, the pager waiting on a human. */
const pagedDiff: ProcSnapshot[] = [
	proc({
		pid: 3177571,
		comm: "script",
		syscall: 7,
		arg0: 0x7ffd,
		fd0: "/dev/pts/4",
	}),
	proc({ pid: 3177572, comm: "zsh", syscall: 61, arg0: -1, fd0: "/dev/pts/4" }),
	proc({ pid: 3177638, comm: "git", syscall: 61, arg0: -1, fd0: "/dev/pts/4" }),
	proc({
		pid: 3177640,
		comm: "less",
		syscall: 7,
		arg0: 0x7ffc,
		fd0: "/dev/pts/4",
	}),
];

describe("the pager tier", () => {
	it("names the pager, where the syscall tiers see only a quiet tree", () => {
		const verdict = classify(pagedDiff, 25 * 60_000, "x64");

		expect(verdict).toEqual({
			kind: "pager",
			quietMs: 25 * 60_000,
			pid: 3177640,
			comm: "less",
		});
	});

	it("says what is wrong and that nobody can fix it by waiting", () => {
		expect(describeVerdict(classify(pagedDiff, 30_000, "x64"))).toBe(
			"no output for 30s — pid 3177640 (less) is waiting for a keypress and nothing here can type.",
		);
	});

	// The same debounce every tier gets: a pager that has just been drawn is
	// still producing output, and output is what resets the quiet clock.
	it("holds off until the tree has been quiet as long as any other verdict", () => {
		expect(classify(pagedDiff, 1_000, "x64")).toEqual({ kind: "working" });
	});

	// The false positive that would be worse than the bug: ending a command that
	// was doing its job.
	it("leaves a working editor alone — a name is not a verdict", () => {
		const headless = [
			proc({ pid: 10, comm: "zsh", syscall: 61, arg0: -1, fd0: "/dev/pts/4" }),
			proc({
				pid: 11,
				comm: "nvim",
				state: "R",
				syscall: null,
				arg0: null,
				fd0: "/dev/pts/4",
			}),
		];

		expect(classify(headless, 25 * 60_000, "x64").kind).not.toBe("pager");
	});

	// Proof it does not steal the stronger claim: a read-blocked leaf is still
	// reported as blocked, which is the verdict the auto-EOF acts on.
	it("does not shadow a proven stdin block", () => {
		const readBlocked = [
			proc({ pid: 20, comm: "zsh", syscall: 61, arg0: -1, fd0: "/dev/pts/4" }),
			proc({
				pid: 21,
				comm: "cat",
				state: "S",
				syscall: 0,
				arg0: 0,
				fd0: "/dev/pts/4",
			}),
		];

		expect(classify(readBlocked, 30_000, "x64").kind).toBe("blocked");
	});
});
