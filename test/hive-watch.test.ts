/**
 * The Hive/Linear data layer behind the footer. These cover the three places
 * where a wrong answer would look completely plausible on screen:
 *
 *   - pipelineFacts picking the wrong pipeline, or counting superseded runs
 *   - buildOrFilter's nesting, where the wrong shape returns EVERY team issue
 *   - extractIssueKeys turning `fix/utf-8` into a ticket lookup
 */

import { describe, expect, it } from "vitest";
import { credentialsFromEnv, mapRun, matchesProject, pickMine, pipelineFacts } from "../extensions/status-footer/hive.ts";
import {
	buildOrFilter,
	extractIssueKeys,
	type LinearIssue,
	mergeIssues,
	tokenFromEnv,
} from "../extensions/status-footer/linear.ts";
import { parsePullView, repoNameFromRemote, sameWorkspace } from "../extensions/status-footer/workspace.ts";

describe("repoNameFromRemote", () => {
	it("handles both remote spellings and strips .git", () => {
		expect(repoNameFromRemote("git@github.com:Artifex-org/hive-pi.git")).toBe("hive-pi");
		expect(repoNameFromRemote("https://github.com/Artifex-org/hive-pi")).toBe("hive-pi");
		expect(repoNameFromRemote("https://github.com/Artifex-org/hive-pi/")).toBe("hive-pi");
		expect(repoNameFromRemote("")).toBeNull();
	});
});

describe("parsePullView", () => {
	it("reads a pull request and treats a missing one as no PR", () => {
		expect(parsePullView('{"number":2419,"url":"https://x/pull/2419","title":"HIV-1067 fix"}')).toEqual({
			pr: 2419,
			prUrl: "https://x/pull/2419",
			prTitle: "HIV-1067 fix",
		});
		// `gh pr view` fails outside a PR branch, so the caller passes null.
		expect(parsePullView(null)).toEqual({ pr: null, prUrl: null, prTitle: null });
		expect(parsePullView("not json")).toEqual({ pr: null, prUrl: null, prTitle: null });
		expect(parsePullView("{}")).toEqual({ pr: null, prUrl: null, prTitle: null });
	});
});

describe("sameWorkspace", () => {
	const base = { cwd: "/w", repo: "hive", branch: "main", pr: 1, prUrl: null, prTitle: null };
	it("notices a new PR on the same branch", () => {
		expect(sameWorkspace(base, { ...base })).toBe(true);
		expect(sameWorkspace(base, { ...base, pr: 2 })).toBe(false);
		expect(sameWorkspace(base, { ...base, branch: "other" })).toBe(false);
	});
	it("ignores PR metadata that does not change the watch target", () => {
		expect(sameWorkspace(base, { ...base, prTitle: "retitled" })).toBe(true);
	});
});

describe("credentials", () => {
	it("treats blank or missing environment as unconfigured", () => {
		expect(credentialsFromEnv({ HIVE_URL: "https://h", HIVE_TOKEN: "t" })).toEqual({ url: "https://h", token: "t" });
		expect(credentialsFromEnv({ HIVE_URL: "https://h/", HIVE_TOKEN: "t" })?.url).toBe("https://h");
		expect(credentialsFromEnv({ HIVE_URL: "https://h" })).toBeNull();
		expect(credentialsFromEnv({ HIVE_URL: "  ", HIVE_TOKEN: "t" })).toBeNull();
		expect(tokenFromEnv({})).toBeNull();
		expect(tokenFromEnv({ LINEAR_API_TOKEN: "lin" })).toBe("lin");
	});
});

describe("mapRun", () => {
	it("keeps only the summary fields and drops the dag snapshot", () => {
		const run = mapRun({
			id: "r1",
			number: 12,
			state: "running",
			pipeline: "ci",
			branch: "feature",
			pr: 8107,
			is_factory: false,
			tasks_summary: { total: 9, succeeded: 2, failed: 0, running: 2, pending: 5, skipped: 0 },
			tests_summary: { total: 273, passed: 273, failed: 0 },
			created_at: "2026-08-05T14:00:00Z",
			// A real response also carries ~14 KB of dag_snapshot here.
		});
		expect(run).not.toBeNull();
		expect(Object.keys(run as object)).not.toContain("dag_snapshot");
		expect(run?.tasks).toEqual({ total: 9, succeeded: 2, failed: 0, running: 2, pending: 5 });
		expect(run?.tests).toEqual({ total: 273, passed: 273, failed: 0 });
	});

	it("rejects a run without the fields the footer needs", () => {
		expect(mapRun({ number: 1, state: "running" })).toBeNull();
		expect(mapRun({ id: "r", state: "running" })).toBeNull();
	});

	it("survives a run with no task or test summary yet", () => {
		const run = mapRun({ id: "r", number: 1, state: "pending", tasks_summary: null, tests_summary: null });
		expect(run?.tasks).toBeNull();
		expect(run?.tests).toBeNull();
	});
});

describe("pipelineFacts", () => {
	const history = (...states: string[]) => states.map((state) => ({ state }));

	it("prefers the ci pipeline and reads its default branch", () => {
		const facts = pipelineFacts([
			{ pipeline: "e2e", default_branch: "feature", runs: 9000, history: history("failed") },
			{ pipeline: "ci", default_branch: "feature", runs: 10, history: history("succeeded", "failed") },
		]);
		expect(facts.gate).toBe("ci");
		expect(facts.defaultBranch).toBe("feature");
		expect(facts.health).toEqual({ passed: 1, total: 2 });
	});

	it("ignores ad-hoc bookkeeping pipelines, which outrank real ones on run count", () => {
		const facts = pipelineFacts([
			{ pipeline: "__template__", default_branch: "feature", runs: 1204, ad_hoc: true, history: history("succeeded") },
			{ pipeline: "__image__", default_branch: "feature", runs: 845, ad_hoc: true, history: history("succeeded") },
			{ pipeline: "gate", default_branch: "feature", runs: 30, history: history("succeeded") },
		]);
		expect(facts.gate).toBe("gate");
	});

	it("excludes canceled runs from health — a superseded run is not a verdict", () => {
		const facts = pipelineFacts([
			{ pipeline: "ci", default_branch: "main", runs: 5, history: history("succeeded", "canceled", "canceled", "failed") },
		]);
		expect(facts.health).toEqual({ passed: 1, total: 2 });
	});

	it("reports no health rather than 0/0 when nothing has finished", () => {
		expect(pipelineFacts([{ pipeline: "ci", runs: 1, history: history("canceled") }]).health).toBeNull();
		expect(pipelineFacts([]).gate).toBeNull();
	});
});

describe("pickMine", () => {
	const run = (id: string, state: string, isFactory = false, createdAt = "2026-08-05T10:00:00Z") =>
		mapRun({ id, number: 1, state, pipeline: isFactory ? "fix" : "ci", is_factory: isFactory, created_at: createdAt })!;

	it("tracks the run that is still moving", () => {
		expect(pickMine([run("a", "succeeded"), run("b", "running")])?.id).toBe("b");
	});

	it("prefers the gate over the autofix agent working on the same PR", () => {
		expect(pickMine([run("fix", "running", true), run("ci", "running")])?.id).toBe("ci");
	});

	it("falls back to the newest finished run", () => {
		const picked = pickMine([
			run("old", "failed", false, "2026-08-05T09:00:00Z"),
			run("new", "succeeded", false, "2026-08-05T11:00:00Z"),
		]);
		expect(picked?.id).toBe("new");
	});

	it("has nothing to say about a branch with no runs", () => {
		expect(pickMine([])).toBeNull();
	});
});

describe("matchesProject", () => {
	it("only matches the project's own events", () => {
		expect(matchesProject('{"project":"hive","type":"task.running"}', "hive")).toBe(true);
		expect(matchesProject('{"project":"Aurora","type":"task.running"}', "hive")).toBe(false);
		// The cheap substring pre-check must not produce a false positive on its own.
		expect(matchesProject('{"project":"Aurora","branch":"hive-thing"}', "hive")).toBe(false);
		expect(matchesProject("not json but mentions hive", "hive")).toBe(false);
	});
});

describe("extractIssueKeys", () => {
	const teams = new Set(["HIV", "TES", "ASF"]);

	it("finds keys in lowercase branch names and uppercases them", () => {
		expect(extractIssueKeys(["feature/hiv-1080"], teams)).toEqual(["HIV-1080"]);
	});

	it("does not treat every word-dash-number as a ticket", () => {
		// This is the whole reason the team-key set is fetched.
		expect(extractIssueKeys(["feature/add-2", "fix/utf-8", "release/v1-2"], teams)).toEqual([]);
	});

	it("dedupes across the branch and the PR title, keeping first-seen order", () => {
		expect(extractIssueKeys(["feature/tes-7062-7081-followups", "TES-7062 and HIV-1080"], teams)).toEqual([
			"TES-7062",
			"HIV-1080",
		]);
	});

	it("normalises leading zeros so the API filter matches", () => {
		expect(extractIssueKeys(["hiv-0042"], teams)).toEqual(["HIV-42"]);
	});

	it("caps how many keys one branch name can produce", () => {
		const many = Array.from({ length: 20 }, (_, i) => `hiv-${i + 1}`).join(" ");
		expect(extractIssueKeys([many], teams)).toHaveLength(8);
	});

	it("ignores empty inputs", () => {
		expect(extractIssueKeys([null, undefined, ""], teams)).toEqual([]);
	});
});

describe("buildOrFilter", () => {
	it("nests team and number under `and` inside each `or` branch", () => {
		// The flat {team, number} sibling form is ACCEPTED by Linear and then
		// silently ignores the number, returning every issue on the team.
		expect(buildOrFilter(["HIV-1075", "TES-7055"])).toEqual({
			or: [
				{ and: [{ team: { key: { eq: "HIV" } } }, { number: { eq: 1075 } }] },
				{ and: [{ team: { key: { eq: "TES" } } }, { number: { eq: 7055 } }] },
			],
		});
	});

	it("returns null rather than an empty filter that would match everything", () => {
		expect(buildOrFilter([])).toBeNull();
		expect(buildOrFilter(["nonsense"])).toBeNull();
	});
});

describe("mergeIssues", () => {
	const issue = (identifier: string, stateType: LinearIssue["stateType"], source: LinearIssue["source"]): LinearIssue => ({
		identifier,
		title: identifier,
		url: "",
		stateName: stateType,
		stateType,
		assignee: null,
		priority: 0,
		source,
	});

	it("prefers the attachment when the same ticket is also parsed from the branch", () => {
		const merged = mergeIssues([issue("HIV-1", "started", "attachment")], [issue("HIV-1", "started", "key")]);
		expect(merged).toHaveLength(1);
		expect(merged[0].source).toBe("attachment");
	});

	it("puts work in progress first and finished work last", () => {
		const merged = mergeIssues(
			[],
			[issue("HIV-3", "completed", "key"), issue("HIV-1", "backlog", "key"), issue("HIV-2", "started", "key")],
		);
		expect(merged.map((i) => i.identifier)).toEqual(["HIV-2", "HIV-1", "HIV-3"]);
	});
});
