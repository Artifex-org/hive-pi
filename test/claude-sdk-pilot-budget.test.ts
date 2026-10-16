import { describe, expect, it } from "vitest";
import { PilotPolicyError, PilotQueryBudget } from "../extensions/claude-sdk/pilot-budget.ts";

function expectClosed(budget: PilotQueryBudget, operation: () => unknown, category: string): void {
	expect(operation).toThrow(expect.objectContaining({ category }));
	expect(() => budget.arm([])).toThrow(PilotPolicyError);
	expect(() => budget.reserveQuery()).toThrow(PilotPolicyError);
}

describe("pilot query allowances (not native retry proof)", () => {
	it("refuses a pre-command availability probe without spending or arming the pilot", () => {
		const budget = new PilotQueryBudget();
		expect(() => budget.assertRequestAllowed()).toThrow("claude_sdk_pilot_not_armed");
		expect(budget.reservedTurns).toBe(0);
		budget.arm([]);
		budget.beginRequest(false);
		expect(budget.reserveQuery()).toBe(2);
		budget.endRequest();
	});

	it("permits only correlated parked continuations and excludes concurrent requests", () => {
		const budget = new PilotQueryBudget(); budget.arm([]);
		budget.beginRequest(false); budget.reserveQuery(); budget.endRequest();
		budget.beginRequest(true); budget.endRequest();
		expectClosed(budget, () => budget.beginRequest(false), "unexpected_query");
		const concurrent = new PilotQueryBudget(); concurrent.arm([]);
		concurrent.beginRequest(false);
		expectClosed(concurrent, () => concurrent.beginRequest(false), "unexpected_query");
	});

	it("refuses a query before explicit arming and cannot recover by arming later", () => {
		const budget = new PilotQueryBudget();
		expectClosed(budget, () => budget.reserveQuery(), "not_armed");
		expect(budget.reservedTurns).toBe(0);
	});

	it("reserves two then one only after a successful result and explicit recall grant", () => {
		const budget = new PilotQueryBudget();
		budget.arm(["denied-fixture"]);
		budget.checkAccount({ credential: "allowed-fixture", slot: "allowed-slot" });
		expect(budget.reserveQuery()).toBe(2);
		budget.observeResult(2, true);
		budget.allowRecall();
		expect(budget.reserveQuery()).toBe(1);
		budget.observeResult(1, true);
		expect(budget.reservedTurns).toBe(3);
		expect(budget.observedTurns).toBe(3);
		expectClosed(budget, () => budget.reserveQuery(), "unexpected_query");
		expect(budget.reservedTurns).toBe(3);
	});

	it("cannot refund the first allowance after a factory failure or concurrent query", () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		expect(budget.reserveQuery()).toBe(2);
		expectClosed(budget, () => budget.reserveQuery(), "unexpected_query");
		expect(budget.reservedTurns).toBe(2);
	});

	it("cannot grant recall before an observed terminal native success", () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		budget.reserveQuery();
		expectClosed(budget, () => budget.allowRecall(), "unexpected_query");
	});

	it.each([0, -1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid first native count %s", (count) => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		budget.reserveQuery();
		expectClosed(budget, () => budget.observeResult(count, true), "unexpected_result");
	});

	it("does not treat an error result as permission for a new query", () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		budget.reserveQuery();
		expectClosed(budget, () => budget.observeResult(2, false), "unexpected_result");
	});

	it("rejects excess or duplicate result frames without a corresponding reservation", () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		budget.reserveQuery();
		budget.observeResult(1, true);
		expectClosed(budget, () => budget.observeResult(1, true), "unexpected_result");
	});

	it.each(["credential", "slot"] as const)("rejects an excluded %s without exposing its value", (key) => {
		const budget = new PilotQueryBudget();
		budget.arm(["denied-fixture"]);
		const identity = { credential: "allowed-fixture", slot: "allowed-slot", [key]: "denied-fixture" };
		expect(() => budget.checkAccount(identity)).toThrow("claude_sdk_pilot_account_excluded");
		expect(() => budget.reserveQuery()).toThrow(PilotPolicyError);
	});

	it("rechecks a pre-arm account and never permits a subsequent account switch", () => {
		const budget = new PilotQueryBudget();
		budget.checkAccount({ credential: "allowed-fixture", slot: "allowed-slot" });
		budget.arm([]);
		budget.checkAccount({ credential: "allowed-fixture", slot: "allowed-slot" });
		expectClosed(budget, () => budget.checkAccount({ credential: "another-fixture", slot: "another-slot" }), "account_changed");
	});

	it("fails closed if a pre-arm account is subsequently excluded", () => {
		const budget = new PilotQueryBudget();
		budget.checkAccount({ credential: "denied-fixture", slot: "denied-slot" });
		expectClosed(budget, () => budget.arm(["denied-slot"]), "account_excluded");
	});

	it("does not reopen after timeout or ordinary cleanup", () => {
		const budget = new PilotQueryBudget();
		budget.arm([]);
		budget.reserveQuery();
		budget.close();
		budget.close();
		expectClosed(budget, () => budget.reserveQuery(), "closed");
		expect(budget.reservedTurns).toBe(2);
	});
});
