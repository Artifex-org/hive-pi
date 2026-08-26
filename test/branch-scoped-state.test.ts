/**
 * Session state follows the ACTIVE BRANCH (HIV-1972).
 *
 * A pi session is a tree. `/tree` moves the leaf inside the same file, so the
 * newest snapshot the file holds may belong to a branch the operator abandoned.
 * The fixture below is built so the two readings genuinely DISAGREE — the
 * abandoned branch's snapshots are LAST in the entry array, and therefore the
 * ones the old `getEntries()` rehydration picked — because a fixture both
 * readings agree on would prove nothing.
 *
 * Three failures are pinned, the two the bug produced and one it can re-enter
 * through:
 *
 *   (a) RESUME restores the wrong branch. A plan, workflow or task list written
 *       on an abandoned branch resurfaced on the sibling the operator came back
 *       to, because "newest wins" was applied across the whole file.
 *   (b) an in-session LEAF MOVE re-derives nothing. `/tree` emits no
 *       `session_start` and no event of its own, so the deck and the documents
 *       went on describing the branch the operator had just left.
 *   (c) the TASK MIRROR re-contaminates. `tasks` repaints, `workflow` listens to
 *       that repaint, and pi runs handlers in load order — so the mirror can
 *       merge the new branch's todos into the old branch's document and persist
 *       the result onto the new branch.
 *
 * The session manager is modelled as ONE stateful object with a movable leaf,
 * which is what pi has: `/tree` moves a pointer inside the live manager, it does
 * not hand extensions a different manager. `fake-pi`'s ctx models a single entry
 * list, so these tests build their own — this bug is only visible where
 * `getEntries()` and `getBranch()` disagree.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import plan from "../extensions/plan/index.ts";
import tasks from "../extensions/tasks/index.ts";
import workflow from "../extensions/workflow/index.ts";
import { DECK_SECTION_CHANNEL } from "../extensions/deck/protocol.ts";
import { applyOps as applyPlanOps, emptyPlan, PLAN_ENTRY_TYPE, toEntry as planEntry } from "../extensions/plan/state.ts";
import { summaryLine as planSummary } from "../extensions/plan/render.ts";
import { applyWrites, emptyTasks, TASKS_ENTRY_TYPE, toEntry as tasksEntry } from "../extensions/tasks/state.ts";
import {
	applyOps as applyWorkflowOps,
	emptyWorkflow,
	toEntry as workflowEntry,
	WORKFLOW_ENTRY_TYPE,
} from "../extensions/workflow/state.ts";
import { createGoal, GOAL_ENTRY_TYPE, rehydrateGoal, rehydrateGoalFromBranch } from "../extensions/agenda/goal-state.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOW = 1_700_000_000_000;
const REPO = join(import.meta.dirname, "..");

/* -------------------------------------------------------------------------- */
/* The tree                                                                    */
/* -------------------------------------------------------------------------- */

const ROOT = { type: "message", id: "root", parentId: null };

const custom = (id: string, parentId: string, customType: string, data: unknown) => ({
	type: "custom",
	id,
	parentId,
	customType,
	data,
});

/** One branch's four documents, chained so the path has a real shape. */
function branchOf(prefix: string, label: string, steps: number) {
	const tasksDoc = applyWrites(emptyTasks, [{ subject: `${label} todo` }], NOW).state;
	const planDoc = applyPlanOps(
		emptyPlan(NOW),
		[
			{ op: "header", title: `${label} plan`, phase: prefix === "a" ? "drafting" : "approved" },
			{
				op: "upsert",
				block: { type: "steps", steps: Array.from({ length: steps }, (_, i) => ({ title: `${label} step ${i}` })) },
			},
		],
		NOW,
	).doc;
	const workflowDoc = applyWorkflowOps(
		emptyWorkflow(NOW),
		[{ op: "stage", title: `${label} stage`, kind: "execute" }],
		NOW,
	).doc;
	const goalDoc = createGoal(`${prefix}-goal`, `${label} is done`, NOW);

	const entries = [
		custom(`${prefix}-tasks`, "root", TASKS_ENTRY_TYPE, tasksEntry(tasksDoc)),
		custom(`${prefix}-plan`, `${prefix}-tasks`, PLAN_ENTRY_TYPE, planEntry(planDoc)),
		custom(`${prefix}-workflow`, `${prefix}-plan`, WORKFLOW_ENTRY_TYPE, workflowEntry(workflowDoc)),
		custom(`${prefix}-goal`, `${prefix}-workflow`, GOAL_ENTRY_TYPE, goalDoc),
	];
	return { entries, leafId: `${prefix}-goal`, tasksDoc, planDoc, workflowDoc, goalDoc };
}

/** The live branch, written first. */
const ACTIVE = branchOf("a", "active-branch", 1);
/** The abandoned sibling, written LATER — so every "newest wins" scan finds it. */
const ABANDONED = branchOf("b", "abandoned-branch", 3);

/**
 * One session manager, one movable leaf — the shape pi actually has.
 *
 * `getEntries()` returns the whole file (the abandoned branch last);
 * `getBranch()` returns the root->leaf path of wherever the leaf currently is.
 */
function liveSession() {
	const all = [ROOT, ...ACTIVE.entries, ...ABANDONED.entries];
	let path: unknown[] = [ROOT, ...ACTIVE.entries];
	let leafId = ACTIVE.leafId;
	const ctx = {
		sessionManager: {
			getEntries: () => all,
			getBranch: () => path,
			getLeafId: () => leafId,
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		/** What `/tree` does: move the leaf pointer, tell nobody. */
		moveTo(target: "active" | "abandoned" | "root") {
			if (target === "root") {
				path = [ROOT];
				leafId = "root";
				return;
			}
			const branch = target === "active" ? ACTIVE : ABANDONED;
			path = [ROOT, ...branch.entries];
			leafId = branch.leafId;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Driving the extensions                                                      */
/* -------------------------------------------------------------------------- */

/** Drive every handler registered for an event, serially and in load order, as pi does. */
async function fire(pi: FakePi, type: string, event: Record<string, unknown>, ctx: ExtensionContext) {
	const results: unknown[] = [];
	for (const handler of pi.handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
	return results;
}

const lastSection = (pi: FakePi, section: string) => {
	const events = pi.busEvents.filter(
		(e) => e.name === DECK_SECTION_CHANNEL && (e.payload as { section?: string }).section === section,
	);
	return events.length === 0 ? undefined : (events[events.length - 1].payload as { state?: unknown }).state;
};

const subjects = (pi: FakePi) => ((lastSection(pi, "tasks") as { rows: { subject: string }[] } | null)?.rows ?? []).map((r) => r.subject);

async function call(pi: FakePi, name: string, params: unknown) {
	const tool = pi.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no tool registered named "${name}"`);
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
	return (await execute("call-id", params, undefined, undefined, undefined)) as { content: { text: string }[] };
}

let pi: FakePi;
let session: ReturnType<typeof liveSession>;
beforeEach(() => {
	pi = createFakePi();
	session = liveSession();
});

/* -------------------------------------------------------------------------- */

describe("(a) a resume restores the active branch's state, not the file's newest", () => {
	it("tasks: the abandoned branch's later list does not come back", async () => {
		// Under the old `getEntries()` read this is "abandoned-branch todo": the
		// abandoned snapshot is later in the array and every rehydrate in this
		// repo takes the newest one it finds.
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		expect(subjects(pi)).toEqual(["active-branch todo"]);
	});

	it("plan: the abandoned branch's approved plan does not resurface", async () => {
		plan(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);

		const state = lastSection(pi, "plan") as { summary: string };
		expect(state.summary).toBe(planSummary(ACTIVE.planDoc));
		expect(state.summary).not.toBe(planSummary(ABANDONED.planDoc));
	});

	it("workflow: the abandoned branch's stages do not come back", async () => {
		workflow(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);

		// The tool renders the whole document, so its text is the honest read of
		// what was restored. `ops: []` changes nothing and cannot re-seed, because
		// a restored document already counts as seeded.
		const result = await call(pi, "workflow_write", { ops: [] });
		expect(result.content[0].text).toContain("active-branch stage");
		expect(result.content[0].text).not.toContain("abandoned-branch stage");
	});

	it("the PRODUCTION call sites are wired, not just the helpers", () => {
		// The check that was missing, and the gap it left is instructive: the
		// branch-scoped goal helper was written, exported and tested green while
		// `agenda/index.ts` still rehydrated from every entry — a tested helper
		// with no caller. Every other assertion in this file exercises a fold
		// directly, so none of them could see it.
		//
		// So this reads the SOURCE, the way test/worker-tool-universe.test.ts
		// does. The all-entries counts are pinned rather than banned: two reads in
		// agenda genuinely want every entry, and pinning them makes the next one
		// arrive as a diff somebody has to justify.
		const ALLOWED_ALL_ENTRY_READS: Record<string, { count: number; why: string }> = {
			"extensions/plan/index.ts": { count: 0, why: "the plan document is branch-scoped in full" },
			"extensions/workflow/index.ts": { count: 0, why: "same, plus its task mirror" },
			"extensions/tasks/index.ts": { count: 0, why: "the task list is branch-scoped in full" },
			"extensions/agenda/index.ts": {
				count: 1,
				why: "`/handoff` passes BOTH views to deriveSignals on purpose — it compares them",
			},
		};

		for (const [file, expected] of Object.entries(ALLOWED_ALL_ENTRY_READS)) {
			const source = readFileSync(join(REPO, file), "utf8");
			const allEntryReads = source.match(/getEntries\(\)/g)?.length ?? 0;
			expect(allEntryReads, `${file}: ${expected.why}`).toBe(expected.count);
			expect(source, `${file} must read the active branch`).toContain("branchEntries(");
		}
	});

	it("goal: the abandoned branch's condition does not drive the session", async () => {
		// The goal is the one branch-scoped document that ACTS: the driver injects
		// turns against it, so restoring the wrong one keeps the agent working on
		// a condition the operator navigated away from — against that branch's
		// ledger, which is what the budget is enforced from.
		const all = session.ctx.sessionManager.getEntries() as readonly unknown[];
		expect(rehydrateGoalFromBranch(session.ctx)?.condition).toBe("active-branch is done");
		// The contrast that makes this fixture a real test: the all-entries read
		// genuinely gives the other answer.
		expect(rehydrateGoal(all)?.condition).toBe("abandoned-branch is done");
	});
});

describe("(b) an in-session leaf move re-derives, with no event to tell us", () => {
	it("tasks: the list follows a /tree move at the next turn", async () => {
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);

		session.moveTo("abandoned"); // the operator types `/tree`; pi emits nothing
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		expect(subjects(pi)).toEqual(["abandoned-branch todo"]);
	});

	it("plan: the deck stops describing the branch the operator left", async () => {
		plan(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		session.moveTo("abandoned");
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		expect((lastSection(pi, "plan") as { summary: string }).summary).toBe(planSummary(ABANDONED.planDoc));
	});

	it("workflow: the document follows the leaf", async () => {
		workflow(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		session.moveTo("abandoned");
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		expect((await call(pi, "workflow_write", { ops: [] })).content[0].text).toContain("abandoned-branch stage");
	});

	it("moving to a branch that never had a list EMPTIES it", async () => {
		// The reset-on-switch rule, and the one case where clearing is right:
		// carrying the old branch's todos onto a branch that never wrote any is
		// the resurfacing bug in (a), only sideways.
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		session.moveTo("root");
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		expect(lastSection(pi, "tasks")).toBeNull();
	});

	it("a stale ctx changes nothing — it is not a branch with no state", async () => {
		// The difference between "cannot tell" and "this branch is empty". Reading
		// the second as the first would wipe the list mid-session every time a
		// session was replaced between pi's emit and this handler.
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		const before = pi.busEvents.length;

		const stale = new Proxy(
			{},
			{
				get() {
					throw new Error("extension ctx is stale");
				},
			},
		) as ExtensionContext;
		await fire(pi, "before_agent_start", { prompt: "carry on" }, stale);

		// Nothing re-derived, nothing repainted, and nothing threw out of the
		// handler — a throw there IS the agent loop stopping.
		expect(pi.busEvents.length).toBe(before);
		expect(subjects(pi)).toEqual(["active-branch todo"]);
	});

	it("re-derives once per move, not once per turn", async () => {
		// `before_agent_start` runs on every turn. A second turn on the same leaf
		// must not repaint, or the deck flickers and the walk is paid forever.
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		const afterStart = pi.busEvents.length;

		await fire(pi, "before_agent_start", { prompt: "one" }, session.ctx);
		await fire(pi, "before_agent_start", { prompt: "two" }, session.ctx);

		expect(pi.busEvents.length).toBe(afterStart);
	});

	it("nothing is persisted by a re-derive", async () => {
		// The snapshot being adopted is already in the session. Re-appending it
		// would copy an entry per turn and, for the workflow, replay a revision
		// against Hive's monotonic upsert — which refuses one behind the stored
		// value, so the replay is not even harmless.
		workflow(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		const before = pi.entries.length;

		session.moveTo("abandoned");
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		expect(pi.entries.length).toBe(before);
	});

	it("the re-derive handler contributes neither a message nor a system prompt", async () => {
		// pi collects `before_agent_start` return values: a stray one here would
		// inject a message into the turn or overwrite the system prompt.
		tasks(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);
		const results = await fire(pi, "before_agent_start", { prompt: "go" }, session.ctx);
		expect(results.every((r) => r === undefined)).toBe(true);
	});
});

describe("(c) the task mirror cannot re-contaminate through the bus", () => {
	it("mirrors the new branch's todos into the NEW branch's workflow", async () => {
		// Load order is configuration, so `tasks` repainting before `workflow`
		// re-derives is a real arrangement, and it is the one that used to merge
		// new-branch todos into the abandoned document and PERSIST it — putting
		// the old branch's stages onto the branch the operator moved to.
		tasks(pi.api);
		workflow(pi.api);
		await fire(pi, "session_start", { reason: "resume" }, session.ctx);

		session.moveTo("abandoned");
		await fire(pi, "before_agent_start", { prompt: "carry on" }, session.ctx);

		// The contamination check FIRST, because it is the one that lands in the
		// session file: a merged document persisted onto the new branch is what
		// the next rehydration would then adopt as that branch's own.
		const persisted = pi.entries.filter((e) => e.customType === WORKFLOW_ENTRY_TYPE);
		expect(JSON.stringify(persisted)).not.toContain("active-branch stage");

		const rendered = (await call(pi, "workflow_write", { ops: [] })).content[0].text;
		expect(rendered).toContain("abandoned-branch stage");
		expect(rendered).not.toContain("active-branch stage");
		// The mirror still did its job — on the branch that is now live.
		expect(rendered).toContain("abandoned-branch todo");
	});
});
