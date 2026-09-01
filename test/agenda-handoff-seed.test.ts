/**
 * The handoff seed's TWO sources (HIV-1231 follow-up).
 *
 * The seed carries local state (the open work items, which exist only on this
 * machine) and remote state (`recap_session`: branch/PR/CI, tickets, knowledge,
 * teammates). These tests pin the three properties that make it trustworthy:
 * open work survives the budget, an absent Hive reads as ABSENT rather than as
 * "nothing to report", and a block is dropped whole rather than truncated.
 */

import { describe, expect, it } from "vitest";
import { buildHandoffSeed, openWorkLines } from "../extensions/agenda/handoff.ts";
import { handoffRecapSections } from "../extensions/agenda/session-recap.ts";
import { emptyPlan, type PlanDoc, type WorkItem } from "../extensions/plan/state.ts";
import { emptySignals } from "../extensions/agenda/signals.ts";

function item(over: Partial<WorkItem> & { id: string; title: string }): WorkItem {
	return { status: "pending", ...over };
}

function planWith(lanes: { title: string; steps: WorkItem[] }[]): PlanDoc {
	const doc = emptyPlan(0);
	doc.blocks = lanes.map((lane, index) => ({
		type: "steps" as const,
		id: `b${index}`,
		title: lane.title,
		createdAt: 0,
		updatedAt: 0,
		steps: lane.steps,
	}));
	return doc;
}

describe("openWorkLines", () => {
	it("lists open items by lane, marking in-progress and blocked", () => {
		const lines = openWorkLines(
			planWith([
				{
					title: "Execute",
					steps: [
						item({ id: "1", title: "Wire the recap fetch", status: "in_progress" }),
						item({ id: "2", title: "Write the tests" }),
						item({ id: "3", title: "Read the plan", status: "done" }),
						item({ id: "4", title: "Await review", status: "blocked", note: "needs the operator" }),
					],
				},
			]),
		);
		const text = lines.join("\n");
		expect(text).toContain("**Execute**");
		expect(text).toContain("[~] Wire the recap fetch");
		expect(text).toContain("[ ] Write the tests");
		expect(text).toContain("[!] Await review — note: needs the operator");
		// Completed work is not what the successor owes.
		expect(text).not.toContain("Read the plan");
	});

	it("excludes items whose status Hive resolves, not the agent", () => {
		// A delivery lane's pending observations are not work the successor owes;
		// listing them makes a fresh session try to 'do' a CI result.
		const lines = openWorkLines(
			planWith([
				{
					title: "Deliver",
					steps: [
						item({ id: "1", title: "checks green", kind: "ci.green" }),
						item({ id: "2", title: "open the PR", kind: "pr.open" }),
						item({ id: "3", title: "Rebase onto main" }),
					],
				},
			]),
		);
		const text = lines.join("\n");
		expect(text).toContain("Rebase onto main");
		expect(text).not.toContain("checks green");
		expect(text).not.toContain("open the PR");
	});

	it("is empty for no plan and for a plan with nothing open", () => {
		expect(openWorkLines(null)).toEqual([]);
		expect(openWorkLines(undefined)).toEqual([]);
		expect(
			openWorkLines(planWith([{ title: "Done", steps: [item({ id: "1", title: "x", status: "done" })] }])),
		).toEqual([]);
	});
});

describe("handoffRecapSections", () => {
	const payload = JSON.stringify({
		working: { branch: "hiv-1231-seed", worktree: "/w/repo", pr_number: 42, cut_from: "main" },
		delivery: { ci_state: "failing", ci_run_id: "run-7" },
		tickets: [{ ticket: "HIV-1231", source: "plan-ref" }],
		knowledge: {
			refs: [{ collection: "knowledge-base", path: "memory/hive/recap-session-compaction.md" }],
			returned: 1,
			total: 5,
			truncated: true,
		},
		team: {
			members: [
				{ session_id: "s1", title: "me", self: true, live_state: "active" },
				{ session_id: "s2", title: "reviewer", live_state: "active" },
			],
		},
	});

	it("folds delivery, tickets, knowledge and team in drop-order", () => {
		const labels = handoffRecapSections(payload).map((s) => s.label);
		expect(labels).toEqual(["Delivery", "Claimed tickets", "Knowledge already read", "Teammates at handoff"]);
	});

	it("carries the facts a successor cannot cheaply re-derive", () => {
		const byLabel = Object.fromEntries(handoffRecapSections(payload).map((s) => [s.label, s.lines.join("\n")]));
		expect(byLabel.Delivery).toContain("hiv-1231-seed");
		expect(byLabel.Delivery).toContain("PR: #42");
		expect(byLabel.Delivery).toContain("CI: failing (run run-7)");
		expect(byLabel["Claimed tickets"]).toContain("HIV-1231 (via plan-ref)");
		expect(byLabel["Knowledge already read"]).toContain("knowledge-base/memory/hive/recap-session-compaction.md");
		// A truncated list has to say so, or the successor reads 1-of-5 as all of it.
		expect(byLabel["Knowledge already read"]).toContain("4 more not listed");
		// Own row excluded; the block says to re-read rather than to trust.
		expect(byLabel["Teammates at handoff"]).toContain("reviewer");
		expect(byLabel["Teammates at handoff"]).not.toContain("- me");
		expect(byLabel["Teammates at handoff"]).toContain("list_teammates");
	});

	it("returns nothing for a body it does not recognise", () => {
		// Inventing a section from an unrecognised shape is how a successor ends
		// up trusting a fact nobody asserted.
		expect(handoffRecapSections("not json")).toEqual([]);
		expect(handoffRecapSections("[1,2,3]")).toEqual([]);
		expect(handoffRecapSections("")).toEqual([]);
		expect(handoffRecapSections("{}")).toEqual([]);
	});
});

describe("buildHandoffSeed — the two sources", () => {
	const base = {
		objective: "land the seed",
		goal: null,
		conductor: null,
		signals: { ...emptySignals, tasks: { total: 3, pending: 2, inProgress: 0, completed: 1 } },
		gitStatus: null,
		cwd: "/work/repo",
	};

	it("carries the OPEN ITEMS, not just their count", () => {
		const seed = buildHandoffSeed({
			...base,
			plan: planWith([{ title: "Execute", steps: [item({ id: "1", title: "Wire the recap fetch" })] }]),
			recap: [],
		});
		expect(seed).toContain("## Open work (1/3 done)");
		expect(seed).toContain("Wire the recap fetch");
		// The pre-follow-up seed told the successor to re-derive them.
		expect(seed).not.toContain("re-derive the open ones");
	});

	it("falls back to counts when no plan document survived", () => {
		const seed = buildHandoffSeed({ ...base, plan: null, recap: [] });
		expect(seed).toContain("1/3 completed");
		expect(seed).toContain("re-derive the open ones");
	});

	it("distinguishes an ABSENT Hive from a Hive that reported nothing", () => {
		const absent = buildHandoffSeed({ ...base, recap: null });
		expect(absent).toContain("The block is ABSENT, not empty");
		expect(absent).toContain("recap_session");

		const empty = buildHandoffSeed({ ...base, recap: [] });
		expect(empty).toContain("reported no branch, PR, ticket");
		expect(empty).not.toContain("ABSENT");
	});

	it("bounds a huge git status instead of letting it eat the budget", () => {
		const seed = buildHandoffSeed({
			...base,
			recap: [],
			gitStatus: Array.from({ length: 200 }, (_, i) => ` M file${i}.ts`).join("\n"),
		});
		expect(seed).toContain(" M file0.ts");
		expect(seed).toContain("more path(s)");
		expect(seed).not.toContain(" M file199.ts");
	});
});

describe("buildHandoffSeed — the character budget", () => {
	it("drops whole blocks worst-first and keeps the open work", () => {
		// A block truncated mid-list reads as a complete one, which is worse than
		// a block that is honestly missing. Teammates go before open work because
		// the successor can rebuild them with one tool call.
		const many = Array.from({ length: 200 }, (_, i) =>
			item({ id: `t${i}`, title: `Task ${i} ${"x".repeat(60)}` }),
		);
		const seed = buildHandoffSeed({
			objective: "survive the budget",
			goal: null,
			conductor: null,
			signals: emptySignals,
			gitStatus: null,
			cwd: "/work/repo",
			plan: planWith([{ title: "Execute", steps: many }]),
			recap: [
				{ label: "Delivery", lines: ["- branch: `b`"] },
				{ label: "Teammates at handoff", lines: [`- ${"y".repeat(9000)}`] },
			],
		});

		expect(seed.length).toBeLessThanOrEqual(12_000);
		// Head and footer are never droppable.
		expect(seed).toContain("survive the budget");
		expect(seed).toContain("verifying this seed against the worktree");
		// The expensive-to-rebuild block survived; the cheap one did not.
		expect(seed).toContain("Task 0");
		expect(seed).not.toContain("yyyy");
		// And the seed admits the loss rather than reading as complete.
		expect(seed).toContain("did not fit this seed's budget");
	});

	it("says nothing about dropping when everything fits", () => {
		const seed = buildHandoffSeed({
			objective: "small",
			goal: null,
			conductor: null,
			signals: emptySignals,
			gitStatus: null,
			cwd: "/work/repo",
			recap: [{ label: "Delivery", lines: ["- branch: `b`"] }],
		});
		expect(seed).not.toContain("did not fit");
		expect(seed).toContain("## Delivery");
	});
});
