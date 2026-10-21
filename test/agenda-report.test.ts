/**
 * The closing-report check (agenda/report.ts): one nudge when a run that
 * opened a PR ends on a receipt, never a second, never without a PR.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportPolicy, REPORT_LEDGER_ID, REPORT_MIN_WORDS, wordCount } from "../extensions/agenda/report.ts";
import { emptyLedger, record } from "../extensions/agenda/ledger.ts";
import { deriveSignals, emptySignals } from "../extensions/agenda/signals.ts";
import { PR_OPENED_ENTRY, registerDeliveryProgress } from "../extensions/agenda/delivery-progress.ts";
import type { PolicyContext } from "../extensions/agenda/policy.ts";
import { installDriver } from "../extensions/agenda/driver.ts";
import { createFakePi } from "./fake-pi.ts";

const receipt = "Opened draft PR #9060. Added tests and docs. Hooks passed; no fleet checks ran.";
const report = Array.from({ length: REPORT_MIN_WORDS + 10 }, (_, i) => `word${i}`).join(" ");

const context = (overrides: Partial<PolicyContext> = {}, prOpenedSinceUser = true): PolicyContext => ({
	cwd: "/repo",
	ledger: emptyLedger,
	lastAssistantText: receipt,
	transcript: "",
	signals: { ...emptySignals, prOpenedSinceUser },
	...overrides,
});

describe("closing-report check", () => {
	it("asks once for the report when a run that opened a PR ends on a receipt", async () => {
		const work = createReportPolicy().decide(context());
		expect(work).not.toBeNull();
		const outcome = await work!.run();
		expect(outcome.inject).toContain(`your closing message is ${wordCount(receipt)} words`);
		expect(outcome.inject).toContain("read in the chat, not in the PR description");
		expect(outcome.inject).toContain("Do not run tools, change files or push");
		expect(outcome.ledger!(emptyLedger).iterations[REPORT_LEDGER_ID]).toBe(1);
	});

	it.each([
		["no PR this run", context({}, false)],
		["a full report", context({ lastAssistantText: report })],
		["the nudge already spent", context({ ledger: record(emptyLedger, REPORT_LEDGER_ID) })],
		["no signals", context({ signals: undefined })],
	])("stays quiet with %s", (_name, ctx) => {
		expect(createReportPolicy().decide(ctx)).toBeNull();
	});

	it("derives prOpenedSinceUser from PR openings after the newest user prompt", () => {
		const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
		const pr = { type: "custom", customType: PR_OPENED_ENTRY, data: { at: 1 } };
		expect(deriveSignals([], [user("fix it"), pr]).prOpenedSinceUser).toBe(true);
		expect(deriveSignals([], [user("fix it"), pr, user("now something else")]).prOpenedSinceUser).toBe(false);
		expect(deriveSignals([], [user("fix it")]).prOpenedSinceUser).toBe(false);
	});

	it("records a PR opening even after a commit already marked delivery", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "report-pr-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
		try {
			git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
			writeFileSync(join(cwd, "code.ts"), "export const code = 0;\n"); git("add", "."); git("commit", "-qm", "initial");
			const pi = createFakePi(); registerDeliveryProgress(pi.api);
			const commit = { cwd, command: "git commit --allow-empty -m change" };
			await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "c", input: commit });
			await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "c", input: commit, content: [{ type: "text", text: "[main abc1234] change" }], isError: false });
			const pr = { cwd, command: "gh pr create --draft --title t --body-file /tmp/b.md" };
			await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "p", input: pr });
			await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "p", input: pr, content: [{ type: "text", text: "https://github.com/owner/repo/pull/123" }], isError: false });
			expect(pi.entries.map((e) => e.customType)).toEqual(["agenda-delivery-progress", PR_OPENED_ENTRY]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("injects through the driver once, at the settle after a PR, ahead of the goal judge", async () => {
		const pi = createFakePi();
		registerDeliveryProgress(pi.api);
		let goalJudgments = 0;
		installDriver(pi.api, { policies: [createReportPolicy(), { name: "goal", decide: () => { goalJudgments++; return null; } }] });
		const base = [{ message: { role: "user", content: "Implement HIV-3450 and open a draft PR" } }];
		let closing = receipt;
		const ctx = () => {
			const branch = [...base, ...pi.entries, { message: { role: "assistant", content: [{ type: "text", text: closing }] } }];
			return { branch, idle: false, get entries() { return branch; } };
		};
		await pi.emit({ type: "session_start" }, ctx());
		const pr = { command: "gh pr create --draft --title t --body-file /tmp/b.md" };
		await pi.emit({ type: "tool_result", toolName: "bash", toolCallId: "p", input: pr, content: [{ type: "text", text: "https://github.com/owner/repo/pull/9060" }], isError: false }, ctx());
		await pi.emit({ type: "agent_before_settle" }, ctx());
		expect(pi.messages.map((m) => m.content)).toEqual([expect.stringContaining("Report check")]);
		expect(goalJudgments).toBe(0);
		// The model answers with a full report: nothing more is asked, and the goal is judged.
		closing = report;
		await pi.emit({ type: "agent_before_settle" }, ctx());
		expect(pi.messages).toHaveLength(1);
		expect(goalJudgments).toBe(1);
		// Even another short message is not asked about twice.
		closing = receipt;
		await pi.emit({ type: "agent_before_settle" }, ctx());
		expect(pi.messages).toHaveLength(1);
	});
});
