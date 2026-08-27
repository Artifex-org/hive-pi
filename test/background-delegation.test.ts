/**
 * Backgrounded delegations, and the seam they cross.
 *
 * Two distinct claims are tested here, and they fail in different places:
 *
 *  - `backgroundRefusal` — what may be backgrounded at all. Pure, so it is
 *    tested directly. Every refusal matters more than it looks: the caller
 *    stops paying attention after a successful start, so a mistake that gets
 *    past this is discovered much later, if at all.
 *  - The BUS — that a job registered by one extension shows up in the other's
 *    list, notification and cancel path. pi builds a fresh jiti instance per
 *    extension, so the two really are separate module graphs; this is the only
 *    test that would catch the seam being wired to nothing.
 */

import { describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import background from "../extensions/background/index.ts";
import { BACKGROUND_CANCEL_CHANNEL, BACKGROUND_JOB_CHANNEL } from "../extensions/background/channel.ts";
import { backgroundRefusal, backgroundStartedMessage } from "../extensions/subagent/background.ts";

describe("what may be backgrounded", () => {
	const single = { background: true, what: "auditing the migration", agent: "research", task: "look" };

	it("allows a well-formed single delegation in tui", () => {
		expect(backgroundRefusal(single, "tui")).toBeNull();
	});

	it("refuses where the notification would have nowhere to land", () => {
		const refusal = backgroundRefusal(single, "headless");
		expect(refusal).toContain("headless");
		// The remedy, not just the rule — the reader is a model choosing what to
		// do next, and "unsupported" leaves it guessing between dropping the work
		// and retrying the identical call.
		expect(refusal).toContain("foreground");
	});

	it("refuses chain mode, and says to background the long step instead", () => {
		const refusal = backgroundRefusal({ ...single, chain: [{}, {}] }, "tui");
		expect(refusal).toContain("single mode only");
		expect(refusal).toContain("longest step");
	});

	it("refuses parallel mode, because it is already concurrent", () => {
		const refusal = backgroundRefusal({ ...single, tasks: [{}] }, "tui");
		expect(refusal).toContain("single mode only");
		expect(refusal).toContain("concurrently");
	});

	it("requires `what`, including when it is only whitespace", () => {
		expect(backgroundRefusal({ ...single, what: undefined }, "tui")).toContain("`what`");
		expect(backgroundRefusal({ ...single, what: "   " }, "tui")).toContain("`what`");
	});

	it("requires both agent and task", () => {
		expect(backgroundRefusal({ ...single, task: undefined }, "tui")).toContain("single mode");
		expect(backgroundRefusal({ ...single, agent: undefined }, "tui")).toContain("single mode");
	});
});

describe("the start message", () => {
	it("tells the model not to poll — the mistake that undoes the whole feature", () => {
		const text = backgroundStartedMessage("sub-1", "auditing the migration", "research");
		expect(text).toContain("sub-1");
		expect(text).toContain("research");
		expect(text).toContain("Do NOT poll");
	});
});

describe("the bus between the two extensions", () => {
	function boot(): FakePi {
		const pi = createFakePi();
		background(pi.api);
		return pi;
	}

	async function call(pi: FakePi, name: string, params: Record<string, unknown> = {}): Promise<string> {
		const tool = pi.tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(`no tool named ${name}`);
		const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
		const result = (await execute("cid", params, undefined, undefined, { mode: "tui", cwd: process.cwd() })) as
			| { content?: { text?: string }[] }
			| undefined;
		return result?.content?.[0]?.text ?? "";
	}

	it("shows an externally-owned job in the list and notifies when it finishes", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });

		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "auditing the migration",
			kind: "subagent",
			detail: "research: look at the migration",
		});

		expect(await call(pi, "background_list")).toContain("auditing the migration");
		expect(pi.statuses.at(-1)?.text).toBe("1 bg job");

		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "output", id: "sub-1", chunk: "found three problems" });
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id: "sub-1", status: "done", exitCode: 0 });

		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toContain("found three problems");
		expect(pi.messages[0].options?.deliverAs).toBe("followUp");
		expect(pi.messages[0].options?.triggerTurn).toBe(true);
		expect(await call(pi, "background_result", { id: "sub-1" })).toContain("found three problems");
	});

	it("asks the owner to cancel rather than settling the job itself", async () => {
		// The registry must NOT mark an external job canceled on its own: the
		// owner still has to unwind a worker and release its writer lock, and
		// announcing the job as over while that lock is held would let the next
		// writer past a gate that has not actually opened.
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "a long audit",
			kind: "subagent",
			detail: "research: look",
		});

		const out = await call(pi, "background_cancel", { id: "sub-1" });
		expect(out).toContain("Asked to cancel");

		const cancels = pi.busEvents.filter((event) => event.name === BACKGROUND_CANCEL_CHANNEL);
		expect(cancels).toHaveLength(1);
		expect((cancels[0].payload as { id?: string }).id).toBe("sub-1");

		// Still running, and NOT announced, until the owner says so.
		expect(await call(pi, "background_list")).toContain("running");
		expect(pi.messages).toHaveLength(0);

		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id: "sub-1", status: "canceled" });
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toContain("canceled");
	});

	it("re-delivers a notification that was lost to a session swap", async () => {
		// A job the model was PROMISED a notification for, that silently never
		// arrives, is the same failure the mode gate refuses headless sessions to
		// avoid — the model waits forever for a message that is never coming.
		// `notify` only marks a job notified after sendMessage returns, so the
		// loss is recoverable; this is the sweep that recovers it.
		const pi = boot();
		// No session_start yet: the very first delivery has no live session, and
		// the fake's sendMessage is recorded regardless, so force a real throw.
		let failNext = true;
		const original = pi.api.sendMessage.bind(pi.api);
		(pi.api as { sendMessage: unknown }).sendMessage = (...args: unknown[]) => {
			if (failNext) {
				failNext = false;
				throw new Error("session went away");
			}
			return (original as (...a: unknown[]) => unknown)(...args);
		};

		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "an audit",
			kind: "subagent",
			detail: "research: look",
		});
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id: "sub-1", status: "done", exitCode: 0 });
		expect(pi.messages).toHaveLength(0); // the throw ate it

		await pi.emit({ type: "session_start" }, { mode: "tui" });
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toContain("an audit");

		// And it is not announced a second time on the next session_start.
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		expect(pi.messages).toHaveLength(1);
	});

	it("ignores a finish for a job it never saw start", () => {
		// The two sides disagreeing about what exists is a bug; synthesising a
		// completed job from a stray event would put a notification in front of
		// the model for work it cannot then look up.
		const pi = boot();
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id: "sub-99", status: "done", exitCode: 0 });
		expect(pi.messages).toHaveLength(0);
	});

	it("keeps the original job when a duplicate start arrives", () => {
		const pi = boot();
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "the first one",
			kind: "subagent",
			detail: "research: look",
		});
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "a confusing second one",
			kind: "subagent",
			detail: "research: look again",
		});
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, { action: "finish", id: "sub-1", status: "done", exitCode: 0 });
		expect(pi.messages).toHaveLength(1);
		expect(pi.messages[0].content).toContain("the first one");
	});

	it("does not collide with locally-owned bash ids", async () => {
		// `bg-N` and `sub-N` are minted by different owners with no shared
		// counter. If they shared a namespace, `background_result bg-1` would
		// quietly return whichever job registered last.
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "sleep 5", what: "a shell job" });
		pi.api.events.emit(BACKGROUND_JOB_CHANNEL, {
			action: "start",
			id: "sub-1",
			what: "a delegation",
			kind: "subagent",
			detail: "research: look",
		});

		const list = await call(pi, "background_list");
		expect(list).toContain("bg-1");
		expect(list).toContain("sub-1");
		expect(await call(pi, "background_result", { id: "bg-1" })).toContain("a shell job");
		expect(await call(pi, "background_result", { id: "sub-1" })).toContain("a delegation");

		await call(pi, "background_cancel", { id: "bg-1" });
	});
});
