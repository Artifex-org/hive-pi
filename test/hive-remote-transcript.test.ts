import { describe, expect, it } from "vitest";
import {
	createTranscript,
	drain,
	foldAssistantText,
	foldNotice,
	foldToolBatch,
	foldToolEnd,
	foldThinking,
	foldToolStart,
	foldUserText,
	grillNoticeText,
	PLAN_GRILL_NOTICE_PREFIX,
	deltaOf,
	thinkingOf,
	MAX_EVENT_TEXT,
	MAX_PENDING_TOOLS,
	MAX_QUEUE,
	rebase,
	requeue,
	turnEndNotice,
	turnFailure,
} from "../extensions/hive-remote/transcript.ts";

// The fold is the part of hive-remote that runs INSIDE pi's event handlers,
// where a throw becomes an agent-loop error and an unbounded map becomes a leak
// that outlives the session. It is pure precisely so those properties can be
// tested without a running agent.

// A read-write share means the owner is no longer the only human who can steer
// (HIV-1420). The transcript has to relay WHICH person, and this is the only
// place it can learn it: the server stamps `issued_by` on the command, the claim
// hands it over, and the fold echoes it exactly as it echoes `source`.
describe("issuer attribution", () => {
	it("echoes the issuer onto the folded event", () => {
		const t = createTranscript();
		foldUserText(t, "try the other approach", 1_700_000_000_000, "driver", "user-uuid-1");

		expect(t.queue[0].origin).toBe("driver");
		expect(t.queue[0].issued_by).toBe("user-uuid-1");
	});

	it("omits the issuer rather than sending an empty one", () => {
		const t = createTranscript();
		foldUserText(t, "ship it", 1_700_000_000_000, "operator");

		// Omitted, not "": the server treats absence as "not attributed", and an
		// empty string would be a value it has to defend against instead.
		expect(t.queue[0].issued_by).toBeUndefined();
	});
});

describe("seq", () => {
	it("is monotonic across every event kind", () => {
		const t = createTranscript();
		foldUserText(t, "hello");
		foldAssistantText(t, "hi");
		foldToolStart(t, "call-1", "bash", { command: "ls" });
		foldToolEnd(t, "call-1", "bash", "file.txt", false);
		foldNotice(t, "model switched");

		expect(t.queue.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
	});

	// seq is BOTH the ordering and the server-side idempotency key, so it must
	// never rewind — a reused seq silently drops a different event server-side.
	it("does not rewind when a batch is drained and re-queued", () => {
		const t = createTranscript();
		foldUserText(t, "one");
		foldUserText(t, "two");
		const batch = drain(t, 10);
		requeue(t, batch);
		foldUserText(t, "three");

		expect(t.queue.map((e) => e.seq)).toEqual([1, 2, 3]);
	});
});

describe("tool pairing", () => {
	it("emits ONE event carrying both the call and its result", () => {
		const t = createTranscript();
		foldToolStart(t, "call-1", "bash", { command: "go test ./..." });
		foldToolEnd(t, "call-1", "bash", "FAIL", true);

		expect(t.queue).toHaveLength(1);
		expect(t.queue[0]).toMatchObject({
			role: "tool",
			kind: "tool_call",
			tool_name: "bash",
			tool_result: "FAIL",
			is_error: true,
		});
		expect(t.queue[0].tool_args).toContain("go test");
	});

	it("preserves assistant-declared grouping despite out-of-order completion", () => {
		const t = createTranscript();
		foldToolBatch(t, ["slow", "fast"]);
		foldToolStart(t, "slow", "bash", { command: "slow" });
		foldToolStart(t, "fast", "read", { path: "fast" });
		foldToolEnd(t, "fast", "read", "ok", false);
		foldToolEnd(t, "slow", "bash", "ok", false);

		expect(t.queue).toMatchObject([
			{ tool_batch_id: "turn-1", tool_batch_index: 1, tool_batch_size: 2 },
			{ tool_batch_id: "turn-1", tool_batch_index: 0, tool_batch_size: 2 },
		]);
	});

	it("still emits an ungrouped event when the start was never seen", () => {
		const t = createTranscript();
		foldToolEnd(t, "orphan", "read", "contents", false);
		expect(t.queue).toHaveLength(1);
		expect(t.queue[0]).toMatchObject({ tool_name: "read", tool_batch_id: undefined });
	});

	// An aborted tool may never emit its end event. Without a bound, `pending`
	// grows for the life of the session.
	it("bounds pending tools and evicts oldest-first", () => {
		const t = createTranscript();
		for (let i = 0; i < MAX_PENDING_TOOLS + 10; i++) {
			foldToolStart(t, `call-${i}`, "bash");
		}
		expect(t.pending.size).toBeLessThanOrEqual(MAX_PENDING_TOOLS);
		expect(t.pending.has("call-0")).toBe(false);
		expect(t.pending.has(`call-${MAX_PENDING_TOOLS + 9}`)).toBe(true);
	});

	it("clears the pending entry once paired, so a long session does not leak", () => {
		const t = createTranscript();
		foldToolStart(t, "call-1", "bash");
		foldToolEnd(t, "call-1", "bash", "ok", false);
		expect(t.pending.size).toBe(0);
	});
});

describe("payload rendering", () => {
	it("pretty-prints structured args and passes strings through", () => {
		const t = createTranscript();
		foldToolStart(t, "c", "edit", { path: "main.go" });
		foldToolEnd(t, "c", "edit", "done", false);
		expect(t.queue[0].tool_args).toBe('{\n  "path": "main.go"\n}');
		expect(t.queue[0].tool_result).toBe("done");
	});

	// A throw here would surface inside pi's awaited handler chain as an agent
	// error, so an unserializable payload must degrade instead.
	it("degrades an unserializable payload instead of throwing", () => {
		const t = createTranscript();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => {
			foldToolStart(t, "c", "weird", cyclic);
			foldToolEnd(t, "c", "weird", cyclic, false);
		}).not.toThrow();
		expect(t.queue[0].tool_result).toBe("[unserializable]");
	});

	it("drops empty text rather than queueing blank turns", () => {
		const t = createTranscript();
		foldUserText(t, "   ");
		foldAssistantText(t, "");
		foldNotice(t, "");
		expect(t.queue).toHaveLength(0);
	});
});

describe("queue bounds", () => {
	// Dropping the NEWEST keeps the transcript a correct prefix. Dropping the
	// oldest would punch a silent hole in the middle of a conversation someone is
	// reading, which is worse than a visibly truncated tail.
	it("drops the newest when full and counts the loss", () => {
		const t = createTranscript();
		for (let i = 0; i < MAX_QUEUE + 5; i++) foldUserText(t, `m${i}`);

		expect(t.queue).toHaveLength(MAX_QUEUE);
		expect(t.dropped).toBe(5);
		expect(t.queue[0].text).toBe("m0");
	});

	it("re-queues a failed batch at the FRONT so order survives a retry", () => {
		const t = createTranscript();
		foldUserText(t, "first");
		foldUserText(t, "second");
		const batch = drain(t, 1);
		foldUserText(t, "third");
		requeue(t, batch);

		expect(t.queue.map((e) => e.text)).toEqual(["first", "second", "third"]);
	});

	// Re-queuing can exceed the cap. Trim the END: the oldest unsent events are
	// the ones the server is still missing.
	it("keeps the oldest unsent events when a re-queue overflows", () => {
		const t = createTranscript();
		for (let i = 0; i < MAX_QUEUE; i++) foldUserText(t, `m${i}`);
		const batch = drain(t, 10);
		for (let i = 0; i < 10; i++) foldUserText(t, `new${i}`);
		requeue(t, batch);

		expect(t.queue).toHaveLength(MAX_QUEUE);
		expect(t.queue[0].text).toBe("m0");
		expect(t.dropped).toBeGreaterThan(0);
	});
});

describe("drain", () => {
	it("removes what it returns, so nothing is sent twice", () => {
		const t = createTranscript();
		foldUserText(t, "a");
		foldUserText(t, "b");
		expect(drain(t, 1).map((e) => e.text)).toEqual(["a"]);
		expect(t.queue.map((e) => e.text)).toEqual(["b"]);
	});

	it("is a no-op for a non-positive limit", () => {
		const t = createTranscript();
		foldUserText(t, "a");
		expect(drain(t, 0)).toEqual([]);
		expect(t.queue).toHaveLength(1);
	});
});

describe("turnEndNotice", () => {
	// The "Turn finished" prefix is a CONTRACT with hive's web UI
	// (Agents.transcript.tsx isTurnEnd recognises the row by it) — renaming it
	// here without renaming it there downgrades the divider to a plain notice.
	it("always starts with the recognised prefix", () => {
		expect(turnEndNotice(undefined, 0, 1000)).toBe("Turn finished");
		expect(turnEndNotice(0, 3, 42_000).startsWith("Turn finished")).toBe(true);
	});

	it("reports duration and tool calls when both are known", () => {
		expect(turnEndNotice(0, 7, 42_000)).toBe("Turn finished · 42s · 7 tool calls");
		expect(turnEndNotice(0, 1, 5_000)).toBe("Turn finished · 5s · 1 tool call");
	});

	// Attached mid-turn: the start was never seen, and a guessed duration would
	// be a lie in the flattering direction (always too short).
	it("omits the duration when the turn start was never seen", () => {
		expect(turnEndNotice(undefined, 2, 99_000)).toBe("Turn finished · 2 tool calls");
	});

	it("omits tool calls when there were none", () => {
		expect(turnEndNotice(0, 0, 12_000)).toBe("Turn finished · 12s");
	});

	it("formats minutes and hours in operator units", () => {
		expect(turnEndNotice(0, 0, 192_000)).toBe("Turn finished · 3m 12s");
		expect(turnEndNotice(0, 0, 3_840_000)).toBe("Turn finished · 1h 4m");
	});

	// A clock that goes backwards (NTP step) must not produce "-3s".
	it("omits a negative duration", () => {
		expect(turnEndNotice(5_000, 0, 1_000)).toBe("Turn finished");
	});
});

// ── Reasoning (HIV-1212) ────────────────────────────────────────────────────
//
// pi has always emitted thinking_start/thinking_delta/thinking_end. deltaOf()
// matched only text_delta, so every token of reasoning was discarded here — on a
// high-thinking model, most of the wall-clock of a turn, during which the Hive
// pane showed nothing at all and was indistinguishable from a frozen session.

describe("deltaOf", () => {
	function update(type: string, delta: string) {
		return { assistantMessageEvent: { type, delta } };
	}

	it("reads the answer", () => {
		expect(deltaOf(update("text_delta", "hello"))).toEqual({ text: "hello", thinking: false });
	});

	// The regression this feature is: reasoning used to fall through to "".
	it("reads reasoning, and says that is what it is", () => {
		expect(deltaOf(update("thinking_delta", "weighing"))).toEqual({ text: "weighing", thinking: true });
	});

	it("ignores the events that carry no incremental text", () => {
		expect(deltaOf(update("toolcall_delta", '{"a":1}')).text).toBe("");
		expect(deltaOf(update("text_start", "")).text).toBe("");
		expect(deltaOf(undefined).text).toBe("");
		expect(deltaOf({}).text).toBe("");
	});
});

describe("thinkingOf", () => {
	function msg(content: unknown[]) {
		return { role: "assistant", content } as never;
	}

	it("joins every reasoning block in the message", () => {
		expect(
			thinkingOf(msg([
				{ type: "thinking", thinking: "first" },
				{ type: "text", text: "the answer" },
				{ type: "thinking", thinking: "second" },
			])),
		).toBe("first\n\nsecond");
	});

	it("is empty when the model did not reason", () => {
		expect(thinkingOf(msg([{ type: "text", text: "just an answer" }]))).toBe("");
		expect(thinkingOf(msg([]))).toBe("");
	});

	// A provider that filters its own reasoning returns an opaque signature and no
	// prose. Dropping it silently would make a turn that reasoned look like one
	// that did not — the same "nothing on screen, two possible causes" ambiguity
	// this whole feature exists to remove.
	it("names a redacted block rather than dropping it", () => {
		const got = thinkingOf(msg([{ type: "thinking", thinking: "", redacted: true }]));
		expect(got).toContain("redacted");
	});

	// ...but real reasoning alongside a redacted block is what the operator wants;
	// the notice would only be noise.
	it("prefers the readable reasoning when there is any", () => {
		expect(
			thinkingOf(msg([
				{ type: "thinking", thinking: "", redacted: true },
				{ type: "thinking", thinking: "the readable part" },
			])),
		).toBe("the readable part");
	});
});

describe("foldThinking", () => {
	it("emits an assistant row in the reasoning register", () => {
		const t = createTranscript();
		foldThinking(t, "two approaches", 1_000);
		expect(t.queue).toHaveLength(1);
		expect(t.queue[0]).toMatchObject({ seq: 1, role: "assistant", kind: "thinking", text: "two approaches" });
	});

	it("skips an empty trace rather than queueing a blank row", () => {
		const t = createTranscript();
		foldThinking(t, "   \n  ");
		expect(t.queue).toHaveLength(0);
	});

	// The server truncates on insert, so an over-long trace is cut either way.
	// Cutting it HERE lets it end with a marker instead of mid-word, so a reader
	// can tell a truncated trace from a short one.
	it("marks a trace it had to cut", () => {
		const t = createTranscript();
		foldThinking(t, "x".repeat(MAX_EVENT_TEXT + 5_000));
		const text = t.queue[0].text ?? "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_EVENT_TEXT);
		expect(text).toContain("truncated");
	});

	// A multi-byte character cut in half is invalid UTF-8, which a jsonb column
	// refuses outright — turning a defensive truncation into the failed write it
	// exists to prevent.
	it("never splits a character", () => {
		const t = createTranscript();
		foldThinking(t, "é".repeat(MAX_EVENT_TEXT));
		const text = t.queue[0].text ?? "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_EVENT_TEXT);
		expect(text).not.toContain("�");
	});
});

// Provenance (HIV-1215): the origin is what lets the Hive transcript say who
// an injected message came from. It must ride the event when given and be
// ABSENT — not empty — when not, so untagged rows keep rendering as the plain
// operator bubble on every server version.
describe("origin", () => {
	it("carries a steer's server-stamped source on the user event", () => {
		const t = createTranscript();
		foldUserText(t, "focus on the failing shard", Date.now(), "agent");
		expect(t.queue[0].origin).toBe("agent");
	});

	it("tags notices with their machinery", () => {
		const t = createTranscript();
		foldNotice(t, "Team update: you now control x", Date.now(), "team");
		foldNotice(t, "conductor: entering execute stage", Date.now(), "conductor");
		expect(t.queue.map((e) => e.origin)).toEqual(["team", "conductor"]);
	});

	it("omits the field entirely when there is no origin", () => {
		const t = createTranscript();
		foldUserText(t, "hello");
		foldNotice(t, "model switched");
		expect("origin" in t.queue[0] && t.queue[0].origin !== undefined).toBe(false);
		expect(t.queue[1].origin).toBeUndefined();
	});

	it("normalizes an empty-string origin to absent", () => {
		const t = createTranscript();
		foldUserText(t, "hello", Date.now(), "");
		expect(t.queue[0].origin).toBeUndefined();
	});
});

// `seq` is both the ordering and the idempotency key, and the server's insert is
// ON CONFLICT DO NOTHING — so a client that restarts its numbering does not
// corrupt the transcript, it silently vanishes from it. That was the state of
// `/reload` for as long as `last_seq` came back from attach and was read by
// nothing (HIV-1627). These pin the arithmetic that fixes it, and — just as
// importantly — the cases where it must decline to act.
describe("rebase — resuming above the server's watermark", () => {
	it("moves the queue as well as the counter, strictly above the watermark", () => {
		// The reload case: a fresh Transcript numbering from 1, folded into while
		// the attach round-trip was still in flight.
		const t = createTranscript();
		foldUserText(t, "one");
		foldAssistantText(t, "two");
		expect(t.queue.map((e) => e.seq)).toEqual([1, 2]);

		expect(rebase(t, 147)).toBe(147);

		// Strictly above 147: landing ON the watermark would lose one event to the
		// same silent drop this exists to prevent.
		expect(t.queue.map((e) => e.seq)).toEqual([148, 149]);
		foldAssistantText(t, "three");
		expect(t.queue[2].seq).toBe(150);
	});

	it("seeds an empty transcript so the first event clears the watermark", () => {
		const t = createTranscript();
		expect(rebase(t, 147)).toBe(147);
		foldUserText(t, "after the reload");
		expect(t.queue[0].seq).toBe(148);
	});

	it("declines when the watermark is already covered — the lost-ack case", () => {
		// A batch was accepted but its response was lost, so these are re-queued
		// while the server's watermark already covers them. Renumbering HERE would
		// duplicate accepted events; the ordinary resend dedupes server-side.
		const t = createTranscript();
		for (const text of ["a", "b", "c"]) foldAssistantText(t, text);
		const sent = drain(t, 3);
		requeue(t, sent);

		expect(rebase(t, 3)).toBe(0);
		expect(t.queue.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(t.seq).toBe(3);
	});

	it("never moves backwards, and never on a re-attach", () => {
		const t = createTranscript();
		rebase(t, 147);
		expect(rebase(t, 147)).toBe(0);
		expect(rebase(t, 12)).toBe(0);
		expect(t.seq).toBe(147);
	});

	it("is a no-op for a server that does not send the field", () => {
		// An older server omits `last_seq`; `undefined` arithmetic would poison
		// every seq in the queue with NaN, which is worse than the bug.
		const t = createTranscript();
		foldUserText(t, "one");
		for (const bad of [undefined, 0, -1, 1.5, Number.NaN]) {
			expect(rebase(t, bad as number)).toBe(0);
		}
		expect(t.queue.map((e) => e.seq)).toEqual([1]);
		expect(t.seq).toBe(1);
	});
});

// HIV-1914. turnEndNotice had no error parameter, so a turn that died before it
// ever reached the model produced a notice byte-identical to a successful one.
// On 2026-08-15 that turned a fleet-wide provider outage into eight sessions
// posting `Turn finished · 0s` while every Hive view reported them healthy.
describe("turnFailure", () => {
	it("reads a failed turn's error off the settled assistant message", () => {
		expect(
			turnFailure({
				stopReason: "error",
				errorMessage: "OAuth refresh failed for openai-codex: fetch failed",
			}),
		).toBe("OAuth refresh failed for openai-codex: fetch failed");
	});

	// stopReason is authoritative. A turn can fail with no text attached, and
	// calling that a success because the message was missing is the exact
	// silence this fixes.
	it("still reports a failure that carries no message", () => {
		expect(turnFailure({ stopReason: "error" })).not.toBe("");
		expect(turnFailure({ stopReason: "error", errorMessage: "   " })).not.toBe("");
	});

	it("treats a normal turn as no failure", () => {
		for (const stopReason of ["stop", "toolUse", "length", "pending"]) {
			expect(turnFailure({ stopReason })).toBe("");
		}
	});

	// An abort is an operator interrupting on purpose. Alerting on it would make
	// the alert routine, and a routine alert stops being read.
	it("does not treat a deliberate abort as a failure", () => {
		expect(turnFailure({ stopReason: "aborted", errorMessage: "cancelled" })).toBe("");
	});

	// Crosses an extension boundary into a package that updates independently.
	it("survives a message shape it does not recognise", () => {
		for (const junk of [undefined, null, "nope", 42, {}, { stopReason: 7 }]) {
			expect(turnFailure(junk)).toBe("");
		}
	});
});

describe("turnEndNotice on a failed turn", () => {
	it("takes the Turn failed prefix and carries the error", () => {
		const notice = turnEndNotice(0, 0, 0, "OAuth refresh failed for openai-codex: fetch failed");
		expect(notice.startsWith("Turn failed")).toBe(true);
		expect(notice).toContain("OAuth refresh failed for openai-codex");
		// It must NOT read as a completed turn — that equivalence was the bug.
		expect(notice.startsWith("Turn finished")).toBe(false);
	});

	it("keeps the success path byte-identical when there is no error", () => {
		expect(turnEndNotice(0, 7, 42_000)).toBe("Turn finished · 42s · 7 tool calls");
		expect(turnEndNotice(0, 7, 42_000, "")).toBe("Turn finished · 42s · 7 tool calls");
		expect(turnEndNotice(0, 7, 42_000, "   ")).toBe("Turn finished · 42s · 7 tool calls");
	});

	it("keeps duration and tool counts alongside the error", () => {
		expect(turnEndNotice(0, 1, 5_000, "boom")).toBe("Turn failed · 5s · 1 tool call · boom");
	});

	// The head of the line stays fixed and parseable however long or strangely
	// shaped the provider's message is; a stack trace must not become the row.
	it("flattens and bounds a runaway error", () => {
		const notice = turnEndNotice(undefined, 0, 0, "line one\n\tline two   with   gaps");
		expect(notice).toBe("Turn failed · line one line two with gaps");

		const huge = turnEndNotice(undefined, 0, 0, "x".repeat(5000));
		expect(huge.length).toBeLessThan(400);
		expect(huge.endsWith("…")).toBe(true);
	});
});

// The grill notice is a CONTRACT with the browser card (HIV-2080), not prose:
// web/src/lib/planGrill.ts recognises the row by this prefix and reads the round
// out of it. Same arrangement as "Turn finished" / "Turn failed", and the same
// reason to pin it here — the failure mode of drifting is silent, a grey
// unstyled line instead of the card that tells an operator their decline landed.
describe("grillNoticeText", () => {
	it("leads with the prefix the browser matches on", () => {
		expect(grillNoticeText(1, 3).startsWith(PLAN_GRILL_NOTICE_PREFIX)).toBe(true);
	});

	it("carries the round and pluralises the step tally", () => {
		expect(grillNoticeText(2, 5)).toBe("Plan sent back for questions · round 2 · 5 steps");
		expect(grillNoticeText(1, 1)).toBe("Plan sent back for questions · round 1 · 1 step");
	});

	// Counters only, and a nonsense tally must not reach the row: the doorbell is
	// the only source, and a missing count is 0, never NaN.
	it("floors a missing or nonsensical step count", () => {
		expect(grillNoticeText(1, Number.NaN)).toContain("0 steps");
		expect(grillNoticeText(1, -4)).toContain("0 steps");
	});
});
