import { describe, expect, it } from "vitest";
import { ancestors, gateArgs, gateCandidates, render, splitReport, stripAnsi, tail } from "../extensions/gate/gate.ts";

const OK = `{
  "passed": true,
  "total_duration_ms": 3120,
  "checks": [
    {"name": "universal/gitleaks", "duration_ms": 210, "status": "pass"},
    {"name": "python/ruff_lint", "duration_ms": 900, "status": "pass"},
    {"name": "python/mypy", "duration_ms": 1200, "status": "warn"}
  ],
  "failures": [],
  "skipped_missing_tools": []
}`;

const BAD = `Running quality gate...
Ruff: Linting issues
src/app.py:12:1: F401 'os' imported but unused
{
  "passed": false,
  "total_duration_ms": 4500,
  "checks": [
    {"name": "python/ruff_lint", "duration_ms": 900, "status": "fail"},
    {"name": "universal/file_length", "duration_ms": 30, "status": "pass"}
  ],
  "failures": ["python/ruff_lint"],
  "skipped_missing_tools": [{"tool": "python/basedpyright", "reason": "not installed"}]
}`;

describe("splitReport", () => {
	it("separates diagnostics from the json trailer", () => {
		const { text, result } = splitReport(BAD);
		expect(result?.passed).toBe(false);
		expect(result?.failures).toEqual(["python/ruff_lint"]);
		// The findings are the part the agent needs; they must not be eaten.
		expect(text).toContain("F401 'os' imported but unused");
		expect(text).not.toContain('"passed"');
	});

	it("handles a trailer with no preceding output", () => {
		const { text, result } = splitReport(OK);
		expect(result?.passed).toBe(true);
		expect(text).toBe("");
	});

	// A gate that dies mid-run prints findings and no trailer. Reporting a parse
	// error instead of those findings would hide the only useful information.
	it("keeps the output when there is no trailer", () => {
		const { text, result } = splitReport("Ruff: Linting issues\nsrc/a.py:1:1: E501 line too long\n");
		expect(result).toBeNull();
		expect(text).toContain("E501");
	});

	it("does not mistake JSON in a finding for the trailer", () => {
		const { result } = splitReport('eslint: unexpected token in {\n  "a": 1\n}\n');
		expect(result).toBeNull();
	});
});

describe("render", () => {
	const opts = { command: "quality-gate --mode=quick", exitCode: 0, maxLines: 200 };

	it("reports a pass, and does not hide an advisory behind it", () => {
		const { text, result } = splitReport(OK);
		const out = render(text, result, opts);
		expect(out).toContain("PASS");
		// Every emitted check RAN. The gate spells its statuses pass|warn|fail
		// and never emits "skipped" — a check that could not run is reported
		// through skipped_missing_tools instead, so the old `!== "skipped"`
		// filter was dead code and this fixture's "one skipped" was fiction.
		expect(out).toContain("3 check(s)");
		// `warn` keeps passed:true, so without this the finding is invisible and
		// the agent reads an unqualified PASS over a real advisory.
		expect(out).toContain("1 advisory");
		expect(out).toContain("advisory (non-blocking): python/mypy");
		expect(out).toContain("3.1s");
	});

	it("names the failed checks and shows the findings", () => {
		const { text, result } = splitReport(BAD);
		const out = render(text, result, { ...opts, exitCode: 1 });
		expect(out).toContain("FAIL");
		expect(out).toContain("failed: python/ruff_lint");
		expect(out).toContain("F401");
	});

	// The distinction that keeps a green gate meaningful: a check that could not
	// run made no claim, and that is not the same as passing.
	it("calls out checks that never ran", () => {
		const { text, result } = splitReport(BAD);
		const out = render(text, result, { ...opts, exitCode: 1 });
		expect(out).toContain("not run (tool missing): python/basedpyright");
		expect(out).toContain("made no claim");
	});

	// Measured against the real gate: a fast-fail exit prints findings and never
	// reaches its summary. Calling that "unparseable" invites the agent to
	// dismiss the findings underneath it.
	it("treats a trailer-less failure as a real failure, not a broken tool", () => {
		const out = render("Ruff: Linting issues\nsrc/a.py:1:1: F401", null, { ...opts, exitCode: 1 });
		expect(out).toContain("FAIL");
		expect(out).toContain("F401");
		expect(out).not.toContain("unparseable");
	});

	// The gate short-circuits with exit 0 when nothing changed. "Nothing was
	// checked" is not "it passed", and the wording has to keep those apart.
	it("reports a no-op run as nothing checked, not as a pass", () => {
		const out = render("No files changed - skipping quality gate", null, { ...opts, exitCode: 0 });
		expect(out).toContain("Nothing to check");
		expect(out).not.toContain("PASS");
	});

	// "Nothing to check" has two very different causes — there genuinely are no
	// changes, or the gate is looking at the wrong tree — and the message used
	// to be identical for both. An agent whose work sat in a second checkout
	// under ~/.hive/scratch/ read it as "clean" and shipped; it had gated the
	// session's ORIGINAL worktree, which of course had nothing in it. The path
	// is the one fact that separates the two readings.
	it("names the directory it examined when it found nothing", () => {
		const out = render("No files changed - skipping quality gate", null, {
			...opts,
			exitCode: 0,
			cwd: "/home/dev/repos/Aurora__worktrees/agents-aurora-cd48400b",
		});
		expect(out).toContain("/home/dev/repos/Aurora__worktrees/agents-aurora-cd48400b");
		expect(out).toContain("NOT a pass");
		expect(out).toContain("cwd");
		expect(out).not.toContain("PASS —");
	});

	// THE LARGEST PAPERCUT CLUSTER IN THE CORPUS: 16 entries between 2026-08-17
	// and 08-19, across Aurora and Borealis-Ops, every one "reported Nothing to
	// check while git status showed N modified files IN THAT EXACT CHECKOUT".
	//
	// The cause is not the directory. `scope: "changed"` resolves to
	// `git diff <merge-base>...HEAD` — committed history only — so uncommitted
	// work is invisible to it, which is the state an agent is in when it gates
	// before committing. The message blamed the cwd unconditionally and sent
	// people to re-check a path that was already right.
	it("blames the scope, not the directory, when the tree has uncommitted work", () => {
		const out = render("No files changed - skipping quality gate", null, {
			...opts,
			exitCode: 0,
			cwd: "/home/dev/repos/Borealis-Ops__worktrees/agents-borealis-ops-8fa85aaf",
			scope: "changed",
			uncommitted: 24,
		});
		expect(out).toContain("NOT a pass");
		expect(out).toContain("24 uncommitted paths");
		// It must still blame the scope rather than the directory…
		expect(out).not.toContain("different checkout");
		// …but it must NOT claim the tree being dirty is the reason, and must not
		// prescribe staging or committing. `changed` has seen the working tree
		// since quality-gate ce86647; that advice sent people to stage work the
		// gate would already have looked at.
		expect(out).not.toContain("merge-base");
		expect(out).not.toContain("git add");
		expect(out).toContain("does NOT explain this");
		// It has to leave the reader somewhere to go.
		expect(out).toContain("git status --short");
	});

	// A clean tree is the case the old advice was written for, and it stays.
	it("keeps the wrong-checkout advice when the tree is clean", () => {
		const out = render("No files changed - skipping quality gate", null, {
			...opts,
			exitCode: 0,
			cwd: "/home/dev/repos/Aurora__worktrees/feature-8a0e6d40",
			scope: "changed",
			uncommitted: 0,
		});
		expect(out).toContain("different checkout");
		expect(out).not.toContain("uncommitted path");
	});

	// The count is best-effort — not a git repo, git missing, a timeout. When it
	// is unknown the old wording stands: a diagnostic that cannot answer must not
	// invent one, and guessing "clean" would restore the wrong advice silently.
	it("falls back to the previous wording when the count is unknown", () => {
		const out = render("No files changed - skipping quality gate", null, {
			...opts,
			exitCode: 0,
			cwd: "/some/where",
			scope: "changed",
		});
		expect(out).toContain("different checkout");
		expect(out).not.toContain("uncommitted");
	});

	// One file is the common case for a targeted fix, and "1 uncommitted paths"
	// reads as a bug in the tool telling you about a bug.
	it("counts one file in the singular", () => {
		const out = render("No files changed", null, {
			...opts,
			exitCode: 0,
			cwd: "/w",
			scope: "changed",
			uncommitted: 1,
		});
		// The trailing "." pins the SINGULAR: a bare "1 uncommitted path" would
		// also match the plural "1 uncommitted paths" this guards against.
		expect(out).toContain("1 uncommitted path.");
	});

	// A `staged` run that found nothing is a DIFFERENT story, and the first
	// version of this fix got it wrong: it interpolated the scope into the
	// merge-base sentence, so a staged caller was told `staged` resolves to
	// `git diff <merge-base>...HEAD` (it does not — it reads the index) and was
	// then advised to re-run with the scope they had just run. Wrong mechanism,
	// circular remedy: precisely the failure this whole change removes, moved one
	// scope along.
	it("tells a staged run about the index, not the merge-base", () => {
		const out = render("No files changed", null, {
			...opts,
			exitCode: 0,
			cwd: "/w",
			scope: "staged",
			uncommitted: 3,
		});
		expect(out).toContain("`staged`");
		expect(out).toContain("INDEX");
		expect(out).toContain("git add");
		// The mechanism that belongs to `changed` must not be claimed here.
		expect(out).not.toContain("merge-base");
		// And it must not send them back to the scope that just failed.
		expect(out).not.toContain('re-run with scope "staged"');
	});

	// This test used to assert the opposite — that a `changed` run is told its
	// scope is committed history and to re-run as `staged`. quality-gate ce86647
	// (2026-08-18) made `changed` union the working tree, one day after that
	// wording was written from the 08-17/19 papercuts, and nothing here moved
	// with it. pyERP's vendored gate is pinned at exactly ce86647, so the repo
	// generating most of these papercuts had the corrected behaviour throughout.
	//
	// The property now pinned: a `changed` run must never be sent to stage or
	// commit, because that is work the gate has already seen.
	it("does not send a changed run to stage or commit", () => {
		const out = render("No files changed", null, {
			...opts,
			exitCode: 0,
			cwd: "/w",
			scope: "changed",
			uncommitted: 3,
		});
		expect(out).not.toContain("merge-base");
		expect(out).not.toContain('scope "staged"');
		expect(out).not.toContain("git add");
		// It says what `changed` actually covers…
		expect(out).toContain("working tree");
		expect(out).toContain("untracked");
		// …and offers the escape that genuinely widens the scope.
		expect(out).toContain('scope "all"');
	});

	// The `staged` half was never wrong and must survive this correction: an
	// unstaged edit really is invisible to the index, so `git add` is the right
	// advice THERE and only there.
	it("still tells a staged run to git add", () => {
		const out = render("No files changed", null, {
			...opts,
			exitCode: 0,
			cwd: "/w",
			scope: "staged",
			uncommitted: 3,
		});
		expect(out).toContain("INDEX");
		expect(out).toContain("git add");
	});

	// A findings report is about the findings. The path would be noise there,
	// and only earns its place when the answer is "nothing".
	it("does not mention the directory when it actually checked something", () => {
		const out = render("", JSON.parse(OK) as never, { ...opts, exitCode: 0, cwd: "/some/where" });
		expect(out).not.toContain("/some/where");
	});
});

describe("tail", () => {
	// The gate prints check by check, so the LAST failure is the one it stopped
	// on. Truncating from the front drops exactly what was being looked for.
	it("keeps the end and says how much it dropped", () => {
		const out = tail(Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"), 10);
		expect(out).toContain("line49");
		expect(out).not.toContain("line10\n");
		expect(out).toContain("40 earlier line(s) omitted");
	});

	it("leaves short output alone", () => {
		expect(tail("a\nb", 10)).toBe("a\nb");
	});
});

describe("stripAnsi", () => {
	it("removes colour so the model reads findings, not escapes", () => {
		expect(stripAnsi("[31mRuff: issues[0m")).toBe("Ruff: issues");
	});
});

describe("discovery", () => {
	it("walks from the cwd upwards", () => {
		expect(ancestors("/home/dev/repos/Aurora")).toEqual(["/home/dev/repos/Aurora", "/home/dev/repos", "/home/dev", "/home"]);
	});

	// A repo pins a gate version deliberately; running a different one from PATH
	// would report against rules it has not adopted.
	it("prefers a vendored gate over anything further away", () => {
		const c = gateCandidates(["/repo", "/"]);
		expect(c[0]).toBe("/repo/vendor/quality-gate/quality-gate");
		expect(c.indexOf("/repo/quality-gate")).toBeLessThan(c.indexOf("//vendor/quality-gate/quality-gate".replace("//", "/")));
	});
});

describe("gateArgs", () => {
	// --no-fast-fail by default, measured: on fast-fail the real gate exits
	// before its summary, so the agent gets neither the trailer nor the checks
	// after the first failure.
	it("defaults to all findings at once", () => {
		expect(gateArgs({ mode: "quick", scope: "changed" })).toEqual(["--mode=quick", "--json", "--no-fast-fail", "--changed"]);
	});

	it("can stop early when asked", () => {
		expect(gateArgs({ mode: "quick", scope: "changed", stopEarly: true })).not.toContain("--no-fast-fail");
	});

	it("maps scopes to the gate's own flags", () => {
		expect(gateArgs({ mode: "quick", scope: "staged" })).toContain("--staged");
		expect(gateArgs({ mode: "standard", scope: "all" })).toEqual(["--mode=standard", "--json", "--no-fast-fail", "--changed", "--lint-all"]);
	});

	it("passes filters through", () => {
		const args = gateArgs({ mode: "quick", scope: "changed", only: "typescript", skip: "gitleaks" });
		expect(args).toContain("--only=typescript");
		expect(args).toContain("--skip=gitleaks");
	});
});

// The same state as "nothing to check", arriving WITH a trailer: `passed:true`
// and an empty `checks` array. It rendered as `PASS — 0 check(s) in 18.0s`,
// which is worse than unusable — it is a claim, and an agent quite reasonably
// read it as verification and shipped on. Measured 2026-08-18, filed blocking:
// `quality_gate(mode:"standard", scope:"staged", only:"schema-bootstrap")`
// dispatched no step at all and answered exactly that.
describe("render on a run that checked nothing", () => {
	const opts = { command: "quality-gate", exitCode: 0, maxLines: 200 };
	const EMPTY = '{"passed": true, "checks": [], "failures": [], "total_duration_ms": 18000}';

	it("refuses to call an empty run a pass", () => {
		const { text, result } = splitReport(EMPTY);
		const out = render(text, result, opts);
		expect(out).toContain("NOTHING CHECKED");
		expect(out).toContain("NOT a pass");
		expect(out).not.toMatch(/^PASS/m);
	});

	it("names the directory and the selector that produced it", () => {
		const { text, result } = splitReport(EMPTY);
		const out = render(text, result, { ...opts, cwd: "/scratch/wt", selector: "schema-bootstrap" });
		expect(out).toContain("/scratch/wt");
		expect(out).toContain("only=schema-bootstrap");
	});

	// A real run keeps its verdict: the branch must key on "ran nothing", not
	// on "passed", or every green gate in the harness stops saying so.
	it("leaves a run that actually checked something alone", () => {
		const { text, result } = splitReport(OK);
		expect(render(text, result, opts)).toContain("PASS");
	});

	// A zero-check FAILURE is already honest — it has failures to name — so the
	// branch must not swallow it.
	it("does not intercept a failing run", () => {
		const { text, result } = splitReport('{"passed": false, "checks": [], "failures": ["ruff"]}');
		const out = render(text, result, opts);
		expect(out).toContain("FAIL");
		expect(out).not.toContain("NOTHING CHECKED");
	});
});
