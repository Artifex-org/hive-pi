/**
 * The browser-answer path (HIV-1765), from the validator up to `plan_ask`'s
 * decision about whether to block at all.
 *
 * The interesting assertions here are the NEGATIVE ones. An answer that resolves
 * the wrong tool call, or a `plan_ask` that blocks when no browser can reach it,
 * are both worse than the stall this feature exists to end — the second one
 * measurably so (HIV-1449: 68 minutes and 40 turns at a prompt nobody could see).
 */

import { describe, expect, it, vi } from "vitest";
import planExtension from "../extensions/plan/index.ts";
import {
	QUESTION_ANSWER_CHANNEL,
	QUESTION_LISTENER_CHANNEL,
	QUESTION_REMOTE_CHANNEL,
} from "../extensions/hive-common/channels.ts";
import { answerFor, PLAN_ASK_KEY, waitForAnswer } from "../extensions/hive-common/remoteAnswer.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

describe("answerFor", () => {
	const answers = { scope: ["Yes"] };

	it("accepts an answer addressed to this call", () => {
		expect(answerFor("call-1", { callID: "call-1", answers })).toEqual(answers);
	});

	// Routing is by call id and nothing else, which is what makes a late answer
	// (the terminal answered first, the call was recycled) harmless.
	it("ignores an answer addressed to another call", () => {
		expect(answerFor("call-1", { callID: "call-2", answers })).toBeNull();
	});

	// Everything crossed a network, a database and a JSON round trip since the
	// operator clicked. A malformed payload must be ignored, never resolve a tool
	// with garbage.
	it("declines anything malformed", () => {
		for (const bad of [
			undefined,
			null,
			"call-1",
			{ answers },
			{ callID: "call-1" },
			{ callID: "call-1", answers: [] },
			{ callID: "call-1", answers: { scope: "Yes" } },
			{ callID: "call-1", answers: { scope: [] } },
			{ callID: "call-1", answers: { "": ["Yes"] } },
		]) {
			expect(answerFor("call-1", bad)).toBeNull();
		}
	});

	it("drops empty values but keeps the rest of the answer", () => {
		expect(answerFor("call-1", { callID: "call-1", answers: { a: ["", "Yes"], b: [] } })).toEqual({
			a: ["Yes"],
		});
	});
});

describe("waitForAnswer", () => {
	// pi's bus has no `off`: `on` returns its own unsubscribe, and that is the
	// only handle a waiter gets. The fake mirrors it exactly, because getting
	// this wrong leaks a subscription per question for the life of the session.
	function bus() {
		const handlers = new Map<string, ((data: unknown) => void)[]>();
		return {
			on: (channel: string, handler: (data: unknown) => void) => {
				handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
			},
			emit: (channel: string, data: unknown) => {
				for (const h of handlers.get(channel) ?? []) h(data);
			},
			count: (channel: string) => (handlers.get(channel) ?? []).length,
		};
	}

	it("resolves on the first answer for its call", async () => {
		const b = bus();
		const waiter = waitForAnswer(b, QUESTION_ANSWER_CHANNEL, "call-1");
		b.emit(QUESTION_ANSWER_CHANNEL, { callID: "other", answers: { a: ["no"] } });
		b.emit(QUESTION_ANSWER_CHANNEL, { callID: "call-1", answers: { a: ["yes"] } });
		expect(await waiter.answered).toEqual({ a: ["yes"] });
		waiter.dispose();
	});

	// An undisposed waiter holds the overlay's `done` for the rest of the session,
	// and a later answer would fire it at a tool that has already returned.
	it("unsubscribes on dispose", () => {
		const b = bus();
		const waiter = waitForAnswer(b, QUESTION_ANSWER_CHANNEL, "call-1");
		expect(b.count(QUESTION_ANSWER_CHANNEL)).toBe(1);
		waiter.dispose();
		expect(b.count(QUESTION_ANSWER_CHANNEL)).toBe(0);
	});
});

type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function planAsk(fake: FakePi): ToolExecute {
	const tool = fake.tools.find((t) => t.name === "plan_ask");
	if (!tool) throw new Error("plan_ask not registered");
	return (tool.definition as { execute: ToolExecute }).execute;
}

describe("plan_ask", () => {
	// hive-remote declares `can_answer_questions` from listeners rather than from
	// config, so this announcement is exactly what makes the browser draw an
	// answer form — and its absence is what correctly hides one.
	//
	// It fires on session_start rather than at registration, and a subscriber
	// attached AFTER the factory ran still hears it. That ordering is the whole
	// point: extension factories run in load order, so an announcement made at
	// registration reaches whichever extensions happened to load first — and
	// hive-remote is not reliably one of them.
	it("announces itself on session_start, not at registration", async () => {
		const fake = createFakePi();
		planExtension(fake.api);

		const seen: unknown[] = [];
		fake.api.events.on(QUESTION_LISTENER_CHANNEL, (data: unknown) => seen.push(data));
		expect(seen).toEqual([]); // nothing yet — registration must stay silent

		await fake.emit({ type: "session_start", reason: "new" });
		expect(seen).toContainEqual({ tool: "plan_ask" });
	});

	// The behaviour that must NOT regress. With no Hive session attached there is
	// nobody to answer, so the question comes back as text — immediately, as it
	// always has.
	it("returns its question as text when no browser can reach it", async () => {
		const fake = createFakePi();
		planExtension(fake.api);

		const result = await planAsk(fake)("call-1", {
			question: "Ship now?",
			options: [{ label: "Yes" }, { label: "No" }],
		});
		expect(result.content[0].text).toContain("Ship now?");
		expect(result.content[0].text).toContain("1. Yes");
	});

	// And the new behaviour: once hive-remote reports a live session, the tool
	// waits, and a browser answer becomes the tool result.
	it("blocks for a browser answer once a session is attached", async () => {
		const fake = createFakePi();
		planExtension(fake.api);
		fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });

		const pending = planAsk(fake)("call-1", {
			question: "Ship now?",
			options: [{ label: "Yes" }, { label: "No" }],
		});
		// Nothing has resolved it yet; the answer arrives after the tool blocked.
		await Promise.resolve();
		fake.api.events.emit(QUESTION_ANSWER_CHANNEL, { callID: "call-1", answers: { [PLAN_ASK_KEY]: ["No"] } });

		const result = await pending;
		expect(result.content[0].text).toBe("The user answered: No");
	});

	// A withdrawn session must put the tool straight back to non-blocking. The
	// signal going stale in the other direction is what wedges a session.
	it("stops blocking when the session detaches", async () => {
		const fake = createFakePi();
		planExtension(fake.api);
		fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });
		fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: false });

		const result = await planAsk(fake)("call-1", { question: "Ship now?" });
		expect(result.content[0].text).toContain("Ship now?");
	});

	it("gives up on the wait rather than blocking forever", async () => {
		vi.useFakeTimers();
		try {
			const fake = createFakePi();
			planExtension(fake.api);
			fake.api.events.emit(QUESTION_REMOTE_CHANNEL, { available: true });

			const pending = planAsk(fake)("call-1", { question: "Ship now?" });
			await vi.advanceTimersByTimeAsync(11 * 60_000);
			const result = await pending;
			expect(result.content[0].text).toContain("No answer arrived");
			expect(result.content[0].text).toContain("Ship now?");
		} finally {
			vi.useRealTimers();
		}
	});
});
