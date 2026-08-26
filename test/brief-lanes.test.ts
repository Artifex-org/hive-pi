/**
 * brief — the lanes, and the merge that decides what survives (HIV-1804).
 *
 * The fan-out's correctness lives almost entirely in the merge, and its failure
 * mode is invisible: a brief assembled by concatenation still LOOKS complete. It
 * simply contains one chatty lane's twelve findings and none of the quiet lane's
 * two, and nobody reading it can tell. So the tests here are mostly about what
 * the merge refuses to do.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";
import type { AgentConfig } from "../extensions/harness/roles.ts";
import type { BriefDraft } from "../extensions/brief/compile.ts";
import { interleaveBy, knowledgeCollections, laneIsRunnable, laneInstruction, laneTools, mergeDrafts, normalizeRef, planLanes } from "../extensions/brief/lanes.ts";

const ROLE = {
	name: "briefer",
	tools: ["read", "grep", "find", "ls", "knowledge_search", "knowledge_get"],
	systemPrompt: "",
} as unknown as AgentConfig;

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
	return { goal: "", facts: [], startHere: [], refs: [], unknowns: [], nextMoves: [], history: [], ...overrides };
}

describe("planLanes", () => {
	it("always runs repo and knowledge", () => {
		expect(planLanes([])).toEqual(["repo", "knowledge"]);
	});

	// The ticket lane is the only one that reaches off the machine, and an
	// adapter that will not be called is pure startup latency on the path that
	// blocks the first turn.
	it("adds the ticket lane only when the prompt named a key", () => {
		expect(planLanes(["HIV-1804"])).toEqual(["repo", "knowledge", "ticket"]);
	});
});

describe("laneTools", () => {
	it("gives the repo lane the working-tree tools and no knowledge access", () => {
		expect(laneTools(ROLE, "repo")).toEqual(["read", "grep", "find", "ls"]);
	});

	it("gives the knowledge lane the knowledge tools and nothing else", () => {
		expect(laneTools(ROLE, "knowledge")).toEqual(["knowledge_search", "knowledge_get"]);
	});

	// `mcp` is the one tool that leaves the machine. It is granted to the lane
	// whose entire job is a ticket read, and to nothing else — including when the
	// role file itself declares it.
	it("confines mcp to the ticket lane", () => {
		const withMcp = { ...ROLE, tools: [...(ROLE.tools ?? []), "mcp"] } as AgentConfig;
		expect(laneTools(withMcp, "repo")).not.toContain("mcp");
		expect(laneTools(withMcp, "knowledge")).not.toContain("mcp");
		expect(laneTools(withMcp, "ticket")).toEqual(["mcp"]);
	});

	it("reports a lane with no tools as unrunnable rather than spawning it", () => {
		const noKnowledge = { ...ROLE, tools: ["read", "grep"] } as AgentConfig;
		expect(laneIsRunnable(noKnowledge, "knowledge")).toBe(false);
		expect(laneIsRunnable(noKnowledge, "repo")).toBe(true);
	});
});

describe("laneInstruction", () => {
	it("names the tickets the ticket lane must fetch", () => {
		expect(laneInstruction("ticket", ["HIV-1804", "HIV-1805"])).toContain("HIV-1804, HIV-1805");
	});

	// Two lanes doing the same grep is the failure that would make the fan-out
	// cost more than the sequential pass it replaced.
	it("tells each lane what NOT to do, not merely what to prefer", () => {
		expect(laneInstruction("repo", [])).toContain("Do not search the knowledge base");
		expect(laneInstruction("knowledge", [])).toContain("Do not grep the repository");
	});
});

describe("mergeDrafts", () => {
	it("takes the goal from the repo lane", () => {
		const merged = mergeDrafts([
			{ lane: "knowledge", draft: draft({ goal: "a KB summary of the task" }) },
			{ lane: "repo", draft: draft({ goal: "the repo's own vocabulary" }) },
		]);
		expect(merged.goal).toBe("the repo's own vocabulary");
	});

	// The repo lane owns `goal` and the others are told to leave it empty — but
	// an empty goal costs the brief its only restatement of intent, so a goal
	// from anywhere beats none.
	it("falls back to another lane's goal rather than shipping none", () => {
		const merged = mergeDrafts([
			{ lane: "repo", draft: draft({ goal: "   " }) },
			{ lane: "knowledge", draft: draft({ goal: "a KB summary" }) },
		]);
		expect(merged.goal).toBe("a KB summary");
	});

	/**
	 * THE TEST THIS FILE EXISTS FOR. Concatenation would let the knowledge lane's
	 * eight findings fill `facts` to the cap before the repo lane's `file:line`
	 * evidence was considered at all — and the brief would still render, still
	 * look complete, and be worth much less.
	 */
	it("does not let a chatty lane crowd out a quiet one", () => {
		const chatty = draft({ facts: Array.from({ length: 8 }, (_, i) => ({ ref: `KB doc-${i}.md`, note: "kb" })) });
		const quiet = draft({ facts: [{ ref: "extensions/brief/run.ts:88", note: "the wall is per lane" }] });

		const merged = mergeDrafts([
			{ lane: "knowledge", draft: chatty },
			{ lane: "repo", draft: quiet },
		]);

		expect(merged.facts[0]).toEqual({ ref: "extensions/brief/run.ts:88", note: "the wall is per lane" });
		expect(merged.facts).toHaveLength(8);
	});

	it("keeps the first-seen copy of a ref two lanes both found", () => {
		const merged = mergeDrafts([
			{ lane: "repo", draft: draft({ facts: [{ ref: "extensions/brief/run.ts:88", note: "read in the tree" }] }) },
			{ lane: "knowledge", draft: draft({ facts: [{ ref: "./extensions/brief/run.ts:88", note: "mentioned in a doc" }] }) },
		]);
		expect(merged.facts).toEqual([{ ref: "extensions/brief/run.ts:88", note: "read in the tree" }]);
	});

	// `refs` is the section the knowledge lane exists to fill, so precedence
	// there is the reverse of `facts`. One global order would be wrong in one
	// section or the other.
	it("prefers the knowledge lane under refs and the repo lane under facts", () => {
		const merged = mergeDrafts([
			{ lane: "repo", draft: draft({ refs: [{ ref: "README.md", note: "repo readme" }] }) },
			{ lane: "knowledge", draft: draft({ refs: [{ ref: "KB hive.md", note: "the brain" }] }) },
		]);
		expect(merged.refs[0]?.ref).toBe("KB hive.md");
	});

	it("never carries history out of a lane — it is measured, not modelled", () => {
		const merged = mergeDrafts([
			{ lane: "repo", draft: draft({ history: [{ ref: "run.ts", note: "last changed 1999-01-01 in deadbee — invented" }] }) },
		]);
		expect(merged.history).toEqual([]);
	});

	it("survives every lane returning nothing", () => {
		expect(mergeDrafts([])).toEqual(draft());
	});
});

describe("interleaveBy", () => {
	it("takes one from each list in turn", () => {
		expect(interleaveBy([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]], (s) => s, 10)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
	});

	it("stops at the cap", () => {
		expect(interleaveBy([["a1", "a2"], ["b1", "b2"]], (s) => s, 3)).toEqual(["a1", "b1", "a2"]);
	});

	it("drops an entry whose key is empty rather than counting it against the cap", () => {
		expect(interleaveBy([["", "a"]], (s) => s, 2)).toEqual(["a"]);
	});
});

describe("normalizeRef", () => {
	it("treats a leading ./ and backticks as noise", () => {
		expect(normalizeRef("`./internal/place.go:88`")).toBe("internal/place.go:88");
	});

	// The same file at two lines is two facts, so the line number is part of the
	// identity rather than noise to strip.
	it("keeps line numbers apart", () => {
		expect(normalizeRef("place.go:88")).not.toBe(normalizeRef("place.go:120"));
	});
});

describe("knowledgeCollections", () => {
	// The operator report behind HIV-2530: an agent's brief came back citing
	// another project's corpus. An unscoped search is not a neutral default — it
	// is a bias toward whichever corpus is biggest.
	//
	// Fixture-driven, because WHICH projects exist is the house profile's answer
	// and not this repository's. What is asserted here is the PROPERTY: one
	// project's checkout never reaches another project's collections.
	const profile = {
		defaultKnowledgeCollections: ["shared-notes"],
		projects: [
			{ token: "alpha", knowledgeCollections: ["alpha-kb", "alpha-docs"] },
			{ token: "beta", knowledgeCollections: ["beta-docs"] },
		],
	};

	beforeEach(() => setHouseProfileForTest(profile));
	afterEach(() => setHouseProfileForTest(null));

	it("keeps one project's checkout out of another's corpus", () => {
		const got = knowledgeCollections("/home/dev/repos/Alpha__worktrees/agents-8ae46e84");
		expect(got).toContain("alpha-kb");
		expect(got).not.toContain("beta-docs");
	});

	it("keeps the other project's checkout out of the first's corpus", () => {
		const got = knowledgeCollections("/home/dev/repos/Beta-Platform__worktrees/agents-1234");
		expect(got).toContain("beta-docs");
		expect(got).not.toContain("alpha-docs");
	});

	// Infrastructure and workstation knowledge applies to work in any repo, so
	// the default collections are in every list rather than only the fallback.
	it("always includes the default collections", () => {
		for (const cwd of ["/home/dev/repos/alpha", "/home/dev/repos/beta", "/home/dev/repos/unmapped"]) {
			expect(knowledgeCollections(cwd)).toContain("shared-notes");
		}
	});

	it("falls back to the default collections alone for an unmapped repo", () => {
		expect(knowledgeCollections("/home/dev/repos/some-new-thing")).toEqual(["shared-notes"]);
	});

	// The out-of-the-box state: nobody has described this machine's corpus. The
	// lane must then search UNSCOPED rather than be handed an empty filter — see
	// laneInstruction below, which drops the scoping paragraph entirely.
	it("returns nothing when no profile is configured", () => {
		setHouseProfileForTest({});
		expect(knowledgeCollections("/home/dev/repos/alpha")).toEqual([]);
	});
});

describe("laneInstruction scoping", () => {
	afterEach(() => setHouseProfileForTest(null));

	it("tells the knowledge lane which collections to pass", () => {
		setHouseProfileForTest({
			defaultKnowledgeCollections: ["shared-notes"],
			projects: [
				{ token: "alpha", knowledgeCollections: ["alpha-kb"] },
				{ token: "beta", knowledgeCollections: ["beta-docs"] },
			],
		});
		const text = laneInstruction("knowledge", [], "/home/dev/repos/Alpha__worktrees/x");
		expect(text).toContain("alpha-kb");
		expect(text).not.toContain("beta-docs");
	});

	// `Pass collections: []` is an instruction to search NOTHING. With no
	// profile the paragraph has to disappear, not go out empty.
	it("omits the scoping paragraph entirely when no collections are configured", () => {
		setHouseProfileForTest({});
		const text = laneInstruction("knowledge", [], "/home/dev/repos/alpha");
		expect(text).not.toContain("Pass collections");
		expect(text).toContain("KNOWLEDGE lane");
	});
});
