import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConductorAdvicePolicy, createConductorPolicy, ADVISE_LEDGER_ID } from "../extensions/agenda/conductor.ts";
import { createConductor, withStage } from "../extensions/agenda/conductor-state.ts";
import { installDriver } from "../extensions/agenda/driver.ts";
import { deliveryMilestone, registerDeliveryProgress, DELIVERY_PROGRESS_ENTRY, ADVICE_GIVEN_ENTRY } from "../extensions/agenda/delivery-progress.ts";
import type { GoalItem } from "../extensions/agenda/goal-state.ts";
import { createFakePi, type FakeCtxOptions } from "./fake-pi.ts";

describe("delivery milestones", () => {
	it("does not record failed duplicate-PR creation even when the error includes its URL", async () => {
		const pi = createFakePi(); registerDeliveryProgress(pi.api);
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "pr", input: { command: "gh pr create" },
			content: [{ type: "text", text: "a pull request already exists:\nhttps://github.com/owner/repo/pull/123" }], isError: true });
		expect(pi.entries).toHaveLength(0);
	});
	it("ignores successful pipelines masking failed creation, but keeps an attributable partial success", () => {
		const url = "https://github.com/owner/repo/pull/123";
		expect(deliveryMilestone("gh pr create 2>&1 | cat", "already exists:\n" + url, true)).toBe(false);
		expect(deliveryMilestone("gh pr create && false", url, false)).toBe(true);
		expect(deliveryMilestone("gh pr create && false", "already exists:\n" + url, false)).toBe(false);
		expect(deliveryMilestone("gh pr create && gh pr checks --watch", url + "\nGraphQL: checks failed", false)).toBe(true);
	});
	it.each(["git commit -q -m change", "git -c user.name=Test -c user.email=test@example.com commit -q -m change"])("observes actual %s when a later push fails, using commit-specific reflog evidence", async command => {
		const cwd = mkdtempSync(join(tmpdir(), "milestone-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
		try {
			git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
			writeFileSync(join(cwd, "code.ts"), "export const code = 0;\n"); git("add", "."); git("commit", "-qm", "initial");
			writeFileSync(join(cwd, "code.ts"), "export const code = 1;\n"); git("add", ".");
			const pi = createFakePi(); registerDeliveryProgress(pi.api);
			const input = { cwd, command: command + " && git push origin HEAD" };
			await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "partial", input });
			git(...(command.includes("-c") ? ["-c", "user.name=Test", "-c", "user.email=test@example.com"] : []), "commit", "-qm", "change");
			await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "partial", input,
				content: [{ type: "text", text: "fatal: authentication failed" }], isError: true });
			expect(pi.entries).toEqual([{ customType: DELIVERY_PROGRESS_ENTRY, data: { reached: true } }]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
	it.each(["git commit -q -m change", "git add code.ts && git commit -q -m change", "git commit -q -m change && git push origin HEAD", "git commit -q -m change && echo done"])("observes %s only when HEAD actually changes", async command => {
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
		["git commit -m change 2>&1", "[work abc1234] change"],
		["gh pr create 2>&1", "https://github.com/owner/repo/pull/123"],
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
	it("does not spend or persist advice dropped when a user message arrives during policy work", async () => {
		const pi = createFakePi(); let item = withStage(createConductor("c", 0), "execute", 0);
		const advice = createConductorAdvicePolicy({ current: () => item, commit: next => { item = next; }, goal: () => null, enabled: () => true, requestPlanMode: () => {} });
		const driver = installDriver(pi.api, { policies: [advice], turnPolicies: [advice] });
		const branch = [{ message: { role: "user", content: "Implement HIV-3838 with tests and deliver one PR" } }];
		const ctx: FakeCtxOptions = { branch, idle: false, pendingMessages: false };
		await pi.emit({ type: "session_start" }, ctx);
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "c", input: { command: "git commit -m change" },
			content: [{ type: "text", text: "[work abc1234] change" }], isError: false });
		ctx.branch = [...branch, ...pi.entries];
		let metrics = 0;
		const unsubscribe = pi.api.events.on("hive.metric", () => { metrics++; ctx.pendingMessages = true; });
		await pi.emit({ type: "turn_end" }, ctx); unsubscribe();
		expect(metrics).toBe(1);
		expect(pi.messages).toHaveLength(0);
		expect(driver.ledger().iterations[ADVISE_LEDGER_ID]).toBeUndefined();
		expect(pi.entries.filter(entry => entry.customType === ADVICE_GIVEN_ENTRY)).toHaveLength(0);
		ctx.pendingMessages = false;
		await pi.emit({ type: "session_start" }, { ...ctx, entries: [...branch, ...pi.entries] });
		await pi.emit({ type: "turn_end" }, ctx);
		expect(pi.messages).toHaveLength(1);
		expect(pi.entries.filter(entry => entry.customType === ADVICE_GIVEN_ENTRY)).toHaveLength(1);
	});
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
		// /agenda stop uses reset(); /conductor on must not re-arm advice.
		driver.reset(); item = withStage(item, "execute", 9);
		await pi.emit({ type: "turn_end" }, ctx());
		expect(pi.messages).toHaveLength(1);
		expect(driver.ledger().iterations[ADVISE_LEDGER_ID]).toBe(1);
		await pi.emit({ type: "session_start" }, { branch, entries: [...branch, ...pi.entries], idle: false });
		item = withStage(item, "execute", 10);
		await pi.emit({ type: "turn_end" }, ctx());
		expect(pi.messages).toHaveLength(1);
		expect(driver.ledger().iterations[ADVISE_LEDGER_ID]).toBe(1);
	});
});
