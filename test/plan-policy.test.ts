/**
 * Plan mode's read-only enforcement.
 *
 * This is the file where a mistake is not a bug but a broken promise: plan mode
 * exists so a user can let a model explore without anything happening. Every
 * case below is a way to write to disk that a naive "is the first word on the
 * allowlist?" check waves through.
 *
 * The escape-hatch cases are the point. `cat x > y` never runs `cat`'s writer —
 * the redirect does the damage — so the classifier has to refuse constructs it
 * cannot reason about, not just commands it knows are bad.
 */

import { describe, expect, it } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";
import {
	classifyCommand,
	classifyDiscussionTool,
	classifyOrchestrateCommand,
	classifyOrchestrateTool,
	classifyTool,
	findBlockedSegment,
} from "../extensions/plan/policy.ts";

const allowed = (command: string) => classifyCommand(command).allowed;

describe("tool classification", () => {
	it("allows read-only builtins and denies writers", () => {
		expect(classifyTool("read").allowed).toBe(true);
		expect(classifyTool("grep").allowed).toBe(true);
		expect(classifyTool("edit").allowed).toBe(false);
		expect(classifyTool("write").allowed).toBe(false);
	});

	it("denies an unrecognized tool rather than assuming it is safe", () => {
		// The blast radius argument: this harness loads hive, linear, kubernetes,
		// borealis and playwright MCP servers. Defaulting unknown to "allow" puts
		// kubectl_delete one model mistake away from running in a read-only mode.
		const verdict = classifyTool("mcp__kubernetes__kubectl_delete");
		expect(verdict.allowed).toBe(false);
		expect(verdict.allowed === false && verdict.reason).toContain("read-only allowlist");
	});

	// An MCP tool is allowed only by EXACT name from the house profile, never by
	// server prefix — the list asserts somebody read that tool's implementation,
	// and a prefix would extend the claim to every tool the server grows later.
	it("allows a profile-reviewed MCP tool by exact name, and nothing else on that server", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["alpha_read_metrics"] });
		try {
			expect(classifyDiscussionTool("mcp", { tool: "alpha_read_metrics", args: {} }).allowed).toBe(true);
			expect(classifyDiscussionTool("mcp", { tool: "alpha_start_trading", args: {} }).allowed).toBe(false);
		} finally {
			setHouseProfileForTest(null);
		}
	});

	it("allows this extension's own tools", () => {
		expect(classifyTool("plan_write").allowed).toBe(true);
		expect(classifyTool("plan_ask").allowed).toBe(true);
	});

	it("allows the advisor, which the conductor asks for before plan_ready", () => {
		// A consultation is one plain completion — no tools, no session, no way to
		// recurse — so it is read-only by construction. Denying it did not read as
		// a denial: `setActiveTools` dropped the tool from the prompt, the model
		// reported the advisor "unavailable" and improvised
		// `subagent(agent: "advisor")`, which failed on an unknown role. The
		// conductor's pre-`plan_ready` review was silently skipped every time.
		expect(classifyTool("advisor").allowed).toBe(true);
	});
});

describe("shell — plain read-only commands", () => {
	it("allows ordinary inspection", () => {
		expect(allowed("ls -la src")).toBe(true);
		expect(allowed("cat package.json")).toBe(true);
		expect(allowed("rg --files-with-matches TODO")).toBe(true);
		expect(allowed("wc -l extensions/plan/state.ts")).toBe(true);
	});

	it("allows a pipeline of readers", () => {
		expect(allowed("cat package.json | jq .name")).toBe(true);
		expect(allowed("ls src && ls test")).toBe(true);
	});

	it("denies known mutators outright", () => {
		expect(allowed("rm -rf /")).toBe(false);
		expect(allowed("mv a b")).toBe(false);
		expect(allowed("chmod 777 file")).toBe(false);
		expect(allowed("sudo anything")).toBe(false);
	});

	it("denies build and deploy tooling that mutates a tree or a cluster", () => {
		expect(allowed("npm install")).toBe(false);
		expect(allowed("uv sync")).toBe(false);
		expect(allowed("docker build .")).toBe(false);
		expect(allowed("kubectl delete pod x")).toBe(false);
	});
});

describe("shell — the escape hatches", () => {
	it("refuses redirects, which write without any writer command", () => {
		expect(allowed("cat a > b")).toBe(false);
		expect(allowed("echo hi >> notes.md")).toBe(false);
		expect(allowed("cat < input")).toBe(false);
	});

	it("refuses command substitution and subshells", () => {
		expect(allowed("echo $(rm -rf /)")).toBe(false);
		expect(allowed("echo `rm -rf /`")).toBe(false);
		expect(allowed("(cd /tmp && rm x)")).toBe(false);
	});

	it("refuses backgrounding and newlines", () => {
		expect(allowed("sleep 1 &")).toBe(false);
		expect(allowed("ls\nrm -rf /")).toBe(false);
	});

	it("refuses variable assignment prefixes", () => {
		expect(allowed("FOO=bar ls")).toBe(false);
	});

	it("refuses an unbalanced quote rather than guessing", () => {
		expect(allowed("cat 'unterminated")).toBe(false);
	});

	it("blocks the whole command when any one segment is unsafe", () => {
		expect(allowed("ls && rm -rf /")).toBe(false);
		expect(allowed("cat a | tee b")).toBe(false);
	});
});

describe("shell — in-place flags turn readers into writers", () => {
	it("refuses sed -i in every spelling", () => {
		expect(allowed("sed -i s/a/b/ file")).toBe(false);
		expect(allowed("sed --in-place=.bak s/a/b/ file")).toBe(false);
		expect(allowed("sed -ri s/a/b/ file")).toBe(false); // bundled short flags
	});

	it("allows sed without -i", () => {
		expect(allowed("sed -n 1,20p file")).toBe(true);
	});

	it("refuses find -exec and -delete", () => {
		expect(allowed("find . -name '*.tmp' -delete")).toBe(false);
		expect(allowed("find . -exec rm {} ;")).toBe(false);
		expect(allowed("find . -name x")).toBe(true);
	});

	it("refuses sort -o and date -s", () => {
		expect(allowed("sort -o out.txt in.txt")).toBe(false);
		expect(allowed("date -s '2020-01-01'")).toBe(false);
		expect(allowed("sort in.txt")).toBe(true);
	});
});

describe("shell — git and gh are classified by subcommand", () => {
	it("allows read-only git verbs", () => {
		expect(allowed("git status")).toBe(true);
		expect(allowed("git log --oneline -10")).toBe(true);
		expect(allowed("git diff HEAD")).toBe(true);
		expect(allowed("git worktree list")).toBe(true);
	});

	it("denies git verbs that change the repository", () => {
		expect(allowed("git commit -m x")).toBe(false);
		expect(allowed("git push")).toBe(false);
		expect(allowed("git checkout -b new")).toBe(false);
		expect(allowed("git reset --hard")).toBe(false);
		expect(allowed("git worktree add ../x")).toBe(false);
	});

	it("reaches the verb past global flags", () => {
		expect(allowed("git -C /repo status")).toBe(true);
		expect(allowed("git -C /repo push")).toBe(false);
	});

	it("allows read-only gh paths and denies the rest", () => {
		expect(allowed("gh pr view 12")).toBe(true);
		expect(allowed("gh pr list")).toBe(true);
		expect(allowed("gh pr merge 12")).toBe(false);
		expect(allowed("gh pr create")).toBe(false);
	});
});

describe("shell — hive is classified by subcommand", () => {
	// `hive` was in neither allowlist, so isSafeStructured fell through to
	// `return false` and every CI read was refused. MEASURED 2026-08-21..24: 14
	// of the 31 commands plan mode blocked on this workstation were these.
	// "Why is this PR red" is a planning question.
	it("allows the CI read verbs a plan actually needs", () => {
		expect(allowed("hive get 4928 --project hive --pipeline ci")).toBe(true);
		expect(allowed("hive get e90ebbae-6958-4659-85f5-698ae9cc4d9a")).toBe(true);
		expect(allowed("hive explain 5356 --project hive --pipeline ci")).toBe(true);
		expect(allowed("hive runs --project hive --branch feature/x")).toBe(true);
		expect(allowed("hive wait 4928 --project hive")).toBe(true);
		expect(allowed("hive watch 4928")).toBe(true);
		expect(allowed("hive tasklog 4928 test-3 --tail 50")).toBe(true);
		expect(allowed("hive insights")).toBe(true);
		expect(allowed("hive papercuts --days 7")).toBe(true);
	});

	// The same binary mutates, and these are the verbs that make an allowlist
	// necessary rather than a `hive` prefix. `check` is the one worth naming
	// twice: it reads as a read and it DISPATCHES A RUN.
	it("denies every verb that can change something", () => {
		expect(allowed("hive check --step lint")).toBe(false);
		expect(allowed("hive check --full")).toBe(false);
		expect(allowed("hive retry 4928")).toBe(false);
		expect(allowed("hive cancel 4928")).toBe(false);
		expect(allowed("hive trigger --project hive --pipeline ci")).toBe(false);
		expect(allowed("hive worktrees reap --apply")).toBe(false);
		expect(allowed("hive hygiene hive")).toBe(false);
	});

	it("classifies the linear group by its NESTED verb", () => {
		expect(allowed("hive linear get HIV-2113")).toBe(true);
		expect(allowed("hive linear report --title x")).toBe(false);
		// The group alone commits to nothing, so it cannot be approved.
		expect(allowed("hive linear")).toBe(false);
	});

	it("reaches the verb past global flags, and refuses a bare invocation", () => {
		expect(allowed("hive --json get 4928")).toBe(true);
		expect(allowed("hive --json retry 4928")).toBe(false);
		expect(allowed("hive")).toBe(false);
		// hive's own usage is printed by the top-level dispatch before any
		// command runs (cmd/hive/main.go), so it is a read; a verb's --help is
		// not, unless the verb is itself a read.
		expect(allowed("hive --help")).toBe(true);
		expect(allowed("hive retry --help")).toBe(false);
	});
});

describe("the blocked segment is named", () => {
	it("returns the offending segment so a deny can explain itself", () => {
		// A model told only "blocked" retries the same command.
		expect(findBlockedSegment("ls && rm -rf /")).toBe("rm -rf /");
		expect(findBlockedSegment("ls -la")).toBeUndefined();
	});

	it("names the whole command when it cannot be parsed", () => {
		expect(findBlockedSegment("echo `whoami`")).toBe("echo `whoami`");
	});
});

/**
 * Orchestrate mode must be able to SEE the work it is supervising.
 *
 * The mode's promise is "the lead never implements", not "the lead never
 * reads". Each case below was refused in a live session and filed as a
 * papercut: the lead could call `hive_get_run` but not `hive_get_run_tests`,
 * `hive_list_pulls` but not `hive_list_runs` — arbitrary holes in one read
 * surface. The shell cases are the same shape one layer down, and the tmux one
 * cost the most: `diagnose_agent_session` reports a worker's state from the
 * RECORD, so when it says "attached/idle" the pane is the only place the real
 * provider error exists.
 */
describe("orchestrate — reads the mode needs to supervise", () => {
	const orchestrated = (command: string) => classifyOrchestrateCommand(command).allowed;
	const bothEnvelopes = (tool: string) =>
		classifyOrchestrateTool(tool, {}).allowed && classifyOrchestrateTool("mcp", { tool }).allowed;

	it("permits the read-only Hive queries under BOTH calling conventions", () => {
		// Direct and wrapped are the same operation; #52 established the rule and
		// these six were simply missing from the list it consults.
		for (const tool of [
			"hive_list_runs",
			"hive_get_run_tests",
			"hive_get_agent_command",
			"hive_get_agent_spend",
			"hive_get_factory_provider_limits",
			"hive_list_credential_catalog",
		]) {
			expect(bothEnvelopes(tool), tool).toBe(true);
		}
	});

	it("permits the coordination surfaces the second papercut pass found refused", () => {
		// The board is the coordination surface the house rules REQUIRE a lead
		// to read and answer; a pipeline preview inserts no run; a priority bump
		// dispatches nothing; the Linear reads are the inventory step. Each was
		// refused in a live orchestrate session in the week to 2026-09-10.
		for (const tool of [
			"hive_list_communications",
			"hive_get_communication",
			"hive_reply_communication",
			"hive_encounter_communication",
			"hive_evaluate_pipeline",
			"hive_prioritize_run",
			"hive_set_run_priority",
			"hive_get_pull_comments",
			"hive_get_run_reports",
			"linear_list_issues",
			"linear_get_issue",
			"linear_list_comments",
		]) {
			expect(bothEnvelopes(tool), tool).toBe(true);
		}
	});

	it("still denies anything that dispatches, mutates or subscribes", () => {
		for (const tool of [
			"hive_trigger_run",
			"hive_propose_k8s_change",
			"hive_k8s_action_scale",
			// The Linear WRITE half stays a visible teammate's decision.
			"linear_save_issue",
			"linear_delete_comment",
		]) {
			expect(classifyOrchestrateTool(tool, {}).allowed, tool).toBe(false);
			expect(classifyOrchestrateTool("mcp", { tool }).allowed, `mcp ${tool}`).toBe(false);
		}
	});

	it("reads a worker's pane, in both spellings of the socket flag", () => {
		expect(orchestrated("tmux -L hive-agent capture-pane -p -t hive-tes-9051 -S -60")).toBe(true);
		expect(orchestrated("tmux -Lhive-agent capture-pane -p -t hive-tes-9051")).toBe(true);
		expect(orchestrated("tmux -L hive-agent list-panes")).toBe(true);
		expect(orchestrated("tmux ls")).toBe(true);
	});

	it("refuses every tmux verb that reaches execution in someone else's session", () => {
		expect(orchestrated("tmux -L hive-agent send-keys -t hive-x 'rm -rf /' Enter")).toBe(false);
		expect(orchestrated("tmux kill-session -t hive-x")).toBe(false);
		expect(orchestrated("tmux -L hive-agent new-session claude")).toBe(false);
		expect(orchestrated("tmux run-shell 'touch /tmp/pwned'")).toBe(false);
		expect(orchestrated("tmux source-file /tmp/evil.conf")).toBe(false);
		// No verb at all commits to nothing, so it cannot be approved.
		expect(orchestrated("tmux -L hive-agent")).toBe(false);
	});

	it("queries remote refs, which writes nothing locally", () => {
		expect(orchestrated("git ls-remote origin refs/backups/tes-9049/original-250f62ad")).toBe(true);
		expect(allowed("git ls-remote origin")).toBe(true);
		// `-o` still turns it into a writer.
		expect(orchestrated("git ls-remote origin -o /tmp/out")).toBe(false);
	});

	it("permits `gh api` only while it is a GET", () => {
		expect(orchestrated("gh api repos/Artifex-org/pyERP/issues/10093/events --paginate")).toBe(true);
		expect(orchestrated("gh api -X GET repos/o/r/issues/1/events")).toBe(true);
		// A method or a field is what makes it write — not the path.
		expect(orchestrated("gh api -X POST repos/o/r/issues/1/comments")).toBe(false);
		expect(orchestrated("gh api -XDELETE repos/o/r/issues/1")).toBe(false);
		expect(orchestrated("gh api --method PATCH repos/o/r")).toBe(false);
		expect(orchestrated("gh api repos/o/r --input body.json")).toBe(false);
		// `-f query=mutation{…}` reaches every GraphQL mutation there is.
		expect(orchestrated("gh api graphql -f query=mutation{x}")).toBe(false);
	});
});

describe("orchestrate — fourth papercut pass (2026-09-28..10-04)", () => {
	const orchestrated = (command: string) => classifyOrchestrateCommand(command).allowed;
	const bothEnvelopes = (tool: string) =>
		classifyOrchestrateTool(tool, {}).allowed && classifyOrchestrateTool("mcp", { tool }).allowed;

	it("permits capacity reads, Hive bug reports and ticket comments", () => {
		// hive_list_clusters: refused 3x while reading agent_lane capacity before
		// a launch. hive_report_issue: "blocks filing a Hive product bug from the
		// controller". linear_save_comment: a handoff comment, the Linear twin of
		// the already-permitted hive_comment_ticket. hive_get_test_pg_health: a
		// fleet read the lead needed to decide whether a run could start.
		for (const tool of ["hive_list_clusters", "hive_report_issue", "linear_save_comment", "hive_get_test_pg_health"]) {
			expect(bothEnvelopes(tool), tool).toBe(true);
		}
	});

	it("does not mistake a jq comparison inside quotes for a variable assignment", () => {
		// `length==2` matched the VAR= prefix check, which scanned quoted text.
		expect(orchestrated(`jq -r 'select(.ok and length==2)' f.json`)).toBe(true);
		expect(allowed(`jq -r 'select(.ok and length==2)' f.json`)).toBe(true);
		// jq's own $variables inside single quotes are not shell expansions.
		expect(orchestrated(`jq --arg t low -r '.[] | select(.mode_key == $t)' f.json`)).toBe(true);
		// A REAL prefix assignment is still refused: it can inject GIT_EXTERNAL_DIFF,
		// PAGER and friends into an allowed reader.
		expect(orchestrated("GIT_EXTERNAL_DIFF=/tmp/x git diff")).toBe(false);
		expect(allowed("PAGER=/tmp/x git log")).toBe(false);
		expect(allowed("ls; X=1 cat f")).toBe(false);
		// And a double-quoted $ is a real shell expansion.
		expect(orchestrated(`jq ".x | $t" f`)).toBe(false);
	});

	it("accepts one trailing semicolon, and nothing else dangling", () => {
		expect(orchestrated("date -u; gh pr view 7998 --json title --jq '{t: .title}';")).toBe(true);
		expect(allowed("ls;")).toBe(true);
		expect(allowed("ls |")).toBe(false);
		expect(allowed("ls &&")).toBe(false);
		expect(allowed("ls ;;")).toBe(false);
		expect(allowed("ls; ; cat f")).toBe(false);
	});

	it("lists and shows stashes, and nothing that changes them", () => {
		expect(orchestrated("git -C /repo/wt stash list")).toBe(true);
		expect(allowed("git stash list")).toBe(true);
		expect(orchestrated("git stash show -p stash@{0}")).toBe(true);
		// A reader verb with a writer flag is a writer.
		expect(allowed("git stash show -p --output=/tmp/x")).toBe(false);
		expect(allowed("git diff --output=/tmp/x")).toBe(false);
		expect(orchestrated("git stash show -p --output=/tmp/x")).toBe(false);
		for (const command of ["git stash", "git stash push", "git stash pop", "git stash drop", "git stash clear", "git stash apply"]) {
			expect(orchestrated(command), command).toBe(false);
			expect(allowed(command), command).toBe(false);
		}
	});

	it("reads branches, and refuses the verbs that create, move or delete them", () => {
		expect(orchestrated("git -C /repo/wt branch --show-current")).toBe(true);
		expect(orchestrated("git branch -r --list 'origin/feature/asf-3883' 'origin/feature/asf-3435'")).toBe(true);
		expect(orchestrated("git branch -vv")).toBe(true);
		for (const command of ["git branch new-thing", "git branch -D old", "git branch -m a b", "git branch --set-upstream-to=origin/x", "git branch -f main HEAD~1", "git branch --format='%(refname)' newb", "git branch --sort=refname newb"]) {
			expect(orchestrated(command), command).toBe(false);
			expect(allowed(command), command).toBe(false);
		}
	});

	it("deduplicates with sort, and refuses every way sort writes or executes", () => {
		expect(orchestrated("grep -h foo a b | sort -u")).toBe(true);
		expect(orchestrated("sort -u -o out f")).toBe(false);
		expect(orchestrated("sort -uo out f")).toBe(false);
		expect(allowed("sort -uo out f")).toBe(false);
		expect(allowed("sort --output=out f")).toBe(false);
		// GNU sort runs the compressor program when it spills to temp files.
		expect(orchestrated("sort -S 1K --compress-program=./x.sh big.txt")).toBe(false);
		expect(allowed("sort --compress-program ./x.sh big.txt")).toBe(false);
	});

	it("refuses reader flags that RUN a program, in every posture", () => {
		for (const command of [
			"rg --pre ./x.sh foo",
			"rg --pre=./x.sh foo",
			"bat --pager ./x.sh f",
			"bat --pager=./x.sh f",
			"git grep -O./x.sh foo",
			"git grep --open-files-in-pager=./x.sh foo",
			"git diff --ext-diff",
			"git log -p --textconv",
		]) {
			expect(allowed(command), command).toBe(false);
			expect(orchestrated(command), command).toBe(false);
		}
		expect(allowed("rg foo")).toBe(true);
		expect(allowed("git grep -n foo")).toBe(true);
	});

	it("prints hive's own help, but not a verb's", () => {
		expect(orchestrated("hive --help")).toBe(true);
		expect(orchestrated("hive help")).toBe(true);
		expect(allowed("hive -h")).toBe(true);
		// A verb's --help is only inert if that verb parses flags before acting,
		// which this policy cannot prove for every hive command.
		expect(orchestrated("hive ssh --help")).toBe(false);
	});

	it("keeps refusing git fetch, and says what to use instead", () => {
		// fetch writes FETCH_HEAD and the remote-tracking refs every worktree of
		// the repository shares — a lead's fetch moves origin/* under its workers.
		const verdict = classifyOrchestrateCommand("git fetch origin main");
		expect(verdict.allowed).toBe(false);
		expect(verdict.allowed === false && verdict.reason).toMatch(/git ls-remote/);
	});
});

describe("orchestrate — supervised transcript read (2026-10-04 papercut sweep)", () => {
	const bothEnvelopes = (tool: string) =>
		classifyOrchestrateTool(tool, {}).allowed && classifyOrchestrateTool("mcp", { tool }).allowed;

	it("permits the reviewed read-only transcript operation under every envelope", () => {
		// Root 1d6c9048 was refused `mcp__hive__read_agent_transcript` on its
		// controlled verifier: "not on orchestrate mode's coordination
		// allowlist". The adapter form, the native pi form, and the `mcp`
		// wrapper are the same operation; the allowlist is keyed by operation,
		// not envelope (#52 rule). The wrapper speaks adapter-form names by
		// convention — even long-allowed tools are refused in wrapper-native
		// form — so the matrix below pins the adapter wrapper only. What this
		// repo can pin is the policy decision per name; that codemode-nested
		// calls actually pass through this classifier is pi's tool_call
		// contract (_executeNestedToolCall → _beforeToolCall), not this
		// policy's, and is covered by pi's own tests.
		for (const tool of ["hive_read_agent_transcript", "mcp__hive__read_agent_transcript"]) {
			expect(classifyOrchestrateTool(tool, {}).allowed, tool).toBe(true);
		}
		expect(bothEnvelopes("hive_read_agent_transcript"), "mcp wrapper").toBe(true);
	});

	it("still refuses neighbours the review did not cover", () => {
		// Exact names, never a prefix: a `hive_get_*` or `hive_read_*` prefix
		// would silently admit every tool the server grows afterwards.
		for (const tool of [
			"hive_trigger_run", // generic run trigger: implementation, not supervision
			"mcp__hive__trigger_run",
			"hive_read_agent_transcripts", // unknown operation: near-miss spelling
			"hive_read_agent", // prefix fragment, not a reviewed tool
			"mcp__other__read_agent_transcript", // foreign server, same suffix
			"linear_save_issue", // unreviewed write stays out
		]) {
			expect(classifyOrchestrateTool(tool, {}).allowed, tool).toBe(false);
			expect(classifyOrchestrateTool("mcp", { tool }).allowed, `mcp ${tool}`).toBe(false);
		}
	});
});

describe("independent review of #104: bypasses verified under bash -c and git 2.55", () => {
	const orchestrated = (command: string) => classifyOrchestrateCommand(command).allowed;
	const refusedEverywhere = (commands: string[]) => {
		for (const command of commands) {
			expect(allowed(command), `plan: ${command}`).toBe(false);
			expect(orchestrated(command), `orchestrate: ${command}`).toBe(false);
		}
	};

	it("C1/C2: a unique PREFIX of a refused long option is the option (GNU getopt, git parse-options)", () => {
		refusedEverywhere([
			"sort --o=/tmp/pwn in.txt",
			"sort --out /tmp/pwn in.txt",
			"sort --compress=/path/prog -S 64k big.txt",
			"sort --comp /path/prog big.txt",
			"git grep --open='touch X' b",
			"git diff --out=/tmp/x",
			"git log -p --ext",
			"git show --textc HEAD",
		]);
		expect(allowed("date --se='2001-01-01'")).toBe(false);
		// A long option that is NOT a prefix of a refused one still reads.
		expect(allowed("grep --only-matching foo f")).toBe(true);
		expect(allowed("git log --oneline")).toBe(true);
		expect(allowed("date --utc")).toBe(true);
	});

	it("C3: unquoted brace expansion is refused, @{…} reflog syntax is not", () => {
		refusedEverywhere([
			"sort {-o,/tmp/pwn} in.txt",
			"git diff {--output=/tmp/x,HEAD}",
			"find . -maxdepth 0 {-exec,touch,F,\\;}",
			"cat f{1..3}",
		]);
		expect(orchestrated("git stash show -p stash@{0}")).toBe(true);
		expect(allowed("git log -1 HEAD@{1}")).toBe(true);
		expect(allowed("jq -r '{a: .b}' f.json")).toBe(true);
	});

	it("tmux: a `;` argument chains a second command", () => {
		refusedEverywhere(["tmux -L x list-panes \\; run-shell 'touch F'", "tmux list-panes ';' kill-server", "tmux ls\\;"]);
	});

	it("uniq: a second operand is an OUTPUT file", () => {
		refusedEverywhere(["uniq in out"]);
		expect(allowed("uniq -c in")).toBe(true);
		expect(orchestrated("sort f | uniq -c")).toBe(true);
	});

	it("git ls-remote: --upload-pack / -u run a program", () => {
		refusedEverywhere(["git ls-remote --upload-pack='touch X' .", "git ls-remote --upl='touch X' .", "git ls-remote -u 'touch X' .", "git ls-remote -u'touch X' ."]);
		expect(orchestrated("git ls-remote origin main")).toBe(true);
	});

	it("git remote: only listing and show/get-url", () => {
		for (const command of ["git remote add x /tmp/r", "git remote remove origin", "git remote set-url origin /tmp/r", "git remote update", "git remote prune origin", "git remote rename origin x"]) {
			expect(allowed(command), command).toBe(false);
		}
		expect(allowed("git remote -v")).toBe(true);
		expect(allowed("git remote get-url origin")).toBe(true);
		expect(allowed("git remote show origin")).toBe(true);
	});

	it("git config: only explicit reads", () => {
		for (const command of ["git config user.name user.name", "git config -e", "git config --edit", "git config --ed", "git config edit", "git config set user.name x", "git config --unset user.name", "git config --add a.b c"]) {
			expect(allowed(command), command).toBe(false);
		}
		expect(allowed("git config user.name")).toBe(true);
		expect(allowed("git config --get user.name")).toBe(true);
		expect(allowed("git config --get-regexp '^remote\\.'")).toBe(true);
		expect(allowed("git config --list --show-origin")).toBe(true);
		expect(allowed("git config get user.name")).toBe(true);
	});

	it("awk, fd and yq: their execute and in-place forms", () => {
		for (const command of [
			"awk 'BEGIN{system(\"touch F\")}'",
			"awk '{print > \"out\"}' f",
			"awk '{print | \"sh\"}' f",
			"awk '{ \"date\" | getline d }' f",
			"fd -x touch",
			"fd --exec touch",
			"fd -X rm",
			"fd --exec-batch rm",
			"yq --inplace '.a = 1' f.yaml",
			"yq -Pi '.a = 1' f.yaml",
			"sed -n 'w /tmp/x' f",
			"sed 's/a/b/w /tmp/x' f",
			"sed 'e touch F' f",
			"sed '1e touch F' f",
			"file -C -m x",
		]) {
			expect(allowed(command), command).toBe(false);
		}
		expect(allowed("awk '{print $1}' f")).toBe(true);
		expect(allowed("fd -e ts src")).toBe(true);
		expect(allowed("yq '.a' f.yaml")).toBe(true);
		expect(allowed("sed -n '1,100p' f")).toBe(true);
		expect(allowed("sed -n '/start/,/end/p' f")).toBe(true);
		expect(allowed("sed 's/a/b/g' f")).toBe(true);
	});
});

describe("native MCP names (HIV-3745)", () => {
	// pi's built-in MCP names a server tool `mcp__<server>__<tool>`. Every list
	// here is keyed by the adapter form; a rename that missed one would fail
	// CLOSED and silently — the mode denying the verb it exists to permit.
	it("orchestrate permits the native name of every reviewed coordination tool", () => {
		expect(classifyOrchestrateTool("mcp__hive__message_teammate", {}).allowed).toBe(true);
		expect(classifyOrchestrateTool("mcp__hive__wait_for_run", {}).allowed).toBe(true);
		expect(classifyOrchestrateTool("mcp__linear__list_issues", {}).allowed).toBe(true);
		// …and still denies what was never reviewed.
		expect(classifyOrchestrateTool("mcp__hive__trigger_run", {}).allowed).toBe(false);
		expect(classifyOrchestrateTool("mcp__linear__save_issue", {}).allowed).toBe(false);
	});

	it("orchestrate maps a native misname onto the real coordination tool", () => {
		const verdict = classifyOrchestrateTool("mcp__hive__interrupt_agent", {});
		expect(verdict.allowed).toBe(false);
		expect(verdict.allowed ? "" : verdict.reason).toContain("hive_steer_agent");
	});

	it("discussion permits its read-only cards under their native names", () => {
		expect(classifyDiscussionTool("mcp__hive__get_run", {}).allowed).toBe(true);
		expect(classifyDiscussionTool("mcp__hive__cancel_run", {}).allowed).toBe(false);
	});

	it("discussion honours the house profile's reviewed tools under native names", () => {
		setHouseProfileForTest({ readOnlyMcpTools: ["asfam_asfam_deploy_last"] });
		try {
			expect(classifyDiscussionTool("mcp__asfam__asfam_deploy_last", {}).allowed).toBe(true);
			expect(classifyDiscussionTool("mcp__asfam__asfam_strategy_stop", {}).allowed).toBe(false);
		} finally {
			setHouseProfileForTest(null);
		}
	});

	it("plan mode never allows a native MCP tool by name — only the gateway", () => {
		expect(classifyTool("mcp__hive__get_run").allowed).toBe(false);
		// The gateway is allowed because each nested call it makes is classified
		// by this same policy through the tool_call pipeline.
		expect(classifyTool("codemode").allowed).toBe(true);
		expect(classifyTool("tool_search").allowed).toBe(true);
	});
});
