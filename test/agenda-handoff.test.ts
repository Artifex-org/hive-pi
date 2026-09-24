/**
 * `/handoff` (HIV-1231) — seed building and the consume-once contract.
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	buildHandoffSeed,
	consumeHandoff,
	discoverGitDir,
	gitDirFor,
	handoffPath,
	legacyHandoffPath,
	writeHandoff,
} from "../extensions/agenda/handoff.ts";
import { guardTargets } from "../extensions/guards-common/capability.ts";

// Main-shaped fixture: the guard-wiring test below dynamically imports the
// agenda extension, whose module-load worker gates must see a main session.
// (test/tool-capability.test.ts scrubs the same pair for the same reason.)
delete process.env.PI_AGENDA_WORKER;
delete process.env.PI_BRIEF_WORKER;
import { createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { emptySignals } from "../extensions/agenda/signals.ts";

const goal: GoalItem = {
	schemaVersion: 1,
	kind: "goal",
	id: "g",
	state: "active",
	condition: "PR created and its checks green",
	createdAt: 0,
	updatedAt: 0,
	ledger: { iterations: 0, maxIterations: 8, turnsEvaluated: 0, judgeErrors: 0, noProgressStreak: 0,
		pendingStreak: 0, tokens: 0 },
};

describe("buildHandoffSeed", () => {
	it("carries objective, goal, lifecycle stage, todos and git state", () => {
		const seed = buildHandoffSeed({
			objective: "finish the verify stage",
			goal,
			conductor: withStage(createConductor("c", 0), "execute", 0),
			signals: {
				...emptySignals,
				tasks: { total: 4, pending: 1, inProgress: 1, completed: 2 },
				plan: { phase: "approved", revision: 2, stepCount: 4, goal: "ship it" },
			},
			gitStatus: " M extensions/agenda/index.ts\n?? docs/new.md",
			cwd: "/work/repo",
		});
		expect(seed).toContain("finish the verify stage");
		expect(seed).toContain("PR created and its checks green");
		expect(seed).toContain('"execute" stage');
		expect(seed).toContain("2/4 completed");
		expect(seed).toContain("phase: approved, 4 step(s), goal: ship it");
		expect(seed).toContain("M extensions/agenda/index.ts");
		expect(seed).toContain("verifying this seed against the worktree");
	});

	it("omits sections that have nothing to say", () => {
		const seed = buildHandoffSeed({
			objective: "",
			goal: null,
			conductor: null,
			signals: emptySignals,
			gitStatus: null,
			cwd: "/work/repo",
		});
		expect(seed).not.toContain("## Finish line");
		expect(seed).not.toContain("## Lifecycle");
		expect(seed).not.toContain("## Todos");
		expect(seed).toContain("carry the previous session's work forward");
	});
});

describe("write + consume", () => {
	it("round-trips, renames on consume, and never consumes twice", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-"));
		const path = writeHandoff(cwd, "# Handoff\ncontent");
		expect(path).toBe(handoffPath(cwd));
		expect(existsSync(path)).toBe(true);

		const seed = consumeHandoff(cwd, 1234);
		expect(seed).toContain("content");
		// Renamed, not deleted — lineage stays on disk.
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(join(cwd, ".pi"))).toContain("handoff-consumed-1234.md");

		expect(consumeHandoff(cwd)).toBeNull();
	});

	it("consuming when nothing is pending is a quiet null", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-none-"));
		expect(consumeHandoff(cwd)).toBeNull();
	});
});

/**
 * The contamination fix: seeds live in the per-worktree private git dir,
 * outside the checkout, so `git status` and snapshots never see them. Real
 * temp git repos + a real linked worktree — mocks cannot show a status.
 */
describe("git-dir seed location", () => {
	function makeWorktree(): { base: string; wt: string } {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-handoff-repo-"));
		execSync(
			`git init -q "${base}" && git -C "${base}" config user.email t@t.t && git -C "${base}" config user.name t && git -C "${base}" commit -q --allow-empty -m init`,
			{ stdio: "pipe" },
		);
		const wt = `${base}-wt`;
		execSync(`git -C "${base}" worktree add -q "${wt}"`, { stdio: "pipe" });
		return { base, wt };
	}

	function porcelain(cwd: string): string {
		return execSync(`git -C "${cwd}" status --porcelain`, { encoding: "utf8" });
	}

	it("pending seed lives outside the checkout and git status stays clean", () => {
		const { wt } = makeWorktree();
		const path = writeHandoff(wt, "# Handoff\ncontent");
		expect(path).toBe(handoffPath(wt));
		// Not under the checkout: inside the per-worktree private git dir.
		expect(path.startsWith(`${wt}/`)).toBe(false);
		const gitDir = resolve(wt, execSync(`git -C "${wt}" rev-parse --git-dir`, { encoding: "utf8" }).trim());
		expect(path.startsWith(`${gitDir}/`)).toBe(true);
		// And it is the per-worktree dir, not the shared common dir.
		const commonDir = resolve(
			wt,
			execSync(`git -C "${wt}" rev-parse --git-common-dir`, { encoding: "utf8" }).trim(),
		);
		expect(gitDir).not.toBe(commonDir);
		expect(porcelain(wt)).toBe("");
	});

	it("consumed seed stays outside the checkout and consumes exactly once", () => {
		const { wt } = makeWorktree();
		writeHandoff(wt, "# Handoff\ncontent");

		const seed = consumeHandoff(wt, 1234);
		expect(seed).toContain("content");
		// Renamed, not deleted — lineage stays on disk, beside the pending slot.
		expect(existsSync(handoffPath(wt))).toBe(false);
		expect(readdirSync(dirname(handoffPath(wt)))).toContain("handoff-consumed-1234.md");
		// Nothing was ever created in the checkout itself.
		expect(existsSync(join(wt, ".pi"))).toBe(false);
		expect(porcelain(wt)).toBe("");

		expect(consumeHandoff(wt)).toBeNull();
	});

	it("a legacy .pi seed still pending is honored once, and the checkout ends clean", () => {
		const { wt } = makeWorktree();
		const legacy = legacyHandoffPath(wt);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\nlegacy content", "utf8");

		const seed = consumeHandoff(wt, 777);
		expect(seed).toContain("legacy content");
		// Legacy pending slot is gone and the consumed rename left the checkout.
		expect(existsSync(legacy)).toBe(false);
		expect(readdirSync(dirname(handoffPath(wt)))).toContain("handoff-consumed-777.md");
		expect(porcelain(wt)).toBe("");
		expect(consumeHandoff(wt)).toBeNull();
	});

	it("the main worktree seeds under its own .git, still invisible to status", () => {
		const { base } = makeWorktree();
		const path = writeHandoff(base, "# Handoff\ncontent");
		expect(path.startsWith(`${base}/.git/`)).toBe(true);
		expect(porcelain(base)).toBe("");
		expect(consumeHandoff(base, 9)).toContain("content");
		expect(porcelain(base)).toBe("");
	});

	it("a cwd outside any repo falls back to the legacy checkout path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-nongit-"));
		expect(gitDirFor(cwd)).toBeNull();
		expect(handoffPath(cwd)).toBe(legacyHandoffPath(cwd));
		writeHandoff(cwd, "# Handoff\ncontent");
		expect(consumeHandoff(cwd, 1)).toContain("content");
		expect(consumeHandoff(cwd)).toBeNull();
	});
});

/**
 * Discovery failure is not "not a repo": inside a real repo whose git cannot
 * be discovered, falling back to `.pi` would write checkout litter. A fake
 * `git` earlier on PATH makes discovery fail deterministically — the repo
 * itself is real, created with the real git before the PATH is swapped.
 */
describe("discovery failure fails closed", () => {
	function makeRepo(): string {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-handoff-disc-"));
		execSync(
			`git init -q "${base}" && git -C "${base}" config user.email t@t.t && git -C "${base}" config user.name t && git -C "${base}" commit -q --allow-empty -m init`,
			{ stdio: "pipe" },
		);
		return base;
	}

	/** Run fn with a fake `git` shadowing the real one; PATH restored after. */
	function withFakeGit(script: string, fn: () => void): void {
		const bin = mkdtempSync(join(tmpdir(), "hive-pi-fakegit-"));
		writeFileSync(join(bin, "git"), script, { mode: 0o755 });
		const saved = process.env.PATH ?? "";
		process.env.PATH = `${bin}${delimiter}${saved}`;
		try {
			fn();
		} finally {
			process.env.PATH = saved;
		}
	}

	const FAILING_GIT = `#!/bin/sh\necho "fatal: unable to read configuration" >&2\nexit 128\n`;

	it("distinguishes failure from true non-git", () => {
		const base = makeRepo();
		withFakeGit(FAILING_GIT, () => {
			// Same exit code git uses for "not a repo", but a different
		// stderr — and that difference is the whole discriminator.
			const found = discoverGitDir(base);
			expect(found.ok).toBe(false);
			if (!found.ok) expect(found.detail).toContain("git rev-parse failed");
		});
		// And with the real git back, the same cwd resolves normally.
		const after = discoverGitDir(base);
		expect(after.ok).toBe(true);
	});

	it("classifies by git's answer, not by the cwd: 'not a git repository' still falls back", () => {
		const base = makeRepo();
		withFakeGit(
			`#!/bin/sh\necho "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128\n`,
			() => {
				const found = discoverGitDir(base);
				expect(found).toEqual({ ok: true, gitDir: null });
				// ... so a write still falls back instead of throwing.
				const path = writeHandoff(base, "# Handoff\ncontent");
				expect(path).toBe(legacyHandoffPath(base));
			},
		);
	});

	it("writeHandoff throws an actionable error and writes nothing into the checkout", () => {
		const base = makeRepo();
		let thrown: unknown;
		withFakeGit(FAILING_GIT, () => {
			try {
				writeHandoff(base, "# Handoff\ncontent");
			} catch (err) {
				thrown = err;
			}
		});
		expect(String(thrown)).toMatch(/refusing to write handoff seed/);
		expect(String(thrown)).toMatch(/git discovery failed/);
		// No fallback file, no created dir: the checkout is untouched.
		expect(existsSync(join(base, ".pi"))).toBe(false);
		expect(execSync(`git -C "${base}" status --porcelain`, { encoding: "utf8" })).toBe("");
	});

	it("consumeHandoff returns null without writing when discovery fails", () => {
		const base = makeRepo();
		const legacy = legacyHandoffPath(base);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\nlegacy content", "utf8");
		let seed: string | null = "unreached";
		withFakeGit(FAILING_GIT, () => {
			seed = consumeHandoff(base, 4242);
		});
		// No injection AND no writes: the seed stays pending for a session
		// whose git works, and no consumed file lands in the checkout.
		expect(seed).toBeNull();
		expect(readFileSync(legacy, "utf8")).toContain("legacy content");
		expect(existsSync(join(base, ".git", "handoff"))).toBe(false);
		// The only checkout entry is the still-pending seed the test itself
		// staged — consume added nothing, in particular no consumed file.
		const porcelain = execSync(`git -C "${base}" status --porcelain`, { encoding: "utf8" });
		expect(porcelain).toBe("?? .pi/\n");
		expect(porcelain).not.toMatch(/handoff-consumed/);
		// With git back, the still-pending seed consumes exactly once.
		expect(consumeHandoff(base, 4243)).toContain("legacy content");
		expect(consumeHandoff(base)).toBeNull();
	});

	it("a hung git is a failure, not a fallback", () => {
		const base = makeRepo();
		withFakeGit(`#!/bin/sh\nsleep 30\n`, () => {
			const found = discoverGitDir(base);
			expect(found.ok).toBe(false);
			if (!found.ok) expect(found.detail).toMatch(/timed out/);
			expect(() => writeHandoff(base, "# Handoff\ncontent")).toThrow(/refusing to write handoff seed/);
		});
		expect(existsSync(join(base, ".pi"))).toBe(false);
		// Discovery itself waits out the full rev-parse timeout before failing.
	}, 15_000);
});

/**
 * The pack surface, not just `git status`: the tracked-file packer available
 * here (`git archive`) must contain no seed, pending or consumed. Structural
 * note: Hive's `--snapshot` upload packs the working copy and has no local
 * dry-run entry point, so it is covered by construction — the primary seed
 * path is not under the checkout (asserted above), hence not in any
 * checkout-derived pack — plus this end-to-end archive over the real thing.
 */
describe("snapshot pack exclusion", () => {
	it("git archive of a seeded repo contains no handoff file", () => {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-handoff-pack-"));
		execSync(
			`git init -q "${base}" && git -C "${base}" config user.email t@t.t && git -C "${base}" config user.name t`,
			{ stdio: "pipe" },
		);
		writeFileSync(join(base, "tracked.txt"), "shipped\n", "utf8");
		execSync(`git -C "${base}" add tracked.txt && git -C "${base}" commit -q -m init`, { stdio: "pipe" });

		writeHandoff(base, "# Handoff\npending content");
		consumeHandoff(base, 31337);
		// Belt: an untracked legacy-format file sitting in the checkout is
		// still outside the tracked surface a commit/archive pack carries.
		mkdirSync(join(base, ".pi"), { recursive: true });
		writeFileSync(join(base, ".pi", "handoff.md"), "# Handoff\nlegacy-shaped\n", "utf8");

		const listing = execSync(`git -C "${base}" archive HEAD | tar -t`, { encoding: "utf8" });
		expect(listing).toContain("tracked.txt");
		expect(listing).not.toMatch(/handoff/);
		// And the full untracked-file status stays clean of seeds in git space.
		const full = execSync(`git -C "${base}" status --porcelain --untracked-files=all`, { encoding: "utf8" });
		expect(full).not.toMatch(/handoff-consumed/);
		expect(full).not.toMatch(/\.git\/handoff/);
	});
});

/**
 * Guard behavior, not just file placement: the declared fallback must actually
 * be judged by the worktree guard, and the primary git-dir target must need
 * no judging. The declaration-drift check loads the real agenda extension —
 * proving the handoff TOOL asks the guard about the path it really writes —
 * rather than re-stating the literal here.
 */
describe("guard behavior", () => {
	function guardedMainWorktree(): string {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-handoff-guarded-"));
		execSync(
			`git init -q "${base}" && git -C "${base}" config user.email t@t.t && git -C "${base}" config user.name t && git -C "${base}" commit -q --allow-empty -m init`,
			{ stdio: "pipe" },
		);
		// Untracked marker: somebody protected THIS checkout (a committed one
		// arrives with every clone and cannot mark an anchor — see decide()).
		writeFileSync(join(base, ".worktree-guard"), "");
		return base;
	}

	it("the legacy fallback is judged by the guard in a protected checkout", () => {
		const base = guardedMainWorktree();
		const block = guardTargets([legacyHandoffPath(base)], "handoff");
		expect(block).not.toBeNull();
		expect(block?.reason).toContain("BLOCKED");
	});

	it("the primary git-dir target needs no judging, even where the checkout is protected", () => {
		const base = guardedMainWorktree();
		// decide() locates a repo from the checkout, and a path inside `.git`
		// is not locatable as one — verified, not reasoned: ALLOW here.
		expect(guardTargets([handoffPath(base)], "handoff")).toBeNull();
	});

	it("the tool declares the fallback it actually writes", async () => {
		const { createFakePi } = await import("./fake-pi.ts");
		const agenda = (await import("../extensions/agenda/index.ts")).default;
		const pi = createFakePi();
		await agenda(pi.api as never);
		const tool = pi.tools.find((t) => t.name === "handoff");
		expect(tool, "handoff tool must be registered").toBeDefined();
		const capability = (tool!.definition as {
			capability: { writesResolved: (params: Record<string, unknown>, cwd: string | undefined) => string[] };
		}).capability;
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-handoff-decl-"));
		// The guard judges exactly the non-git fallback path — a drift between
		// this declaration and legacyHandoffPath would leave the real write
		// unguarded while the test above guards a stale literal.
		expect(capability.writesResolved({}, cwd)).toEqual([legacyHandoffPath(cwd)]);
	});
});

/**
 * Cross-device reality check for the EXDEV fallback: a repo whose git dir
 * lives on another filesystem (`--separate-git-dir`), so the legacy→primary
 * move genuinely crosses devices. The deterministic core of this contract
 * lives in agenda-handoff-exdev.test.ts (injected EXDEV, runs everywhere);
 * this proves the fallback against a real EXDEV where the platform offers two
 * filesystems.
 */
function crossDevicePair(): [string, string] | null {
	try {
		const candidates = [tmpdir(), "/dev/shm", "/tmp"].filter(
			(dir, i, all) => all.indexOf(dir) === i && existsSync(dir),
		);
		for (const a of candidates) {
			for (const b of candidates) {
				if (statSync(a).dev !== statSync(b).dev) return [a, b];
			}
		}
	} catch {
		/* single-filesystem platform: the injected-EXDEV suite still covers the contract */
	}
	return null;
}
const CROSS_DEVICE = crossDevicePair();
describe.runIf(CROSS_DEVICE !== null)("cross-device consume (real EXDEV)", () => {
	it("moves a legacy seed across filesystems with no checkout litter", () => {
		const [fsA, fsB] = CROSS_DEVICE as [string, string];
		const co = mkdtempSync(join(fsA, "hive-pi-handoff-xdev-co-"));
		const gitDir = join(mkdtempSync(join(fsB, "hive-pi-handoff-xdev-git-")), "separate.git");
		execSync(`git init -q --separate-git-dir="${gitDir}" "${co}"`, { stdio: "pipe" });
		execSync(`git -C "${co}" config user.email t@t.t && git -C "${co}" config user.name t && git -C "${co}" commit -q --allow-empty -m init`, {
			stdio: "pipe",
		});
		// Genuinely cross-device, or this proves nothing about EXDEV.
		expect(statSync(co).dev).not.toBe(statSync(gitDir).dev);
		expect(resolve(co, execSync(`git -C "${co}" rev-parse --git-dir`, { encoding: "utf8" }).trim())).toBe(gitDir);

		const legacy = legacyHandoffPath(co);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "# Handoff\ncross-device content", "utf8");

		const seed = consumeHandoff(co, 6001);
		expect(seed).toContain("cross-device content");
		// Consumed exactly once, across the device boundary...
		expect(existsSync(legacy)).toBe(false);
		const consumed = join(gitDir, "handoff", "handoff-consumed-6001.md");
		expect(readFileSync(consumed, "utf8")).toContain("cross-device content");
		expect(consumeHandoff(co)).toBeNull();
		// ...and the checkout carries no litter the next snapshot could pack.
		expect(execSync(`git -C "${co}" status --porcelain --untracked-files=all`, { encoding: "utf8" })).toBe("");
		expect(execSync(`git -C "${co}" archive HEAD | tar -t`, { encoding: "utf8" })).not.toMatch(/handoff/);
	});
});
