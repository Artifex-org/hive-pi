/**
 * gate — running the house quality gate from inside the agent loop.
 *
 * PURE half: where the gate lives, how to read what it said, and how much of it
 * to show. The impure half (exec) is index.ts, so all of this is testable
 * without a repo or a shell.
 */

/** The gate's `--json` trailer. Per-check diagnostics are NOT in here — they
 *  stream to stdout during the run, which is why both halves are captured. */
export interface GateResult {
	passed: boolean;
	total_duration_ms?: number;
	checks?: { name: string; duration_ms?: number; status: string }[];
	failures?: string[];
	/** OBJECTS, not strings. The trailer emits {"tool":…,"reason":…} per
	 *  lib/reporter.sh:70 — typing this as string[] made `.join()` print
	 *  "[object Object]" in the one line that exists to name what did not run. */
	skipped_missing_tools?: ({ tool: string; reason?: string } | string)[];
	/** Wall time spent before the first check, when the gate reported it. */
	setup_duration_ms?: number;
}

/**
 * A check's status, as the gate ACTUALLY spells it.
 *
 * `pass` | `warn` | `fail` — verified in lib/reporter.sh. Not "passed",
 * "skipped" or "failed": code filtering on those is dead, and a fixture using
 * them certifies nothing.
 */
export type CheckStatus = "pass" | "warn" | "fail";

/**
 * gateCandidates lists where the gate may live, nearest first.
 *
 * Vendored beats installed: a repo pins a gate version deliberately (Aurora
 * vendors it as a submodule), and silently running a different one from PATH
 * would report against rules that repo has not adopted. PATH is the last
 * resort, not the first.
 */
export function gateCandidates(dirs: string[]): string[] {
	const rel = ["vendor/quality-gate/quality-gate", "scripts/quality-gate", "quality-gate"];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const r of rel) out.push(`${dir.replace(/\/$/, "")}/${r}`);
	}
	return out;
}

/** Directories to search: cwd, then each ancestor up to and including root. */
export function ancestors(cwd: string): string[] {
	const parts = cwd.split("/").filter(Boolean);
	const out: string[] = [];
	for (let i = parts.length; i > 0; i--) out.push("/" + parts.slice(0, i).join("/"));
	return out;
}

/**
 * splitReport separates the diagnostics from the `--json` trailer.
 *
 * The trailer is the LAST top-level JSON object in the stream, and everything
 * before it is what the checks actually printed. Parsed defensively: a gate
 * that dies mid-run emits diagnostics and no trailer, and that case has to
 * report the diagnostics rather than an internal parse error.
 */
export function splitReport(stdout: string): { text: string; result: GateResult | null } {
	const start = stdout.lastIndexOf("\n{\n");
	const at = start >= 0 ? start + 1 : stdout.trimStart().startsWith("{") ? 0 : -1;
	if (at < 0) return { text: stdout.trim(), result: null };
	try {
		const result = JSON.parse(stdout.slice(at)) as GateResult;
		if (typeof result.passed !== "boolean") return { text: stdout.trim(), result: null };
		return { text: stdout.slice(0, at).trim(), result };
	} catch {
		return { text: stdout.trim(), result: null };
	}
}

/** Terminal colour, so the model reads findings rather than escape codes. */
export function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * tail keeps the END of the diagnostics when they are too long.
 *
 * The end, not the beginning: the gate prints check-by-check, so the last
 * failure is the one it stopped on, and a head-truncation drops exactly the
 * finding the agent is looking for. Truncation is announced — silently showing
 * part of a report is how an agent concludes a file is clean.
 */
export function tail(s: string, maxLines: number): string {
	const lines = s.split("\n");
	if (lines.length <= maxLines) return s;
	const dropped = lines.length - maxLines;
	return [`[… ${dropped} earlier line(s) omitted — re-run with verbose for all …]`, ...lines.slice(dropped)].join("\n");
}

export interface RenderOptions {
	command: string;
	/**
	 * The child's exit code, or NULL when it never exited.
	 *
	 * Null is not a missing value to be defaulted away: it is the kernel saying
	 * the process died from a signal. Coercing it to 0 (`code ?? 0`) is what
	 * made every killed run indistinguishable from the gate's own "No files
	 * changed" short-circuit — see the terminated branch in render.
	 */
	exitCode: number | null;
	maxLines: number;
	/** Where the gate ran. Only surfaced when the answer is "nothing" — see render. */
	cwd?: string;
	/**
	 * What NARROWED this run — the `only` selector, verbatim.
	 *
	 * Surfaced only in the zero-check branch, where it is the most likely cause:
	 * a selector naming a check this gate does not have selects nothing, and
	 * "nothing" is the one result that must never be reported as a pass.
	 */
	selector?: string;
	/**
	 * How many paths `git status --porcelain` reports in the gated tree, or
	 * undefined when it could not be determined.
	 *
	 * Read ONLY in the zero-check branch, where it settles the question the
	 * message could not previously answer — see render.
	 */
	uncommitted?: number;
	/** The scope this run used (`changed` / `staged` / …), named in the advice. */
	scope?: string;
	/** The mode this run used (`quick` / `standard` / …), named in the ceiling advice. */
	mode?: string;
	/**
	 * The signal that killed the gate, when one did.
	 *
	 * Present ONLY for a run that was terminated. Its presence — not the exit
	 * code — is what tells render that there is no verdict to report, because a
	 * signalled child carries no exit code at all.
	 */
	signal?: string | null;
	/** Wall time the gate ran before it was terminated, when known. */
	elapsedMs?: number;
	/**
	 * The tool's OWN ceiling, in ms, when the ceiling is what fired.
	 *
	 * Set only for a self-inflicted kill: "your gate exceeded MY limit" is
	 * actionable (narrow the run) in a way that "something killed it" is not.
	 */
	ceilingMs?: number;
}

/**
 * What to say when the gate checked nothing and the tree is NOT clean.
 *
 * `staged` reads the INDEX, so an unstaged edit is genuinely invisible to it.
 * That half is still true and still worth saying.
 *
 * `changed` is NOT. This function used to tell its caller that `changed`
 * resolves to `git diff <merge-base>...HEAD` — COMMITTED history only — and to
 * `git add` or commit before re-running. quality-gate `ce86647` (2026-08-18)
 * changed exactly that: `_qg_get_changed_vs_base` now unions the committed diff
 * with `_qg_working_tree_files`, which is `git diff HEAD` plus
 * `git ls-files --others --exclude-standard`, so staged edits, unstaged edits
 * and brand-new untracked files are all in scope.
 *
 * The advice was written FROM the 2026-08-17/19 papercuts and the gate was fixed
 * the day after, so it had been sending people to stage or commit work the gate
 * would already have seen. Measured again on 2026-08-27 (pyERP, blocking):
 * "Its own explanation says `changed` ignores the working tree, so the default
 * scope cannot verify active edits." pyERP's vendored copy is pinned at exactly
 * ce86647, so the correction holds for the repo that generates most of these.
 *
 * The lesson worth keeping: this text describes a DIFFERENT REPOSITORY's
 * behaviour, so it is a constant that has to track a pin, and it will drift
 * again. It now says what the gate does without re-deriving the mechanism, which
 * is the part that goes stale.
 *
 * This is the single largest papercut cluster in the corpus: 16 entries between
 * 2026-08-17 and 08-19, across Aurora and Borealis-Ops, every one of the form
 * "reported Nothing to check while git status showed N modified files in that
 * exact checkout". Several say "in that exact checkout" explicitly, because the
 * message they got blamed the cwd:
 *
 *	If your changes are in a different checkout, re-run with cwd set to it.
 *
 * That advice is right for one cause and wrong for this one, and it was given
 * unconditionally. Sending someone to re-check a path that was already correct
 * is worse than saying nothing — one entry records exactly that dead end
 * ("gave no remediation beyond the cwd already supplied").
 *
 * So the two causes are now separated by the one fact that distinguishes them:
 * whether the tree has uncommitted work. Nothing is guessed — when the count is
 * unknown the old wording stands.
 */
function uncommittedAdvice(count: number, scope?: string): string {
	const files = count === 1 ? "1 uncommitted path" : `${count} uncommitted paths`;
	const seen = `Your working tree has ${files}. `;

	// `staged` is a DIFFERENT list, and telling its caller the merge-base story
	// would be wrong twice over: wrong about the mechanism, and it would end by
	// recommending the scope they just ran. That is the shape of failure this
	// function exists to remove, so it must not reproduce it one scope along.
	//
	// This is also the ONLY branch that may still say "almost certainly the
	// scope": for `staged` a dirty tree really does explain an empty result.
	if (scope === "staged") {
		return (
			seen +
			"That is almost certainly the scope, not the directory: " +
			"`staged` reads the INDEX (`git diff --cached`), so edits you have not `git add`ed are " +
			"invisible to it — an empty index checks nothing even with a dirty tree. " +
			'`git add` the files and re-run, or switch to scope "changed", which reads the ' +
			"working tree directly and needs no staging or commit."
		);
	}
	// `changed` DOES see uncommitted work (quality-gate ce86647), so the tree
	// being dirty no longer explains an empty result — do not send anyone to
	// `git add`. What is left is a scope that resolved to nothing for a reason
	// this function cannot see from here, so name the ways to find out rather
	// than inventing a cause.
	return (
		seen +
		`\`${scope ?? "changed"}\` covers committed work on this branch AND the working tree ` +
		`(modified, staged and new untracked files), so a dirty tree does NOT explain this — ` +
		`do not stage or commit to work around it. Check that the files you expect are in ` +
		`\`git status --short\` here, that the gate resolved a merge base (a detached HEAD or a ` +
		`missing origin ref fails that), and that your paths are not excluded by the project's ` +
		`quality-gate config. Re-run with scope "all" to check the whole repo regardless.`
	);
}

/**
 * render turns a run into what the agent should read.
 *
 * A missing tool is called out separately from a failure, because they mean
 * opposite things: a failure is work to do, a skipped check is a claim the gate
 * did NOT make. Reading "passed" without knowing three checks never ran is how
 * a green gate stops meaning anything.
 */
export function render(text: string, result: GateResult | null, opts: RenderOptions): string {
	const clean = text;
	const out: string[] = [];

	if (!result) {
		// TERMINATED IS NOT AN EMPTY SCOPE, AND IT IS NOT A PASS.
		//
		// This branch has to come first, because a killed gate looks exactly
		// like the short-circuit below once its missing exit code is coerced to
		// 0 — which is what `streamGate` used to do (`code ?? 0`). The result
		// was the single most misleading message this tool has produced: an
		// agent whose `quick` run hit the 300s ceiling mid-check was told the
		// gate "found no files to run against", handed a paragraph about merge
		// bases and quality-gate excludes, and then shown hundreds of lines of
		// the checks that had in fact been running (HIV-2687, P0240/P0815).
		//
		// Nothing here is a diagnosis of the scope, because the scope was never
		// consulted: the run simply did not finish. Deliberately NOT reaching
		// uncommittedAdvice — that paragraph is precisely the dead end.
		if (opts.signal || opts.exitCode === null) {
			const how = opts.signal ? ` (${opts.signal})` : "";
			const after = opts.elapsedMs !== undefined ? ` after ${(opts.elapsedMs / 1000).toFixed(0)}s` : "";
			out.push(
				`NO VERDICT — the gate was terminated${how}${after}, before it finished. Nothing was ` +
					`verified: this is not an empty scope and not a pass.`,
			);
			if (opts.ceilingMs !== undefined) {
				const ceiling = (opts.ceilingMs / 1000).toFixed(0);
				out.push(
					`That was this tool's own ceiling: \`${opts.mode ?? "quick"}\` mode kills the gate at ` +
						`${ceiling}s, and this repo's gate exceeds it. Narrow the run with \`only\`/\`skip\`, ` +
						`or run the repo's gate command directly and let it take as long as it takes.`,
				);
			}
			if (clean) out.push("", tail(clean, opts.maxLines));
			return out.join("\n");
		}
		// A clean exit with no trailer is the gate short-circuiting, not a
		// malfunction: with nothing changed it prints "No files changed" and
		// stops before the summary. Reporting that as an unparseable failure
		// teaches the agent to distrust a tool that is working correctly — and
		// the honest reading is "nothing was checked", which is NOT "it passed".
		if (opts.exitCode === 0) {
			// NAME THE DIRECTORY. "Nothing to check" has two very different
			// causes — there really are no changes, or the gate is looking at
			// the wrong tree — and the message used to be identical for both.
			// An agent whose work sat in a second checkout under
			// ~/.hive/scratch/ read this as "clean" and shipped; it had gated
			// the session's original worktree, which of course had no changes.
			// The path is the one fact that separates the two readings.
			const where = opts.cwd ? ` in ${opts.cwd}` : "";
			// The dirty-tree reading REPLACES the wrong-checkout one rather than
			// joining it: they point opposite ways, and an agent handed both
			// picks the cheaper one to try, which is the one that already failed.
			const why =
				opts.uncommitted !== undefined && opts.uncommitted > 0
					? uncommittedAdvice(opts.uncommitted, opts.scope)
					: `If your changes are in a different checkout, re-run with cwd set to it.`;
			out.push(
				opts.cwd
					? `Nothing to check — the gate found no files to run against${where}. ` +
							`This is NOT a pass: nothing was verified. ${why}`
					: `Nothing to check — the gate had no files to run against.`,
			);
			if (clean) out.push("", tail(clean, opts.maxLines));
			return out.join("\n");
		}
		// A non-zero exit with no trailer is a REAL failure, not a broken tool:
		// the gate stops at the first failing check when fast-fail is on and
		// never reaches its summary. Say that, because "unparseable" invites an
		// agent to dismiss the findings underneath it.
		out.push(`FAIL — the gate stopped before emitting a summary (exit ${opts.exitCode}). Findings:`);
		if (clean) out.push("", tail(clean, opts.maxLines));
		return out.join("\n");
	}

	const failures = result.failures ?? [];
	const missing = result.skipped_missing_tools ?? [];
	const checks = result.checks ?? [];
	// Every emitted check ran. The old `status !== "skipped"` filter was dead
	// code — the gate never emits "skipped"; a check that could not run is
	// reported through skipped_missing_tools instead.
	const ran = checks.length;
	// `warn` keeps passed:true, so without this an advisory finding is invisible
	// and the agent reads an unqualified PASS over a real finding.
	const advisories = checks.filter((c) => c.status === "warn").map((c) => c.name);
	const secs = result.total_duration_ms !== undefined ? ` in ${(result.total_duration_ms / 1000).toFixed(1)}s` : "";

	const advisoryNote = advisories.length ? `, ${advisories.length} advisory` : "";

	// A PASS THAT CHECKED NOTHING IS NOT A PASS.
	//
	// The no-trailer branch above already refuses to call an empty run a pass
	// ("the honest reading is 'nothing was checked'"). This is the same state
	// arriving with a trailer: `passed: true`, `checks: []`. It rendered as
	// `PASS — 0 check(s) in 18.0s`, which an agent quite reasonably read as
	// verification and shipped on.
	//
	// Measured 2026-08-18: `quality_gate(mode:"standard", scope:"staged",
	// only:"schema-bootstrap")` answered exactly that, having dispatched no
	// step at all — the papercut calls a zero-check PASS "unusable", which is
	// generous, because it is worse than unusable: it is a claim.
	//
	// The selector is named because it is the likely cause. `only` naming a
	// check this gate does not have matches nothing, and the gate then has
	// nothing to run and no reason to fail.
	if (result.passed && ran === 0 && failures.length === 0) {
		const where = opts.cwd ? ` in ${opts.cwd}` : "";
		// Naming the MODE is what was missing. In the vendored gate the `only`
		// filter is applied inside the preset test (lib/resolve.sh), so it can
		// only ever narrow the current mode's preset — it cannot reach outside
		// it. `typescript`, `basedpyright`, `mypy` and `vitest` start at
		// `standard`, and `quick` is the default, so the tool's own example
		// selector expands to zero checks on a default call. Measured in a
		// pyERP worktree: `--mode=quick --only=typescript` → 0 checks, after
		// the agent had already waited out the run.
		const because = opts.selector
			? ` The selector \`only=${opts.selector}\` matched no checks in \`${opts.mode ?? "quick"}\` mode. ` +
				`\`only\` narrows the MODE's preset rather than overriding it, so a real check outside ` +
				`this preset selects nothing: \`typescript\`, \`basedpyright\`, \`mypy\` and \`vitest\` ` +
				`start at \`standard\`. Re-run with mode "standard", use \`skip\` instead of \`only\`, or ` +
				`check the name against the gate's own list.`
			: "";
		out.push(
			`NOTHING CHECKED — the gate ran 0 checks${where}${secs}. This is NOT a pass: nothing was ` +
				`verified, so it is not evidence about this code.${because}`,
		);
		if (missing.length) {
			out.push(`not run (tool missing): ${missing.map((m) => (typeof m === "string" ? m : m.tool)).join(", ")}`);
		}
		if (clean) out.push("", tail(clean, opts.maxLines));
		return out.join("\n");
	}

	out.push(
		result.passed
			? `PASS — ${ran} check(s)${advisoryNote}${secs}`
			: `FAIL — ${failures.length} of ${ran} check(s)${advisoryNote}${secs}`,
	);
	if (failures.length) out.push(`failed: ${failures.join(", ")}`);
	// Surfaced in BOTH states. An advisory under a PASS is exactly the finding
	// that would otherwise never be read.
	if (advisories.length) out.push(`advisory (non-blocking): ${advisories.join(", ")}`);
	if (missing.length) {
		// Tolerant of both shapes. The trailer emits objects, but an older gate
		// build emitted bare strings, and a missing tool must never end up
		// unnameable — that is the whole point of this line.
		const named = missing.map((m) => {
			if (typeof m === "string") return m;
			return m.reason ? `${m.tool} — ${m.reason}` : m.tool;
		});
		out.push(`not run (tool missing): ${named.join(", ")} — these checks made no claim about this code`);
	}

	// Diagnostics on a pass too when there were advisories: the finding is in
	// the diagnostics, and a PASS that hides them defeats the line above.
	if ((!result.passed || advisories.length > 0) && clean) out.push("", tail(clean, opts.maxLines));
	return out.join("\n");
}

/**
 * Gate argv for a request.
 *
 * `--json` keeps the machine-readable trailer while per-check diagnostics still
 * stream to stdout, so both are captured.
 *
 * `--no-fast-fail` by DEFAULT, which is the opposite of what a human wants at a
 * pre-commit hook and the right thing here. Measured against the real gate: on
 * fast-fail it prints "QUALITY GATE FAILED" and exits BEFORE the summary is
 * emitted, so there is no trailer at all — and more importantly the agent sees
 * only the first failing check. An agent's cost is round trips, not seconds:
 * fixing one finding, re-running, and discovering the next is strictly worse
 * than being handed all of them at once.
 */
export function gateArgs(o: { mode: string; scope: string; only?: string; skip?: string; stopEarly?: boolean }): string[] {
	const args = [`--mode=${o.mode}`, "--json"];
	if (!o.stopEarly) args.push("--no-fast-fail");
	if (o.scope === "staged") args.push("--staged");
	else if (o.scope === "changed") args.push("--changed");
	else if (o.scope === "all") args.push("--changed", "--lint-all");
	if (o.only) args.push(`--only=${o.only}`);
	if (o.skip) args.push(`--skip=${o.skip}`);
	return args;
}
