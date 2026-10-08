/**
 * PreToolUse — op-mode enforcement and the worktree guard. Synchronous, no
 * model calls, no network: it sits in front of every tool call.
 *
 * Both answers come from hive-pi's own policy, applied to Claude's tool names
 * mapped onto pi's:
 *   - discuss / plan / orchestrate: `opmode/verdict.ts` and the plan
 *     extension's `planToolVerdict` — the same refusal text a pi session reads;
 *   - the worktree guard: `guards-common/worktree-guard.ts`'s `decide`, exactly
 *     as `guards-bridge.ts` calls it for pi's edit/write.
 *
 * Scope, deliberately the contract's: only Claude's file-mutating tools and
 * Bash are classified. Other Claude-native tools (Read, Grep, Task, …) and MCP
 * tools pass — pi's read-only postures deny UNKNOWN tools, but Claude's tool
 * vocabulary is not pi's, and an allowlist written for pi's names would deny
 * Claude's harmless ones wholesale.
 *
 * Bugfix mode withholds the editors until the episode records a root cause
 * through the MCP tools `bugfix_evidence` → `bugfix_root_cause` (claude/bugfix.ts),
 * with opmode's refusal; Bash stays open, as in pi.
 *
 * The decision is only ever DENY or nothing: printing "allow" would skip
 * Claude's own permission prompt, which is not this hook's call.
 */

import { isAbsolute, resolve } from "node:path";
import { decide, realProbe } from "../../extensions/guards-common/worktree-guard.ts";
import { opModeShellVerdict, opModeToolVerdict } from "../../extensions/opmode/verdict.ts";
import { planToolVerdict } from "../../extensions/plan/policy.ts";
import { CLAUDE_BUGFIX_TOOLS } from "../bugfix.ts";
import type { Control } from "../state.ts";
import { denyToolUse, type HookInput, type HookOutput } from "./io.ts";

/** Claude's mutating tools and Bash, by pi's name for the same operation. */
export const CLAUDE_TO_PI_TOOL: Readonly<Record<string, string>> = {
	Edit: "edit",
	MultiEdit: "multiedit",
	Write: "write",
	NotebookEdit: "notebook_edit",
	Bash: "bash",
};

/** The file a Claude edit tool writes, as given. */
function editTarget(toolName: string, input: Record<string, unknown>): string | undefined {
	const raw = toolName === "NotebookEdit" ? input.notebook_path : input.file_path;
	return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * `rootCauseRecorded` is the bugfix gate's key (claude/bugfix.ts): until the
 * episode records a root cause, bugfix mode denies the file-mutating tools
 * with opmode's own refusal, naming the tools by their Claude names.
 */
export function preToolDecision(input: HookInput, control: Control, rootCauseRecorded = false): HookOutput {
	const claudeName = input.tool_name ?? "";
	const piName = CLAUDE_TO_PI_TOOL[claudeName];
	if (!piName) return null;
	const toolInput = input.tool_input ?? {};

	const mode = control.opMode;
	if (mode === "plan") {
		const verdict = planToolVerdict(piName, toolInput);
		if (!verdict.allowed) return denyToolUse(verdict.reason);
	} else if (mode === "bugfix") {
		// Bash stays open, exactly as pi leaves it: the investigation IS the
		// work — repros, instruments, the failing test (opmode/modes.ts,
		// BUGFIX_WITHHELD_TOOLS). Only the file editors wait for a root cause.
		const verdict = opModeToolVerdict(mode, piName, toolInput, rootCauseRecorded, CLAUDE_BUGFIX_TOOLS);
		if (!verdict.allowed) return denyToolUse(verdict.reason);
	} else if (mode === "discuss" || mode === "orchestrate") {
		const verdict = opModeToolVerdict(mode, piName, toolInput, false);
		if (!verdict.allowed) return denyToolUse(verdict.reason);
		if (piName === "bash") {
			const command = typeof toolInput.command === "string" ? toolInput.command : "";
			const shell = opModeShellVerdict(mode, command);
			if (!shell.allowed) return denyToolUse(shell.reason);
		}
	}

	if (piName !== "bash") {
		const target = editTarget(claudeName, toolInput);
		const path = target && !isAbsolute(target) && input.cwd ? resolve(input.cwd, target) : target;
		const verdict = decide(path, claudeName === "Write" ? "Write" : "Edit", realProbe);
		if (verdict.kind === "block") return denyToolUse(verdict.reason);
	}
	return null;
}
