/**
 * The detector's whole value is that it does not cry wolf. A false "blocked on
 * stdin" on a long compile would train everyone to ignore the signal, so most
 * of these tests are about what must NOT be classified as blocked.
 *
 * The fixtures are real: the sandbox tree is the ten-process snapshot measured
 * on 2026-08-26 by walking a live `srt` launch, syscall numbers included.
 */

import { describe, expect, it } from "vitest";

import {
	type ProcSnapshot,
	StdinWatch,
	classify,
	describeVerdict,
	readTree,
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

/** The command leaf as measured: blocked in read(0) on its pty. */
const blockedLeaf = proc({ pid: 888972, comm: "bash", state: "S", syscall: 0, arg0: 0, fd0: "/dev/pts/0" });

/**
 * The real ten-process tree from a live srt launch. Every non-leaf entry is
 * scaffolding that must be excluded — and each is excluded by a DIFFERENT
 * syscall, which is why the read-family list has to be exact.
 */
const realSandboxTree: ProcSnapshot[] = [
	proc({ pid: 887991, comm: "node", syscall: 281, arg0: 0xf, fd0: "pipe:[280251223]" }), // epoll_pwait
	proc({ pid: 888912, comm: "bwrap", syscall: 7, arg0: 0x7fff1f0fa500, fd0: "pipe:[280251223]" }), // poll
	proc({ pid: 888925, comm: "bwrap", syscall: 61, arg0: -1, fd0: "pipe:[280251223]" }), // wait4
	proc({ pid: 888939, comm: "bash", syscall: 61, arg0: -1, fd0: "pipe:[280251223]" }),
	proc({ pid: 888955, comm: "node", syscall: 61, arg0: 0x6, fd0: "pipe:[280251223]" }),
	proc({ pid: 888960, comm: "bwrap", syscall: null, arg0: null, fd0: null }), // unreadable (setuid)
	proc({ pid: 888961, comm: "script", syscall: 7, arg0: 0x7ffd6a45e540, fd0: "pipe:[280251223]" }),
	blockedLeaf,
	proc({ pid: 888952, comm: "socat", syscall: 270, arg0: 0x6, fd0: "/dev/null" }), // pselect6
	proc({ pid: 888951, comm: "socat", syscall: 270, arg0: 0x6, fd0: "/dev/null" }),
];

describe("classify — the proven tier", () => {
	it("finds the one blocked leaf in a real ten-process sandbox tree", () => {
		const v = classify(realSandboxTree, 6_000, "x64");
		expect(v.kind).toBe("blocked");
		if (v.kind !== "blocked") return;
		expect(v.pid).toBe(888972);
		expect(v.fd0).toBe("/dev/pts/0");
	});

	it("says nothing before the proven threshold, however clear the signal", () => {
		expect(classify([blockedLeaf], 4_999, "x64").kind).toBe("working");
		expect(classify([blockedLeaf], 5_000, "x64").kind).toBe("blocked");
	});

	it("accepts a pipe as well as a pty", () => {
		const piped = proc({ pid: 5, syscall: 0, arg0: 0, fd0: "pipe:[99]" });
		expect(classify([piped], 6_000, "x64").kind).toBe("blocked");
	});

	it("refuses to claim blocked on an architecture whose syscall numbers it does not know", () => {
		expect(classify([blockedLeaf], 6_000, "mips" as string).kind).toBe("working");
		// …and still reaches the weak tier, which needs no syscall table.
		expect(classify([blockedLeaf], 200_000, "mips" as string).kind).toBe("quiet");
	});

	it("uses the arm64 numbering on arm64", () => {
		const arm = proc({ pid: 7, syscall: 63, arg0: 0, fd0: "/dev/pts/1" });
		expect(classify([arm], 6_000, "arm64").kind).toBe("blocked");
		// 63 is not a read on x64, so the same tree must not be blocked there.
		expect(classify([arm], 6_000, "x64").kind).toBe("working");
	});

	/**
	 * The gap that a hand-written syscall list produces, caught by a live run:
	 * GNU `cat` blocks in splice(0, …), not read. `cat` is precisely the command
	 * the auto-EOF exists to rescue, so a table without splice is blind to the
	 * most common accidental hang. Numbers measured per tool on 2026-08-26.
	 */
	it.each([
		["cat (splice)", 275, "x64"],
		["bash read", 0, "x64"],
		["head/sort/wc", 0, "x64"],
		["readv", 19, "x64"],
		["cat on arm64", 76, "arm64"],
	])("recognises %s as blocked", (_label, syscall, arch) => {
		const p = proc({ pid: 9, syscall, arg0: 0, fd0: "/dev/pts/3" });
		expect(classify([p], 6_000, arch).kind).toBe("blocked");
	});
});

describe("classify — what must never be called blocked", () => {
	// The acceptance criterion for the whole feature.
	it("never flags a long silent compile", () => {
		const compiling = [
			proc({ pid: 1, comm: "make", state: "S", syscall: 61, arg0: 2, fd0: "/dev/null" }),
			proc({ pid: 2, comm: "cc1", state: "R", syscall: null, fd0: "/dev/null" }),
		];
		expect(classify(compiling, 600_000, "x64").kind).toBe("working");
	});

	it("never flags a poller — its fd set is behind a pointer /proc does not deref", () => {
		// arg0 is a pointer that happens to be 0 would still not be a read, but
		// the syscall check is what actually excludes it.
		const poller = proc({ pid: 3, comm: "git", state: "S", syscall: 7, arg0: 0, fd0: "/dev/pts/0" });
		expect(classify([poller], 60_000, "x64").kind).toBe("working");
	});

	it("never flags a process waiting on a CHILD rather than on input", () => {
		const waiting = proc({ pid: 4, comm: "npm", state: "S", syscall: 61, arg0: 0, fd0: "/dev/pts/0" });
		expect(classify([waiting], 60_000, "x64").kind).toBe("working");
	});

	it("never flags a read on an fd that is not stdin", () => {
		const readingAFile = proc({ pid: 5, syscall: 0, arg0: 3, fd0: "/dev/pts/0" });
		expect(classify([readingAFile], 60_000, "x64").kind).toBe("working");
	});

	it("never flags a read whose stdin a human could not type into", () => {
		const fromFile = proc({ pid: 6, syscall: 0, arg0: 0, fd0: "/home/dev/input.txt" });
		expect(classify([fromFile], 60_000, "x64").kind).toBe("working");
	});

	it("treats an unreadable process as not blocked", () => {
		const unreadable = proc({ pid: 7, syscall: null, arg0: null, fd0: null });
		expect(classify([unreadable], 60_000, "x64").kind).toBe("working");
	});
});

describe("classify — the quiet tier", () => {
	it("asks a question when everything sleeps for a long time", () => {
		const sleeping = [proc({ pid: 1, state: "S", syscall: 35, fd0: "/dev/null" })];
		expect(classify(sleeping, 119_000, "x64").kind).toBe("working");
		expect(classify(sleeping, 121_000, "x64").kind).toBe("quiet");
	});

	it("stays silent while ANY process in the tree is running or in uninterruptible IO", () => {
		for (const state of ["R", "D"]) {
			const tree = [proc({ pid: 1, state: "S" }), proc({ pid: 2, state })];
			expect(classify(tree, 600_000, "x64").kind).toBe("working");
		}
	});

	it("prefers the proven verdict over the quiet one", () => {
		expect(classify([blockedLeaf], 600_000, "x64").kind).toBe("blocked");
	});
});

describe("readTree", () => {
	it("walks descendants and survives a cycle", () => {
		const snaps = new Map<number, ProcSnapshot>([
			[1, proc({ pid: 1, children: [2, 3] })],
			[2, proc({ pid: 2, children: [1] })], // a cycle /proc cannot really produce
			[3, proc({ pid: 3, children: [] })],
		]);
		const tree = readTree(1, { read: (pid) => snaps.get(pid) ?? null });
		expect(tree.map((p) => p.pid).sort()).toEqual([1, 2, 3]);
	});

	it("is bounded, so a fork bomb cannot make the detector the problem", () => {
		const reader = { read: (pid: number) => proc({ pid, children: [pid * 2, pid * 2 + 1] }) };
		expect(readTree(1, reader, 32)).toHaveLength(32);
	});

	it("skips a process that vanished mid-walk", () => {
		const snaps = new Map<number, ProcSnapshot>([[1, proc({ pid: 1, children: [2] })]]);
		expect(readTree(1, { read: (pid) => snaps.get(pid) ?? null }).map((p) => p.pid)).toEqual([1]);
	});
});

describe("StdinWatch", () => {
	function harness(tree: ProcSnapshot[]) {
		let now = 1_000_000;
		const seen: string[] = [];
		const reader = {
			read: (pid: number) => tree.find((p) => p.pid === pid) ?? null,
		};
		const watch = new StdinWatch(tree[0]!.pid, reader, (v) => seen.push(v.kind), {
			now: () => now,
			renotifyMs: 30_000,
		});
		return { watch, seen, advance: (ms: number) => void (now += ms) };
	}

	it("notifies once on the transition, not on every tick", () => {
		const { watch, seen, advance } = harness([blockedLeaf]);
		advance(6_000);
		watch.tick();
		watch.tick();
		watch.tick();
		expect(seen).toEqual(["blocked"]);
	});

	it("re-notifies only after the renotify interval", () => {
		const { watch, seen, advance } = harness([blockedLeaf]);
		advance(6_000);
		watch.tick();
		advance(29_000);
		watch.tick();
		expect(seen).toEqual(["blocked"]);
		advance(2_000);
		watch.tick();
		expect(seen).toEqual(["blocked", "blocked"]);
	});

	// A note that keeps claiming the command is stuck after it resumed is worse
	// than no note at all.
	it("retracts the claim as soon as output arrives", () => {
		const { watch, seen, advance } = harness([blockedLeaf]);
		advance(6_000);
		watch.tick();
		expect(seen).toEqual(["blocked"]);
		watch.noteOutput();
		expect(seen).toEqual(["blocked", "working"]);
		expect(watch.verdict().kind).toBe("working");
	});

	it("restarts its quiet clock on output", () => {
		const { watch, seen, advance } = harness([blockedLeaf]);
		advance(4_000);
		watch.noteOutput();
		advance(4_000); // 8s total, but only 4s since output
		watch.tick();
		expect(seen).toEqual([]);
	});
});

describe("describeVerdict", () => {
	it("names the pid, the command and the terminal", () => {
		const note = describeVerdict({ kind: "blocked", quietMs: 7_000, pid: 21877, comm: "npm", fd0: "/dev/pts/4" });
		expect(note).toBe("no output for 7s — pid 21877 (npm) is blocked reading stdin on /dev/pts/4.");
	});

	it("phrases the weak tier as a question", () => {
		expect(describeVerdict({ kind: "quiet", quietMs: 120_000 })).toContain("?");
	});

	it("says nothing while working", () => {
		expect(describeVerdict({ kind: "working" })).toBeNull();
	});
});
