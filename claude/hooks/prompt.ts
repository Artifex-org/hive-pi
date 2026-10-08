/**
 * UserPromptSubmit — the operating mode's instructions, while one is on.
 *
 * pi appends `buildOpModePrompt(mode)` to the system prompt on every turn
 * (`opmode/index.ts`, `before_agent_start`); Claude's nearest seam is
 * additional context on each prompt. Only discuss and bugfix speak: `build`
 * restricts nothing, and `plan` is Claude's own native mode.
 */

import { buildOpModePrompt } from "../../extensions/opmode/prompt.ts";
import type { Control } from "../state.ts";
import { additionalContext, type HookOutput } from "./io.ts";

export function promptDecision(control: Control): HookOutput {
	if (control.opMode !== "discuss" && control.opMode !== "bugfix") return null;
	const text = buildOpModePrompt(control.opMode);
	return text ? additionalContext("UserPromptSubmit", text) : null;
}
