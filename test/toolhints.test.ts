/**
 * toolhints (HIV-1976): the right hint, at the right moment, and silence
 * otherwise.
 *
 * The assertions that matter are the negative ones. A hint layer that fires
 * eagerly is worse than none: it taxes every tool result and trains the model
 * to skim past a tag that is usually noise.
 */

import { describe, expect, it } from "vitest";

import { HINTS, matchHint, renderHint, scanTail } from "../extensions/toolhints/hints.ts";
import toolhintsExtension, { appendHint, resultText } from "../extensions/toolhints/index.ts";
import { createFakePi } from "./fake-pi.ts";

/** The measured failures this table was built from, verbatim where possible. */
const REAL_ERRORS = {
	gh: "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.",
	ghLogin: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
	hiveOnly:
		"flag provided but not defined: -only\nUsage of check:\n  -base string\n\tbase SHA for pipeline eval + fingerprints",
	branchRef:
		"fatal: cannot lock ref 'refs/heads/feature/tes-7731': 'refs/heads/feature' exists; cannot create 'refs/heads/feature/tes-7731'",
	mcpNoMatch: 'No tools matching "issues search" in "linear"',
	mcpSchema: 'Error: validating "arguments": validating root: unexpected additional properties ["tail"]',
	// Verbatim from a launched agent's sandbox, 2026-08-16 (HIV-1979).
	miseShim:
		"mise ERROR Failed to install aqua:cli/cli@latest: Read-only file system (os error 30)\n" +
		"mise ERROR Version: 2026.7.17 linux-x64 (2026-07-30)",
	// HIV-3240: an agent follows the pr-attachments nudge on the 2.98 shim.
	attachUnsupported: "unknown flag: --attach\n\nUsage:  gh pr create [flags]",
} as const;

describe("the table itself", () => {
	it("cites evidence for every entry — an unauditable table becomes folklore", () => {
		for (const hint of HINTS) {
			expect(hint.evidence, `${hint.id} has no evidence`).toBeTruthy();
			expect(hint.evidence.length, `${hint.id}'s evidence is too thin to audit`).toBeGreaterThan(20);
		}
	});

	it("has unique ids, because the id is what a result is tagged with", () => {
		expect(new Set(HINTS.map((h) => h.id)).size).toBe(HINTS.length);
	});
});

describe("matchHint", () => {
	it("answers the gh failure with the command AND the negative fact", () => {
		// The negative fact is the half that took a session forty turns to not
		// find: Hive's MCP cannot open a pull request, so searching it is wasted.
		const hint = matchHint("bash", REAL_ERRORS.ghLogin);
		expect(hint?.id).toBe("gh-unauthenticated");
		expect(hint?.hint).toContain("gh auth login");
		expect(hint?.hint).toMatch(/read-only about PRs|gh pr create/);
	});

	it("does not tell a sandboxed agent it cannot deliver (HIV-1979)", () => {
		// This hint shipped claiming delivery "needs a session that can reach
		// GitHub". Measured false: api.github.com is allowlisted and answers 200
		// through the sandbox's injected proxy. The claim taught agents to give up
		// on a pull request they could have opened.
		const hint = matchHint("bash", REAL_ERRORS.ghLogin);
		expect(hint?.hint).not.toMatch(/delivery needs a session/i);
		expect(hint?.hint).toContain("api.github.com");
		// And it must name the failure that actually stalled efb2830c.
		expect(hint?.hint).toMatch(/mise|\/usr\/bin\/gh/);
	});

	it("names a shim install failure as a launcher problem, not a tool problem", () => {
		const hint = matchHint("bash", REAL_ERRORS.miseShim);
		expect(hint?.id).toBe("mise-shim-readonly");
		expect(hint?.hint).toContain("/usr/bin/");
		// The load-bearing negative: it must not send anyone off diagnosing
		// credentials, which is what every affected agent did instead.
		expect(hint?.hint).toMatch(/Nothing about your credentials/i);
	});

	it("catches both shapes gh uses to say the same thing", () => {
		expect(matchHint("bash", REAL_ERRORS.gh)?.id).toBe("gh-unauthenticated");
		expect(matchHint("bash", REAL_ERRORS.ghLogin)?.id).toBe("gh-unauthenticated");
	});

	it("corrects a stale instruction rather than only reporting the flag", () => {
		const hint = matchHint("bash", REAL_ERRORS.hiveOnly);
		expect(hint?.id).toBe("hive-check-only-flag");
		expect(hint?.hint).toContain("--step");
		expect(hint?.hint).toMatch(/stale/);
	});

	it("explains the branch-ref collision in terms of what to do next", () => {
		const hint = matchHint("bash", REAL_ERRORS.branchRef);
		expect(hint?.id).toBe("git-branch-ref-collision");
		expect(hint?.hint).toMatch(/flat name|tes-NNNN/);
	});

	it("tells the proxy searcher what its search actually matches", () => {
		const hint = matchHint("mcp", REAL_ERRORS.mcpNoMatch);
		expect(hint?.id).toBe("mcp-proxy-no-match");
		// And names the direct tools, which is the fix that removes the search.
		expect(hint?.hint).toContain("hive_wait_for_run");
		// AND IT MUST BE TRUE. This hint shipped asserting the search "takes
		// tool-NAME fragments, not a description of what you want". The adapter's
		// FIELD_WEIGHTS include `description: 5`, and a probe over the real corpus
		// proves it — `search("booster")` returns `get_metering_usage`, which has
		// "booster" only in its description. Two sessions (P0175, P0556) caught
		// the contradiction with the adapter's own tool description and burned
		// turns reconciling it. A hint that is wrong is worse than no hint.
		expect(renderHint(hint!)).not.toMatch(/not a description/);
	});

	it("names a schema rejection as a schema rejection", () => {
		expect(matchHint("mcp", REAL_ERRORS.mcpSchema)?.id).toBe("mcp-schema-rejection");
	});

	it("tells an agent whose gh is too old for --attach what to do (HIV-3240)", () => {
		const hint = matchHint("bash", REAL_ERRORS.attachUnsupported);
		expect(hint?.id).toBe("gh-attach-flag-unsupported");
		expect(hint?.hint).toContain("2.99.0");
		expect(hint?.hint).toContain("/usr/bin/gh");
		expect(hint?.hint).toMatch(/without images/i);
		// background_bash too — the PR command may be backgrounded.
		expect(matchHint("background_bash", REAL_ERRORS.attachUnsupported)?.id).toBe("gh-attach-flag-unsupported");
	});

	it("respects the tool scope — a bash-shaped error from another tool is not ours", () => {
		expect(matchHint("read", REAL_ERRORS.ghLogin)).toBeNull();
		expect(matchHint("bash", REAL_ERRORS.mcpNoMatch)).toBeNull();
	});

	it("is silent on an error nobody has studied", () => {
		expect(matchHint("bash", "Segmentation fault (core dumped)")).toBeNull();
		expect(matchHint("bash", "")).toBeNull();
	});

	it("does not fire on prose that merely mentions the tool", () => {
		// The failure mode of a signature table is a match on discussion of the
		// error rather than the error, which would annotate a file the agent read.
		expect(matchHint("bash", "the docs say to run gh auth login when this happens")?.id).toBe("gh-unauthenticated");
		expect(matchHint("bash", "we should check whether gh is installed")).toBeNull();
	});
});

describe("scanTail", () => {
	it("keeps the END of a long output — every signature is in the last lines", () => {
		const body = `${"x".repeat(50_000)}\n${REAL_ERRORS.branchRef}`;
		const tail = scanTail(body, 4096);
		expect(tail.length).toBeLessThanOrEqual(4096);
		expect(matchHint("bash", tail)?.id).toBe("git-branch-ref-collision");
	});

	it("leaves a short output alone", () => {
		expect(scanTail("short", 4096)).toBe("short");
	});
});

describe("appendHint", () => {
	it("appends to the last text part, keeping error and hint together", () => {
		const parts = appendHint([{ type: "text", text: "boom" }], "\n\n[harness hint · x] do y");
		expect(parts).toHaveLength(1);
		expect(parts[0].text).toBe("boom\n\n[harness hint · x] do y");
	});

	it("never loses the original output", () => {
		const original = [{ type: "text", text: REAL_ERRORS.hiveOnly }];
		const parts = appendHint(original, renderHint(HINTS[1]));
		expect(parts[0].text.startsWith(REAL_ERRORS.hiveOnly)).toBe(true);
	});

	it("copes with a result that has no text part at all", () => {
		const parts = appendHint([{ type: "image", data: "…" }], "\n\nhint");
		expect(parts).toHaveLength(2);
		expect(parts[1].text).toBe("hint");
	});

	it("reads text out of the shapes pi actually produces", () => {
		expect(resultText("plain")).toBe("plain");
		expect(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(resultText(undefined)).toBe("");
	});
});

describe("the extension", () => {
	function load(env: Record<string, string | undefined> = {}) {
		const saved = process.env.PI_TOOLHINTS;
		if (env.PI_TOOLHINTS === undefined) delete process.env.PI_TOOLHINTS;
		else process.env.PI_TOOLHINTS = env.PI_TOOLHINTS;
		const pi = createFakePi();
		toolhintsExtension(pi.api);
		if (saved === undefined) delete process.env.PI_TOOLHINTS;
		else process.env.PI_TOOLHINTS = saved;
		return pi;
	}

	it("annotates a failing bash result", async () => {
		const pi = load();
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: REAL_ERRORS.ghLogin }],
		})) as ({ content?: { text: string }[] } | undefined)[];
		expect(patch?.content?.[0].text).toContain("[harness hint · gh-unauthenticated]");
	});

	it("leaves a SUCCESSFUL call untouched — a hint there is pure context tax", async () => {
		const pi = load();
		const [patch] = await pi.emit({
			type: "tool_result",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: REAL_ERRORS.ghLogin }],
		});
		expect(patch).toBeUndefined();
	});

	it("still annotates the mcp proxy's non-error failure", async () => {
		// The proxy reports "found nothing" as an ordinary result, which is the
		// exact case this extension exists for: a search that failed silently.
		const pi = load();
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "mcp",
			isError: false,
			content: [{ type: "text", text: REAL_ERRORS.mcpNoMatch }],
		})) as ({ content?: { text: string }[] } | undefined)[];
		expect(patch?.content?.[0].text).toContain("mcp-proxy-no-match");
	});

	it("returns nothing for an unknown failure, so the result is passed through", async () => {
		const pi = load();
		const [patch] = await pi.emit({
			type: "tool_result",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "some novel disaster" }],
		});
		expect(patch).toBeUndefined();
	});

	it("registers nothing at all when switched off", () => {
		const pi = load({ PI_TOOLHINTS: "0" });
		expect(pi.handlers.size).toBe(0);
	});

	it("never modifies isError or details — a hint is not a verdict", async () => {
		const pi = load();
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "bash",
			isError: true,
			details: { exitCode: 128 },
			content: [{ type: "text", text: REAL_ERRORS.branchRef }],
		})) as (Record<string, unknown> | undefined)[];
		expect(Object.keys(patch ?? {})).toEqual(["content"]);
	});
});

// The largest blocking cluster of 2026-08-17/18: a foreground `git commit` is
// killed at the bash ceiling while Aurora's pre-commit hook is still running,
// which strands `index.lock`, and every later git command fails on it. Eleven
// papercuts, several asking in so many words for "owner/PID or safe cleanup
// guidance".
describe("the git-lock hints", () => {
	const LOCK =
		"fatal: Unable to create '/home/dev/repos/Aurora.git/worktrees/feature-11f3b766/index.lock': File exists.";

	it("answers a stranded index.lock with the order to check things in", () => {
		const hint = matchHint("bash", LOCK);
		expect(hint?.id).toBe("git-index-lock");
		// The lock is the second question. Re-running a commit that already
		// succeeded is how one change becomes two.
		expect(hint?.hint).toContain("DID THE WORK LAND");
		// And never delete it under a live hook.
		expect(hint?.hint).toContain("pgrep");
	});

	// THE HOLDER CHECK HAS TO SEE THE REAL HOLDER.
	//
	// The first version prescribed `pgrep -af 'git |pre-commit'`. Aurora's
	// pre-commit runs the quality gate, and killing the foreground bash does NOT
	// kill the hook's grandchildren: 2026-08-18T22:58 found SIX live
	// `quality-gate --changed` shells still holding the lock, and that command
	// line matches neither `git ` nor `pre-commit`.
	//
	// The consequence is not a missing tip, it is a FALSE NEGATIVE on the one
	// question whose wrong answer is destructive: step (3) says "only with no
	// live process is the lock stale", so an agent told "no holder" deletes the
	// lock under a live git. Two papercuts reached exactly that dead end.
	it("looks for the grandchild that actually holds the lock", () => {
		const hint = matchHint("bash", LOCK);
		expect(hint?.hint).toContain("quality-gate");
		// And says WHY, so the reader does not narrow it again.
		expect(hint?.hint).toContain("GRANDCHILDREN");
	});

	// In a worktree — which every Aurora, hive and Borealis checkout is — `.git` is
	// a FILE pointing at <bare>/worktrees/<name>, so `<dir>/.git/index.lock`
	// does not exist and looking there proves nothing. 2026-08-19T00:37: "the
	// worktree's `.git` indirection made the first lock check ineffective".
	it("does not send the reader to a .git/index.lock that cannot exist", () => {
		const hint = matchHint("bash", LOCK);
		expect(hint?.hint).toContain("rev-parse --git-dir");
		// The error already prints the real path; that is what to use.
		expect(hint?.hint).toContain("the path git PRINTED");
	});

	// The two corrections above sit at the END of steps (2) and (3), so anything
	// that ever caps hint length would drop exactly them and leave the rest
	// reading fine. Nothing truncates today — renderHint only prefixes, and the
	// one `slice` bounds the text SCANNED, not the hint emitted — and this pins
	// that, because a payload silently lost is the failure mode this whole table
	// exists to avoid.
	it("delivers the whole hint, corrections included", () => {
		const rendered = renderHint(HINTS.find((h) => h.id === "git-index-lock")!);
		expect(rendered).toContain("quality-gate");
		expect(rendered).toContain("rev-parse --git-dir");
	});

	it("matches the lock wherever git reports it, including a merge", () => {
		expect(matchHint("bash", "Unable to create '/w/.git/index.lock': File exists")?.id).toBe("git-index-lock");
		expect(matchHint("background_bash", LOCK)?.id).toBe("git-index-lock");
	});

	it("tells a timed-out command that its effect is unknown, not undone", () => {
		const hint = matchHint("bash", "Command timed out after 120 seconds");
		expect(hint?.id).toBe("bash-foreground-timeout");
		expect(hint?.hint).toContain("background_bash");
	});

	// background_bash has no ceiling, so the timeout hint would be nonsense there
	// — and the lock hint must still apply to it.
	it("does not offer the timeout hint to background_bash", () => {
		expect(matchHint("background_bash", "Command timed out after 120 seconds")).toBeNull();
	});

	// Silence when unsure: neither signature may fire on ordinary prose.
	it("stays quiet on text that merely mentions a lock or a timeout", () => {
		expect(matchHint("bash", "the request timed out")).toBeNull();
		expect(matchHint("bash", "removed index.lock from the worktree")).toBeNull();
	});
});

// The branch-collision hint had only the LOCAL half. An agent that took its
// advice, renamed, and pushed still hit the same wall from the server — with a
// message sharing no words with the local one:
//
//	! [remote rejected] HEAD -> feature/tes-7787 (directory file conflict)
//
// 2026-08-17T19:07, blocking: the work was finished and could not be published.
describe("the remote half of the branch collision", () => {
	// Real output: the server echoes its OWN lock error, in the same words the
	// local failure uses, above the rejection line. So both patterns are present
	// and the order in the table is what decides which remedy the agent gets.
	const rejected =
		"remote: error: cannot lock ref 'refs/heads/feature/tes-7787': 'refs/heads/feature' exists; " +
		"cannot create 'refs/heads/feature/tes-7787'\n" +
		"To github.com:Artifex-org/Aurora.git\n" +
		" ! [remote rejected] HEAD -> feature/tes-7787 (directory file conflict)\n" +
		"error: failed to push some refs";

	it("is matched, and answers with the PUSH remedy rather than the local one", () => {
		const hint = matchHint("bash", " ! [remote rejected] HEAD -> feature/tes-7787 (directory file conflict)");
		expect(hint?.id).toBe("git-branch-ref-collision-remote");
		expect(hint?.hint).toContain("git push -u origin HEAD:");
		// Renaming locally is what an agent has usually already done by this
		// point; saying so is the difference between one retry and three.
		expect(hint?.hint).toContain("Renaming your local branch is not enough");
	});

	it("also matches git's slashed spelling", () => {
		expect(matchHint("bash", "! [remote rejected] x -> y (directory/file conflict)")?.id).toBe(
			"git-branch-ref-collision-remote",
		);
	});

	// A push failure that carries BOTH messages must still get the remote
	// remedy, since the push is what the caller was doing.
	it("wins over the local hint when the output carries both", () => {
		expect(matchHint("bash", rejected)?.id).toBe("git-branch-ref-collision-remote");
	});
});
