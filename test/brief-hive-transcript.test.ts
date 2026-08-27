/**
 * brief → the Hive agents transcript (HIV-1801).
 *
 * The bug this covers is a SILENT one and it survived a full test suite: the
 * brief was injected as a `customType` message, `hive-remote`'s `message_end`
 * returns early on anything that is not an assistant message, and so the brief
 * reached Hive not at all. Nothing failed. An operator watching the workspace
 * simply saw the agent start work on context they could not see.
 *
 * So these tests assert the two halves of the contract that carries it — the
 * doorbell carries a COUNT and never the prose, and the prose is readable from
 * the session entry — rather than re-testing that a brief gets compiled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));

import brief from "../extensions/brief/index.ts";
import { HIVE_BRIEF_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const TASK = "refactor the scheduler so placement scoring is testable";
const GOAL = "Extract the scoring fold so placement can be tested.";
const SECRET_PATH = "internal/scheduler/place.go:88";

function brieferSucceeds() {
	runBriefer.mockResolvedValue({
		draft: {
			goal: GOAL,
			facts: [{ ref: SECRET_PATH, note: "scoring is inline" }],
			startHere: [{ ref: "internal/scheduler/place.go", reason: "holds the fold" }],
			refs: [],
			unknowns: [],
			nextMoves: [],
			history: [],
		},
		failure: "",
		model: "cheap/model",
		modelSource: "mode:low",
		usage: { input: 900, output: 120 },
		elapsedMs: 4200,
		timedOut: false,
		lanes: [{ lane: "repo", ok: true, failure: "", timedOut: false, elapsedMs: 4100, usage: null }],
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

function ring() {
	return pi.busEvents.find((e) => e.name === HIVE_BRIEF_CHANNEL);
}
function entry() {
	return pi.entries.find((e) => e.customType === "brief")?.data as { text?: string } | undefined;
}

describe("the doorbell", () => {
	it("rings once a brief is compiled", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(ring()).toBeDefined();
		expect((ring()?.payload as { sections?: number })?.sections).toBeGreaterThan(0);
	});

	// The rule at the top of hive-common/channels.ts: any loaded extension can
	// subscribe to pi's bus, so a channel carrying prose is an exfiltration path
	// past every extension's own payload boundary. The brief is the most
	// prose-shaped payload in this harness — repo paths, ticket contents,
	// whatever the knowledge brain returned.
	it("carries a count and NOT the prose", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		const payload = JSON.stringify(ring()?.payload ?? {});
		expect(payload).not.toContain(SECRET_PATH);
		expect(payload).not.toContain(GOAL);
		expect(Object.keys(ring()?.payload as object)).toEqual(["sections"]);
	});

	it("does not ring when the briefer failed", async () => {
		runBriefer.mockResolvedValue({
			draft: null,
			failure: "briefer timed out",
			model: "cheap/model",
			modelSource: "mode:low",
			usage: null,
			elapsedMs: 900,
			timedOut: true,
			lanes: [{ lane: "repo", ok: false, failure: "timed out", timedOut: true, elapsedMs: 900, usage: null }],
		});
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(ring()).toBeUndefined();
	});

	// `/brief` writes to the editor and the operator sends it as an ordinary
	// prompt, which reaches Hive as a normal user turn. Ringing would double it.
	it("does not ring on the explicit path", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(pi.editorTexts).toHaveLength(1);
		expect(ring()).toBeUndefined();
	});
});

describe("the session entry the subscriber reads", () => {
	it("carries the rendered brief", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(entry()?.text).toContain(GOAL);
		expect(entry()?.text).toContain(SECRET_PATH);
	});

	// Ordering is the whole reason the ring happens after appendEntry: the
	// subscriber reads the NEWEST brief entry when it fires, so a ring that
	// preceded the write would race it to an empty read and silently show
	// nothing.
	it("is persisted BEFORE the doorbell rings", async () => {
		brieferSucceeds();
		brief(pi.api);

		const order: string[] = [];
		pi.api.events.on(HIVE_BRIEF_CHANNEL, () => {
			order.push(entry()?.text ? "entry-present" : "entry-missing");
		});

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(order).toEqual(["entry-present"]);
	});

	it("records no text when the briefer failed", async () => {
		runBriefer.mockResolvedValue({
			draft: null,
			failure: "briefer found nothing",
			model: "cheap/model",
			modelSource: "mode:low",
			usage: null,
			elapsedMs: 900,
			timedOut: false,
			lanes: [{ lane: "repo", ok: false, failure: "found nothing", timedOut: false, elapsedMs: 900, usage: null }],
		});
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(entry()).toBeDefined(); // the spend record still exists
		expect(entry()?.text).toBeUndefined();
	});
});
