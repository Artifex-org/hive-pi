/**
 * UserPromptSubmit — the operating mode's instructions, while one is on.
 *
 * pi appends `buildOpModePrompt(mode)` to the system prompt on every turn
 * (`opmode/index.ts`, `before_agent_start`); Claude's nearest seam is
 * additional context on each prompt. Only discuss and bugfix speak: `build`
 * restricts nothing, and `plan` is Claude's own native mode.
 */

import { buildOpModePrompt } from "../../extensions/opmode/prompt.ts";
import { CLAUDE_BUGFIX_TOOLS } from "../bugfix.ts";
import type { Control } from "../state.ts";
import { additionalContext, type HookOutput } from "./io.ts";
import { CLAUDE_HELPER_GUIDANCE } from "../guidance.ts";

export function promptDecision(control: Control): HookOutput {
	// The tools are deferred; a retrieval brief may be disabled or skipped.
	// Name helpers on the actual prompt seam as well, without a model call.
	const modeText = control.opMode === "discuss" || control.opMode === "bugfix"
		? buildOpModePrompt(control.opMode, CLAUDE_BUGFIX_TOOLS) : "";
	return additionalContext("UserPromptSubmit", [modeText, CLAUDE_HELPER_GUIDANCE].filter(Boolean).join("\n\n"));
}
