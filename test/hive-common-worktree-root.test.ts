import { describe, expect, it } from "vitest";
import { resolveProject } from "../extensions/hive-common/identity.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Sessions get started from the worktrees ROOT constantly — it is the natural
// place to stand while deciding which worktree to work in. That directory is not
// itself a repo, so those sessions were bucketed as an opaque `local-<hash>` and
// a meaningful share of a developer's agent activity said nothing about what it
// was for.

const repos = join(homedir(), "repos");
const hasLayout = existsSync(join(repos, "hive.git")) && existsSync(join(repos, "hive__worktrees"));

// This skip is DELIBERATE and cannot be fixed by provisioning the CI image — it
// asserts against a real developer's `~/repos` layout, which no CI checkout has.
// It is therefore NOT covered by `PI_HOUSE_REQUIRE_TOOLS` (test/require-tools.ts),
// which exists to make *tool*-absence fatal. Called out so the two skips are not
// confused: that one was a silent coverage hole (HIV-1238), this one is a
// developer-machine assertion. Converting it to a synthetic bare-repo layout in a
// tmpdir would make it universal — worth doing if this behaviour ever regresses.

describe.runIf(hasLayout)("resolveProject on a bare-repo + worktrees layout", () => {
	it("resolves the worktrees ROOT to the repo beside it", () => {
		expect(resolveProject(join(repos, "hive__worktrees")).repo).toBe("Artifex-org/hive");
	});

	// Walking up means a scratch directory under the root resolves too.
	it("resolves a subdirectory that is not itself a worktree", () => {
		const scratch = join(repos, "hive__worktrees", "does-not-exist-scratch");
		expect(resolveProject(scratch).repo).toBe("Artifex-org/hive");
	});

	// The primary path must still win — a real checkout answers for itself.
	it("still prefers a real checkout's own remote", () => {
		expect(resolveProject(join(repos, "hive__worktrees", "main")).repo).toBe("Artifex-org/hive");
	});
});

describe("resolveProject fallbacks", () => {
	// Read through git, not parsed off the name: a coincidentally named
	// directory with no sibling bare repo must not claim an identity.
	it("does not invent a repo for a lookalike directory", () => {
		const id = resolveProject("/tmp/nothing-here__worktrees");
		expect(id.repo).toBe("");
		expect(id.projectHint).toMatch(/^local-/);
	});
});
