/**
 * "Can this session still send a request?" — the predicate the two direct
 * injectors were missing.
 *
 * Reproduces the shapes measured on 2026-08-29 (HIV-3060), where a grok-4.6
 * session that had reached its provider's hard prompt limit was woken every few
 * minutes by a team message or a background completion, and answered each one
 * with an identical 400. The worst session did that for 12h27m.
 */

import { describe, expect, it } from "vitest";
import { isContextOverflowText, isOverflowWedged, overflowRunLength } from "../extensions/hive-common/overflow.ts";

/** The exact wire text xAI returned, 17 times, in session 01a04abd. */
const XAI_OVERFLOW =
	'OpenAI API error (400): 400 "This model\'s maximum prompt length is 500000 but the request contains 505280 tokens."';

const user = (text: string) => ({ message: { role: "user", content: text } });
const toolResult = () => ({ message: { role: "toolResult", content: "ok" } });
const teamMessage = () => ({ type: "custom", customType: "team-message", data: null });
const overflowed = (text = XAI_OVERFLOW) => ({ message: { role: "assistant", stopReason: "error", errorMessage: text } });
const ran = (stopReason = "stop") => ({ message: { role: "assistant", stopReason, content: "done" } });

describe("isContextOverflowText", () => {
	it("matches the provider text regardless of the wrapper prefix", () => {
		// The wrapper changed between pi builds — `400 "This model's …"` became
		// `OpenAI API error (400): 400 "This model's …"`. An anchored pattern
		// would have silently stopped matching.
		expect(isContextOverflowText(XAI_OVERFLOW)).toBe(true);
		expect(isContextOverflowText('400 "This model\'s maximum prompt length is 500000 but …"')).toBe(true);
	});

	it("matches the other providers' phrasings we have seen", () => {
		expect(isContextOverflowText("Codex error: Your input exceeds the context window of this model.")).toBe(true);
		expect(isContextOverflowText("prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
	});

	it("does not match a transient transport failure", () => {
		// These recover by waiting; suppressing on them would stop a teammate's
		// message from ever landing after one WebSocket blip.
		for (const text of [
			"WebSocket idle timeout after 300000ms",
			"Codex error: Our servers are currently overloaded. Please try again later.",
			"fetch failed",
			"This operation was aborted",
		]) {
			expect(isContextOverflowText(text), text).toBe(false);
		}
	});

	it("is false for a non-string and for nothing at all", () => {
		expect(isContextOverflowText(undefined)).toBe(false);
		expect(isContextOverflowText("")).toBe(false);
		expect(isContextOverflowText({ message: "maximum prompt length is 500000" })).toBe(false);
	});
});

describe("overflowRunLength", () => {
	it("is zero for a session that is running normally", () => {
		expect(overflowRunLength([user("go"), ran("toolUse")])).toBe(0);
	});

	it("counts consecutive refusals, ignoring the injections between them", () => {
		// This IS the measured shape: every refusal after the first is preceded
		// by one of our own wakes, and the run must survive them.
		const branch = [
			user("go"),
			overflowed(),
			teamMessage(),
			overflowed(),
			teamMessage(),
			overflowed(),
		];
		expect(overflowRunLength(branch)).toBe(3);
	});

	it("stops at the newest turn that reached the provider", () => {
		// A session that recovered — by a compaction, or because the human
		// trimmed it — is immediately wakeable again. Old refusals must not
		// suppress it forever.
		expect(overflowRunLength([overflowed(), overflowed(), user("continue"), ran()])).toBe(0);
	});

	it("does not count a transient error as an overflow", () => {
		expect(overflowRunLength([user("go"), { message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error" } }])).toBe(0);
	});

	it("does not count an abort — the human stopped that turn deliberately", () => {
		expect(overflowRunLength([user("go"), { message: { role: "assistant", stopReason: "aborted", errorMessage: XAI_OVERFLOW } }])).toBe(0);
	});

	it("is not confused by tool results trailing the assistant message", () => {
		expect(overflowRunLength([overflowed(), toolResult()])).toBe(1);
	});

	it("is zero for an empty branch", () => {
		expect(overflowRunLength([])).toBe(0);
	});
});

describe("isOverflowWedged", () => {
	it("suppresses on the FIRST refusal", () => {
		// pi has already retried this turn itself (retry.maxRetries = 3) before
		// the error becomes the newest assistant turn, so waiting for a second
		// refusal buys nothing and costs another round trip.
		expect(isOverflowWedged([user("go"), overflowed()])).toBe(true);
	});

	it("is false while the session can still reach the provider", () => {
		expect(isOverflowWedged([user("go"), ran("toolUse")])).toBe(false);
	});
});
