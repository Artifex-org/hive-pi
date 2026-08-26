/**
 * brief — what the extension actually DOES when pi emits (HIV-1798).
 *
 * The briefer worker is mocked; spawning a real child would test pi, not this.
 * What is exercised here is every decision the extension makes around it, and
 * the ones that matter most are the negative ones: the auto path must fail OPEN
 * (a dead briefer costs latency, never the prompt), must fire once, and must
 * never hand the appended TEAM PROTOCOL block to a model that rewrites text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));

import brief from "../extensions/brief/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const TASK = "refactor the scheduler so placement scoring is testable";

const TEAM_PROTOCOL = `

---
TEAM PROTOCOL (added by Hive — you are on a team)

Send a short \`message_teammate\` to \`@orchestrator\` at these four moments.
`;

function brieferReturns(overrides: Record<string, unknown> = {}) {
	runBriefer.mockResolvedValue({
		draft: {
			goal: "Extract the scoring fold so placement can be tested.",
			facts: [{ ref: "internal/scheduler/place.go:88", note: "scoring is inline" }],
			startHere: [{ ref: "internal/scheduler/place.go", reason: "holds the fold" }],
			refs: [],
			unknowns: [],
			nextMoves: [],
			history: [{ ref: "internal/scheduler/place.go", note: "last changed 2026-08-01 in a1b2c3d — split the dispatch loop" }],
		},
		failure: "",
		model: "cheap/model",
		modelSource: "mode:low",
		usage: { input: 900, output: 120 },
		elapsedMs: 4200,
		timedOut: false,
		lanes: [
			{ lane: "repo", ok: true, failure: "", timedOut: false, elapsedMs: 4100, usage: null },
			{ lane: "knowledge", ok: true, failure: "", timedOut: false, elapsedMs: 2200, usage: null },
		],
		...overrides,
	});
}

function brieferFails(failure: string, overrides: Record<string, unknown> = {}) {
	runBriefer.mockResolvedValue({
		draft: null,
		failure,
		model: "cheap/model",
		modelSource: "mode:low",
		usage: null,
		elapsedMs: 900,
		timedOut: false,
		lanes: [{ lane: "repo", ok: false, failure, timedOut: false, elapsedMs: 900, usage: null }],
		...overrides,
	});
}

let pi: FakePi;
const savedEnv = { ...process.env };

beforeEach(() => {
	runBriefer.mockReset();
	pi = createFakePi();
});

afterEach(() => {
	process.env = { ...savedEnv };
});

describe("the automatic path", () => {
	it("injects a brief before the first task-like turn", async () => {
		brieferReturns();
		brief(pi.api);

		const results = await pi.emit({ type: "before_agent_start", prompt: TASK });

		const injected = results[0] as { message?: { customType: string; content: string; display?: boolean } };
		expect(injected?.message?.customType).toBe("brief");
		expect(injected?.message?.content).toContain("Extract the scoring fold");
		// Displayed: content entering the model's context on the operator's
		// behalf that nobody can see is content nobody can correct.
		expect(injected?.message?.display).toBe(true);
	});

	it("does not repeat the caller's prompt back at it", async () => {
		brieferReturns();
		brief(pi.api);

		const results = await pi.emit({ type: "before_agent_start", prompt: TASK });
		expect((results[0] as { message: { content: string } }).message.content).not.toContain(TASK);
	});

	it("hands the briefer the task, never the appended protocol", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: `${TASK}${TEAM_PROTOCOL}` });

		expect(runBriefer).toHaveBeenCalledTimes(1);
		const passed = runBriefer.mock.calls[0]![0] as { task: string };
		expect(passed.task).toContain(TASK);
		expect(passed.task).not.toContain("TEAM PROTOCOL");
	});

	// The same guarantee for a SOLO launch, which is the common shape and the one
	// the single-heading split could not see (HIV-2530). The brief still runs —
	// what changed is that the briefer no longer receives Hive's appended block
	// as if it were part of the task.
	it("hands the briefer the task for a solo launch too", async () => {
		brieferReturns();
		brief(pi.api);

		const SOLO = "\n\n---\nIF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT (added by Hive)\n\nYou are running alone. Say so and carry on.\n";
		await pi.emit({ type: "before_agent_start", prompt: `${TASK}${SOLO}` });

		expect(runBriefer).toHaveBeenCalledTimes(1);
		const passed = runBriefer.mock.calls[0]![0] as { task: string };
		expect(passed.task).toContain(TASK);
		expect(passed.task).not.toContain("BIGGER THAN ONE AGENT");
	});

	it("fires once per session", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });
		await pi.emit({ type: "before_agent_start", prompt: "now also fix the flaky dispatch test in place_test.go" });

		expect(runBriefer).toHaveBeenCalledTimes(1);
	});

	it("re-arms on a new session", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });
		await pi.emit({ type: "session_start", reason: "new" });
		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(runBriefer).toHaveBeenCalledTimes(2);
	});

	it("does not re-arm on a resume — the brief is already in the transcript", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });
		await pi.emit({ type: "session_start", reason: "resume" });
		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(runBriefer).toHaveBeenCalledTimes(1);
	});

	it("stays out of the way of a prompt that is not task-like", async () => {
		brief(pi.api);
		await pi.emit({ type: "before_agent_start", prompt: "thanks, that all makes sense to me now" });
		expect(runBriefer).not.toHaveBeenCalled();
	});

	it("fails OPEN when the briefer times out — no message, prompt untouched", async () => {
		brieferFails("briefer timed out after 60000ms");
		brief(pi.api);

		const results = await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(results[0]).toBeUndefined();
		expect(pi.entries).toEqual([
			{
				customType: "brief",
				data: expect.objectContaining({ ok: false, failure: "briefer timed out after 60000ms", mode: "auto" }),
			},
		]);
	});

	it("clears its status line whether it succeeded or not", async () => {
		brieferFails("briefer found nothing");
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(pi.statuses.map((s) => s.text)).toEqual(["compiling brief…", undefined]);
	});

	it("records what the pass cost, so the token bet is settleable", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(pi.entries[0]?.data).toMatchObject({
			mode: "auto",
			ok: true,
			model: "cheap/model",
			elapsedMs: 4200,
			usage: { input: 900, output: 120 },
		});
	});
});

describe("the explicit path", () => {
	it("/brief writes to the editor and does NOT start a turn", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(pi.editorTexts).toHaveLength(1);
		expect(pi.editorTexts[0]).toContain("Extract the scoring fold");
		// The whole point of asking by name is to read it first.
		expect(pi.userMessages).toEqual([]);
		expect(pi.messages).toEqual([]);
	});

	it("/brief keeps the original verbatim — here the brief BECOMES the prompt", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(pi.editorTexts[0]).toContain(TASK);
	});

	it("a trailing -brief marker is handled, not passed through", async () => {
		brieferReturns();
		brief(pi.api);

		const results = await pi.emit({ type: "input", text: `${TASK} -brief` });

		expect(results[0]).toEqual({ action: "handled" });
		expect(pi.editorTexts).toHaveLength(1);
	});

	it("an unmarked input is passed straight through", async () => {
		brief(pi.api);
		const results = await pi.emit({ type: "input", text: TASK });
		expect(results[0]).toEqual({ action: "continue" });
		expect(runBriefer).not.toHaveBeenCalled();
	});

	it("leaves the editor alone when the briefer fails, and says so", async () => {
		brieferFails("briefer returned no parseable json");
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(pi.editorTexts).toEqual([]);
		expect(pi.notifications.at(-1)?.message).toContain("your prompt is unchanged");
	});

	it("/brief off stops the automatic path but keeps the command", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.runCommand("brief", "off");
		await pi.emit({ type: "before_agent_start", prompt: TASK });
		expect(runBriefer).not.toHaveBeenCalled();

		await pi.runCommand("brief", TASK);
		expect(runBriefer).toHaveBeenCalledTimes(1);
	});

	it("/brief on re-enables it", async () => {
		brieferReturns();
		brief(pi.api);

		await pi.runCommand("brief", "off");
		await pi.runCommand("brief", "on");
		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(runBriefer).toHaveBeenCalledTimes(1);
	});

	it("/brief with no argument explains itself instead of guessing", async () => {
		brief(pi.api);
		await pi.runCommand("brief", "");
		expect(runBriefer).not.toHaveBeenCalled();
		expect(pi.notifications.at(-1)?.message).toContain("/brief <what you want done>");
	});
});

describe("registration", () => {
	it("registers nothing at all inside a worker", () => {
		process.env.PI_AGENDA_WORKER = "1";
		brief(pi.api);
		expect(pi.handlers.size).toBe(0);
		expect(pi.commands.size).toBe(0);
	});

	it("registers nothing when disabled", () => {
		process.env.PI_BRIEF_DISABLED = "1";
		brief(pi.api);
		expect(pi.handlers.size).toBe(0);
	});

	it("starts armed but idle when PI_BRIEF_AUTO=0", async () => {
		process.env.PI_BRIEF_AUTO = "0";
		brief(pi.api);
		await pi.emit({ type: "before_agent_start", prompt: TASK });
		expect(runBriefer).not.toHaveBeenCalled();
		expect(pi.commands.has("brief")).toBe(true);
	});
});
