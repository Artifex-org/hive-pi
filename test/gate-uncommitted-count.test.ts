import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { uncommittedCount } from "../extensions/gate/index.ts";

// The counter is the half of this fix that can be silently wrong: `render` only
// decides what to SAY about a number, and every render test hands it one. If
// `uncommittedCount` miscounts — or returns 0 where it should return undefined —
// the message confidently gives the advice it was written to stop giving.
//
// So it is tested against real `git status --porcelain` output in real
// repositories, not a stub. A stub would agree with whatever I assumed the
// porcelain format was, which is exactly the assumption under test.

const run = promisify(execFile);

let clean: string;
let dirty: string;
let notARepo: string;

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "gate-uncommitted-"));

	clean = join(root, "clean");
	dirty = join(root, "dirty");
	notARepo = join(root, "plain");

	for (const dir of [clean, dirty]) {
		await run("git", ["init", "-q", dir]);
		await writeFile(join(dir, "tracked.txt"), "one\n");
		await run("git", ["-C", dir, "add", "."]);
		await run("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
	}

	// Three shapes of "uncommitted", because porcelain reports them differently:
	// a modification to a tracked file, a staged addition, and an untracked file.
	await writeFile(join(dirty, "tracked.txt"), "two\n");
	await writeFile(join(dirty, "staged.txt"), "s\n");
	await run("git", ["-C", dirty, "add", "staged.txt"]);
	await writeFile(join(dirty, "untracked.txt"), "u\n");

	await mkdtemp(join(root, "x-")); // ensure root exists before the plain dir
	await run("git", ["init", "-q", notARepo]); // create then make it non-git below
});

describe("uncommittedCount", () => {
	it("counts nothing in a clean checkout", async () => {
		expect(await uncommittedCount(clean)).toBe(0);
	});

	// The number reaches the agent as "N uncommitted paths", so it has to be the
	// number a human would get from `git status --short` — modified, staged and
	// untracked all included, because all three are work the gate did not see.
	it("counts modified, staged and untracked paths alike", async () => {
		expect(await uncommittedCount(dirty)).toBe(3);
	});

	// Undefined, NOT 0. Zero means "I looked and the tree is clean", which
	// re-selects the wrong-checkout advice this whole change exists to suppress.
	// A directory that is not a repository has to be indistinguishable from
	// "could not tell".
	it("returns undefined rather than 0 when it cannot tell", async () => {
		const nowhere = join(tmpdir(), "gate-uncommitted-does-not-exist-9e7c");
		expect(await uncommittedCount(nowhere)).toBeUndefined();
	});

	// It runs on a path the agent is already waiting on. Throwing there would
	// replace a useful message with no message at all.
	it("never throws, whatever it is handed", async () => {
		await expect(uncommittedCount("")).resolves.toBeTypeOf("undefined");
		await expect(uncommittedCount("/proc/1/mem")).resolves.toBeTypeOf("undefined");
	});

	// An aborted gate call must not leave a git subprocess behind it.
	it("resolves when the caller aborts", async () => {
		const ac = new AbortController();
		const p = uncommittedCount(dirty, ac.signal);
		ac.abort();
		await expect(p).resolves.toBeTypeOf("undefined");
	});
});
