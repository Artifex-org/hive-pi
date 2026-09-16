/**
 * Client-side LLM generation-speed measurement.
 *
 * The server (hive #7459) stores four nullable per-(session,model) columns —
 * generation_ms, generated_tokens, ttft_ms, timed_turns — and reads NULL as
 * "not measured". A 0 would read as infinitely fast / zero throughput, so the
 * one property these tests pin above all is: a model with no TIMED message emits
 * NOTHING for the four fields, never 0, and the numerator (generated_tokens)
 * tracks the output of TIMED messages only, never the bucket's total output.
 *
 * The fold decision lives in the pure `timedTurnContribution`, tested directly;
 * `foldMessageEnd(…, timing)` wires it into the bucket; `buildPayload` gates the
 * wire emission on `timedTurns !== undefined`.
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	createRun,
	foldMessageEnd,
	foldToolUsage,
	type MessageTiming,
	type RunAccumulator,
	timedTurnContribution,
} from "../extensions/hive-telemetry/accumulator.ts";
import { buildPayload } from "../extensions/hive-telemetry/payload.ts";
import type { ResolvedConfig } from "../extensions/hive-telemetry/types.ts";

const T0 = 1_770_000_000_000;

const CFG: ResolvedConfig = {
	enabled: true,
	url: "https://hive.example/api/v1/agent-sessions",
	flushIntervalMs: 120_000,
	eventThreshold: 25,
	spoolEveryFlush: false,
	projectOverride: null,
};

function run(): RunAccumulator {
	return createRun("run-1", "sess-1", "", "workstation", T0);
}

function usage(input: number, output: number, cost = 0): Usage {
	return { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } as unknown as Usage;
}

function assistant(
	provider: string,
	model: string,
	u: Usage,
	stopReason = "stop",
	responseModel?: string,
): AssistantMessage {
	return { role: "assistant", provider, model, responseModel, usage: u, stopReason } as unknown as AssistantMessage;
}

/** message_start at +0, first token at +ttft, message_end at +ttft+decode. */
function timing(ttftMs: number, decodeMs: number, base = T0): MessageTiming {
	return { headersAt: base, firstTokenAt: base + ttftMs, endAt: base + ttftMs + decodeMs };
}

describe("timedTurnContribution — the fold decision, pure", () => {
	it("splits a normal streamed message into decode ms, its output, and ttft ms", () => {
		const c = timedTurnContribution(assistant("p", "m", usage(1000, 200)), timing(120, 800));
		expect(c).toEqual({ generationMs: 800, generatedTokens: 200, ttftMs: 120 });
	});

	it("returns null when the message never streamed a token (non-streaming reply)", () => {
		// message_start then message_end with no update between → firstTokenAt null.
		const t: MessageTiming = { headersAt: T0, firstTokenAt: null, endAt: T0 + 500 };
		expect(timedTurnContribution(assistant("p", "m", usage(1000, 200)), t)).toBeNull();
	});

	it("returns null when nothing was decoded (output 0)", () => {
		expect(timedTurnContribution(assistant("p", "m", usage(1000, 0)), timing(120, 800))).toBeNull();
	});

	it("returns null for an aborted or errored stop", () => {
		expect(timedTurnContribution(assistant("p", "m", usage(1000, 50), "aborted"), timing(120, 800))).toBeNull();
		expect(timedTurnContribution(assistant("p", "m", usage(1000, 50), "error"), timing(120, 800))).toBeNull();
	});

	it("accepts toolUse and length as complete decodes", () => {
		expect(timedTurnContribution(assistant("p", "m", usage(10, 5), "toolUse"), timing(30, 90))).not.toBeNull();
		expect(timedTurnContribution(assistant("p", "m", usage(10, 5), "length"), timing(30, 90))).not.toBeNull();
	});

	it("returns null when a clock skew inverts an interval", () => {
		const skewed: MessageTiming = { headersAt: T0, firstTokenAt: T0 - 50, endAt: T0 + 100 };
		expect(timedTurnContribution(assistant("p", "m", usage(10, 5)), skewed)).toBeNull();
	});
});

describe("foldMessageEnd — timing folds into the same model bucket", () => {
	it("a timed message adds to all four fields", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false, timing(120, 800));
		const b = a.models.get("anthropic/claude")!;
		expect(b.generationMs).toBe(800);
		expect(b.generatedTokens).toBe(200);
		expect(b.ttftMs).toBe(120);
		expect(b.timedTurns).toBe(1);
	});

	it("a non-streaming message folds usage but NO timing (fields stay undefined)", () => {
		const a = run();
		const noStream: MessageTiming = { headersAt: T0, firstTokenAt: null, endAt: T0 + 300 };
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false, noStream);
		const b = a.models.get("anthropic/claude")!;
		expect(b.output).toBe(200); // usage still counted
		expect(b.generationMs).toBeUndefined();
		expect(b.generatedTokens).toBeUndefined();
		expect(b.ttftMs).toBeUndefined();
		expect(b.timedTurns).toBeUndefined();
	});

	it("an aborted message folds usage but NO timing", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 50), "aborted"), false, timing(120, 800));
		const b = a.models.get("anthropic/claude")!;
		expect(b.output).toBe(50);
		expect(b.timedTurns).toBeUndefined();
	});

	it("two timed messages sum each component", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false, timing(120, 800));
		foldMessageEnd(a, assistant("anthropic", "claude", usage(500, 100)), false, timing(80, 400));
		const b = a.models.get("anthropic/claude")!;
		expect(b.generationMs).toBe(1200);
		expect(b.generatedTokens).toBe(300);
		expect(b.ttftMs).toBe(200);
		expect(b.timedTurns).toBe(2);
	});

	it("generated_tokens tracks TIMED output only, not the bucket's total output", () => {
		const a = run();
		// One timed turn (output 200) and one non-streaming turn (output 999) on
		// the SAME model. The bucket's total output is 1199; the timed numerator
		// must remain 200.
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false, timing(120, 800));
		const noStream: MessageTiming = { headersAt: T0, firstTokenAt: null, endAt: T0 + 10 };
		foldMessageEnd(a, assistant("anthropic", "claude", usage(10, 999)), false, noStream);
		const b = a.models.get("anthropic/claude")!;
		expect(b.output).toBe(1199);
		expect(b.generatedTokens).toBe(200);
		expect(b.timedTurns).toBe(1);
	});

	it("folds nothing when no timing is supplied at all (old code path)", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false);
		expect(a.models.get("anthropic/claude")!.timedTurns).toBeUndefined();
	});

	it("nested/subagent usage never acquires timing fields", () => {
		const a = run();
		foldToolUsage(a, usage(500, 60));
		const b = a.models.get("nested/subagent")!;
		expect(b.output).toBe(60);
		expect(b.timedTurns).toBeUndefined();
		expect(b.generationMs).toBeUndefined();
	});
});

describe("buildPayload — all-four-or-none emission", () => {
	it("omits all four fields for a model with no timed message", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false);
		const m = buildPayload(a, CFG, "0.85.1", T0 + 1000).models[0];
		expect("generation_ms" in m).toBe(false);
		expect("generated_tokens" in m).toBe(false);
		expect("ttft_ms" in m).toBe(false);
		expect("timed_turns" in m).toBe(false);
	});

	it("emits all four together once a timed message contributed", () => {
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(1000, 200)), false, timing(120, 800));
		const m = buildPayload(a, CFG, "0.85.1", T0 + 1000).models[0];
		expect(m.generation_ms).toBe(800);
		expect(m.generated_tokens).toBe(200);
		expect(m.ttft_ms).toBe(120);
		expect(m.timed_turns).toBe(1);
	});

	it("still ships timed_turns and ttft when the decode rounds to 0 ms", () => {
		// A sub-millisecond one-token decode: generation_ms is 0, but the turn was
		// measured and must not be dropped — the gate is `!== undefined`, not truthy.
		const a = run();
		foldMessageEnd(a, assistant("anthropic", "claude", usage(10, 1)), false, timing(40, 0));
		const m = buildPayload(a, CFG, "0.85.1", T0 + 1000).models[0];
		expect(m.generation_ms).toBe(0);
		expect(m.timed_turns).toBe(1);
		expect(m.ttft_ms).toBe(40);
		expect(m.generated_tokens).toBe(1);
	});
});
