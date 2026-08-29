/**
 * overflow-guard — what the extension DOES when a session can no longer send a
 * request (HIV-3060).
 *
 * The two properties that matter are opposites of each other: it must act ONCE
 * (a retry loop here would be the same burn loop it exists to stop), and it must
 * re-arm as soon as the session recovers (a guard that stays latched would
 * disarm recovery for the rest of the session — which is exactly pi's own
 * `_overflowRecoveryAttempted` bug one level down).
 */

import { describe, expect, it } from "vitest";
import overflowGuard from "../extensions/overflow-guard/index.ts";
import { createFakePi, type FakeCtxOptions } from "./fake-pi.ts";

const XAI_OVERFLOW =
	'OpenAI API error (400): 400 "This model\'s maximum prompt length is 500000 but the request contains 505280 tokens."';

const wedged: FakeCtxOptions["branch"] = [
	{ message: { role: "user", content: "go" } },
	{ message: { role: "assistant", content: "", stopReason: "error", errorMessage: XAI_OVERFLOW } },
];
const healthy: FakeCtxOptions["branch"] = [
	{ message: { role: "user", content: "go" } },
	{ message: { role: "assistant", content: "done", stopReason: "stop" } },
];

const settle = (pi: ReturnType<typeof createFakePi>, branch: FakeCtxOptions["branch"], extra: FakeCtxOptions = {}) =>
	pi.emit({ type: "agent_settled" }, { branch, ...extra });

describe("overflow-guard", () => {
	it("asks for a compaction when the newest turn was refused for overflow", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, wedged);
		expect(pi.compactions).toBe(1);
	});

	it("asks exactly once, however long the session stays wedged", async () => {
		// The whole point. A compaction that did not clear the overflow will not
		// clear it on the second ask either, and asking every settle would be
		// the burn loop with an extra step.
		const pi = createFakePi();
		overflowGuard(pi.api);
		for (let i = 0; i < 5; i++) await settle(pi, wedged);
		expect(pi.compactions).toBe(1);
	});

	it("says so on the status line once the compaction did not help", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, wedged);
		await settle(pi, wedged);
		const said = pi.statuses.map((s) => s.text ?? "").join(" | ");
		expect(said).toMatch(/compacting/);
		expect(said).toMatch(/cannot send another request/);
	});

	it("never touches a healthy session", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, healthy);
		expect(pi.compactions).toBe(0);
		expect(pi.statuses).toEqual([]);
	});

	it("re-arms once the session reaches the provider again", async () => {
		// A guard that stayed latched would leave the session undefended for the
		// rest of its life — the same one-shot-latch defect this works around.
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, wedged);
		await settle(pi, healthy);
		await settle(pi, wedged);
		expect(pi.compactions).toBe(2);
	});

	it("does not inject a turn — the one-injector invariant is the driver's", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, wedged);
		await settle(pi, wedged);
		expect(pi.messages).toEqual([]);
		expect(pi.userMessages).toEqual([]);
	});

	it("survives a ctx that went stale between the event and the handler", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await expect(settle(pi, wedged, { staleCtx: true })).resolves.toBeDefined();
		expect(pi.compactions).toBe(0);
	});

	it("starts a new session with its attempt unspent", async () => {
		const pi = createFakePi();
		overflowGuard(pi.api);
		await settle(pi, wedged);
		await pi.emit({ type: "session_start" }, { branch: healthy });
		await settle(pi, wedged);
		expect(pi.compactions).toBe(2);
	});
});
