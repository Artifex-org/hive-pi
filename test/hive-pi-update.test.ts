import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../workstation/.local/bin/hive-pi-update");
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A PATH holding fake `mise`, `npm` and `pi`, and a log of what got called.
 *
 * Not a convenience. The updater upgrades the pi BINARY on every tick, so
 * without this the suite runs the operator's real `mise upgrade pi` and
 * `npm i -g` — a network round-trip inside a 5s test budget (it timed out under
 * the full suite's parallelism), and, far worse, a test that silently upgrades
 * the machine it is running on.
 *
 * `pi` is planted at the layout the script matches on, so the npm branch is
 * genuinely exercised rather than skipped.
 */
function stubTools(home: string): { bin: string; log: string } {
	const bin = join(home, "stubbin");
	const prefix = join(home, "npm-global");
	const pkg = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist");
	const log = join(home, "tool-calls.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
	for (const name of ["mise", "npm"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n`, { mode: 0o755 });
	}
	symlinkSync(join(pkg, "cli.js"), join(bin, "pi"));
	return { bin, log };
}

function runUpdater(home: string, extraPath?: string, overlay = ""): void {
	execFileSync(SCRIPT, [], {
		env: {
			...process.env,
			HOME: home,
			XDG_STATE_HOME: join(home, "state"),
			// And the CONFIG home, or this inherits the machine's and sources its
			// real update.env — which names the operator's live checkouts. The
			// script prefers an explicit HIVE_PI_* over the file now, so this is
			// belt and braces; both halves are cheap and the failure mode they
			// prevent is a unit test mutating the machine it runs on.
			// And the CONFIG home, or this inherits the machine's and sources its
			// real update.env — which names the operator's live checkouts. The
			// script prefers an explicit HIVE_PI_* over the file now, so this is
			// belt and braces; both halves are cheap and the failure mode they
			// prevent is a unit test mutating the machine it runs on.
			XDG_CONFIG_HOME: join(home, "config"),
			HIVE_PI_BASE: join(home, "repos/hive-pi__worktrees/main"),
			HIVE_PI_OVERLAY: overlay,
			// REPLACED, not prepended. Inheriting the operator's PATH puts their
			// real pi installs in `type -a -P pi`, so the updater would enumerate
			// (and, with a real npm, upgrade) them from inside a unit test.
			...(extraPath ? { PATH: `${extraPath}:/usr/bin:/bin` } : {}),
		},
		stdio: "pipe",
	});
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-update-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const source = join(root, "source");
	git(root, "init", "--bare", origin);
	git(root, "clone", origin, source);
	git(source, "config", "user.email", "test@example.invalid");
	git(source, "config", "user.name", "test");
	git(source, "checkout", "-b", "main");
	mkdirSync(join(source, "workstation/.pi/agent"), { recursive: true });
	// settings.DEFAULT.json, which is what the base actually tracks since the
	// HIV-2792 split — it is a stow-ignored template, and the real settings.json
	// lives in the overlay. The fixture used to plant settings.json here, so the
	// suite was green against a layout no machine has had since the split, and
	// the updater's `git checkout -- …/settings.json` looked exercised while on
	// a real machine it exited 1 and aborted every update.
	writeFileSync(join(source, "workstation/.pi/agent/settings.default.json"), '{"theme":"{{HIVE_PI_ROOT}}"}\n');
	writeFileSync(join(source, "README"), "base\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "base");
	git(source, "push", "-u", "origin", "main");
	return { root, origin, source };
}

/**
 * A second origin + checkout standing in for the private overlay, tracking the
 * settings.json the base no longer does. `harness install` symlinks this file
 * into ~/.pi/agent, so pi writes through the link and dirties this checkout.
 */
function overlayFixture(root: string, name: string) {
	const origin = join(root, `${name}-origin.git`);
	const source = join(root, `${name}-source`);
	const work = join(root, `${name}-work`);
	git(root, "init", "--bare", origin);
	git(root, "clone", origin, source);
	git(source, "config", "user.email", "test@example.invalid");
	git(source, "config", "user.name", "test");
	git(source, "checkout", "-b", "main");
	mkdirSync(join(source, "workstation/.pi/agent"), { recursive: true });
	writeFileSync(join(source, "workstation/.pi/agent/settings.json"), '{"lastChangelogVersion":"base"}\n');
	// A second TRACKED file. `git diff HEAD` does not see untracked ones, so a
	// "real local work" case that edited an untracked path would slip past the
	// guard and prove nothing.
	writeFileSync(join(source, "README.md"), "overlay\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "overlay base");
	git(source, "push", "-u", "origin", "main");
	git(root, "clone", "-b", "main", origin, work);
	return { origin, source, work };
}

/** Advance the overlay's origin so the checkout has something to fast-forward to. */
function advanceOverlay(source: string) {
	writeFileSync(join(source, "ROLE"), "new agent role\n");
	git(source, "add", "ROLE");
	git(source, "commit", "-m", "advance overlay");
	git(source, "push");
}

function checkout(root: string, origin: string, name: string) {
	const home = join(root, name);
	const repo = join(home, "repos/hive-pi__worktrees/main");
	mkdirSync(join(home, "repos/hive-pi__worktrees"), { recursive: true });
	git(root, "clone", "-b", "main", origin, repo);
	mkdirSync(join(home, "state/hive-pi-update"), { recursive: true });
	return { home, repo };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("hive-pi-update", () => {
	// THE REGRESSION. On the post-split layout the base tracks no settings.json,
	// and the reset that stayed behind — `git checkout -- …/settings.json` —
	// exits 1 on a pathspec git does not know. Under `set -Eeuo pipefail` that
	// aborted the whole updater, but only inside the "upstream is strictly
	// ahead" branch: every quiet tick passed, so it fired on the FIRST real
	// update after the split and stranded 26 merged commits.
	it("fast-forwards a behind checkout", () => {
		const { root, origin, source } = fixture();
		const { home, repo } = checkout(root, origin, "behind");
		writeFileSync(join(source, "README"), "advanced\n");
		git(source, "add", "README");
		git(source, "commit", "-m", "advance");
		git(source, "push");
		git(repo, "fetch", "origin", "main");
		writeFileSync(join(home, "state/hive-pi-update/activated-revision"), `${git(repo, "rev-parse", "origin/main")}\n`);
		runUpdater(home, stubTools(home).bin);
		expect(git(repo, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/main"));
		expect(readFileSync(join(repo, "README"), "utf8")).toContain("advanced");
	});

	// The guard the removal above must not have weakened: real local work in the
	// base still stops the update rather than being fast-forwarded over.
	it("refuses to update a base checkout carrying local work", () => {
		const { root, origin, source } = fixture();
		const { home, repo } = checkout(root, origin, "dirty");
		writeFileSync(join(source, "README"), "advanced\n");
		git(source, "add", "README");
		git(source, "commit", "-m", "advance");
		git(source, "push");
		writeFileSync(join(repo, "README"), "someone was editing this\n");
		const before = git(repo, "rev-parse", "HEAD");
		expect(() => runUpdater(home, stubTools(home).bin)).toThrow();
		expect(git(repo, "rev-parse", "HEAD")).toBe(before);
		expect(readFileSync(join(home, "state/hive-pi-update/last-run"), "utf8")).toContain("failed");
	});

	it("preserves an ahead checkout and reports its own revision as available", () => {
		const { root, origin } = fixture();
		const { home, repo } = checkout(root, origin, "ahead");
		git(repo, "config", "user.email", "test@example.invalid");
		git(repo, "config", "user.name", "test");
		writeFileSync(join(repo, "LOCAL"), "ahead\n");
		git(repo, "add", "LOCAL");
		git(repo, "commit", "-m", "ahead");
		const head = git(repo, "rev-parse", "HEAD");
		writeFileSync(join(home, "state/hive-pi-update/activated-revision"), `${head}\n`);
		runUpdater(home, stubTools(home).bin);
		expect(readFileSync(join(home, "state/hive-pi-update/available-revision"), "utf8").trim()).toBe(head);
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
	});

	// Pi releases on its OWN schedule, so the binary update runs on every tick —
	// BEFORE the "nothing new in hive-pi" early return, not after it. Placing it
	// after was the first version of the change and it reproduced the original
	// bug: a quiet hive-pi week would leave the binary drifting behind its
	// extensions while the unit reported `ok` every seventeen minutes.
	it("upgrades the pi binary even when hive-pi has nothing new", () => {
		const { root, origin } = fixture();
		const { home, repo } = checkout(root, origin, "current");
		writeFileSync(
			join(home, "state/hive-pi-update/activated-revision"),
			`${git(repo, "rev-parse", "HEAD")}\n`,
		);
		const { bin, log } = stubTools(home);
		runUpdater(home, bin);

		// The early return was taken — this is the quiet path, not the activate one.
		expect(readFileSync(join(home, "state/hive-pi-update/last-run"), "utf8")).toContain("already at");
		const calls = readFileSync(log, "utf8");
		expect(calls).toContain("mise upgrade pi");
		// ...and in the prefix the resolved binary actually lives in, not npm's
		// default, which on the measured machine was /usr/lib and needs root.
		expect(calls).toContain(`npm i -g --prefix ${join(home, "npm-global")} @earendil-works/pi-coding-agent@latest`);
	});

	describe("the overlay", () => {
		// ~/.pi/agent/settings.json is a symlink into the overlay, so pi stamping
		// its changelog marker leaves that checkout dirty forever. Before this,
		// the guard read that as local work and declined every overlay update for
		// the life of the machine — reporting it only as a parenthetical inside a
		// run line that still began with `ok`.
		it("fast-forwards when the only dirt is Pi's changelog marker", () => {
			const { root, origin } = fixture();
			const { home, repo } = checkout(root, origin, "overlay-ok");
			const ov = overlayFixture(root, "ov-ok");
			advanceOverlay(ov.source);
			writeFileSync(
				join(ov.work, "workstation/.pi/agent/settings.json"),
				'{"lastChangelogVersion":"pi-wrote-this"}\n',
			);
			writeFileSync(join(home, "state/hive-pi-update/activated-revision"), `${git(repo, "rev-parse", "HEAD")}\n`);
			runUpdater(home, stubTools(home).bin, ov.work);

			expect(git(ov.work, "rev-parse", "HEAD")).toBe(git(ov.work, "rev-parse", "origin/main"));
			expect(readFileSync(join(ov.work, "ROLE"), "utf8")).toContain("new agent role");
			const run = readFileSync(join(home, "state/hive-pi-update/last-run"), "utf8");
			expect(run).not.toContain("left alone");
			expect(run).not.toContain("overlay pull failed");
		});

		// ...and the guard still does its job for anything that is NOT pi's marker.
		it("is left alone when it carries real local work", () => {
			const { root, origin } = fixture();
			const { home, repo } = checkout(root, origin, "overlay-dirty");
			const ov = overlayFixture(root, "ov-dirty");
			advanceOverlay(ov.source);
			writeFileSync(join(ov.work, "workstation/.pi/agent/settings.json"), '{"lastChangelogVersion":"pi"}\n');
			writeFileSync(join(ov.work, "README.md"), "half-written change\n");
			const before = git(ov.work, "rev-parse", "HEAD");
			writeFileSync(join(home, "state/hive-pi-update/activated-revision"), `${git(repo, "rev-parse", "HEAD")}\n`);
			runUpdater(home, stubTools(home).bin, ov.work);

			expect(git(ov.work, "rev-parse", "HEAD")).toBe(before);
			expect(readFileSync(join(home, "state/hive-pi-update/last-run"), "utf8")).toContain("left alone");
		});
	});
});
