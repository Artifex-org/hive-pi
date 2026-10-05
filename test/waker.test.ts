/**
 * The shared waker (hive-common/waker.ts): the one way an automatic notice may
 * wake the agent.
 *
 * Two paths kept the agent going after it had handed the turn back:
 *   - idle: a completion or teammate message woke it straight past a plan up
 *     for approval or a question;
 *   - mid-run: a `triggerTurn` notice sent while streaming joined pi's
 *     follow-up queue, which the agent loop drains at "Agent would stop here",
 *     so the run never ended on the agent's final word.
 * These tests pin both closed, and pin that nothing is lost on the way.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createWaker, type Notice, type Waker } from "../extensions/hive-common/waker.ts";
import { trackSettleClaims } from "../extensions/hive-common/settle-claim.ts";
import { createFakePi, type FakeCtxOptions, type FakePi } from "./fake-pi.ts";

const said = (text: string) => [
	{ type: "message", message: { role: "user", content: "go" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } },
];
const plainStop = said("Wave done.");
const question = said("Two options are ready. Shall I merge the first?");
const standingBy = said("Standing by.");

const done: Notice = { customType: "background", content: "✓ job bg-1 finished", display: true };

let pi: FakePi;
let waker: Waker;
beforeEach(async () => {
	pi = createFakePi();
	waker = createWaker(pi.api, "test");
});

async function at(type: string, options: FakeCtxOptions, extra: Record<string, unknown> = {}) {
	return pi.emit({ type, ...extra }, options);
}

describe("idle", () => {
	it("wakes after a plain stop", async () => {
		await at("agent_settled", { branch: plainStop });
		waker.deliver(done, "completion");
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: true } }]);
	});

	it("parks a completion behind a question — delivered, not woken, and said so", async () => {
		await at("agent_settled", { branch: question });
		waker.deliver(done, "completion");
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: false } }]);
		expect(pi.statuses.at(-1)).toEqual({ key: "handback", text: "⏸ waiting on you (question) — 1 notice held" });
	});

	it("still wakes a completion through a bare 'standing by' — the agent may be waiting for exactly this", async () => {
		await at("agent_settled", { branch: standingBy });
		waker.deliver(done, "completion");
		expect(pi.messages[0].options?.triggerTurn).toBe(true);
	});

	it("wakes a teammate's message through a prose question, with a reminder of what is still open", async () => {
		await at("agent_settled", { branch: question });
		waker.deliver({ customType: "team-message", content: "FYI: I touched x.ts", display: true }, "message");
		expect(pi.messages[0].options?.triggerTurn).toBe(true);
		expect(pi.messages[0].content).toMatch(/^FYI: I touched x\.ts\n\n\(Before this arrived you handed the turn back/);
	});

	it("never wakes a teammate's message through a plan awaiting approval", async () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "plan it" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "plan_ready", arguments: {} }], stopReason: "toolUse" } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "plan_ready", content: [{ type: "text", text: "Plan is ready and awaiting approval:\n\nX" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Here is the plan." }], stopReason: "stop" } },
		];
		await at("agent_settled", { branch });
		waker.deliver({ customType: "team-message", content: "hi", display: true }, "message");
		expect(pi.messages[0].options?.triggerTurn).toBe(false);
	});

	it("does not wake when another injector already took the settle", async () => {
		await at("agent_settled", { branch: plainStop });
		trackSettleClaims(pi.api).claim("agenda");
		waker.deliver(done, "completion");
		expect(pi.messages[0].options?.triggerTurn).toBe(false);
	});
});

describe("mid-run", () => {
	it("never joins the follow-up queue while streaming", async () => {
		await at("turn_start", { idle: false });
		waker.deliver(done, "completion");
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: false } }]);
	});

	it("asks for one continuation when the run ends on a plain stop", async () => {
		await at("turn_start", { idle: false });
		waker.deliver(done, "completion");
		const results = await at("agent_before_settle", { idle: false, branch: plainStop });
		expect(results).toContainEqual({ continue: true });
	});

	it("lets the run END when its final turn handed back — the notice stays parked", async () => {
		await at("turn_start", { idle: false });
		waker.deliver(done, "completion");
		const results = await at("agent_before_settle", { idle: false, branch: question });
		expect(results).toEqual([undefined]);
		expect(pi.statuses.at(-1)?.text).toMatch(/waiting on you \(question\)/);
	});

	it("does not continue for a notice the model already read in a later turn", async () => {
		await at("turn_start", { idle: false });
		waker.deliver(done, "completion");
		await at("turn_end", { idle: false });
		await at("turn_start", { idle: false });
		const results = await at("agent_before_settle", { idle: false, branch: plainStop });
		expect(results).toEqual([undefined]);
	});

	it("does not double up when another handler already continued the run", async () => {
		pi.api.on("agent_before_settle", () => ({ continue: true }));
		const late = createWaker(pi.api, "late");
		await at("turn_start", { idle: false });
		late.deliver(done, "completion");
		const results = await at("agent_before_settle", { idle: false, branch: plainStop });
		// Registration order: the first waker had nothing pending, the extra
		// handler continued, and the late waker stood down.
		expect(results).toEqual([undefined, { continue: true }, undefined]);
	});

	it("ignores a run that did not complete", async () => {
		await at("turn_start", { idle: false });
		waker.deliver(done, "completion");
		const results = await at("agent_before_settle", { idle: false, branch: plainStop }, { outcome: "aborted" });
		expect(results).toEqual([undefined]);
	});
});

describe("settling", () => {
	it("holds a notice that lands mid-settle and delivers it by the idle rule once settled", async () => {
		await at("agent_before_settle", { idle: false, branch: plainStop });
		waker.deliver(done, "completion");
		expect(pi.messages).toEqual([]);
		await at("agent_settled", { branch: plainStop });
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: true } }]);
	});

	it("parks it instead when the settled turn handed back", async () => {
		await at("agent_before_settle", { idle: false, branch: question });
		waker.deliver(done, "completion");
		await at("agent_settled", { branch: question });
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: false } }]);
	});

	it("delivers it as streaming when the settle continued the run instead", async () => {
		await at("agent_before_settle", { idle: false, branch: plainStop });
		waker.deliver(done, "completion");
		await at("turn_start", { idle: false });
		expect(pi.messages).toEqual([{ ...done, options: { deliverAs: "followUp", triggerTurn: false } }]);
	});
});

describe("status", () => {
	it("clears the parked line when the next run starts", async () => {
		await at("agent_settled", { branch: question });
		waker.deliver(done, "completion");
		await at("agent_start", {});
		expect(pi.statuses.at(-1)).toEqual({ key: "handback", text: undefined });
	});
});
