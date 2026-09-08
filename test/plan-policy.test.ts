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
		expect(allowed("hive --help")).toBe(false);
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

	it("still denies anything that dispatches, mutates or subscribes", () => {
		for (const tool of ["hive_trigger_run", "hive_propose_k8s_change", "hive_k8s_action_scale", "hive_watch_ticket"]) {
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
