/**
 * Bugfix mode in a Claude session: opmode's evidence protocol served as MCP
 * tools, the editors withheld by `hook pre-tool` until a root cause is
 * recorded, the prompt naming Claude's tool names, and the episode discarded
 * when the session leaves bugfix mode.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { bugfixEvidence, bugfixRootCause } from "../claude/mcp/bugfix-tools.ts";
import { bugfixPath } from "../claude/bugfix.ts";
import type { Control } from "../claude/state.ts";
import { makeLaunch, runCli, type LaunchEnv } from "./claude-harness.ts";

let launch: LaunchEnv;
let transcript: string;
const bugfix: Control = { opMode: "bugfix", ysk: { enabled: true } };

type Line = Record<string, unknown>;
const call = (id: string, command: string): Line => ({
	type: "assistant",
	uuid: `a-${id}`,
	message: { id: `m-${id}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const result = (id: string, text: string, isError: boolean): Line => ({
	type: "user",
	uuid: `r-${id}`,
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
});

function writeLines(lines: Line[]): void {
	writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
	launch = makeLaunch();
	launch.writeControl({ opMode: "bugfix" });
	transcript = join(launch.root, "t.jsonl");
	launch.env.HIVE_CLAUDE_TRANSCRIPT = transcript;
	writeLines([
		{ type: "user", uuid: "u", message: { role: "user", content: "the parser drops the last token" } },
		call("toolu_repro", "npm test -- parser"),
		result("toolu_repro", "FAIL parser.test.ts: expected 3 tokens, got 2", true),
		call("toolu_probe", "node probe.js"),
		result("toolu_probe", "loop stops at length - 1", false),
	]);
});

const preTool = (tool: string, input: Record<string, unknown>) => runCli(["hook", "pre-tool"], launch.env, JSON.stringify({ tool_name: tool, tool_input: input, cwd: "/tmp" }));

describe("bugfix mode", () => {
	it("withholds the editors with opmode's refusal, naming Claude's tools, and leaves Bash open", async () => {
		const edit = JSON.parse((await preTool("Edit", { file_path: "/tmp/a.ts" })).stdout);
		expect(edit.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(edit.hookSpecificOutput.permissionDecisionReason).toContain("Bugfix mode: no fix before a root cause");
		expect(edit.hookSpecificOutput.permissionDecisionReason).toContain("mcp__hive-pi__bugfix_evidence");
		expect(edit.hookSpecificOutput.permissionDecisionReason).toContain("mcp__hive-pi__bugfix_root_cause");
		for (const tool of ["Write", "MultiEdit"]) {
			expect(JSON.parse((await preTool(tool, { file_path: "/tmp/a.ts" })).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		}
		expect(JSON.parse((await preTool("NotebookEdit", { notebook_path: "/tmp/a.ipynb" })).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		expect((await preTool("Bash", { command: "echo probe > /tmp/out && npm test" })).stdout).toBe("");
	});

	it("walks the protocol from the transcript, unlocks edits on a root cause, and re-verifies", async () => {
		const dir = launch.stateDir;
		// No id: the refusal lists the observed results, newest first, failing one as the example.
		const listing = bugfixEvidence(dir, bugfix, transcript, { phase: "reproduce" });
		expect(listing.text).toContain("toolu_repro");
		expect(listing.text).toContain('"tool_call_id": "toolu_repro"');

		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "reproduce", tool_call_id: "toolu_probe", reproduction_key: "k" }).text).toContain("completed without failing");
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "reproduce", tool_call_id: "toolu_repro", reproduction_key: "parser-last-token" }).text).toContain("Reproduction failed via bash");
		expect(bugfixRootCause(dir, bugfix, { summary: "x", evidence: "y" }).text).toContain("mcp__hive-pi__bugfix_evidence");
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "hypothesize", tool_call_id: "toolu_probe", hypothesis: "off-by-one in the loop bound" }).text).toContain("Hypothesis recorded");
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "instrument", tool_call_id: "toolu_probe" }).text).toContain("Instrumentation recorded");
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "confirm", tool_call_id: "toolu_probe", hypothesis: "loop stops at length - 1" }).text).toContain("Hypothesis confirmed");

		// Still locked until the cause is recorded.
		expect(JSON.parse((await preTool("Edit", { file_path: "/tmp/a.ts" })).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		const recorded = bugfixRootCause(dir, bugfix, { summary: "tokenize() loops to length - 1", evidence: "probe.js shows the loop stops one short" });
		expect(recorded.text).toContain("Root cause recorded — file edits are unlocked.");
		expect((await preTool("Edit", { file_path: "/tmp/a.ts" })).stdout).toBe("");

		// Re-verification must be a DISTINCT passing run of the same reproduction.
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "reverify", tool_call_id: "toolu_repro", reproduction_key: "parser-last-token" }).text).toContain("failing baseline");
		writeLines([
			{ type: "user", uuid: "u", message: { role: "user", content: "x" } },
			call("toolu_repro", "npm test -- parser"),
			result("toolu_repro", "FAIL", true),
			call("toolu_probe", "node probe.js"),
			result("toolu_probe", "loop stops at length - 1", false),
			call("toolu_rerun", "npm test -- parser"),
			result("toolu_rerun", "PASS parser.test.ts", false),
		]);
		expect(bugfixEvidence(dir, bugfix, transcript, { phase: "reverify", tool_call_id: "toolu_rerun", reproduction_key: "parser-last-token" }).text).toBe("The same reproduction now passes.");
	});

	it("discards the episode when the session leaves bugfix mode — a cause never carries over", async () => {
		const dir = launch.stateDir;
		writeFileSync(bugfixPath(dir), JSON.stringify({ episode: "e1", machine: { phase: "fix", reproduction: null }, rootCause: { summary: "s", evidence: "e" } }));
		expect((await preTool("Edit", { file_path: "/tmp/a.ts" })).stdout).toBe(""); // unlocked in this episode
		launch.writeControl({ opMode: "build" });
		await preTool("Read", { file_path: "/tmp/a.ts" });
		expect(existsSync(bugfixPath(dir))).toBe(false);
		launch.writeControl({ opMode: "bugfix" });
		expect(JSON.parse((await preTool("Edit", { file_path: "/tmp/a.ts" })).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(bugfixEvidence(dir, { ...bugfix, opMode: "build" }, transcript, { phase: "blocked" })).toMatchObject({ isError: true });
	});

	it("injects the bugfix prompt with Claude's tool names", async () => {
		const out = JSON.parse((await runCli(["hook", "prompt"], launch.env, "{}")).stdout);
		const text = out.hookSpecificOutput.additionalContext as string;
		expect(text).toContain("# Bugfix mode");
		expect(text).toContain("`mcp__hive-pi__bugfix_evidence`");
		expect(text).toContain("`mcp__hive-pi__bugfix_root_cause`");
		expect(text).not.toMatch(/`bugfix_(evidence|root_cause)`/);
	});

	it("tags each result with its evidence id while the investigation is live", async () => {
		const out = await runCli(["hook", "post-tool"], launch.env, JSON.stringify({ tool_name: "Bash", tool_use_id: "toolu_x", tool_input: { command: "ls" }, cwd: "/tmp" }));
		expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toBe("[bugfix evidence id: toolu_x]");
		launch.writeControl({ opMode: "build" });
		const off = await runCli(["hook", "post-tool"], launch.env, JSON.stringify({ tool_name: "Bash", tool_use_id: "toolu_y", tool_input: { command: "ls" }, cwd: "/tmp" }));
		expect(off.stdout).toBe("");
	});
});
