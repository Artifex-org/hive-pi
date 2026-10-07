import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HIVE_SESSION_CHANNEL, HIVE_SESSION_END_CHANNEL } from "../extensions/hive-common/channels.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { CredentialReceiver } from "../extensions/hive-remote/credentials.ts";
import { registerCredentialConsumer } from "../extensions/hive-remote/credential-runtime.ts";
import { createFakePi, type FakeCtxOptions, type FakePi, type SessionEntryLike } from "./fake-pi.ts";

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
	attach?: { status: number; lastSeq?: number; delayMs?: number };
	refreshes?: Array<{ status: number; lastSeq?: number; delayMs?: number }>;
	commands?: Array<Record<string, unknown>>;
	toolStarts?: number[];
	credentialStatuses?: number[];
	byRun?: Record<string, string>;
	eventGate?: Promise<void>;
}) {
	const calls: Call[] = [];
	const events = [...(handlers.events ?? [])];
	const toolStarts = [...(handlers.toolStarts ?? [])];
	const credentialStatuses = [...(handlers.credentialStatuses ?? [])];
	const refreshes = [...(handlers.refreshes ?? [])];
	let attachCount = 0;
	let acceptsCredentials = false;
	let commandsServed = false;
	let eventGateServed = false;

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method: String(init?.method ?? "GET"), path, body });

		if (path.endsWith("/credential-catalog")) return json(200, { entries: [] });
		if (path.endsWith("/credential-grants")) {
			const status = credentialStatuses.shift() ?? (acceptsCredentials ? 200 : 409);
			return json(status, status === 200 ? { items: [] } : { error: "receiver/backend not ready" });
		}
		if (path.startsWith("/agent-sessions/by-run/")) return json(200, { id: handlers.byRun?.[path.split("/").pop() ?? ""] ?? SESSION_ID });

		if (path.endsWith("/conversation")) {
			const a = (attachCount++ > 0 ? refreshes.shift() : undefined) ?? handlers.attach ?? { status: 200, lastSeq: 0, delayMs: 0 };
			if (a.delayMs) await new Promise(resolve => setTimeout(resolve, a.delayMs));
			if (a.status !== 200) return json(a.status, { error: "nope" });
			acceptsCredentials = body?.can_receive_credentials === true;
			return json(200, { session_id: SESSION_ID, last_seq: a.lastSeq ?? 0 });
		}

		if (path.endsWith("/tool-starts")) {
			const status = toolStarts.shift() ?? 204;
			return json(status, status >= 400 ? { error: "transient" } : {});
		}

		if (/\/attachments\/[^/]+$/.test(path)) {
			return new Response(Buffer.from("image-bytes"), {
				status: 200,
				headers: { "Content-Type": "image/png", "X-Hive-File-Name": "shot.png" },
			});
		}

		if (path.endsWith("/commands/claim")) {
			// Serve the queued commands ONCE — a poll loop that re-served them
			// would re-kill the session on every tick and prove nothing.
			const items = commandsServed ? [] : (handlers.commands ?? []);
			commandsServed = true;
			return json(200, { items });
		}

		if (path.endsWith("/events")) {
			if (handlers.eventGate && !eventGateServed) {
				eventGateServed = true;
				await handlers.eventGate;
			}
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
		acceptsCredentials: () => acceptsCredentials,
		posted: () => calls.filter((c) => c.path.endsWith("/events")),
		attaches: () => calls.filter((c) => c.path.endsWith("/conversation")),
		worktrees: () => calls.filter((c) => c.path.endsWith("/worktree")),
		patches: () => calls.filter((c) => c.path.endsWith("/worktree/patch")),
		toolStarts: () => calls.filter((c) => c.path.endsWith("/tool-starts")),
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
async function attachAndSettle(fake: FakePi, ctxOptions: FakeCtxOptions = {}): Promise<void> {
	await fake.emit({ type: "session_start", reason: "startup" }, ctxOptions);
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

describe("send_attachment wiring", () => {
	it("registers independently of steer and refuses publication after remote-off", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps(config({ allowSteer: false })));
		await attachAndSettle(fake);
		const tool = fake.tools.find((entry) => entry.name === "send_attachment")?.definition;
		expect(tool).toBeDefined();
		// Execution's lifecycle validation is independently covered by the tool test;
		// this asserts remote-off withdraws its target before a queued completion.
		await fake.emit({ type: "session_shutdown" });
		expect(hive.attaches()).toHaveLength(1);
	});
});

describe("attach", () => {
	it.each([{ refresh: { status: 200, delayMs: 9_000 } }, { refresh: { status: 503 } }])("retains recovered binding until refresh acknowledgement $refresh", async ({ refresh }) => {
		const release = registerCredentialConsumer("bash");
		const binds = vi.spyOn(CredentialReceiver.prototype, "bind");
		const hive = fakeHive({ credentialStatuses: [503, 409], refreshes: [refresh] });
		const pollStates: boolean[] = [], originalPoll = CredentialReceiver.prototype.poll;
		const polls = vi.spyOn(CredentialReceiver.prototype, "poll").mockImplementation(async function(this: CredentialReceiver) {
			pollStates.push(hive.acceptsCredentials());
			await originalPoll.call(this);
		});
		hiveRemote(fake.api, deps(config({ allowReceiveCredentials: true })));
		try {
			await attachAndSettle(fake, { sessionId: "ack-local" });
			await vi.advanceTimersByTimeAsync(18_000);
			expect(binds).toHaveBeenCalledOnce();
			expect(pollStates.length).toBeGreaterThan(0);
			expect(pollStates).not.toContain(false);
			expect(hive.attaches().at(-1)?.body?.can_receive_credentials).toBe(true);
		} finally { await fake.emit({ type: "session_shutdown" }); release(); binds.mockRestore(); polls.mockRestore(); }
	});
	it.each([{ statuses: [503, 409] }, { statuses: [409, 503, 409] }])("recovers credential readiness after transient statuses $statuses", async ({ statuses }) => {
		const release = registerCredentialConsumer("bash");
		const hive = fakeHive({ credentialStatuses: statuses });
		hiveRemote(fake.api, deps(config({ allowReceiveCredentials: true })));
		try {
			await attachAndSettle(fake, { sessionId: "recovery-local" });
			await vi.advanceTimersByTimeAsync(11_000);
			expect(hive.calls.filter(c => c.path.endsWith("/credential-grants")).length).toBeGreaterThanOrEqual(statuses.length);
			expect(hive.attaches().at(-1)?.body?.can_receive_credentials).toBe(true);
			const execute = fake.tools.find(tool => tool.name === "list_credential_catalog")?.definition.execute;
			if (typeof execute !== "function") throw new Error("missing credential catalog tool");
			expect(JSON.stringify(await execute("fixture-call", {}))).toContain("No credentials are configured");
		} finally { await fake.emit({ type: "session_shutdown" }); release(); }
	});
	it("keeps a ready receiver on repeated session_start for the same local identity", async () => {
		const release = registerCredentialConsumer("bash");
		const hive = fakeHive({});
		const binds = vi.spyOn(CredentialReceiver.prototype, "bind");
		const detaches = vi.spyOn(CredentialReceiver.prototype, "detach");
		hiveRemote(fake.api, deps(config({ allowReceiveCredentials: true })));
		const list = async () => {
			const execute = fake.tools.find(tool => tool.name === "list_credential_catalog")?.definition.execute;
			if (typeof execute !== "function") throw new Error("missing credential catalog tool");
			return JSON.stringify(await execute("fixture-call", {}));
		};
		try {
			await attachAndSettle(fake, { sessionId: "local-a" });
			expect(hive.attaches()[0]?.body?.can_receive_credentials).toBe(true);
			expect(await list()).toContain("No credentials are configured");
			await fake.emit({ type: "session_start", reason: "resume" }, { sessionId: "local-a" });
			expect(binds).toHaveBeenCalledTimes(1);
			expect(detaches).toHaveBeenCalledTimes(2);
			expect(hive.attaches()).toHaveLength(1);
			expect(await list()).toContain("No credentials are configured");
		} finally { await fake.emit({ type: "session_shutdown" }); release(); binds.mockRestore(); detaches.mockRestore(); }
	});
	it.each([true, false])("rebinds a new local session with telemetry announcement before start=%s", async before => {
		const release = registerCredentialConsumer("bash");
		const hive = fakeHive({});
		hiveRemote(fake.api, deps(config({ allowReceiveCredentials: true })));
		try {
			await attachAndSettle(fake, { sessionId: "local-a" });
			fake.staleCurrentCtx();
			if (before) fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-next" });
			await fake.emit({ type: "session_start", reason: "resume" }, { sessionId: "local-b" });
			if (!before) {
				await vi.advanceTimersByTimeAsync(400);
				expect(hive.attaches()).toHaveLength(1);
				fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "run-next" });
			}
			await vi.advanceTimersByTimeAsync(400);
			expect(hive.attaches()).toHaveLength(2);
			expect(hive.attaches()[1]?.body?.can_receive_credentials).toBe(true);
			const execute = fake.tools.find(tool => tool.name === "list_credential_catalog")?.definition.execute;
			if (typeof execute !== "function") throw new Error("missing credential catalog");
			expect(JSON.stringify(await execute("fixture-call", {}))).toContain("No credentials are configured");
		} finally { await fake.emit({ type: "session_shutdown" }); release(); }
	});

	it("reports only a pull URL created by gh pr create", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps(config({ streamDeltas: true })));
		await attachAndSettle(fake);

		await fake.emit({
			type: "tool_execution_start",
			toolCallId: "create-pr",
			toolName: "bash",
			args: { command: "gh pr create --base main" },
		});
		await fake.emit({
			type: "tool_execution_end",
			toolCallId: "create-pr",
			toolName: "bash",
			result: { content: [{ type: "text", text: "https://github.com/Artifex-org/hive-pi/pull/27" }] },
			isError: false,
		});
		await fake.emit({
			type: "tool_execution_start",
			toolCallId: "view-pr",
			toolName: "bash",
			args: { command: "gh pr view 27" },
		});
		await fake.emit({
			type: "tool_execution_end",
			toolCallId: "view-pr",
			toolName: "bash",
			result: { content: [{ type: "text", text: "https://github.com/Artifex-org/hive-pi/pull/27" }] },
			isError: false,
		});
		await vi.advanceTimersByTimeAsync(0);

		const pulls = hive.calls.filter((call) => call.path.endsWith("/conversation/pulls"));
		expect(pulls).toHaveLength(1);
		expect(pulls[0]?.body).toEqual({ url: "https://github.com/Artifex-org/hive-pi/pull/27" });
	});

	it("retries an interactive question start until Hive acknowledges it", async () => {
		const hive = fakeHive({ toolStarts: [503, 204] });
		hiveRemote(fake.api, deps(config({ streamDeltas: true })));
		await attachAndSettle(fake);

		await fake.emit({
			type: "tool_execution_start",
			toolCallId: "ask-1",
			toolName: "ask_user_question",
			args: { questions: [{ id: "scope", header: "Scope", question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }] }] },
		});
		await vi.advanceTimersByTimeAsync(600);

		expect(hive.toolStarts()).toHaveLength(2);
		expect(hive.toolStarts()[0]?.body?.tool_call_id).toBe("ask-1");
	});

	it("retires an acknowledged question when its turn ends before tool end", async () => {
		const hive = fakeHive({ toolStarts: [204] });
		hiveRemote(fake.api, deps(config({ streamDeltas: true })));
		await attachAndSettle(fake);
		await fake.emit({
			type: "tool_execution_start",
			toolCallId: "ask-1",
			toolName: "ask_user_question",
			args: { questions: [{ id: "scope", header: "Scope", question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }] }] },
		});
		await vi.advanceTimersByTimeAsync(0);
		await fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } });
		await vi.advanceTimersByTimeAsync(1_200);

		const cancelled = hive
			.posted()
			.flatMap((call) => (call.body?.events ?? []) as Array<{ tool_name?: string; tool_result?: string }>)
			.filter((event) => event.tool_name === "ask_user_question");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]?.tool_result).toContain("cancelled because the agent turn ended");
	});

	it("stops a transient question-start retry when the session shuts down", async () => {
		const hive = fakeHive({ toolStarts: [503, 204] });
		hiveRemote(fake.api, deps(config({ streamDeltas: true })));
		await attachAndSettle(fake);
		await fake.emit({
			type: "tool_execution_start",
			toolCallId: "ask-1",
			toolName: "ask_user_question",
			args: { questions: [{ id: "scope", header: "Scope", question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }] }] },
		});
		await vi.advanceTimersByTimeAsync(0);
		await fake.emit({ type: "session_shutdown", reason: "quit" });
		await vi.advanceTimersByTimeAsync(600);

		expect(hive.toolStarts()).toHaveLength(1);
	});

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
		for (const name of ["request_workspace", "list_workspace_catalog"]) {
			expect(fake.tools.some((tool) => tool.name === name)).toBe(true);
		}
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

	it.each(["manual", "threshold", "overflow"])("reports the actual completed method for %s compaction", async (reason) => {
		const fromExtension = reason === "threshold";
		const method = fromExtension ? "Extension summary" : "Pi summary";
		const hive = fakeHive({});
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await fake.emit({
			type: "session_before_compact",
			reason,
			preparation: { tokensBefore: 12345 },
		});
		await fake.emit({
			type: "session_compact",
			fromExtension,
			reason,
			compactionEntry: { summary: "compressed context", tokensBefore: 12600 },
		});
		await vi.advanceTimersByTimeAsync(1_200);

		const events = hive.posted().flatMap((call) => (call.body?.events ?? []) as Array<{ text?: string }>);
		expect(events.some((event) => event.text?.includes(`Compaction completed · method: ${method}`) && event.text.includes(reason) && event.text.includes("12600"))).toBe(true);
	});

	it.each([true, false])("reports unsuccessful compaction without inventing a method (aborted=%s)", async (aborted) => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await fake.emit({ type: "session_before_compact", reason: "threshold", preparation: { tokensBefore: 999 } });
		await fake.emit({ type: "session_compact_failed", reason: "threshold", fromExtension: false, aborted, errorMessage: "stopped before summarization" });
		await fake.emit({ type: "session_compact", reason: "manual", fromExtension: false, compactionEntry: { tokensBefore: 42 } });
		await vi.advanceTimersByTimeAsync(1_200);
		const text = hive.posted().flatMap((call) => (call.body?.events ?? []) as Array<{ text?: string }>).map((e) => e.text).join("\n");
		expect(text).toContain(`Compaction ${aborted ? "cancelled" : "failed"} · trigger: threshold`);
		expect(text).not.toContain(`Pi summary ${aborted ? "cancelled" : "failed"}`);
		expect(text).toContain("tokens before: 42");
		expect(text).not.toContain("tokens before: 999");
	});

	it("reports only confirmed handoff seeds and releases its listener on shutdown", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		fake.api.events.emit("hive.context.handoff", { trigger: "untrusted" });
		await vi.advanceTimersByTimeAsync(1_200);
		const text = hive.posted().flatMap((call) => (call.body?.events ?? []) as Array<{ text?: string }>).map((e) => e.text).join("\n");
		expect(text).toContain("Handoff seed written · method: seeded fresh session · trigger: threshold");
		expect(text).not.toContain("untrusted");
		await fake.emit({ type: "session_shutdown" });
		const count = hive.posted().length;
		fake.api.events.emit("hive.context.handoff", { trigger: "manual" });
		await vi.advanceTimersByTimeAsync(1_200);
		expect(hive.posted()).toHaveLength(count);
	});

	it("flushes a confirmed handoff notice before immediate graceful shutdown", async () => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		// No timer tick: the threshold branch requests shutdown immediately.
		await fake.emit({ type: "session_shutdown" });
		const text = hive.posted().flatMap((call) => (call.body?.events ?? []) as Array<{ text?: string }>).map((e) => e.text).join("\n");
		expect(text).toContain("Handoff seed written · method: seeded fresh session · trigger: threshold");
	});

	it("joins an in-flight batch before sending the newly queued handoff at shutdown", async () => {
		let release = () => {};
		const eventGate = new Promise<void>((resolve) => { release = resolve; });
		const hive = fakeHive({ eventGate });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await assistantSays(fake, "previous batch");
		await vi.advanceTimersByTimeAsync(1_200);
		expect(hive.posted()).toHaveLength(1);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		const shuttingDown = fake.emit({ type: "session_shutdown" });
		release();
		await shuttingDown;
		expect(hive.posted()).toHaveLength(2);
		expect(JSON.stringify(hive.posted()[1]?.body)).toContain("Handoff seed written");
	});

	it("does not retry a transiently refused shutdown batch indefinitely", async () => {
		const hive = fakeHive({ events: [{ status: 503 }] });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		await fake.emit({ type: "session_shutdown" });
		expect(hive.posted()).toHaveLength(1);
	});

	it("bounds graceful shutdown even if the transport ignores cancellation", async () => {
		let release = () => {};
		const eventGate = new Promise<void>((resolve) => { release = resolve; });
		const hive = fakeHive({ eventGate });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		let finished = false;
		const shuttingDown = fake.emit({ type: "session_shutdown" }).then(() => { finished = true; });
		await vi.advanceTimersByTimeAsync(4_001);
		expect(finished).toBe(true);
		release();
		await shuttingDown;
	});

	it("keeps one handoff listener across session switch and reattachment", async () => {
		const hive = fakeHive({ byRun: { [RUN_ID]: SESSION_ID, "new-run": "sess-2" } });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		fake.api.events.emit("hive.context.handoff", { trigger: "manual" });
		await vi.advanceTimersByTimeAsync(1_200);
		await fake.emit({ type: "session_before_switch", reason: "resume" });
		await fake.emit({ type: "session_start", reason: "resume" }, { sessionId: "new-local-session" });
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "new-run" });
		await vi.advanceTimersByTimeAsync(400);
		fake.api.events.emit("hive.context.handoff", { trigger: "threshold" });
		await vi.advanceTimersByTimeAsync(1_200);
		const notices = hive.posted().flatMap((call) =>
			((call.body?.events ?? []) as Array<{ text?: string }>).filter((e) => e.text?.startsWith("Handoff seed written")).map((e) => ({ path: call.path, text: e.text })),
		);
		expect(notices).toEqual([
			{ path: "/agent-sessions/sess-1/events", text: "Handoff seed written · method: seeded fresh session · trigger: manual" },
			{ path: "/agent-sessions/sess-2/events", text: "Handoff seed written · method: seeded fresh session · trigger: threshold" },
		]);
	});

	it.each(["success", "failure", "cancel"])("clears the actual compaction heartbeat on %s, then reports retry work", async (outcome) => {
		const hive = fakeHive({});
		hiveRemote(fake.api, deps(config({ reportActivity: true })));
		await attachAndSettle(fake);
		await fake.emit({ type: "session_before_compact", reason: "overflow", preparation: { tokensBefore: 12345 } });
		await vi.advanceTimersByTimeAsync(10);
		expect(hive.calls.filter((c) => c.path.endsWith("/activity")).at(-1)?.body?.phase).toBe("compacting");
		await fake.emit(outcome === "success"
			? { type: "session_compact", reason: "overflow", fromExtension: false, compactionEntry: { tokensBefore: 12345 } }
			: { type: "session_compact_failed", reason: "overflow", fromExtension: false, aborted: outcome === "cancel" });
		await vi.advanceTimersByTimeAsync(10);
		const idle = hive.calls.filter((c) => c.path.endsWith("/activity")).at(-1)?.body;
		expect(idle?.phase).toBe("idle");
		expect(idle?.detail).toBeUndefined();
		await fake.emit({ type: "turn_start" });
		await vi.advanceTimersByTimeAsync(10);
		const retry = hive.calls.filter((c) => c.path.endsWith("/activity")).at(-1)?.body;
		expect(retry?.phase).toBe("working");
		expect(retry?.detail).toBeUndefined();
	});

	it("compacts through Pi rather than sending /compact to the model", async () => {
		const hive = fakeHive({ commands: [{ id: "compact-1", kind: "compact", payload: "" }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await fake.emit({ type: "turn_start" });
		await vi.advanceTimersByTimeAsync(2_200);

		expect(hive.attaches()[0]?.body?.can_compact).toBe(true);
		expect(fake.compactions).toBe(1);
		expect(fake.userMessages).toEqual([]);
	});

	it.each(["session_compact", "session_compact_failed"])("retains steers through %s until the SDK really leaves compaction", async (type) => {
		const hive = fakeHive({ commands: [
			{ id: "s1", kind: "steer", payload: "first", attachment_ids: ["att-1"] },
			{ id: "s2", kind: "follow_up", payload: "second" },
			{ id: "interrupt", kind: "interrupt", payload: "" },
		] });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		let interrupts = 0;
		const ctxOptions = { idle: false, onAbort: () => { interrupts++; } };
		await fake.emit({ type: "session_before_compact" }, ctxOptions);
		await vi.advanceTimersByTimeAsync(2200);
		expect(interrupts).toBe(1); // control commands still land during compaction
		expect(fake.userMessages).toEqual([]);
		expect(hive.posted().flatMap((c) => (c.body?.events ?? []) as Array<{ role?: string }>).filter((e) => e.role === "user")).toEqual([]);
		await fake.emit({ type }, ctxOptions);
		await vi.advanceTimersByTimeAsync(2200);
		expect(fake.userMessages).toEqual([]); // event fires before controller cleanup
		ctxOptions.idle = true;
		await vi.advanceTimersByTimeAsync(2200);
		expect(fake.userMessages.map((m) => m.options?.deliverAs)).toEqual(["steer", "followUp"]);
		expect(fake.userMessages[0]?.content).toEqual([
			{ type: "text", text: "first" },
			{ type: "image", mimeType: "image/png", data: Buffer.from("image-bytes").toString("base64") },
		]);
		expect(fake.userMessages[1]?.content).toBe("second");
		await vi.advanceTimersByTimeAsync(2200);
		expect(fake.userMessages).toHaveLength(2);
	});

	it("drops compaction-deferred messages on session replacement", async () => {
		fakeHive({ commands: [{ id: "old", kind: "steer", payload: "old-session input" }] });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await fake.emit({ type: "session_before_compact" }, { idle: false });
		await vi.advanceTimersByTimeAsync(2200);
		expect(fake.userMessages).toEqual([]);
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "replacement-run" });
		await fake.emit({ type: "session_start" }, { idle: true });
		await vi.advanceTimersByTimeAsync(2400);
		expect(fake.userMessages).toEqual([]);
	});

	it.each(["claim", "attachment"])("discards a late %s response after session replacement", async (lane) => {
		fakeHive({ commands: [{ id: "old", kind: "steer", payload: "old-session input", attachment_ids: ["att-1"] }] });
		const originalFetch = globalThis.fetch;
		let release!: () => void;
		let entered = false;
		const held = new Promise<void>((resolve) => { release = resolve; });
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			const path = String(url);
			if (path.includes("/by-run/replacement-run")) {
				return new Response(JSON.stringify({ id: "replacement-session" }), { status: 200 });
			}
			if (!entered && (lane === "claim" ? path.endsWith("/commands/claim") : path.endsWith("/attachments/att-1"))) {
				entered = true;
				await held;
			}
			return originalFetch(url, init);
		});
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2200);
		expect(entered).toBe(true);
		fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: "replacement-run" });
		await fake.emit({ type: "session_start" }, { idle: true });
		await vi.advanceTimersByTimeAsync(400);
		release();
		await vi.advanceTimersByTimeAsync(2400);
		expect(fake.userMessages).toEqual([]);
	});

	it("delivers a deferred steer into an automatic compaction retry without waiting for idle", async () => {
		fakeHive({ commands: [{ id: "retry", kind: "steer", payload: "continue" }] });
		hiveRemote(fake.api, deps());
		await attachAndSettle(fake);
		await fake.emit({ type: "session_before_compact" }, { idle: false });
		await vi.advanceTimersByTimeAsync(2200);
		await fake.emit({ type: "session_compact" }, { idle: false });
		await fake.emit({ type: "turn_start" }, { idle: false });
		await vi.advanceTimersByTimeAsync(2200);
		expect(fake.userMessages.map((m) => m.content)).toEqual(["continue"]);
	});

	it("echoes attachment-only incoming steer IDs into the transcript", async () => {
		const hive = fakeHive({ commands: [{ id: "img-1", kind: "steer", payload: "", attachment_ids: ["att-1"] }] });
		hiveRemote(fake.api, deps());

		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);

		expect(fake.userMessages).toHaveLength(1);
		const events = hive.posted().flatMap((call) => (call.body?.events ?? []) as Array<{ role?: string; attachment_ids?: string[] }>);
		expect(events).toContainEqual(expect.objectContaining({ role: "user", attachment_ids: ["att-1"] }));
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

describe("worktree identity", () => {
	it("attaches and reports the live context directory, not the process launch root", async () => {
		const root = mkdtempSync(join(tmpdir(), "hive-remote-live-cwd-"));
		try {
			execFileSync("git", ["-C", root, "init", "-q", "-b", "feature/hiv-3032"]);
			execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
			execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
			writeFileSync(join(root, "tracked.ts"), "const value = 1;\n");
			execFileSync("git", ["-C", root, "add", "tracked.ts"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
			writeFileSync(join(root, "tracked.ts"), "const value = 2;\n");

			const hive = fakeHive({});
			hiveRemote(fake.api, deps(config({ reportWorktree: true })));
			await attachAndSettle(fake, { cwd: root });
			await fake.emit(
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "edit", result: {}, isError: false },
				{ cwd: root },
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(hive.attaches()[0]?.body?.worktree).toBe(root);
			expect(hive.worktrees()).toHaveLength(1);
			expect(hive.worktrees()[0]?.body?.path).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a requested patch from the tree whose accepted report authorized it", async () => {
		const treeA = mkdtempSync(join(tmpdir(), "hive-remote-tree-a-"));
		const treeB = mkdtempSync(join(tmpdir(), "hive-remote-tree-b-"));
		try {
			for (const [root, before, after] of [
				[treeA, "const value = 1;\n", "const value = 2;\n"],
				[treeB, "const value = 10;\n", "const value = 20;\n"],
			] as const) {
				execFileSync("git", ["-C", root, "init", "-q", "-b", "feature/hiv-3032"]);
				execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
				execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
				writeFileSync(join(root, "tracked.ts"), before);
				execFileSync("git", ["-C", root, "add", "tracked.ts"]);
				execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
				writeFileSync(join(root, "tracked.ts"), after);
			}

			const hive = fakeHive({ commands: [{ id: "diff-1", kind: "worktree_diff", payload: "tracked.ts" }] });
			hiveRemote(fake.api, deps(config({ reportWorktree: true })));
			await attachAndSettle(fake, { cwd: treeA });
			await fake.emit(
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "edit", result: {}, isError: false },
				{ cwd: treeA },
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(hive.worktrees()[0]?.body?.path).toBe(treeA);

			// Move the live context without publishing another tree. The command must
			// remain bound to tree A's accepted file list, not re-resolve against B.
			await fake.emit({ type: "turn_start" }, { cwd: treeB });
			await vi.advanceTimersByTimeAsync(2_200);

			const patch = String(hive.patches()[0]?.body?.patch ?? "");
			expect(patch).toContain("+const value = 2;");
			expect(patch).not.toContain("+const value = 20;");
		} finally {
			rmSync(treeA, { recursive: true, force: true });
			rmSync(treeB, { recursive: true, force: true });
		}
	});

	it("answers a diff request explicitly before any worktree report exists", async () => {
		const hive = fakeHive({ commands: [{ id: "diff-early", kind: "worktree_diff", payload: "tracked.ts" }] });
		hiveRemote(fake.api, deps(config({ reportWorktree: false })));
		await attachAndSettle(fake);
		await vi.advanceTimersByTimeAsync(2_200);

		expect(hive.patches()).toHaveLength(1);
		expect(hive.patches()[0]?.body?.reason).toBe("no worktree reported yet");
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

describe("interrupt", () => {
	it("aborts the active question and flushes its cancelled terminal event", async () => {
		const hive = fakeHive({ commands: [{ id: "interrupt-1", kind: "interrupt", payload: "", source: "operator" }] });
		let aborts = 0;
		hiveRemote(fake.api, deps(config({ streamDeltas: true })));
		await fake.emit({ type: "turn_start" }, { onAbort: () => aborts++ });
		await attachAndSettle(fake);
		await fake.emit(
			{
				type: "tool_execution_start",
				toolCallId: "ask-1",
				toolName: "ask_user_question",
				args: { questions: [{ id: "scope", header: "Scope", question: "Ship now?", options: [{ label: "Yes" }, { label: "No" }] }] },
			},
			{ onAbort: () => aborts++ },
		);

		await vi.advanceTimersByTimeAsync(2_500);
		expect(aborts).toBe(1);
		await fake.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } });
		await vi.advanceTimersByTimeAsync(1_200);

		await fake.emit({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_user_question", result: {}, isError: false });
		await vi.advanceTimersByTimeAsync(1_200);
		const cancelled = hive
			.posted()
			.flatMap((call) => (call.body?.events ?? []) as Array<{ tool_name?: string; tool_result?: string }>)
			.filter((event) => event.tool_name === "ask_user_question");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]?.tool_result).toContain("cancelled because the agent turn ended");
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

	describe("in a TUI session", () => {
		// A headless kill also exits the process after a fixed grace (see the
		// kill case), so the wait-for-idle path is only observable where the
		// process is left to pi: an interactive session.
		const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		beforeEach(() => {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		});
		afterEach(() => {
			if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		});

		it("waits for the session to go idle before it shuts down", async () => {
			// The aborted turn settles inside the grace, and a settle handler starts a
			// compaction: pi is busy when the first shutdown() would run, and a busy
			// session's shutdown() is only acted on at an `agent_settled` that never
			// comes. The kill must keep aborting until pi says idle, then shut down.
			fakeHive({ commands: [{ id: "c1", kind: "kill", payload: "", source: "operator" }] });
			let aborts = 0;
			const ctxOptions: FakeCtxOptions = { idle: false, onAbort: () => aborts++ };

			hiveRemote(fake.api, deps());
			await fake.emit({ type: "turn_start" }, ctxOptions);
			await attachAndSettle(fake, ctxOptions);
			await vi.advanceTimersByTimeAsync(2_500); // poll claims the command
			await vi.advanceTimersByTimeAsync(2_000);

			expect(fake.shutdowns).toBe(0);
			const abortsWhileBusy = aborts;
			expect(abortsWhileBusy).toBeGreaterThan(1); // the kill's own abort, then re-aborts

			ctxOptions.idle = true;
			await vi.advanceTimersByTimeAsync(500);
			expect(fake.shutdowns).toBe(1);

			// Stops once it has shut down: no more aborts, no second shutdown.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(fake.shutdowns).toBe(1);
			expect(aborts).toBe(abortsWhileBusy);
		});

		it("shuts down anyway once the settle deadline passes", async () => {
			fakeHive({ commands: [{ id: "c1", kind: "kill", payload: "", source: "operator" }] });
			hiveRemote(fake.api, deps());
			await fake.emit({ type: "turn_start" }, { idle: false });
			await attachAndSettle(fake, { idle: false });
			await vi.advanceTimersByTimeAsync(2_500);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(fake.shutdowns).toBe(0);
			await vi.advanceTimersByTimeAsync(31_000);
			expect(fake.shutdowns).toBe(1);
		});
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
		await attachAndSettle(fake, { branch });
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
