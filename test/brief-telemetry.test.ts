/**
 * brief — what the fleet can see, and what cannot escape (HIV-1805).
 *
 * HIV-1798 shipped a bet about token spend and a record that never left the
 * machine: `appendEntry` writes transcript state, nothing forwards it, and the
 * header claiming hive-telemetry folded it into the run was simply wrong.
 * These tests pin the two halves that make the bet settleable —
 *
 *   - the metric leaves (pass / fail / timeout / skip, per pass and per lane),
 *   - and it leaves as a METRIC: a name, an enum and a duration, never prose,
 *
 * plus the fail-open hole that sat under both: an exception on the handler that
 * gates every session's first turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBriefer = vi.hoisted(() => vi.fn());
vi.mock("../extensions/brief/run.ts", () => ({ runBriefer, BRIEFER_ROLE: "briefer" }));

import brief from "../extensions/brief/index.ts";
import { HIVE_METRIC_CHANNEL } from "../extensions/hive-telemetry/types.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const TASK = "refactor the scheduler so placement scoring is testable";
const SECRET_PATH = "internal/scheduler/place.go:88";

function succeeds() {
	runBriefer.mockResolvedValue({
		draft: {
			goal: "Extract the scoring fold so placement can be tested.",
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
		lanes: [
			{ lane: "repo", ok: true, failure: "", timedOut: false, elapsedMs: 4100, usage: null },
			{ lane: "ticket", ok: false, failure: "timed out after 120000ms", timedOut: true, elapsedMs: 120000, usage: null },
		],
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

function metrics() {
	return pi.busEvents
		.filter((e) => e.name === HIVE_METRIC_CHANNEL)
		.map((e) => e.payload as { kind: string; name: string; outcome: string; value?: number });
}
function metric(name: string) {
	return metrics().find((m) => m.name === name);
}
function entries() {
	return pi.entries.filter((e) => e.customType === "brief").map((e) => e.data as Record<string, unknown>);
}

describe("the metric that reaches Hive", () => {
	it("reports a compiled brief as a pass, with what it cost in wall-clock", async () => {
		succeeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(metric("brief")).toMatchObject({ kind: "gate", outcome: "pass", value: 4200 });
	});

	/**
	 * A pass where every lane hit the wall is a LATENCY problem; one that
	 * returned nothing is a RETRIEVAL problem. Both leave the operator with no
	 * brief, and they want opposite fixes — a bigger timeout versus a better
	 * query — so collapsing them into one outcome would make the data useless
	 * for the only decision it exists to inform.
	 */
	it("separates a timed-out pass from one that found nothing", async () => {
		runBriefer.mockResolvedValue({
			draft: null,
			failure: "repo: timed out",
			model: "cheap/model",
			modelSource: "mode:low",
			usage: null,
			elapsedMs: 120000,
			timedOut: true,
			lanes: [{ lane: "repo", ok: false, failure: "timed out", timedOut: true, elapsedMs: 120000, usage: null }],
		});
		brief(pi.api);
		await pi.emit({ type: "before_agent_start", prompt: TASK });
		expect(metric("brief")?.outcome).toBe("timeout");

		pi = createFakePi();
		runBriefer.mockResolvedValue({
			draft: null,
			failure: "every lane returned an empty draft",
			model: "cheap/model",
			modelSource: "mode:low",
			usage: null,
			elapsedMs: 3000,
			timedOut: false,
			lanes: [{ lane: "repo", ok: false, failure: "found nothing", timedOut: false, elapsedMs: 3000, usage: null }],
		});
		brief(pi.api);
		await pi.emit({ type: "before_agent_start", prompt: TASK });
		expect(metric("brief")?.outcome).toBe("fail");
	});

	/**
	 * Per-lane visibility is the reason the fan-out is not opaque from outside: a
	 * pass whose ticket lane times out on every prompt still reports `pass`
	 * overall, because another lane carried it — and the fix for that is in the
	 * lane, not in the feature.
	 */
	it("reports each lane as itself, including one that failed inside a passing brief", async () => {
		succeeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(metric("brief.repo")).toMatchObject({ outcome: "pass", value: 4100 });
		expect(metric("brief.ticket")).toMatchObject({ outcome: "timeout", value: 120000 });
	});

	// The channel is metric-only BECAUSE any loaded extension can subscribe to
	// pi's bus. The brief is the most prose-shaped payload in this harness, so it
	// is the one that must not leak through a counter.
	it("carries no prose — a name, an enum and a number", async () => {
		succeeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		const payload = JSON.stringify(metrics());
		expect(payload).not.toContain(SECRET_PATH);
		expect(payload).not.toContain("Extract the scoring fold");
		for (const m of metrics()) expect(Object.keys(m).sort()).toEqual(["kind", "name", "outcome", "value"]);
	});

	it("keeps the manual path out of the number the A/B reads", async () => {
		succeeds();
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(metric("brief.manual")?.outcome).toBe("pass");
		expect(metric("brief")).toBeUndefined();
	});
});

describe("a pass that never ran", () => {
	it("records WHY it was suppressed", async () => {
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: "thanks, that all makes sense to me now" });

		expect(entries()[0]).toMatchObject({ mode: "auto", ok: false, suppressed: "prompt is not task-like" });
		expect(metric("brief")?.outcome).toBe("skip");
	});

	/**
	 * The steady state after a brief has fired is "already briefed this session",
	 * on every remaining turn. Recording that would bury the suppression that
	 * actually means something — which is the failure the reason string exists to
	 * prevent, reintroduced from the other side.
	 */
	it("stays quiet about the steady state", async () => {
		succeeds();
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });
		await pi.emit({ type: "before_agent_start", prompt: "now fix the flaky dispatch test in place_test.go" });
		await pi.emit({ type: "before_agent_start", prompt: "and re-run the gate for me please" });

		expect(entries().filter((e) => e.suppressed)).toEqual([]);
	});

	it("records one suppression per session, not one per turn", async () => {
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: "hmm" });
		await pi.emit({ type: "before_agent_start", prompt: "ok" });
		await pi.emit({ type: "before_agent_start", prompt: "sure" });

		expect(entries().filter((e) => e.suppressed)).toHaveLength(1);
	});

	it("re-arms the suppression record on a new session", async () => {
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: "hmm" });
		await pi.emit({ type: "session_start", reason: "new" });
		await pi.emit({ type: "before_agent_start", prompt: "hmm" });

		expect(entries().filter((e) => e.suppressed)).toHaveLength(2);
	});
});

describe("the fail-open contract", () => {
	/**
	 * Everything under this handler resolves rather than throws, so a throw
	 * reaching it means something nobody modelled — a spawn that failed
	 * synchronously, an ENOENT on the pi binary. This is the handler that gates
	 * the session's FIRST TURN: a brief that cannot be compiled costs a few
	 * turns, an exception escaping here costs the prompt.
	 */
	it("swallows a crash in the pass and leaves the prompt untouched", async () => {
		runBriefer.mockRejectedValue(new Error("spawn ENOENT"));
		brief(pi.api);

		const results = await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(results[0]).toBeUndefined();
		expect(entries()[0]).toMatchObject({ ok: false });
		expect(String(entries()[0]?.failure)).toContain("spawn ENOENT");
		expect(metric("brief")?.outcome).toBe("fail");
	});

	it("clears the status line after a crash", async () => {
		runBriefer.mockRejectedValue(new Error("spawn ENOENT"));
		brief(pi.api);

		await pi.emit({ type: "before_agent_start", prompt: TASK });

		expect(pi.statuses.map((s) => s.text)).toEqual(["compiling brief…", undefined]);
	});

	it("keeps the operator's typed prompt when /brief crashes", async () => {
		runBriefer.mockRejectedValue(new Error("spawn ENOENT"));
		brief(pi.api);

		await pi.runCommand("brief", TASK);

		expect(pi.editorTexts).toEqual([]);
		expect(pi.notifications.at(-1)?.message).toContain("your prompt is unchanged");
	});
});
