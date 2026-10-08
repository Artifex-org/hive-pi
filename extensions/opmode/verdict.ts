/**
 * What an operating mode permits — the enforcement, as pure functions.
 *
 * Lifted out of `index.ts`'s closure so the pi extension and the Claude
 * adapter's PreToolUse hook (`claude/hooks/pre-tool.ts`) answer from one
 * policy. Pi tool names throughout: a host with other names maps them first.
 *
 * `plan` answers `allowed` here on purpose: in pi that posture's gate belongs
 * to the plan extension, whose own `tool_call` hook is active whenever it is,
 * and answering here as well would be a second opinion about one mode. A host
 * without the plan extension applies `plan/policy.ts`'s `planToolVerdict`.
 */

import {
	classifyCommand,
	classifyDiscussionTool,
	classifyOrchestrateCommand,
	classifyOrchestrateTool,
	type PlanToolVerdict,
} from "../plan/policy.ts";
import { phaseOrder, PI_BUGFIX_TOOLS, type BugfixToolNames } from "./bugfix.ts";
import { BUGFIX_WITHHELD_TOOLS, type OpMode } from "./modes.ts";

/** The evidence protocol's phases, in the one order they run, with pi's tool names. */
export const PHASE_ORDER = phaseOrder();

/**
 * Whether `mode` permits calling `name` with `input`. `rootCauseRecorded` is
 * the bugfix gate's key: edits open once a root cause exists.
 */
export function opModeToolVerdict(
	mode: OpMode,
	name: string,
	input: unknown,
	rootCauseRecorded: boolean,
	names: BugfixToolNames = PI_BUGFIX_TOOLS,
): PlanToolVerdict {
	switch (mode) {
		case "discuss":
			return classifyDiscussionTool(name, input);
		case "bugfix":
			if (rootCauseRecorded || !BUGFIX_WITHHELD_TOOLS.has(name)) return { allowed: true };
			// This is the FIRST thing an agent in bugfix mode reads, and it used
			// to send them straight at `bugfix_root_cause` — which then refuses
			// until bugfix_evidence has walked every phase. The deny that opens
			// the investigation cannot prescribe the call that closes it, or the
			// agent's first two moves are both refusals.
			return {
				allowed: false,
				reason:
					`Bugfix mode: no fix before a root cause. Reproduce the bug and build something that measures it ` +
					`— the shell, tests and scripts are all open — recording each step with ${names.evidence}, in order: ` +
					`${phaseOrder(names)}. Once "confirm" is recorded, ${names.rootCause} accepts the mechanism and unlocks edits.`,
			};
		case "orchestrate":
			return classifyOrchestrateTool(name, input);
		case "build":
		case "plan":
			return { allowed: true };
	}
}

/**
 * The shell gate for the two fail-closed read-only postures. Every other mode
 * leaves `bash` to the tool verdict — bugfix deliberately (see
 * BUGFIX_WITHHELD_TOOLS), plan because its gate is the plan extension's.
 */
export function opModeShellVerdict(mode: OpMode, command: string): PlanToolVerdict {
	if (mode === "orchestrate") return classifyOrchestrateCommand(command);
	if (mode === "discuss") return classifyCommand(command, "Discussion");
	return { allowed: true };
}
