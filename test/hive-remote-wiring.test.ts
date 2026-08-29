import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HIVE_SESSION_CHANNEL, HIVE_SESSION_END_CHANNEL } from "../extensions/hive-common/channels.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { createFakePi, type FakePi, type SessionEntryLike } from "./fake-pi.ts";

/**
 * hive-remote's ENTRY POINT, driven through the fake pi.
 *
 * Thirteen extensions' entry points were exercised here and this one was not
 * (HIV-1627) — the file with the attach sequence, the whole-record PUT, the
 * poll→dispatch loop, the kill path and the flush's failure handling in it.
 * Every existing hive-remote suite tests a pure module (`transcript`, `budget`,
 * `status`), which is exactly the split that let `last_seq` be declared,
 * documented and consumed by nothing.
 *
 * `fake-pi.ts`'s header names the three shipped bugs that motivated building it
 * — a handler registered behind an `if (!enabled) return`, a spool deleted on
 * failure, an unpriced model reported as $0. All three needed the thing
 * running, and so does everything below.
 */

const URL_BASE = "https://hive.test";
const SESSION_ID = "sess-1";
const RUN_ID = "run-abc";

function config(over: Partial<RemoteConfig> = {}): RemoteConfig {
	return {
		enabled: true,
		url: URL_BASE,
		flushIntervalMs: 1_000,
		eventThreshold: 200, // never threshold-flush; the tests drive the timer
		allowSteer: true,
		allowInterrupt: true,
		allowKill: true,
		allowSetMode: true,
		allowSetOpMode: true,
		reportStatus: false, // keep the request log to the paths under test
		streamDeltas: false,
		streamThinking: true,
		reportActivity: false,
		reportWorktree: false,
		allowAddWorkspace: false,
		...over,
	};
}

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}

/**
 * A fake Hive, recording every call and answering from a queue per path.
 *
 * `fetch` is stubbed rather than the client injected, deliberately: the
 * permanent-vs-transient distinction these tests turn on is computed by
 * `hive-common/http.ts` from the STATUS CODE, and a stubbed client would let a
 * test assert a re-queue that the real classifier would never have reached.
 */
function fakeHive(handlers: {
	events?: Array<{ status: number; lastSeq?: number }>;
	attach?: { status: number; lastSeq?: number };
	commands?: Array<Record<string, unknown>>;
}) {
	const calls: Call[] = [];
	const events = [...(handlers.events ?? [])];
	let commandsServed = false;

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method: String(init?.method ?? "GET"), path, body });

		if (path.startsWith("/agent-sessions/by-run/")) return json(200, { id: SESSION_ID });

		if (path.endsWith("/conversation")) {
			const a = handlers.attach ?? { status: 200, lastSeq: 0 };
			if (a.status !== 200) return json(a.status, { error: "nope" });
			return json(200, { session_id: SESSION_ID, last_seq: a.lastSeq ?? 0 });
		}

		if (path.endsWith("/commands/claim")) {
			// Serve the queued commands ONCE — a poll loop that re-served them
			// would re-kill the session on every tick and prove nothing.
			const items = commandsServed ? [] : (handlers.commands ?? []);
			commandsServed = true;
			return json(200, { items });
		}

		if (path.endsWith("/events")) {
			const next = events.shift() ?? { status: 200 };
			if (next.status !== 200) return json(next.status, { error: "rejected" });
			const sent = (body?.events ?? []) as Array<{ seq: number }>;
			const highest = sent.length > 0 ? (sent[sent.length - 1]?.seq ?? 0) : 0;
			return json(200, { last_seq: next.lastSeq ?? highest });
		}

		return json(200, {});
	});

	return {
		calls,
		posted: () => calls.filter((c) => c.path.endsWith("/events")),
		attaches: () => calls.filter((c) => c.path.endsWith("/conversation")),
		/** Every event seq the client actually put on the wire, in order. */
		seqs: () =>
			calls
				.filter((c) => c.path.endsWith("/events"))
				.flatMap((c) => ((c.body?.events ?? []) as Array<{ seq: number }>).map((e) => e.seq)),
	};
}

function deps(cfg: RemoteConfig = config()): RemoteDeps {
	return {
		loadConfig: () => cfg,
		resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }),
	};
}

/** Get the extension past attach: announce the run id, then run the eager
 *  attach and the first flush tick. */
async function attachAndSettle(fake: FakePi): Promise<void> {
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: RUN_ID });
	await vi.advanceTimersByTimeAsync(400); // ATTACH_EAGER_DELAY_MS + slack
}

/** One assistant turn, which is what folds a transcript event. */
async function assistantSays(fake: FakePi, text: string, thinking?: string): Promise<void> {
	const content: Array<Record<string, unknown>> = [];
	if (thinking) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text });
	await fake.emit({ type: "message_end", message: { role: "assistant", content } });
}

let fake: FakePi;

beforeEach(() => {
	vi.useFakeTimers();
	fake = createFakePi();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("attach", () => {
	it("resumes numbering above the watermark the server reports", async () => {
		// THE RELOAD CASE, end to end. `/reload` builds a fresh Transcript
		// numbering from 1; the server already holds 147 events and its insert
		// ignores anything at or below that. Before HIV-1627 every event here went
		// on the wire as seq 1, 2, 3 … and was silently discarded — the session
		// read as one that had gone quiet, with no error on either side.
		const hive = fakeHive({ attach: { status: 200, lastSeq: 147 } });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await assistantSays(fake, "after the reload");
		await vi.advanceTimersByTimeAsync(1_200);

		expect(hive.posted().length).toBeGreaterThan(0);
		// Strictly above 147 — landing ON the watermark loses one event to the
		// same silent drop.
		expect(Math.min(...hive.seqs())).toBeGreaterThan(147);
	});

	it("numbers from 1 when the server has nothing yet", async () => {
		const hive = fakeHive({ attach: { status: 200, lastSeq: 0 } });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await assistantSays(fake, "first thing this session says");
		await vi.advanceTimersByTimeAsync(1_200);

		expect(hive.seqs()[0]).toBe(1);
	});

	// HIV-1166: attach is a strict full-record PUT, so a field omitted from the
	// body is a field ERASED on the server — which is how a session lost the
	// terminal an operator needed to join it.
	it("sends the whole record, not a patch", async () => {
		const hive = fakeHive({ attach: { status: 200 } });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);

		const body = hive.attaches()[0]?.body ?? {};
		for (const field of ["title", "branch", "worktree", "catalog"]) {
			expect(body).toHaveProperty(field);
		}
		// Every capability travels as an explicit boolean. A capability the UI
		// renders a control for must never be absent-and-assumed.
		for (const cap of ["can_steer", "can_interrupt", "can_kill", "can_set_mode", "can_message"]) {
			expect(typeof body[cap]).toBe("boolean");
		}
		// Declared false, never true, until this build can honour it (HIV-1088).
		expect(body.can_approve).toBe(false);
	});

	// The inverse of the rule above: `can_add_workspace` must be ABSENT when off,
	// because a server that predates the field rejects the whole body — the
	// HIV-1163 class, which costs the session its entire conversation.
	it("omits the opt-in workspace capability entirely when it is off", async () => {
		const hive = fakeHive({ attach: { status: 200 } });
		hiveRemote(fake.api, deps(config({ allowAddWorkspace: false })));

		await attachAndSettle(fake);

		expect(hive.attaches()[0]?.body).not.toHaveProperty("can_add_workspace");
	});

	it("re-arms the Detail recap after compaction once attached", async () => {
		const seen: Array<string | null | undefined> = [];
		fakeHive({ attach: { status: 200 } });
		hiveRemote(fake.api, {
			...deps(),
			fetchSessionRecap: async (id) => {
				seen.push(id);
				return "Session recap (restored after compaction):\n- branch feature/x";
			},
		});
		await attachAndSettle(fake);
		await fake.emit({ type: "session_compact" });
		await vi.advanceTimersByTimeAsync(0);
		const recapMsg = fake.messages.find((m) => String(m.content).includes("Session recap (restored after compaction)"));
		expect(seen).toEqual([SESSION_ID]);
		expect(recapMsg?.display).toBe(false);
		expect(recapMsg?.options).toEqual({ deliverAs: "nextTurn" });
		expect(String(recapMsg?.content)).toContain("feature/x");
	});

	it("does not fetch a recap when hive-remote is disabled", async () => {
		let called = 0;
		hiveRemote(fake.api, {
			...deps(config({ enabled: false })),
			fetchSessionRecap: async () => {
				called += 1;
				return "should not inject";
			},
		});
		await fake.emit({ type: "session_compact" });
		await vi.advanceTimersByTimeAsync(0);
		expect(called).toBe(0);
		expect(fake.messages).toEqual([]);
	});

	it("compacts through Pi rather than sending /compact to the model", async () => {
		const hive = fakeHive({ commands: [{ id: "compact-1", kind: "compact", payload: "" }] });
		hiveRemote(fake.api, deps());

		await fake.emit({ type: "session_start", reason: "startup" });
		await fake.emit({ type: "turn_start" });
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);

		expect(hive.attaches()[0]?.body?.can_compact).toBe(true);
		expect(fake.compactions).toBe(1);
		expect(fake.userMessages).toEqual([]);
	});

	it("opts a catalogued browser /skill: steer into prompt expansion", async () => {
		fakeHive({ commands: [{ id: "s1", kind: "steer", payload: "/skill:craft-ui restyle" }] });
		hiveRemote(fake.api, deps());
		fake.api.registerCommand("skill:craft-ui", { handler: async () => {} });

		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);

		expect(fake.userMessages).toHaveLength(1);
		expect(fake.userMessages[0]?.content).toBe("/skill:craft-ui restyle");
		expect(fake.userMessages[0]?.options?.expandPromptTemplates).toBe(true);
	});

	it("folds a catalogued /skill: input as an origin:skill notice", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps());
		fake.api.registerCommand("skill:craft-ui", { handler: async () => {} });

		await attachAndSettle(fake);
		await fake.emit({ type: "input", text: "/skill:craft-ui restyle the rail" });
		await vi.advanceTimersByTimeAsync(1_200);

		const events = (hive.posted()[0]?.body?.events ?? []) as Array<{
			kind?: string;
			origin?: string;
			text?: string;
		}>;
		expect(events.some((e) => e.origin === "skill" && e.text === "skill activated · craft-ui")).toBe(
			true,
		);
	});

	it("does not expand an ordinary steer or an unknown /skill:", async () => {
		fakeHive({ commands: [{ id: "s2", kind: "follow_up", payload: "/skill:missing" }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);

		expect(fake.userMessages).toHaveLength(1);
		expect(fake.userMessages[0]?.options?.expandPromptTemplates).toBe(false);
	});
});

describe("flush failure handling", () => {
	// A server that predates reasoning rejects the WHOLE batch with a permanent
	// 400. Dropping it would lose the assistant text and tool calls travelling
	// with the thinking event — to a feature they have nothing to do with.
	it("withdraws thinking on a permanent 400 and re-queues everything else", async () => {
		const hive = fakeHive({ events: [{ status: 400 }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await assistantSays(fake, "the answer", "the reasoning");
		await vi.advanceTimersByTimeAsync(1_200); // rejected
		await vi.advanceTimersByTimeAsync(1_200); // retried

		const batches = hive.posted();
		expect(batches.length).toBeGreaterThanOrEqual(2);
		const first = (batches[0]?.body?.events ?? []) as Array<{ kind: string }>;
		const second = (batches[1]?.body?.events ?? []) as Array<{ kind: string }>;

		expect(first.some((e) => e.kind === "thinking")).toBe(true);
		// The capability is withdrawn, not the batch.
		expect(second.some((e) => e.kind === "thinking")).toBe(false);
		expect(second.some((e) => e.kind === "text")).toBe(true);
	});

	it("re-queues a transient failure at the front, preserving order", async () => {
		const hive = fakeHive({ events: [{ status: 503 }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await assistantSays(fake, "one");
		await assistantSays(fake, "two");
		await vi.advanceTimersByTimeAsync(1_200); // 503
		await vi.advanceTimersByTimeAsync(1_200); // retry

		const retried = (hive.posted()[1]?.body?.events ?? []) as Array<{ text?: string; seq: number }>;
		expect(retried.map((e) => e.text)).toEqual(["one", "two"]);
		// Same numbers on the retry: seq IS the idempotency key, so a resend that
		// renumbered would duplicate rather than dedupe.
		expect(retried.map((e) => e.seq)).toEqual([1, 2]);
	});

	it("does not renumber a re-queued batch when the watermark already covers it", async () => {
		// The lost-ack shape: the server accepted the batch, the response did not
		// arrive. The retry must resend the SAME seqs so the server's ON CONFLICT
		// dedupes them, rather than rebasing them into duplicates.
		const hive = fakeHive({ events: [{ status: 503 }, { status: 200, lastSeq: 2 }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await assistantSays(fake, "one");
		await assistantSays(fake, "two");
		await vi.advanceTimersByTimeAsync(1_200);
		await vi.advanceTimersByTimeAsync(1_200);
		await assistantSays(fake, "three");
		await vi.advanceTimersByTimeAsync(1_200);

		expect(hive.seqs()).toEqual([1, 2, 1, 2, 3]);
	});
});

describe("kill", () => {
	it("books the outcome before it stops the session", async () => {
		const hive = fakeHive({ commands: [{ id: "c1", kind: "kill", payload: "", source: "operator" }] });

		// The session row's `outcome` is what every fleet aggregate reads, and
		// shutdown() is graceful — so without this emit pi reports reason "quit"
		// and a killed session is booked as `completed`. It has to be emitted
		// BEFORE the shutdown, because that call does not return.
		let shutdownsAtEmit: number | null = null;
		fake.api.events.on(HIVE_SESSION_END_CHANNEL, () => {
			shutdownsAtEmit = fake.shutdowns;
		});

		hiveRemote(fake.api, deps());
		// Give the extension a ctx to abort/shutdown through.
		await fake.emit({ type: "turn_start" });
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_500); // poll claims the command

		const ended = fake.busEvents.filter((e) => e.name === HIVE_SESSION_END_CHANNEL);
		expect(ended).toHaveLength(1);
		expect(ended[0]?.payload).toMatchObject({ reason: "killed" });
		// Emitted while nothing had shut down yet — the ordering is the point.
		expect(shutdownsAtEmit).toBe(0);

		// And the shutdown does follow, after the grace that lets the aborted
		// turn unwind.
		await vi.advanceTimersByTimeAsync(500);
		expect(fake.shutdowns).toBeGreaterThan(0);

		expect(hive.calls.length).toBeGreaterThan(0);
	});

	it("ignores a kill the operator has not permitted", async () => {
		fakeHive({ commands: [{ id: "c1", kind: "kill", payload: "", source: "operator" }] });
		hiveRemote(fake.api, deps(config({ allowKill: false })));

		await fake.emit({ type: "turn_start" });
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(fake.busEvents.filter((e) => e.name === HIVE_SESSION_END_CHANNEL)).toHaveLength(0);
		expect(fake.shutdowns).toBe(0);
	});
});

describe("the disabled path", () => {
	// The `if (!enabled) return` bug class fake-pi was built for: an extension
	// that is off must register nothing and reach nothing.
	it("registers no handlers and makes no requests when disabled", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps(config({ enabled: false })));

		await attachAndSettle(fake);
		await assistantSays(fake, "anything");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(hive.calls).toHaveLength(0);
	});
});

/**
 * A session wedged against its own context window (HIV-3060).
 *
 * Measured 2026-08-29: this downlink and `background`'s completion notify were
 * waking sessions that could no longer send a request at all, every few minutes,
 * for as long as 12h27m. The wake does not reach the model — it becomes one more
 * refused request, and each refusal leaves the context larger than the last.
 */
describe("waking a session that cannot send a request", () => {
	const OVERFLOW =
		'OpenAI API error (400): 400 "This model\'s maximum prompt length is 500000 but the request contains 505280 tokens."';

	const branchWedged: SessionEntryLike[] = [
		{ message: { role: "user", content: "go" } },
		{ message: { role: "assistant", content: "", stopReason: "error", errorMessage: OVERFLOW } },
	];
	const branchHealthy: SessionEntryLike[] = [
		{ message: { role: "user", content: "go" } },
		{ message: { role: "assistant", content: "done", stopReason: "stop" } },
	];

	const directMessage = JSON.stringify({ category: "message", text: "please look at the PR" });

	async function deliverTeamMessage(branch: SessionEntryLike[]) {
		fakeHive({ commands: [{ id: "tm-1", kind: "team_message", payload: directMessage }] });
		hiveRemote(fake.api, deps());
		// Refreshes the extension's retained ctx, which is how it reads the branch.
		await fake.emit({ type: "session_start" }, { branch });
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);
	}

	it("still DELIVERS a teammate's message, but does not wake the session", async () => {
		await deliverTeamMessage(branchWedged);

		// Delivered — nothing is dropped, so it lands whenever the session can
		// run again. Just not woken, which is the only part that costs a request.
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]?.customType).toBe("team-message");
		expect(fake.messages[0]?.options?.deliverAs).toBe("followUp");
		expect(fake.messages[0]?.options?.triggerTurn).toBe(false);
	});

	it("wakes the session normally when it can still reach the provider", async () => {
		// The control. Without it this suite would pass just as well against an
		// extension that had stopped waking on team messages altogether.
		await deliverTeamMessage(branchHealthy);
		expect(fake.messages[0]?.options?.triggerTurn).toBe(true);
	});
});
