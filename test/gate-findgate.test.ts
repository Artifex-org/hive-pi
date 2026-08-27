/**
 * findGate must return something SPAWNABLE.
 *
 * The bug these tests pin: `access(path, X_OK)` succeeds on a directory,
 * because for a directory the execute bit means "searchable". One of the
 * candidate names is bare `quality-gate`, which is also the name of the gate's
 * own checkout — so an agent anywhere under `~/repos` walked its ancestors,
 * matched the `~/repos/quality-gate` CLONE, and handed a directory to spawn.
 *
 * The observed failure was `env: '/home/dev/repos/quality-gate': Permission
 * denied` (exit 126), reported by 7 separate agents in one day, each of which
 * then shipped without running the gate at all.
 */
import { mkdtemp, mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { findGate } from "../extensions/gate/index.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "findgate-"));
});

/** An executable regular file, i.e. a real gate. */
async function realGate(at: string) {
	await mkdir(join(at, ".."), { recursive: true }).catch(() => {});
	await writeFile(at, "#!/bin/sh\nexit 0\n");
	await chmod(at, 0o755);
}

describe("findGate", () => {
	it("skips a DIRECTORY named like the gate and keeps searching upwards", async () => {
		// ~/repos/quality-gate — a checkout, not a binary. This is the exact
		// shape that produced the exit-126 papercuts.
		const repos = join(root, "repos");
		await mkdir(join(repos, "quality-gate"), { recursive: true });
		const cwd = join(repos, "hive__worktrees", "agents-hive-1234");
		await mkdir(cwd, { recursive: true });

		expect(await findGate(cwd)).toBeNull();
	});

	it("still finds a real gate ABOVE the decoy directory", async () => {
		// The decoy must not terminate the walk — a genuine gate further up has
		// to remain reachable, or the fix would trade a crash for a miss.
		const repos = join(root, "repos");
		await mkdir(join(repos, "quality-gate"), { recursive: true });
		const cwd = join(repos, "proj", "sub");
		await mkdir(cwd, { recursive: true });
		await realGate(join(root, "quality-gate"));

		expect(await findGate(cwd)).toBe(join(root, "quality-gate"));
	});

	it("finds a vendored gate, nearest first", async () => {
		const cwd = join(root, "proj", "sub");
		await mkdir(join(root, "proj", "vendor", "quality-gate"), { recursive: true });
		await mkdir(cwd, { recursive: true });
		await realGate(join(root, "proj", "vendor", "quality-gate", "quality-gate"));
		await realGate(join(root, "quality-gate"));

		// Vendored beats installed: a repo pins its gate deliberately.
		expect(await findGate(cwd)).toBe(join(root, "proj", "vendor", "quality-gate", "quality-gate"));
	});

	it("accepts a SYMLINK to an executable file", async () => {
		// Gates are commonly symlinks into a vendored checkout. stat() follows
		// links on purpose, so this must still resolve.
		const cwd = join(root, "proj");
		await mkdir(cwd, { recursive: true });
		await realGate(join(root, "real-gate"));
		await symlink(join(root, "real-gate"), join(cwd, "quality-gate"));

		expect(await findGate(cwd)).toBe(join(cwd, "quality-gate"));
	});

	it("skips a non-executable regular file", async () => {
		const cwd = join(root, "proj");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "quality-gate"), "not executable");
		await chmod(join(cwd, "quality-gate"), 0o644);

		expect(await findGate(cwd)).toBeNull();
	});
});
