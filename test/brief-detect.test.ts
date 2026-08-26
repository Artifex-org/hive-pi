/**
 * brief — what gets enriched, and what is left alone (HIV-1798).
 *
 * Each case here is a failure this gate exists to prevent, not a restatement of
 * the implementation. The two that would be silently expensive in production
 * are the protocol split (a rewritten TEAM PROTOCOL is a broken contract with
 * the controlling session) and the worker guard (an extension that enriches its
 * own worker's task recurses).
 */

import { describe, expect, it } from "vitest";
import {
	BRIEF_MARKER,
	isWorkerProcess,
	looksTaskLike,
	splitTeamProtocol,
	stripInlineMarker,
	suppressionReason,
	ticketKeys,
} from "../extensions/brief/detect.ts";

/** The block Hive's `withTeamReportProtocol` appends verbatim. */
const TEAM_PROTOCOL = `

---
TEAM PROTOCOL (added by Hive — you are on a team)

Send a short \`message_teammate\` to \`@orchestrator\` at these four moments.
`;

/**
 * The block Hive appends to a SOLO launch — the common case, and the one the
 * single-heading implementation could not see (HIV-2530). Copied from the
 * prompt of Aurora launch 8ae46e84, which was treated as hand-typed prose.
 */
const SOLO_PROTOCOL = `

---
IF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT (added by Hive)

You are running alone. If the work is really several parts that do not depend on
each other, you may ask to run it as a team — but ASK FIRST.

Below about four genuinely independent parts this is usually not worth it — the
coordination costs more than the parallelism returns. Say so and carry on.
`;

describe("splitTeamProtocol", () => {
	it("leaves a plain prompt whole", () => {
		const { task, protocol } = splitTeamProtocol("fix the flaky scheduler test");
		expect(task).toBe("fix the flaky scheduler test");
		expect(protocol).toBe("");
	});

	it("separates the appended protocol from the task", () => {
		const { task, protocol } = splitTeamProtocol(`implement HIV-1798${TEAM_PROTOCOL}`);
		expect(task.trim()).toBe("implement HIV-1798");
		expect(protocol).toContain("TEAM PROTOCOL");
	});

	it("rejoins to exactly the original — the protocol is a contract, not prose", () => {
		const original = `implement HIV-1798${TEAM_PROTOCOL}`;
		const { task, protocol } = splitTeamProtocol(original);
		expect(task + protocol).toBe(original);
	});

	it("does not eat a task's own horizontal rule", () => {
		const original = "step one\n\n---\n\nstep two";
		expect(splitTeamProtocol(original).task).toBe(original);
	});
});

describe("ticketKeys", () => {
	it("finds our three teams and dedupes", () => {
		expect(ticketKeys("see HIV-1798 and TES-5925, again HIV-1798")).toEqual(["HIV-1798", "TES-5925"]);
	});

	it("ignores a lookalike", () => {
		expect(ticketKeys("ABC-123 and HIVE-9")).toEqual([]);
	});
});

describe("stripInlineMarker", () => {
	it("strips a trailing marker and reports it", () => {
		expect(stripInlineMarker("make the cards stop jumping -brief")).toEqual({
			text: "make the cards stop jumping",
			marked: true,
		});
	});

	it("leaves an unmarked prompt alone", () => {
		expect(stripInlineMarker("make the cards stop jumping").marked).toBe(false);
	});

	it("does not fire on the word mid-prompt", () => {
		expect(stripInlineMarker("write a -brief summary of the run").marked).toBe(false);
	});
});

describe("looksTaskLike", () => {
	const min = 40;

	it("accepts a task verb", () => {
		expect(looksTaskLike("refactor the scheduler so placement is testable", min)).toBe(true);
	});

	it("accepts a ticket key even with no verb", () => {
		expect(looksTaskLike("HIV-1798 — the one about the opening prompt", min)).toBe(true);
	});

	it("accepts a file path even with no verb", () => {
		expect(looksTaskLike("something is off in internal/scheduler/place.go somewhere", min)).toBe(true);
	});

	it("rejects a short prompt", () => {
		expect(looksTaskLike("fix it", min)).toBe(false);
	});

	it("rejects a slash command and a shell escape", () => {
		expect(looksTaskLike("/plan implement the whole retrieval layer now", min)).toBe(false);
		expect(looksTaskLike("!git status --porcelain and then show me the diff", min)).toBe(false);
	});

	it("does not read `fixture` as `fix`", () => {
		expect(looksTaskLike("the fixture directory contains several large samples", min)).toBe(false);
	});

	it("rejects conversational chatter", () => {
		expect(looksTaskLike("thanks, that all makes sense to me now, appreciated", min)).toBe(false);
	});
});

describe("suppressionReason", () => {
	const base = { minPromptChars: 40, alreadyBriefed: false, env: {} as NodeJS.ProcessEnv };

	it("passes a real task through", () => {
		expect(suppressionReason({ ...base, prompt: "refactor the scheduler so placement is testable" })).toBeNull();
	});

	it("refuses to brief a brief", () => {
		const prompt = `${BRIEF_MARKER} model=x -->\n\n## Goal\n\nrefactor the scheduler for testable placement`;
		expect(suppressionReason({ ...base, prompt })).toBe("prompt is already a compiled brief");
	});

	it("refuses twice in one session", () => {
		const prompt = "refactor the scheduler so placement is testable";
		expect(suppressionReason({ ...base, prompt, alreadyBriefed: true })).toBe("already briefed this session");
	});

	it("refuses inside a worker", () => {
		const env = { PI_AGENDA_WORKER: "1" } as NodeJS.ProcessEnv;
		expect(suppressionReason({ ...base, prompt: "refactor the scheduler for testable placement", env })).toBe(
			"running inside a worker",
		);
	});

	it("refuses a prompt that is protocol and nothing else", () => {
		expect(suppressionReason({ ...base, prompt: TEAM_PROTOCOL })).toBe("prompt is protocol only");
	});

	it("classifies the TASK, not the appended protocol", () => {
		// The protocol is long and full of verbs. Without the split it would make
		// every launched prompt look task-like, including the ones that are not.
		expect(suppressionReason({ ...base, prompt: `ok${TEAM_PROTOCOL}` })).toBe("prompt is not task-like");
	});
});

describe("isWorkerProcess", () => {
	it("recognises both markers", () => {
		expect(isWorkerProcess({ PI_AGENDA_WORKER: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isWorkerProcess({ PI_BRIEF_WORKER: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isWorkerProcess({} as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("the solo-launch protocol block", () => {
	// The single-heading version returned the whole prompt as `task` here, which
	// is why every rule keyed on "was this machine-appended to" missed most
	// launches. Solo is the common shape.
	it("is split off like the team block", () => {
		const { task, protocol } = splitTeamProtocol(`fix the flaky scheduler test${SOLO_PROTOCOL}`);
		expect(task.trim()).toBe("fix the flaky scheduler test");
		expect(protocol).toContain("IF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT");
	});

	it("splits losslessly, like the team block", () => {
		const prompt = `fix the flaky scheduler test${SOLO_PROTOCOL}`;
		const { task, protocol } = splitTeamProtocol(prompt);
		expect(task + protocol).toBe(prompt);
	});

	it("splits at the FIRST heading when a prompt carries both", () => {
		const prompt = `do the thing${SOLO_PROTOCOL}${TEAM_PROTOCOL}`;
		const { task, protocol } = splitTeamProtocol(prompt);
		expect(task.trim()).toBe("do the thing");
		expect(protocol).toContain("IF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT");
		expect(protocol).toContain("TEAM PROTOCOL");
	});
});
