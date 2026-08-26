/**
 * btw — the two hard constraints, asserted.
 *
 * Most of what is checked here is what the feature does NOT do. A side lane that
 * quietly writes to the session, or a "tool-less" child that gets a `tools` field
 * anyway, would both look completely healthy in use — the failure is invisible
 * from inside the session and only shows up as a session file that grew, or a
 * bill that did. So: every wiring test asserts on `fake.messages` and
 * `fake.entries` being empty, and on the request the child would actually have
 * been sent.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { createFakePi } from "./fake-pi.ts";
import { wireBtw, type BtwConfig, type BtwDeps, type SideRequest } from "../extensions/btw/index.ts";
import {
	assistantText,
	buildSideSystemPrompt,
	capSeed,
	createThread,
	describeThread,
	handoffContent,
	parseBtwCommand,
	questionText,
	recordExchange,
	SEED_MAX_CHARS,
	stripDynamicSystemPromptFooter,
	threadMessages,
	userMessage,
} from "../extensions/btw/thread.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function reply(text: string, extra: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [...extra, { type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const CONFIG: BtwConfig = { enabled: true, timeoutMs: 1_000, maxSeedChars: SEED_MAX_CHARS };

interface Harness {
	fake: ReturnType<typeof createFakePi>;
	/** Every request the child would have been sent, in order. */
	requests: SideRequest[];
	/**
	 * How many times the excerpt was built.
	 *
	 * The COUNT, not the bytes, is what pins "frozen at seeding": with a fixed
	 * fake seed and a constant `getSystemPrompt()`, a prompt recomputed on every
	 * turn is byte-identical to the frozen one, so comparing the two strings
	 * cannot see the regression it exists to catch.
	 */
	seedCalls: () => number;
}

/**
 * Wire the extension with a scripted child.
 *
 * `answers` is consumed one per turn; a function throws instead, which is how the
 * failure paths are driven. The default seed is a fixed string so a test can
 * assert the excerpt reached the prompt without owning a session tree; `seeds`
 * varies it per call, for the tests that care whether it was read twice.
 */
function harness(options: {
	answers?: Array<AssistantMessage | (() => never)>;
	seed?: string;
	seeds?: string[];
	capped?: boolean;
	config?: Partial<BtwConfig>;
} = {}): Harness {
	const fake = createFakePi();
	const requests: SideRequest[] = [];
	const answers = [...(options.answers ?? [])];
	const seeds = options.seeds ?? [options.seed ?? "[user] hello\n\n[assistant] hi"];
	let seedCalls = 0;
	const deps: BtwDeps = {
		seed: () => {
			const index = Math.min(seedCalls, seeds.length - 1);
			seedCalls += 1;
			return { text: seeds[index] ?? "", capped: options.capped ?? false };
		},
		async complete(_ctx, request) {
			requests.push(request);
			const next = answers.shift();
			if (!next) return reply("(scripted default)");
			if (typeof next === "function") return next();
			return next;
		},
	};
	wireBtw(fake.api, { ...CONFIG, ...options.config }, deps);
	return { fake, requests, seedCalls: () => seedCalls };
}

afterEach(() => {
	delete process.env.PI_AGENDA_WORKER;
});

/* -------------------------------------------------------------------------- */
/* Cache stability: the dynamic footer                                         */
/* -------------------------------------------------------------------------- */

describe("stripDynamicSystemPromptFooter", () => {
	// pi 0.84.1 appends exactly this, and only this (core/system-prompt.js).
	it("removes the working-directory line pi appends", () => {
		expect(stripDynamicSystemPromptFooter("You are pi.\nCurrent working directory: /home/u/repo")).toBe("You are pi.");
	});

	it("removes a date line and a cwd line in either order, blank lines included", () => {
		const a = "Be helpful.\n\nCurrent date and time: 2026-08-15 09:00\nCurrent working directory: /r";
		const b = "Be helpful.\nCurrent working directory: /r\n\nCurrent date and time: 2026-08-15 09:00\n";
		expect(stripDynamicSystemPromptFooter(a)).toBe("Be helpful.");
		expect(stripDynamicSystemPromptFooter(b)).toBe("Be helpful.");
	});

	// The whole point is a byte-stable prefix. A stripper that also "tidied"
	// trailing whitespace would change the prompt of every session that has no
	// footer at all — i.e. it would cause the cache miss it exists to prevent.
	it("returns a prompt with no footer byte-identical, trailing blanks and all", () => {
		for (const prompt of ["You are pi.", "You are pi.\n\n", "", "\n"]) {
			expect(stripDynamicSystemPromptFooter(prompt)).toBe(prompt);
		}
	});

	it("leaves a matching line alone when it is not at the end", () => {
		const prompt = "Current working directory: is a phrase we document.\nThen more guidance.";
		expect(stripDynamicSystemPromptFooter(prompt)).toBe(prompt);
	});
});

/* -------------------------------------------------------------------------- */
/* The excerpt                                                                 */
/* -------------------------------------------------------------------------- */

describe("capSeed", () => {
	it("passes a short excerpt through untouched and unflagged", () => {
		expect(capSeed("short", 100)).toEqual({ text: "short", capped: false });
	});

	it("keeps the END, because a side question is about what is on screen now", () => {
		const capped = capSeed("A".repeat(200) + "TAIL", 60);
		expect(capped.capped).toBe(true);
		expect(capped.text.endsWith("TAIL")).toBe(true);
		expect(capped.text.length).toBeLessThanOrEqual(60);
		// Says so, rather than silently presenting a fragment as the whole thing.
		expect(capped.text).toContain("elided");
	});

	it("defaults to the agenda driver's 16k", () => {
		expect(SEED_MAX_CHARS).toBe(16_000);
	});
});

describe("buildSideSystemPrompt", () => {
	const built = (capped: boolean) =>
		buildSideSystemPrompt("HOUSE RULES\nCurrent working directory: /r", "[user] why opt-in?", capped);

	it("inherits the main prompt without its dynamic tail", () => {
		expect(built(false).startsWith("HOUSE RULES\n")).toBe(true);
		expect(built(false)).not.toContain("Current working directory");
	});

	it("fences the excerpt as data and tells the child it has no tools", () => {
		const prompt = built(false);
		expect(prompt).toContain("===== BEGIN SESSION EXCERPT (DATA) =====");
		expect(prompt).toContain("[user] why opt-in?");
		expect(prompt).toContain("===== END SESSION EXCERPT (DATA) =====");
		expect(prompt).toContain("NO TOOLS");
	});

	// A model that thinks it has the whole conversation answers confidently about
	// a beginning it never saw.
	it("says whether the excerpt is partial", () => {
		expect(built(true)).toContain("TAIL of a longer conversation");
		expect(built(false)).toContain("whole conversation so far");
	});
});

/* -------------------------------------------------------------------------- */
/* Thread state                                                                */
/* -------------------------------------------------------------------------- */

describe("threadMessages", () => {
	it("sends only the question on the first turn", () => {
		const thread = createThread("SYS", 10, "sid", 0);
		const messages = threadMessages(thread, userMessage("what does gwq do?", 1));
		expect(messages).toHaveLength(1);
		expect(questionText(messages[0] as ReturnType<typeof userMessage>)).toBe("what does gwq do?");
	});

	// Follow-ups are the SAME conversation, which is the difference between this
	// and running `/btw` twice.
	it("replays prior exchanges verbatim before the new question", () => {
		const thread = createThread("SYS", 10, "sid", 0);
		const first = userMessage("q1", 1);
		const answer = reply("a1");
		recordExchange(thread, first, answer);
		const messages = threadMessages(thread, userMessage("q2", 2));
		expect(messages).toHaveLength(3);
		expect(messages[0]).toBe(first);
		// The object the provider returned, not a reconstruction of it.
		expect(messages[1]).toBe(answer);
	});
});

describe("assistantText", () => {
	it("keeps text and drops thinking", () => {
		expect(assistantText(reply("the answer", [{ type: "thinking", thinking: "hmm" }]))).toBe("the answer");
	});

	it("returns empty for an answer with no text at all", () => {
		expect(assistantText(reply("", [{ type: "thinking", thinking: "hmm" }]))).toBe("");
	});
});

describe("parseBtwCommand", () => {
	it("treats bare /btw as a status request", () => {
		expect(parseBtwCommand("")).toEqual({ kind: "status" });
		expect(parseBtwCommand("   ")).toEqual({ kind: "status" });
	});

	it("recognises the verbs, case-insensitively", () => {
		expect(parseBtwCommand("done")).toEqual({ kind: "handoff" });
		expect(parseBtwCommand("Summary")).toEqual({ kind: "handoff" });
		expect(parseBtwCommand(" END ")).toEqual({ kind: "end" });
	});

	// The trap this rule exists for: prefix matching would make a real question
	// silently discard the thread it was asked in.
	it("treats a verb followed by anything as a question", () => {
		expect(parseBtwCommand("end of file handling — do we strip the newline?")).toEqual({
			kind: "ask",
			question: "end of file handling — do we strip the newline?",
		});
		expect(parseBtwCommand("done with the migration yet?")).toEqual({
			kind: "ask",
			question: "done with the migration yet?",
		});
	});
});

describe("handoffContent", () => {
	it("names its own provenance before saying anything else", () => {
		const thread = createThread("SYS", 10, "sid", 0);
		recordExchange(thread, userMessage("why opt-in?", 1), reply("because it leaves the machine"));
		const content = handoffContent(thread, "Opt-in is right here.");
		expect(content.split("\n")[0]).toContain("/btw");
		expect(content).toContain("without tools");
		expect(content).toContain("why opt-in?");
		expect(content).toContain("Opt-in is right here.");
	});
});

describe("describeThread", () => {
	it("teaches the command when nothing is open", () => {
		const lines = describeThread(null, 0);
		expect(lines[0]).toContain("no side thread");
		expect(lines.join("\n")).toContain("/btw done");
	});

	it("lists the questions asked so far", () => {
		const thread = createThread("SYS", 1234, "sid", 0);
		recordExchange(thread, userMessage("first\nsecond line", 1), reply("a"));
		const lines = describeThread(thread, 5_000);
		expect(lines[0]).toContain("1 exchange");
		// One line per question — a status view that reprinted the answers would
		// be the transcript this lane exists to stay out of.
		expect(lines[1]).toContain("first");
		expect(lines[1]).not.toContain("second line");
	});
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

describe("registration", () => {
	it("registers /btw", () => {
		expect(harness().fake.commands.has("btw")).toBe(true);
	});

	it("registers NOTHING when disabled", () => {
		const { fake } = harness({ config: { enabled: false } });
		expect(fake.commands.has("btw")).toBe(false);
		expect(fake.handlers.has("session_start")).toBe(false);
	});

	// A delegated worker has no human at its transcript, so a side answer there is
	// spend with no reader.
	it("registers NOTHING inside a worker", () => {
		process.env.PI_AGENDA_WORKER = "1";
		const { fake } = harness();
		expect(fake.commands.has("btw")).toBe(false);
	});

	it("subscribes to no forbidden or hot event", () => {
		expect([...harness().fake.handlers.keys()]).toEqual(["session_start"]);
	});
});

describe("/btw <question>", () => {
	it("sends the inherited prompt plus the excerpt, and NO tools", async () => {
		const h = harness({ answers: [reply("Because it leaves the machine.")], seed: "[user] why opt-in?" });
		await h.fake.runCommand("btw", "why is telemetry opt-in?");

		expect(h.requests).toHaveLength(1);
		const request = h.requests[0]!;
		expect(request.system).toContain("[user] why opt-in?");
		expect(request.system).toContain("NO TOOLS");
		// The constraint, checked structurally: a `tools` field cannot appear,
		// because SideRequest has nowhere to put one.
		expect(Object.keys(request)).toEqual(["system", "messages", "sessionId"]);
		expect(h.fake.notifications[0]?.message).toContain("Because it leaves the machine.");
	});

	// THE property that makes this a side lane. Both stores, every time.
	it("writes nothing to the session", async () => {
		const h = harness({ answers: [reply("an answer")] });
		await h.fake.runCommand("btw", "a question");
		expect(h.fake.messages).toEqual([]);
		expect(h.fake.entries).toEqual([]);
		expect(h.fake.userMessages).toEqual([]);
	});

	it("continues the same child on a follow-up, with a byte-identical system prompt", async () => {
		const h = harness({ answers: [reply("a1"), reply("a2")] });
		await h.fake.runCommand("btw", "q1");
		await h.fake.runCommand("btw", "q2");

		expect(h.requests).toHaveLength(2);
		// Frozen at seeding: a recomputed prompt would cost a full cache miss on
		// every follow-up, which is most of what a follow-up should cost nothing.
		expect(h.requests[1]!.system).toBe(h.requests[0]!.system);
		expect(h.requests[1]!.sessionId).toBe(h.requests[0]!.sessionId);
		expect(h.requests[0]!.messages).toHaveLength(1);
		expect(h.requests[1]!.messages).toHaveLength(3);
	});

	// The assertion above compares two strings, and with a fixed seed and a
	// constant `getSystemPrompt()` a RECOMPUTED prompt is byte-identical to a
	// frozen one — so it cannot see the regression it names. This one can: the
	// excerpt is built at most once per thread, whatever it would have contained
	// the second time.
	it("builds the excerpt once per thread, not once per turn", async () => {
		const h = harness({ answers: [reply("a1"), reply("a2")], seeds: ["FIRST SEED", "SECOND SEED"] });
		await h.fake.runCommand("btw", "q1");
		await h.fake.runCommand("btw", "q2");

		expect(h.seedCalls()).toBe(1);
		expect(h.requests[1]!.system).toContain("FIRST SEED");
		expect(h.requests[1]!.system).not.toContain("SECOND SEED");
	});

	it("shows the working status while it thinks, and clears it after", async () => {
		const h = harness({ answers: [reply("a")] });
		await h.fake.runCommand("btw", "q");
		expect(h.fake.statuses.map((entry) => entry.text)).toEqual(["btw: thinking…", undefined]);
	});

	it("reports a provider failure without stranding an empty thread", async () => {
		const h = harness({
			answers: [
				() => {
					throw new Error("timed out");
				},
			],
		});
		await h.fake.runCommand("btw", "q1");
		expect(h.fake.notifications[0]?.type).toBe("error");
		expect(h.fake.notifications[0]?.message).toContain("timed out");

		// No thread was opened, so the next turn starts clean rather than
		// replaying a question that never got an answer.
		await h.fake.runCommand("btw", "q2");
		expect(h.requests[1]!.messages).toHaveLength(1);
	});

	it("treats an answer with no text as a failure rather than recording it", async () => {
		const h = harness({ answers: [reply("")] });
		await h.fake.runCommand("btw", "q1");
		expect(h.fake.notifications[0]?.type).toBe("error");
		await h.fake.runCommand("btw", "q2");
		expect(h.requests[1]!.messages).toHaveLength(1);
	});
});

describe("/btw done", () => {
	it("folds one message into the main thread and closes the side one", async () => {
		const h = harness({ answers: [reply("42"), reply("The answer is 42; it changes nothing.")] });
		await h.fake.runCommand("btw", "what is the answer?");
		await h.fake.runCommand("btw", "done");

		expect(h.fake.messages).toHaveLength(1);
		const folded = h.fake.messages[0]!;
		expect(folded.customType).toBe("btw");
		expect(folded.content).toContain("The answer is 42");
		expect(folded.content).toContain("what is the answer?");
		// The summary request is a message ABOUT the conversation, not a question
		// asked in it — listing it under "Asked:" would put the harness's own
		// meta-prompt in front of the user as something they said.
		expect(folded.content).not.toContain("Stop answering");
		// Delivered, not acted on: the user is mid-task and decides what it means.
		expect(folded.options).toEqual({ deliverAs: "nextTurn" });
		expect(h.fake.entries).toEqual([]);

		// Closed afterwards — a second /btw done has nothing to fold.
		await h.fake.runCommand("btw", "done");
		expect(h.fake.messages).toHaveLength(1);
		expect(h.fake.notifications.at(-1)?.message).toContain("no side thread");
	});

	it("asks the child for a handoff, not for another answer", async () => {
		const h = harness({ answers: [reply("42"), reply("summary")] });
		await h.fake.runCommand("btw", "q");
		await h.fake.runCommand("btw", "done");
		const last = h.requests[1]!.messages.at(-1);
		expect(JSON.stringify(last)).toContain("write the handoff for the main conversation");
	});

	it("keeps the thread when the handoff call fails", async () => {
		const h = harness({
			answers: [
				reply("42"),
				() => {
					throw new Error("provider down");
				},
				reply("second try"),
			],
		});
		await h.fake.runCommand("btw", "q");
		await h.fake.runCommand("btw", "done");
		expect(h.fake.messages).toEqual([]);
		expect(h.fake.notifications.at(-1)?.message).toContain("still open");

		await h.fake.runCommand("btw", "done");
		expect(h.fake.messages).toHaveLength(1);
		// The retry sends the same three messages as the first attempt: the failed
		// summary request left nothing behind to replay.
		expect(h.requests[2]!.messages).toHaveLength(3);
	});

	it("refuses politely when nothing is open", async () => {
		const h = harness();
		await h.fake.runCommand("btw", "done");
		expect(h.fake.messages).toEqual([]);
		expect(h.requests).toEqual([]);
	});
});

describe("/btw end", () => {
	it("discards the thread and folds nothing in", async () => {
		const h = harness({ answers: [reply("a")] });
		await h.fake.runCommand("btw", "q");
		await h.fake.runCommand("btw", "end");
		expect(h.fake.messages).toEqual([]);
		expect(h.fake.entries).toEqual([]);

		await h.fake.runCommand("btw", "q2");
		expect(h.requests[1]!.messages).toHaveLength(1);
	});
});

describe("session lifecycle", () => {
	// A thread seeded from one conversation answers from an excerpt the next one
	// never had.
	it("drops the thread on session_start", async () => {
		const h = harness({ answers: [reply("a1"), reply("a2")] });
		await h.fake.runCommand("btw", "q1");
		await h.fake.emit({ type: "session_start" });
		await h.fake.runCommand("btw", "q2");
		expect(h.requests[1]!.messages).toHaveLength(1);
	});
});
