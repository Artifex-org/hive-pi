import { describe, expect, it } from "vitest";
import { createConductorAdvicePolicy, createConductorPolicy, ADVISE_LEDGER_ID } from "../extensions/agenda/conductor.ts";
import { createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import { installDriver } from "../extensions/agenda/driver.ts";
import { deliveryMilestone, registerDeliveryProgress, DELIVERY_PROGRESS_ENTRY, ADVICE_GIVEN_ENTRY } from "../extensions/agenda/delivery-progress.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { createFakePi } from "./fake-pi.ts";

describe("delivery milestones", () => {
	it("does not record failed duplicate-PR creation even when the error includes its URL", async () => {
		const pi = createFakePi(); registerDeliveryProgress(pi.api);
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "pr", input: { command: "gh pr create" },
			content: [{ type: "text", text: "a pull request already exists:\nhttps://github.com/owner/repo/pull/123" }], isError: true });
		expect(pi.entries).toHaveLength(0);
	});
	it.each(["git commit -q -m change", "git add code.ts && git commit -q -m change"])("observes %s only when HEAD actually changes", async command => {
		const pi = createFakePi(); let head = "old";
		registerDeliveryProgress(pi.api, () => head);
		const call = () => pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "q", input: { command } });
		const result = (isError = false) => pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "q", input: { command }, content: [], isError });
		await call(); await result(); expect(pi.entries).toHaveLength(0);
		await call(); head = "failed hook changed HEAD"; await result(true); expect(pi.entries).toHaveLength(0);
		const fallback = "git commit -q -m change || git checkout other";
		await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "f", input: { command: fallback } });
		head = "other";
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "f", input: { command: fallback }, content: [], isError: false });
		expect(pi.entries).toHaveLength(0);
		await call(); head = "new"; await result();
		expect(pi.entries).toEqual([{ customType: DELIVERY_PROGRESS_ENTRY, data: { reached: true } }]);
	});
	it.each([
		["git commit -m change", "[work abc1234] change"],
		["HIVE_PRESIGN_REQUIRED=1 git -C /repo commit -m change && false", "[work (root-commit) abc1234] change"],
		["gh pr create", "https://github.com/owner/repo/pull/123"],
		["gh pr create && echo done", "https://github.com/owner/repo/pull/123\ndone"],
		["hive ship", "https://github.com/owner/repo/pull/123"],
	])("recognizes successful evidence for %s", (command, output) => {
		expect(deliveryMilestone(command, output)).toBe(true);
	});
	it.each([
		["git commit -m change", "nothing to commit, working tree clean"],
		["git commit -m change", "fatal: failed"],
		["gh pr create", "permission denied"],
		["gh pr view", "https://github.com/owner/repo/pull/123"],
		["gh pr create || gh pr view --json url --jq .url", "https://github.com/owner/repo/pull/123"],
		["echo 'git commit'", "[work abc1234] change"],
		["echo 'gh pr create'", "https://github.com/owner/repo/pull/123"],
	])("does not mistake failed or read-only %s for a milestone", (command, output) => {
		expect(deliveryMilestone(command, output)).toBe(false);
	});
});

describe("advisor timing", () => {
	it.each([
		["git commit -m change", "[work abc1234] change"],
		["gh pr create", "https://github.com/owner/repo/pull/123"],
	])("injects after %s, before final report/goal judgment, and survives resume", async (command, output) => {
		const pi = createFakePi();
		let item = withStage(createConductor("c", 0), "execute", 0);
		const hooks = {
			current: () => item, commit: (next: typeof item) => { item = next; },
			goal: () => ({ state: "active" } as GoalItem), enabled: () => true, requestPlanMode: () => {},
		};
		const advice = createConductorAdvicePolicy(hooks);
		let goalJudgments = 0;
		const driver = installDriver(pi.api, {
			policies: [advice, { name: "goal", decide: () => { goalJudgments++; return null; } }, createConductorPolicy(hooks)],
			turnPolicies: [advice],
		});
		const branch = [{ message: { role: "user", content: "Implement HIV-3838 with tests and deliver one PR" } }];
		const ctx = () => ({ branch: [...branch, ...pi.entries], idle: false });
		await pi.emit({ type: "session_start" }, ctx());
		await pi.emit({ type: "turn_end" }, ctx());
		expect(pi.messages).toHaveLength(0);
		// Nested bash inside codemode still emits tool_result to the driver.
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "code/1",
			input: { command }, content: [{ type: "text", text: output }], isError: false }, ctx());
		expect(pi.entries.filter(entry => entry.customType === DELIVERY_PROGRESS_ENTRY)).toHaveLength(1);
		await pi.emit({ type: "turn_end" }, ctx());
		expect(goalJudgments).toBe(0);
		expect(pi.messages.map(message => message.content)).toEqual([expect.stringContaining("first commit or PR opening")]);
		expect(item.stage).toBe("verify");
		expect(driver.ledger().iterations[ADVISE_LEDGER_ID]).toBe(1);
		expect(pi.entries.filter(entry => entry.customType === ADVICE_GIVEN_ENTRY)).toHaveLength(1);
		await pi.emit({ type: "turn_start" }, ctx());
		await pi.emit({ type: "turn_end" }, ctx());
		await pi.emit({ type: "agent_before_settle" }, ctx());
		expect(goalJudgments).toBe(1);
		await pi.emit({ type: "session_start" }, { branch, entries: [...branch, ...pi.entries], idle: false });
		item = withStage(item, "execute", 10);
		await pi.emit({ type: "turn_end" }, ctx());
		expect(pi.messages).toHaveLength(1);
		expect(driver.ledger().iterations[ADVISE_LEDGER_ID]).toBe(1);
	});
});
