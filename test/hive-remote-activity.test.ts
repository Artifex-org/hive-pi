import { describe, expect, it } from "vitest";
import {
	HEARTBEAT_MS,
	MAX_DETAIL,
	buildPayload,
	createActivity,
	enterPhase,
	shouldReport,
	toolDetail,
	toolEnded,
	toolStarted,
	turnEnded,
} from "../extensions/hive-remote/activity.ts";

const T0 = Date.parse("2026-08-06T12:00:00Z");

describe("phase transitions", () => {
	// Load-bearing rather than an optimisation: `sinceMs` is what the pane's
	// elapsed timer counts from, so re-entering the current phase on every
	// streamed token would reset it and a long turn would read as "0s" forever.
	it("does not restart the clock when nothing changed", () => {
		const s = createActivity(T0);
		enterPhase(s, "responding", T0 + 1_000);
		enterPhase(s, "responding", T0 + 9_000);
		expect(s.sinceMs).toBe(T0 + 1_000);
	});

	it("restarts the clock on a real change", () => {
		const s = createActivity(T0);
		enterPhase(s, "thinking", T0 + 1_000);
		enterPhase(s, "responding", T0 + 4_000);
		expect(s.phase).toBe("responding");
		expect(s.sinceMs).toBe(T0 + 4_000);
	});

	// The tool NAME is part of the identity: "running bash" and "running rg" are
	// different situations to someone watching a session that has gone quiet.
	it("treats a different tool as a different phase", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		toolStarted(s, "2", "rg", T0 + 2_000);
		expect(s.tool).toBe("rg");
		expect(s.sinceMs).toBe(T0 + 2_000);
	});
});

describe("concurrent tool calls", () => {
	// pi runs batches. One call finishing must not report the whole batch done —
	// the operator wants to know something is still executing.
	it("stays in the tool phase while a sibling is still running", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		toolStarted(s, "2", "rg", T0 + 1_100);
		toolEnded(s, "2", T0 + 2_000);
		expect(s.phase).toBe("tool");
		expect(s.tool).toBe("bash");
	});

	// NOT idle: the turn has not ended, the model is back at the provider
	// deciding what to do with the result. Reporting idle here would draw a
	// finished agent over one that is mid-turn.
	it("returns to working, not idle, when the last tool finishes", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		toolEnded(s, "1", T0 + 5_000);
		expect(s.phase).toBe("working");
	});

	// An aborted tool never emits its end event. A stale entry would make the
	// NEXT turn report a tool that is long gone.
	it("forgets tools that never finished when the turn ends", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		turnEnded(s, T0 + 9_000);
		expect(s.phase).toBe("idle");
		expect(s.running.size).toBe(0);
	});
});

describe("shouldReport", () => {
	function sent(phase: Parameters<typeof enterPhase>[1], atMs: number) {
		const s = createActivity(T0);
		enterPhase(s, phase, atMs);
		buildPayload(s, atMs);
		return s;
	}

	it("always reports the first reading", () => {
		expect(shouldReport(createActivity(T0), T0)).toBe(true);
	});

	it("reports a change immediately", () => {
		const s = sent("thinking", T0);
		enterPhase(s, "tool", T0 + 100, "bash");
		expect(shouldReport(s, T0 + 100)).toBe(true);
	});

	// The whole feature: proof of life during a long tool call, where nothing
	// changes for minutes and silence is the only other explanation.
	it("beats while work is in flight and nothing has changed", () => {
		const s = sent("tool", T0);
		expect(shouldReport(s, T0 + HEARTBEAT_MS - 1)).toBe(false);
		expect(shouldReport(s, T0 + HEARTBEAT_MS)).toBe(true);
	});

	// A workstation at a prompt overnight would otherwise POST every ten seconds,
	// forever, to say nothing. It costs the pane nothing: an idle agent draws no
	// activity row, so there is no liveness claim standing that could go stale.
	it("goes silent once idle", () => {
		const s = sent("idle", T0);
		expect(shouldReport(s, T0 + 60 * HEARTBEAT_MS)).toBe(false);
	});

	it("still reports the transition INTO idle", () => {
		const s = sent("tool", T0);
		turnEnded(s, T0 + 1_000);
		expect(shouldReport(s, T0 + 1_000)).toBe(true);
	});

	// needs_input and completed are both idle-shaped for beating (HIV-1240/1265):
	// an agent waiting on an answer, or on review of finished work, must not
	// re-POST forever. The transition in was the news.
	it("goes silent once needs_input or completed, but reports the transition", () => {
		const asking = sent("tool", T0);
		enterPhase(asking, "needs_input", T0 + 1_000);
		expect(shouldReport(asking, T0 + 1_000)).toBe(true);
		buildPayload(asking, T0 + 1_000);
		expect(shouldReport(asking, T0 + 60 * HEARTBEAT_MS)).toBe(false);

		const done = sent("tool", T0);
		enterPhase(done, "completed", T0 + 1_000);
		expect(shouldReport(done, T0 + 1_000)).toBe(true);
		buildPayload(done, T0 + 1_000);
		expect(shouldReport(done, T0 + 60 * HEARTBEAT_MS)).toBe(false);
	});
});

describe("buildPayload", () => {
	it("carries the phase, the tool and the phase's start", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		const payload = buildPayload(s, T0 + 3_000);
		expect(payload).toEqual({
			phase: "tool",
			tool: "bash",
			since: new Date(T0 + 1_000).toISOString(),
		});
	});

	// `since` is the PHASE's start, not the beat's. Sending the beat's time would
	// make the pane restart the elapsed timer every ten seconds, so one
	// four-minute tool call would render as a series of short ones.
	it("keeps sending the phase's start across beats", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000);
		buildPayload(s, T0 + 3_000);
		const second = buildPayload(s, T0 + 40_000);
		expect(second.since).toBe(new Date(T0 + 1_000).toISOString());
	});

	// Recorded at BUILD time, not on a successful response: a beat is
	// fire-and-forget, and re-reporting because one response was slow would queue
	// a burst of identical posts behind a single stalled request.
	it("closes the send gate as soon as the payload is taken", () => {
		const s = createActivity(T0);
		enterPhase(s, "tool", T0, "bash");
		buildPayload(s, T0);
		expect(shouldReport(s, T0 + 1_000)).toBe(false);
	});

	it("omits the tool when there is none", () => {
		const s = createActivity(T0);
		enterPhase(s, "thinking", T0);
		expect(buildPayload(s, T0).tool).toBeUndefined();
	});
});

// The detail (HIV-1279). `bash` is the same word for a two-second `ls` and a
// twenty-minute `hive check`, and the transcript's own tool event does not reach
// Hive until the call ENDS — so while a long call blocks, this is the only thing
// that can say what is being waited on.
describe("toolDetail", () => {
	it("reads the command off a bash call", () => {
		expect(toolDetail("bash", { command: "hive check --step lint" })).toBe("hive check --step lint");
	});

	// A heredoc would otherwise put its whole body on a one-line status.
	it("takes only the first line", () => {
		expect(toolDetail("bash", { command: "hive check \\\n  --step lint" })).toBe("hive check \\");
	});

	it("reads the path off a file tool and the pattern off a search", () => {
		expect(toolDetail("read", { path: "internal/store/agent_session_status.go" })).toBe(
			"internal/store/agent_session_status.go",
		);
		expect(toolDetail("grep", { pattern: "activity_detail" })).toBe("activity_detail");
	});

	// Unrecognised tools fall back to the tool name, which is what the pane
	// showed before this existed — never a JSON blob on a status line.
	it("says nothing about a tool it does not know", () => {
		expect(toolDetail("subagent", { role: "research", prompt: "x" })).toBe("");
		expect(toolDetail("bash", undefined)).toBe("");
		expect(toolDetail("bash", { command: 42 })).toBe("");
	});

	it("truncates a command too long for a status line", () => {
		const got = toolDetail("bash", { command: "x".repeat(MAX_DETAIL + 50) });
		expect(got.length).toBe(MAX_DETAIL);
		expect(got.endsWith("…")).toBe(true);
	});
});

describe("detail on the wire", () => {
	it("rides the beat that enters the phase, once", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000, "hive check --step lint");
		expect(buildPayload(s, T0 + 1_000).detail).toBe("hive check --step lint");
		// The heartbeats that follow omit it; the server preserves the stored
		// value, so re-sending the same command every ten seconds is wire noise.
		expect(buildPayload(s, T0 + 11_000).detail).toBeUndefined();
	});

	// The detail belongs to the phase. Carrying it across would label the next
	// tool call with the previous one's command.
	it("does not survive into the next phase", () => {
		const s = createActivity(T0);
		toolStarted(s, "1", "bash", T0 + 1_000, "hive check --step lint");
		buildPayload(s, T0 + 1_000);
		enterPhase(s, "thinking", T0 + 5_000);
		expect(buildPayload(s, T0 + 5_000).detail).toBeUndefined();
	});
});
