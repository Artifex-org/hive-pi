/**
 * The pi RPC wire protocol.
 *
 * Three of these pin failures that are invisible in a happy-path run and fatal
 * in production:
 *
 *   - an unanswered `extension_ui_request` hangs an unattended worker forever
 *   - a JSON object split across two stdout chunks is lost silently
 *   - an unknown event type must be ignored, or the next pi bump kills workers
 *
 * None of them need a child process, which is the point of keeping the fold
 * pure.
 */

import { describe, expect, it } from "vitest";
import {
	deliveryCommand,
	emptyWorkerState,
	finalText,
	foldLine,
	frame,
	isBlocked,
	latestReport,
	MAX_REPORTS,
	parseReport,
	takeReplies,
	type WorkerState,
} from "../extensions/agenda/rpc-protocol.ts";
import type { WireUsage } from "../extensions/harness/usage.ts";

const feed = (lines: string[], from: WorkerState = emptyWorkerState): WorkerState =>
	lines.reduce((state, line) => foldLine(state, line), from);

// `WireUsage`, not `Record<string, number>` — `cost` is an object, and a helper
// that mistypes it lets the fold quietly stop reading dollars with no test failing.
const assistant = (text: string, usage?: WireUsage) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });

describe("foldLine — basics", () => {
	it("ignores blank lines without counting them as junk", () => {
		expect(feed(["", "   "])).toEqual(emptyWorkerState);
	});

	it("counts unparseable lines rather than throwing", () => {
		// The child's stderr can interleave, and a crash dump is not JSON.
		expect(feed(["not json at all"]).junk).toBe(1);
	});

	it("ignores an unknown event type", () => {
		// pi adds events between versions. A worker that dies on an unrecognised
		// line is a worker that dies on the next pin bump.
		const state = feed([JSON.stringify({ type: "some_future_event", payload: 1 })]);
		expect(state).toEqual(emptyWorkerState);
	});

	it("tracks busy across agent_start and agent_settled", () => {
		let state = feed([JSON.stringify({ type: "agent_start" })]);
		expect(state.busy).toBe(true);
		expect(state.everSettled).toBe(false);
		state = foldLine(state, JSON.stringify({ type: "agent_settled" }));
		expect(state.busy).toBe(false);
		expect(state.everSettled).toBe(true);
	});

	it("accumulates assistant text and tokens, and counts turns", () => {
		const state = feed([
			assistant("first", { input: 10, output: 5 }),
			JSON.stringify({ type: "turn_end" }),
			assistant("second", { input: 3, output: 2 }),
			JSON.stringify({ type: "turn_end" }),
		]);
		expect(finalText(state)).toBe("first\nsecond");
		expect(state.tokens).toBe(20);
		expect(state.turns).toBe(2);
	});

	it("ignores a non-assistant message_end", () => {
		const line = JSON.stringify({ type: "message_end", message: { role: "user", content: "hi" } });
		expect(feed([line]).texts).toEqual([]);
	});

	it("accepts assistant content as a bare string", () => {
		const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: "plain" } });
		expect(finalText(feed([line]))).toBe("plain");
	});

	it("records the last tool for the live view", () => {
		const state = feed([JSON.stringify({ type: "tool_execution_start", toolName: "bash" })]);
		expect(state.lastTool).toBe("bash");
	});
});

describe("extension_ui_request — the hang", () => {
	it("queues a reply, because nobody else will ever answer one", () => {
		// A worker is unattended by definition. The subagent extension really does
		// call ctx.ui.confirm (its project-agent trust prompt), and in RPC mode the
		// child BLOCKS until a matching response arrives.
		const state = feed([
			JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run project agents?" }),
		]);
		expect(state.pendingReplies).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
	});

	it("declines rather than confirms", () => {
		// Silently confirming would let a repo-supplied prompt grant itself the
		// trust a human was supposed to grant.
		const reply = feed([JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm" })])
			.pendingReplies[0];
		expect(reply).toMatchObject({ cancelled: true });
		expect(JSON.stringify(reply)).not.toContain("confirmed");
	});

	it("ignores a request with no id, which cannot be answered anyway", () => {
		expect(feed([JSON.stringify({ type: "extension_ui_request", method: "notify" })]).pendingReplies).toEqual([]);
	});

	it("queues one reply per request, in order", () => {
		const state = feed([
			JSON.stringify({ type: "extension_ui_request", id: "a" }),
			JSON.stringify({ type: "extension_ui_request", id: "b" }),
		]);
		expect(state.pendingReplies.map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("takeReplies drains exactly once", () => {
		const state = feed([JSON.stringify({ type: "extension_ui_request", id: "a" })]);
		const first = takeReplies(state);
		expect(first.replies).toHaveLength(1);
		// Draining twice would answer the same blocking request twice; the child
		// keys by id and drops the second, but the queue must not grow forever.
		expect(takeReplies(first.state).replies).toHaveLength(0);
	});
});

describe("frame — the split-chunk loss", () => {
	it("returns a trailing partial rather than parsing it", () => {
		const first = frame("", '{"type":"agent_st');
		expect(first.lines).toEqual([]);
		expect(first.rest).toBe('{"type":"agent_st');
	});

	it("reassembles an object split across two chunks", () => {
		// Without this, the object parses as junk twice and the event is lost
		// silently — no error, just a worker that never looks busy.
		const first = frame("", '{"type":"agent_st');
		const second = frame(first.rest, 'art"}\n');
		expect(second.lines).toEqual(['{"type":"agent_start"}']);
		expect(feed(second.lines).busy).toBe(true);
	});

	it("splits several complete lines in one chunk", () => {
		const framed = frame("", '{"a":1}\n{"b":2}\n');
		expect(framed.lines).toHaveLength(2);
		expect(framed.rest).toBe("");
	});

	it("survives a chunk boundary landing exactly on the newline", () => {
		const first = frame("", '{"type":"turn_end"}');
		const second = frame(first.rest, "\n");
		expect(feed(second.lines).turns).toBe(1);
	});
});

describe("deliveryCommand", () => {
	it("maps the two modes to the two commands pi actually distinguishes", () => {
		// Exposed rather than abstracted: a steer for merely-additional scope
		// throws away in-flight reasoning, and a follow_up for a stop-now
		// correction lets the worker finish work that is already wrong.
		expect(deliveryCommand("1", "steer", "stop")).toEqual({ id: "1", type: "steer", message: "stop" });
		expect(deliveryCommand("1", "follow_up", "also")).toEqual({ id: "1", type: "follow_up", message: "also" });
	});
});

describe("the upward report channel", () => {
	const report = (args: unknown) => JSON.stringify({ type: "tool_execution_start", toolName: "report", args });

	it("folds a report the moment the tool is CALLED, not when the worker finishes", () => {
		// Spike W2: tool_execution_start carries toolName AND args on the RPC
		// stream. That is what lets a worker stuck at minute two say so at minute
		// two rather than at minute twenty.
		const state = feed([report({ status: "blocked", note: "needs a DB password" })]);
		expect(latestReport(state)).toEqual({ status: "blocked", note: "needs a DB password" });
		expect(isBlocked(state)).toBe(true);
	});

	it("still records the tool name for the live view", () => {
		expect(feed([report({ status: "progress", note: "ok" })]).lastTool).toBe("report");
	});

	it("clamps pct into range rather than trusting it", () => {
		expect(latestReport(feed([report({ status: "progress", note: "x", pct: 250 })]))?.pct).toBe(100);
		expect(latestReport(feed([report({ status: "progress", note: "x", pct: -4 })]))?.pct).toBe(0);
		expect(latestReport(feed([report({ status: "progress", note: "x", pct: 41.6 })]))?.pct).toBe(42);
	});

	it("omits pct entirely when the worker did not offer a usable one", () => {
		expect(latestReport(feed([report({ status: "progress", note: "x", pct: "soon" })]))?.pct).toBeUndefined();
		expect(latestReport(feed([report({ status: "progress", note: "x", pct: Number.NaN })]))?.pct).toBeUndefined();
	});

	it("drops an unknown status instead of passing it through", () => {
		// The parent validates, not the child: anything loaded into a worker can
		// call `report`, so its args are untrusted input crossing a process
		// boundary.
		expect(feed([report({ status: "on_fire", note: "x" })]).reports).toEqual([]);
		expect(feed([report({ note: "no status at all" })]).reports).toEqual([]);
		expect(feed([report("not an object")]).reports).toEqual([]);
	});

	it("truncates a long note rather than rejecting the report", () => {
		// A long note is still a useful note; a dropped one is not.
		const state = feed([report({ status: "progress", note: "y".repeat(500) })]);
		const note = latestReport(state)?.note ?? "";
		expect(note.length).toBeLessThanOrEqual(200);
		expect(note.endsWith("…")).toBe(true);
	});

	it("collapses whitespace, so a pasted blob cannot become a multi-line status", () => {
		expect(latestReport(feed([report({ status: "done", note: "a\n\n  b\tc" })]))?.note).toBe("a b c");
	});

	it("keeps only the newest MAX_REPORTS", () => {
		// An unbounded array outlives the worker inside the parent's heap.
		const many = Array.from({ length: MAX_REPORTS + 10 }, (_, i) =>
			report({ status: "progress", note: `n${i}` }),
		);
		const state = feed(many);
		expect(state.reports).toHaveLength(MAX_REPORTS);
		expect(latestReport(state)?.note).toBe(`n${MAX_REPORTS + 9}`);
	});

	it("isBlocked follows the LATEST report, so recovery clears it", () => {
		let state = feed([report({ status: "blocked", note: "stuck" })]);
		expect(isBlocked(state)).toBe(true);
		state = foldLine(state, report({ status: "progress", note: "unstuck" }));
		expect(isBlocked(state)).toBe(false);
	});

	it("treats a non-report tool call as an ordinary tool", () => {
		const state = feed([JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } })]);
		expect(state.reports).toEqual([]);
		expect(state.lastTool).toBe("bash");
	});
});

describe("parseReport", () => {
	it("accepts a minimal valid report", () => {
		expect(parseReport({ status: "done", note: "" })).toEqual({ status: "done", note: "" });
	});

	it("rejects anything that is not an object", () => {
		for (const bad of [null, undefined, 42, "x", []]) expect(parseReport(bad)).toBeNull();
	});
});

describe("a realistic two-turn session", () => {
	it("folds spike W1's actual sequence", () => {
		const state = feed([
			JSON.stringify({ type: "response", command: "get_state", data: { sessionId: "s1" } }),
			JSON.stringify({ type: "agent_start" }),
			assistant("ALPHA", { input: 100, output: 4 }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "agent_settled" }),
			JSON.stringify({ type: "response", command: "follow_up" }),
			JSON.stringify({ type: "agent_start" }),
			assistant("BETA", { input: 120, output: 4 }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "agent_settled" }),
		]);
		expect(finalText(state)).toBe("ALPHA\nBETA");
		expect(state.turns).toBe(2);
		expect(state.busy).toBe(false);
		expect(state.everSettled).toBe(true);
		expect(state.tokens).toBe(228);
		expect(state.junk).toBe(0);
	});
});

describe("cost on the RPC path", () => {
	it("accumulates dollars from cost.total, not just tokens", () => {
		const state = feed([
			assistant("one", { input: 100, output: 20, cost: { total: 0.004 } }),
			assistant("two", { input: 50, output: 10, cost: { total: 0.002 } }),
		]);

		expect(state.tokens).toBe(180);
		expect(state.usage.cost).toBeCloseTo(0.006, 10);
	});

	it("keeps a worker's spend when it produced no text", () => {
		// A worker that spent money and said nothing still spent money. Reporting
		// zero there is the silently-free failure the accumulator exists to stop.
		const state = feed([assistant("", { input: 90, output: 0, cost: { total: 0.0007 } })]);

		expect(state.texts).toEqual([]);
		expect(state.usage.cost).toBeCloseTo(0.0007, 10);
	});

	it("does not bill the user's own message to the worker", () => {
		const userTurn = JSON.stringify({
			type: "message_end",
			message: { role: "user", content: "go", usage: { input: 999, cost: { total: 9.99 } } },
		});

		expect(feed([userTurn]).usage.cost).toBe(0);
	});
});
