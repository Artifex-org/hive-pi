/**
 * The ask policy's Jev tier. The phrase list answers first and for free; Jev is
 * asked only when the list is silent, the ending carries a request-shaped word,
 * and a client is live. Jev is a fake fetch — nothing here reaches the network.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ASK_JEV_BAR,
	ASK_JEV_METRIC,
	ASK_NUDGE,
	askTail,
	createAskPolicy,
	MAX_ASK_NUDGES,
	worthAskingJev,
} from "../extensions/agenda/ask.ts";
import { emptyLedger, record } from "../extensions/agenda/ledger.ts";
import { TypesafeClient } from "../extensions/typesafe-common/client.ts";
import { configFrom } from "../extensions/typesafe-common/config.ts";

// Real endings from the 2026-09-18 corpus that the phrase list MISSED and Jev
// rated >= 0.7 — the class this tier exists for.
const MISSED_ASK =
	"Root cause is confirmed: the one failing test is stale on main, not a behavior change from this PR. " +
	"Correcting it would require expanding the explicitly fixed three-file scope, so I need your scope decision.";
const REPORT = "All checks are green on the final head. The PR is merged and the worktree is clean.";

function fakeJev(p: number | null) {
	const bodies: unknown[] = [];
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		if (p === null) return new Response("down", { status: 503 });
		return new Response(JSON.stringify({ model: "jev-test", answers: { asks: { type: "noul", noul: p } } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return { client: new TypesafeClient({ config: configFrom({ enabled: true }), apiKey: "k", fetchImpl }), fetchImpl, bodies };
}

function ctx(text: string | undefined, ledger = emptyLedger) {
	return { cwd: "/tmp", ledger, lastAssistantText: text, transcript: "" };
}

describe("the prefilter decides only whether Jev is asked", () => {
	it("passes an ending that asks without a phrase the list knows", () => {
		expect(worthAskingJev(MISSED_ASK)).toBe(true);
	});
	it("skips a plain report", () => {
		expect(worthAskingJev(REPORT)).toBe(false);
	});
	it("leaves an ending in ? to question-guard", () => {
		expect(worthAskingJev("Should I also update the docs for you?")).toBe(false);
	});
	it("looks at the last two paragraphs, where the ask sat in a measured miss", () => {
		const text = "Earlier work.\n\nPlan remains blocked pending your KB decision.\n\nAdvisor review also requires reverting first.";
		expect(askTail(text)).toContain("pending your KB decision");
		expect(worthAskingJev(text)).toBe(true);
	});
	it("ignores code", () => {
		expect(worthAskingJev("Done.\n\n```\necho 'your choice'\n```")).toBe(false);
	});
});

describe("ask policy with Jev", () => {
	it("the phrase list still answers first, without calling Jev", async () => {
		const { client, fetchImpl } = fakeJev(0.99);
		const policy = createAskPolicy({ attended: () => true, jev: () => client });
		const work = policy.decide(ctx("I can do either. Let me know which you prefer."));
		const out = await work!.run();
		expect(out.inject).toBe(ASK_NUDGE);
		expect(out.metric.name).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("nudges on a miss the list cannot see when Jev clears the bar", async () => {
		const { client, bodies } = fakeJev(ASK_JEV_BAR + 0.1);
		const policy = createAskPolicy({ attended: () => true, jev: () => client });
		const out = await policy.decide(ctx(MISSED_ASK))!.run();
		expect(out.inject).toBe(ASK_NUDGE);
		expect(out.metric).toMatchObject({ outcome: "fail", name: ASK_JEV_METRIC });
		expect(out.ledger).toBeDefined();
		expect((bodies[0] as { state: string }).state).toBe(askTail(MISSED_ASK));
	});

	it("stays silent below the bar, and says so on the metric", async () => {
		const { client } = fakeJev(ASK_JEV_BAR - 0.01);
		const out = await createAskPolicy({ attended: () => true, jev: () => client }).decide(ctx(MISSED_ASK))!.run();
		expect(out.inject).toBeUndefined();
		expect(out.metric).toMatchObject({ outcome: "pass", name: ASK_JEV_METRIC });
	});

	it("a failed call never invents a question", async () => {
		const { client } = fakeJev(null);
		const out = await createAskPolicy({ attended: () => true, jev: () => client }).decide(ctx(MISSED_ASK))!.run();
		expect(out.inject).toBeUndefined();
		expect(out.metric).toMatchObject({ outcome: "skip", name: ASK_JEV_METRIC });
	});

	it("does not call Jev for an ending the prefilter skips", () => {
		const { client, fetchImpl } = fakeJev(0.99);
		expect(createAskPolicy({ attended: () => true, jev: () => client }).decide(ctx(REPORT))).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("an unattended session is never nudged, by either tier", () => {
		const { client } = fakeJev(0.99);
		expect(createAskPolicy({ attended: () => false, jev: () => client }).decide(ctx(MISSED_ASK))).toBeNull();
	});

	it("the per-session cap binds the Jev tier too", () => {
		const { client } = fakeJev(0.99);
		let ledger = emptyLedger;
		for (let i = 0; i < MAX_ASK_NUDGES; i++) ledger = record(ledger, "ask");
		expect(createAskPolicy({ attended: () => true, jev: () => client }).decide(ctx(MISSED_ASK, ledger))).toBeNull();
	});

	it("without a live Jev the policy is exactly the phrase list", () => {
		const off = new TypesafeClient({ config: configFrom({}), apiKey: "k", fetchImpl: vi.fn() });
		expect(createAskPolicy({ attended: () => true, jev: () => off }).decide(ctx(MISSED_ASK))).toBeNull();
		expect(createAskPolicy({ attended: () => true }).decide(ctx(MISSED_ASK))).toBeNull();
	});
});
