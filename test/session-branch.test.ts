/**
 * The branch helper: which entries count as "the session state", and how a leaf
 * move is noticed when pi tells nobody it happened.
 *
 * Every assertion here is a way the fix could fail quietly rather than loudly:
 * reading the whole file again (the original bug), swallowing a stale ctx into
 * "this branch has no state" (a wipe dressed as a reset), a fingerprint that
 * cannot tell two equal-depth branches apart (the move nobody re-derives on),
 * and a poll that walks the tree even when nothing moved (a per-turn cost added
 * to the agent loop for nothing).
 */

import { describe, expect, it } from "vitest";
import { branchEntries, branchFingerprint, createBranchWatch } from "../extensions/session-branch/branch.ts";

/** A session entry as pi writes them: every one carries an id and a parent. */
const entry = (id: string, parentId: string | null, customType?: string) => ({
	type: customType ? "custom" : "message",
	id,
	parentId,
	...(customType ? { customType } : {}),
});

/**
 * The tree this whole stream exists for: one root, two children. The ABANDONED
 * branch was written later, so it is last in the append-ordered entry list and
 * any "newest wins" scan finds it first.
 */
const ROOT = entry("root", null);
const ACTIVE = entry("active", "root", "plan");
const ABANDONED = entry("abandoned", "root", "plan");
const ALL = [ROOT, ACTIVE, ABANDONED];
const ACTIVE_PATH = [ROOT, ACTIVE];

const ctxOf = (options: {
	all?: readonly unknown[];
	branch?: readonly unknown[];
	leafId?: string | null;
	omitBranch?: boolean;
	omitLeaf?: boolean;
}) => ({
	sessionManager: {
		getEntries: () => options.all ?? ALL,
		...(options.omitBranch ? {} : { getBranch: () => options.branch ?? ACTIVE_PATH }),
		// `?? "active"` would swallow a deliberately null leaf id, which is the
		// empty-session case one of the tests below is about.
		...(options.omitLeaf ? {} : { getLeafId: () => ("leafId" in options ? options.leafId ?? null : "active") }),
	},
});

/** A ctx that has been replaced under the handler, as pi's really do. */
const staleCtx = () =>
	new Proxy(
		{},
		{
			get() {
				throw new Error("extension ctx is stale");
			},
		},
	) as { sessionManager?: never };

describe("branchEntries", () => {
	it("returns the root->leaf path, not every entry in the file", () => {
		// The bug in one assertion: `getEntries()` would hand back the abandoned
		// branch's newer snapshot, and every rehydrate in this repo takes the
		// newest one it finds.
		expect(branchEntries(ctxOf({}))).toEqual(ACTIVE_PATH);
	});

	it("falls back to every entry when the pin has no getBranch", () => {
		// A documented degradation, pinned so it stays deliberate: without it a
		// pin bump turns a missing method into a throw inside an awaited handler,
		// which is the agent loop stopping. With it, the branch bug comes back —
		// so this test exists to make the trade visible, not to bless it.
		expect(branchEntries(ctxOf({ omitBranch: true }))).toEqual(ALL);
	});

	it("reports an empty branch when there is no session manager at all", () => {
		expect(branchEntries(null)).toEqual([]);
		expect(branchEntries({})).toEqual([]);
	});

	it("lets a stale ctx throw rather than reporting an empty branch", () => {
		// Swallowing this would be indistinguishable from "the branch is empty",
		// and callers clear their state on an empty branch. The catch belongs in
		// the watch, where "cannot tell" can be answered with "change nothing".
		expect(() => branchEntries(staleCtx())).toThrow("extension ctx is stale");
	});
});

describe("branchFingerprint", () => {
	it("separates two branches of equal depth", () => {
		// Length alone cannot see this move, and it is the common one: fork a
		// sibling, write there, go back.
		expect(branchFingerprint([ROOT, ACTIVE])).not.toBe(branchFingerprint([ROOT, ABANDONED]));
	});

	it("separates a leaf from its own ancestor", () => {
		// `/tree` moving up one entry keeps every id, so only the length differs.
		expect(branchFingerprint([ROOT, ACTIVE])).not.toBe(branchFingerprint([ROOT]));
	});

	it("is stable for the same path, so an unchanged branch never re-derives", () => {
		expect(branchFingerprint([ROOT, ACTIVE])).toBe(branchFingerprint([ROOT, ACTIVE]));
	});

	it("still produces an identity for entries without ids", () => {
		// Fixtures and older entries have no id; the fallback must not throw or
		// collapse every branch onto one string.
		expect(branchFingerprint([{ customType: "tasks" }])).not.toBe(branchFingerprint([{ customType: "plan" }]));
		expect(branchFingerprint([])).toBe("0:");
	});
});

describe("createBranchWatch", () => {
	it("reports the branch once per move and nothing while it stays put", () => {
		const watch = createBranchWatch();
		expect(watch.poll(ctxOf({}))).toEqual(ACTIVE_PATH);
		// The second turn on the same leaf must not re-derive — that is the
		// difference between a hook and a polling loop.
		expect(watch.poll(ctxOf({}))).toBeNull();
		expect(watch.poll(ctxOf({ branch: [ROOT, ABANDONED], leafId: "abandoned" }))).toEqual([ROOT, ABANDONED]);
	});

	it("does not walk the branch when the leaf pointer has not moved", () => {
		// The allocation-light requirement, made checkable: `before_agent_start`
		// runs on every turn, so an unchanged branch must cost one field read.
		let walks = 0;
		const counting = {
			sessionManager: {
				getEntries: () => ALL,
				getBranch: () => {
					walks++;
					return ACTIVE_PATH;
				},
				getLeafId: () => "active",
			},
		};
		const watch = createBranchWatch();
		watch.poll(counting);
		const afterFirst = walks;
		watch.poll(counting);
		watch.poll(counting);
		expect(afterFirst).toBe(1);
		expect(walks).toBe(1);
	});

	it("marks a branch as derived without re-deriving it", () => {
		// `session_start` reads the branch itself; without `mark` the first turn
		// after a resume would rehydrate a second time for no reason.
		const watch = createBranchWatch();
		watch.mark(ctxOf({}));
		expect(watch.poll(ctxOf({}))).toBeNull();
		expect(watch.poll(ctxOf({ branch: [ROOT, ABANDONED], leafId: "abandoned" }))).not.toBeNull();
	});

	it("returns null, never an empty branch, when the ctx has gone stale", () => {
		// The wipe this prevents: callers clear state on a successful read that
		// carries no snapshot, so a stale ctx reported as `[]` would empty the
		// plan, the workflow and the task list mid-session.
		const watch = createBranchWatch();
		expect(watch.poll(staleCtx())).toBeNull();
		expect(watch.stamp()).toBeNull();
	});

	it("falls back to the path fingerprint when the pin exposes no leaf id", () => {
		const watch = createBranchWatch();
		expect(watch.poll(ctxOf({ omitLeaf: true }))).toEqual(ACTIVE_PATH);
		expect(watch.poll(ctxOf({ omitLeaf: true }))).toBeNull();
		// A move the leaf pointer would have reported has to be visible from the
		// path alone, or a pin without `getLeafId` silently stops re-deriving.
		expect(watch.poll(ctxOf({ omitLeaf: true, branch: [ROOT, ABANDONED] }))).toEqual([ROOT, ABANDONED]);
	});

	it("keeps a null leaf id from colliding with a path fingerprint", () => {
		// An empty session reports `getLeafId(): null`. Mixing the two sources
		// without a prefix could make a leaf id equal a fingerprint and suppress
		// a real move.
		const watch = createBranchWatch();
		watch.poll(ctxOf({ leafId: null, branch: ACTIVE_PATH }));
		expect(watch.stamp()).toBe(`path:${branchFingerprint(ACTIVE_PATH)}`);
	});
});
