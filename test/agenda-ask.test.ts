/**
 * The prose-decision nudge.
 *
 * The positives below are REAL end-of-turn messages from a fleet-week of pi
 * transcripts, and the negatives are drawn from the same corpus — the detector
 * matched 4 of 7,864 settles with no false positive, and these tests pin both
 * halves of that. A phrase added without re-running that check is how a set
 * like this drifts into matching reports.
 */

import { describe, expect, it } from "vitest";
import {
	ASK_NUDGE,
	createAskPolicy,
	endsWithProseDecisionRequest,
	MAX_ASK_NUDGES,
} from "../extensions/agenda/ask.ts";
import { emptyLedger, count, type LedgerState } from "../extensions/agenda/ledger.ts";
import type { PolicyContext } from "../extensions/agenda/policy.ts";

const context = (over: Partial<PolicyContext> = {}): PolicyContext => ({
	cwd: "/repo",
	ledger: emptyLedger,
	lastAssistantText: undefined,
	transcript: "",
	...over,
});

describe("endsWithProseDecisionRequest", () => {
	it("catches the real prose asks that reached nobody", () => {
		for (const text of [
			"Awaiting your core-delivery decision before further mutations.",
			"Please choose scope: exclude homectl from **all Hive-launched agents** (recommended) or **pyERP launches only**.",
			"Awaiting your scope decision: preserve the email-only boundary, or authorize integrating the separately owned Shipping repair.",
			"Please choose **Recover PR only**, **Stop here**, or **Expand scope** from the pending plan decision.",
			"I can go either way here — let me know which you prefer.",
			"Shall I roll that into the same PR.",
		]) {
			expect(endsWithProseDecisionRequest(text), text).toBe(true);
		}
	});

	it("leaves anything ending in a question mark to the question guard", () => {
		// Two mechanisms reacting to one ending would mean the guard's veto races
		// a nudge that can never be delivered — the guard wins, and correctly.
		expect(endsWithProseDecisionRequest("Should I use approach A or B?")).toBe(false);
		expect(endsWithProseDecisionRequest("Please confirm: is this the right branch?")).toBe(false);
		expect(endsWithProseDecisionRequest("Ready to merge?\n\n")).toBe(false);
	});

	it("does not fire on reports that merely contain a decision word", () => {
		for (const text of [
			"The run is green; I can confirm the tests pass on the rebased head.",
			"A clean dependency-only reproduction is running; it will confirm whether the missing install is the cause.",
			"I picked the narrower fix and stated the assumption in the PR body.",
			"Merged #6779. Next: rebase the three issue branches onto main.",
			"Done — the guard was already stale, so I deleted it rather than repairing it.",
			"I'll proceed with approach A unless you say otherwise.",
		]) {
			expect(endsWithProseDecisionRequest(text), text).toBe(false);
		}
	});

	it("reads only the LAST sentence, so a quoted question is not an ask", () => {
		const text = "You asked whether we should split the PR. We should not: the two changes share a migration.";
		expect(endsWithProseDecisionRequest(text)).toBe(false);
	});

	it("ignores decision words that appear only inside code", () => {
		expect(endsWithProseDecisionRequest('Landed the helper:\n```\nconsole.log("let me know")\n```')).toBe(false);
		expect(endsWithProseDecisionRequest("Renamed the flag to `please_confirm`.")).toBe(false);
	});

	it("is false for an empty or missing turn", () => {
		expect(endsWithProseDecisionRequest(undefined)).toBe(false);
		expect(endsWithProseDecisionRequest("   ")).toBe(false);
	});
});

describe("the ask policy", () => {
	const attended = createAskPolicy({ attended: () => true });
	const unattended = createAskPolicy({ attended: () => false });
	const asking = "Awaiting your scope decision before I continue.";

	it("nudges an attended session toward the card", () => {
		const work = attended.decide(context({ lastAssistantText: asking }));
		expect(work).not.toBeNull();
	});

	it("injects a nudge naming the tool, not a restatement of the question", () => {
		expect(ASK_NUDGE).toContain("ask_user_question");
		expect(ASK_NUDGE).toContain("(Recommended)");
	});

	it("stays silent when nobody can answer", () => {
		// An unattended worker blocking on a question is the 68-minute stall of
		// HIV-1449. There, deciding and stating the assumption is correct.
		expect(unattended.decide(context({ lastAssistantText: asking }))).toBeNull();
	});

	it("stays silent on a turn that did not ask anything", () => {
		expect(attended.decide(context({ lastAssistantText: "Merged #6779." }))).toBeNull();
	});

	it("stops nudging once the budget is spent", async () => {
		// A model that ignores the nudge twice intends to proceed; a fourth
		// reminder is a spent turn.
		let ledger: LedgerState = emptyLedger;
		for (let i = 0; i < MAX_ASK_NUDGES; i++) {
			const work = attended.decide(context({ lastAssistantText: asking, ledger }));
			expect(work, `nudge ${i + 1}`).not.toBeNull();
			const outcome = await work!.run();
			ledger = outcome.ledger!(ledger);
		}
		expect(count(ledger, "ask")).toBe(MAX_ASK_NUDGES);
		expect(attended.decide(context({ lastAssistantText: asking, ledger }))).toBeNull();
	});
});
