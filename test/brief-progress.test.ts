/**
 * The brief holding the first turn, as a signal that leaves the machine
 * (HIV-2242).
 *
 * The defect these cover is one of ABSENCE, which is why they assert on the bus
 * rather than on a rendering: the brief blocks `before_agent_start` for up to
 * 120s per retrieval lane, its only progress signal was `ctx.ui.setStatus` —
 * which paints the local status line and reaches nothing else — and every
 * activity phase hive-remote reports is entered at `turn_start` or later. So
 * the window the operator most wants to see was the one window nothing could
 * describe, and a launch working normally was indistinguishable, from the
 * browser, from one that had hung.
 *
 * Two properties matter and neither is "a brief gets compiled":
 *
 *  1. the pass ANNOUNCES ITSELF BEFORE it blocks, and releases on every exit —
 *     including the ones that never reach a turn
 *  2. the announcement carries lane names and NOTHING ELSE, per the rule at the
 *     top of hive-common/channels.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));

import brief from "../extensions/brief/index.ts";
import { HIVE_BRIEF_PROGRESS_CHANNEL } from "../extensions/hive-common/channels.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const TASK = "refactor the scheduler so placement scoring is testable";
const TICKET_TASK = "fix HIV-1234 so the placement fold is testable in isolation";
const SECRET_PATH = "internal/scheduler/place.go:88";
const GOAL = "Extract the scoring fold so placement can be tested.";

function brieferSucceeds() {
	runBriefer.mockResolvedValue({
		draft: {
			goal: GOAL,
			facts: [{ ref: SECRET_PATH, note: "scoring is inline" }],
			startHere: [],
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

function progress() {
	return pi.busEvents
		.filter((e) => e.name === HIVE_BRIEF_PROGRESS_CHANNEL)
		.map((e) => e.payload as { phase?: string; lanes?: string[] });
}

// Ticket keys come from the house profile; with none configured no prompt
// names a ticket and the ticket lane never spawns.
beforeEach(() => setHouseProfileForTest({ ticketKeys: ["HIV", "AUR", "BOR"] }));
afterEach(() => setHouseProfileForTest(null));

describe("announcing the held turn", () => {
	it("says `start` before the pass and `end` after it", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(progress().map((p) => p.phase)).toEqual(["start", "end"]);
	});

	// The ordering is the entire point. A `start` emitted after the await would
	// arrive when the wait it describes is already over — which is the state the
	// feature replaces, not a smaller version of it.
	it("says `start` BEFORE the briefer is called, not after", async () => {
		const order: string[] = [];
		runBriefer.mockImplementation(async () => {
			order.push("briefer");
			return {
				draft: null,
				failure: "no",
				model: "",
				modelSource: "",
				usage: null,
				elapsedMs: 1,
				timedOut: false,
				lanes: [],
			};
		});
		brief(pi.api);
		pi.api.events.on(HIVE_BRIEF_PROGRESS_CHANNEL, (d: unknown) => {
			order.push(`progress:${(d as { phase: string }).phase}`);
		});

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(order).toEqual(["progress:start", "briefer", "progress:end"]);
	});

	// A brief that failed still HELD the turn, so the operator still waited and
	// still needs the phase released. This is the split from HIVE_BRIEF_CHANNEL,
	// which is a document doorbell and correctly stays silent here.
	it("releases the phase when the briefer failed", async () => {
		runBriefer.mockResolvedValue({
			draft: null,
			failure: "briefer timed out",
			model: "cheap/model",
			modelSource: "mode:low",
			usage: null,
			elapsedMs: 120_000,
			timedOut: true,
			lanes: [{ lane: "repo", ok: false, failure: "timed out", timedOut: true, elapsedMs: 120_000, usage: null }],
		});
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(progress().map((p) => p.phase)).toEqual(["start", "end"]);
	});

	// The `finally` is what makes this true, and it is the reason the release
	// does not ride on `turn_start`: there is no turn on this path. A workspace
	// left on "Briefing" forever would be the one failure this feature could
	// introduce that is worse than the silence it replaces.
	it("releases the phase when the pass CRASHES", async () => {
		runBriefer.mockRejectedValue(new Error("nobody modelled this"));
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(progress().map((p) => p.phase)).toEqual(["start", "end"]);
	});

	// The suppressed path never blocks, so announcing a wait would be a lie —
	// and one that would leave a phase set with nothing coming to clear it.
	it("says nothing at all when the brief is suppressed", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: "hi" });

		expect(progress()).toEqual([]);
		expect(runBriefer).not.toHaveBeenCalled();
	});
});

describe("what the announcement carries", () => {
	it("names the lanes the task plans to use", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(progress()[0]?.lanes).toEqual(["repo", "knowledge"]);
	});

	// The ticket lane is conditional — it runs only when the prompt names a key
	// — so a fixed list would describe a pass that is not the one running.
	it("adds the ticket lane when the prompt names a key", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TICKET_TASK });

		expect(progress()[0]?.lanes).toEqual(["repo", "knowledge", "ticket"]);
	});

	// Same rule as every other channel in hive-common: any loaded extension can
	// subscribe to pi's bus, so prose on it is an exfiltration path past each
	// extension's own payload boundary. Lane names are a closed enum.
	it("carries lane names and NOT the task or anything retrieved", async () => {
		brieferSucceeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		const wire = JSON.stringify(progress());
		expect(wire).not.toContain(SECRET_PATH);
		expect(wire).not.toContain(GOAL);
		expect(wire).not.toContain("scheduler");
		expect(Object.keys(progress()[0] as object).sort()).toEqual(["lanes", "phase"]);
		expect(Object.keys(progress()[1] as object)).toEqual(["phase"]);
	});
});
