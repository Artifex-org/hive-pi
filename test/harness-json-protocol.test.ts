/**
 * The `--mode json` fold.
 *
 * Every case here was previously reachable only by spawning a real `pi` worker,
 * because the logic lived inside a `proc.stdout.on("data")` closure. That is why
 * the two rules it has to get right were found by reading the wire rather than
 * by a failing test.
 */

import { describe, expect, it } from "vitest";
import { emptyJsonRunState, foldJsonLine, type JsonRunState } from "../extensions/harness/json-protocol.ts";
import { frame } from "../extensions/harness/framing.ts";

const feed = (lines: string[], from: JsonRunState = emptyJsonRunState()): JsonRunState =>
	lines.reduce((state, line) => foldJsonLine(state, line), from);

/** Shaped like a real `message_end`, including `cost` as an OBJECT. */
const assistant = (
	text: string,
	extra: Record<string, unknown> = {},
	usage: Record<string, unknown> = { input: 100, output: 20, totalTokens: 1200, cost: { total: 0.003 } },
) =>
	JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], usage, ...extra },
	});

const user = (text: string) =>
	JSON.stringify({
		type: "message_end",
		// A real user `message_end` carries usage too — which is exactly the trap.
		message: { role: "user", content: text, usage: { input: 9999, cost: { total: 9.99 } } },
	});

describe("what counts as the worker's output", () => {
	it("does NOT bill or count the user's own message", () => {
		// The failure this prevents: an empty run returning the caller's own goal
		// as a successful answer. Observed in the Aurora sidecar.
		const state = feed([user("do the thing")]);

		expect(state.turns).toBe(0);
		expect(state.usage.cost).toBe(0);
		expect(state.usage.input).toBe(0);
	});

	it("still RECORDS the user message, so the transcript is complete", () => {
		expect(feed([user("do the thing")]).messages).toHaveLength(1);
	});

	it("counts one turn per assistant message", () => {
		expect(feed([user("go"), assistant("one"), assistant("two")]).turns).toBe(2);
	});
});

describe("usage", () => {
	it("reads dollars from cost.total and accumulates them", () => {
		const state = feed([assistant("a"), assistant("b")]);
		expect(state.usage.cost).toBeCloseTo(0.006, 10);
		expect(state.usage.input).toBe(200);
	});

	it("ASSIGNS contextTokens rather than summing them", () => {
		// It is a running snapshot of the live context window. Summed across turns
		// it grows without bound and describes nothing.
		const state = feed([
			assistant("a", {}, { totalTokens: 1000, cost: { total: 0 } }),
			assistant("b", {}, { totalTokens: 1400, cost: { total: 0 } }),
		]);
		expect(state.contextTokens).toBe(1400);
	});

	it("keeps the last known contextTokens when a message omits usage", () => {
		const state = feed([assistant("a", {}, { totalTokens: 900, cost: { total: 0 } }), assistant("b", {}, {})]);
		expect(state.contextTokens).toBe(900);
	});
});

describe("terminal metadata", () => {
	it("keeps the FIRST model that answered", () => {
		// A later fallback must not overwrite the record of what actually ran.
		const state = feed([assistant("a", { model: "deepseek-v4-flash" }), assistant("b", { model: "claude-opus" })]);
		expect(state.model).toBe("deepseek-v4-flash");
	});

	it("carries stopReason and errorMessage through", () => {
		const state = feed([assistant("", { stopReason: "error", errorMessage: "no such model" })]);
		expect(state.stopReason).toBe("error");
		expect(state.errorMessage).toBe("no such model");
	});

	it("does not let a later clean message erase an earlier error", () => {
		const state = feed([assistant("", { stopReason: "error", errorMessage: "boom" }), assistant("recovered")]);
		expect(state.errorMessage).toBe("boom");
	});
});

describe("robustness", () => {
	it("counts non-JSON lines as junk instead of throwing", () => {
		const state = feed(["not json at all", assistant("a")]);
		expect(state.junk).toBe(1);
		expect(state.turns).toBe(1);
	});

	it("ignores unknown event types rather than dying on them", () => {
		// pi adds events between versions; a worker that dies on an unrecognised
		// line is a worker that dies on the next pi bump.
		const state = feed([JSON.stringify({ type: "some_future_event", payload: {} }), assistant("a")]);
		expect(state.turns).toBe(1);
	});

	it("ignores a message_end with no message", () => {
		expect(feed([JSON.stringify({ type: "message_end" })]).messages).toHaveLength(0);
	});

	it("returns the SAME state object when nothing changed, so callers can skip work", () => {
		const start = emptyJsonRunState();
		expect(foldJsonLine(start, JSON.stringify({ type: "turn_start" }))).toBe(start);
		expect(foldJsonLine(start, "   ")).toBe(start);
	});
});

describe("framing, end to end", () => {
	it("survives an event split across two chunks", () => {
		// The reason framing is shared: dropping the straddling line reads as
		// "worker produced no output", never as a parse error.
		const line = assistant("hello");
		const cut = Math.floor(line.length / 2);

		let buffer = "";
		let state = emptyJsonRunState();
		for (const chunk of [line.slice(0, cut), `${line.slice(cut)}\n`]) {
			const framed = frame(buffer, chunk);
			buffer = framed.rest;
			for (const l of framed.lines) state = foldJsonLine(state, l);
		}

		expect(state.turns).toBe(1);
		expect(state.usage.cost).toBeCloseTo(0.003, 10);
	});

	it("never hands a partial object to the parser", () => {
		const framed = frame("", '{"type":"message_end","mess');
		expect(framed.lines).toEqual([]);
		expect(framed.rest).toBe('{"type":"message_end","mess');
	});
});
