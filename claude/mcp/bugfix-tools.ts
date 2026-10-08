/**
 * `bugfix_evidence` and `bugfix_root_cause` — opmode's tools, with opmode's
 * schemas and its state machine (`extensions/opmode/bugfix.ts`), for a Claude
 * session in bugfix mode. A recorded root cause is what `hook pre-tool` reads
 * to unlock Edit/Write/MultiEdit/NotebookEdit.
 *
 * One difference from pi, by construction: the protocol exists only while the
 * session IS in bugfix mode (the episode is discarded the moment control.json
 * leaves it — see claude/bugfix.ts), so outside bugfix mode both tools say so
 * instead of recording into an episode that does not exist.
 */

import { applyEvidence, applyRootCause, phaseOrder, type EvidenceParams } from "../../extensions/opmode/bugfix.ts";
import { CLAUDE_BUGFIX_TOOLS, currentEpisode, observedResults, writeEpisode } from "../bugfix.ts";
import type { Control } from "../state.ts";
import { readClaudeTranscript } from "../transcript.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

export const BUGFIX_TOOLS: ToolDefinition[] = [
	{
		name: "bugfix_evidence",
		description:
			`Bind a bugfix phase to a completed tool result. The phases run in one order: ${phaseOrder(CLAUDE_BUGFIX_TOOLS)}. ` +
			"The tool-call id (a tool_use id) must name an actual result from this session; reproduction_key is required by the " +
			"reproduce and reverify phases, the same value on both, which is what binds one failing baseline to a distinct passing " +
			"re-verification. If you do not know the id, call with the phase alone — the refusal lists the recent result ids to pass.",
		inputSchema: {
			type: "object",
			properties: {
				phase: { type: "string", enum: ["reproduce", "hypothesize", "instrument", "confirm", "reverify", "blocked"] },
				tool_call_id: { type: "string" },
				reproduction_key: {
					type: "string",
					description:
						"Stable identifier for this reproduction. REQUIRED by the reproduce and reverify phases — optional only because " +
						"the phases between them do not take it — and the same value must be used for both.",
				},
				hypothesis: { type: "string" },
			},
			required: ["phase"],
			additionalProperties: false,
		},
	},
	{
		name: "bugfix_root_cause",
		description:
			"Record the root cause of the bug under investigation, with the evidence that establishes it. In bugfix mode this " +
			"unlocks file edits. Call it when you can explain the MECHANISM — which state, at which point, produces the observed " +
			"behaviour — not when you have found a line that changes the symptom.",
		inputSchema: {
			type: "object",
			properties: {
				summary: { type: "string", description: "The mechanism, in one or two sentences: what state, at what point, produces the behaviour." },
				evidence: {
					type: "string",
					description:
						"What established it — the failing repro, the measurement, the log line, the test that isolates it. " +
						"Name what you actually ran or observed, not what you reasoned.",
				},
			},
			required: ["summary", "evidence"],
			additionalProperties: false,
		},
	},
];

const NOT_BUGFIX = "The session is not in bugfix mode, so there is no bugfix investigation to record into.";

export function bugfixEvidence(stateDir: string, control: Control, transcriptPath: string | undefined, args: Record<string, unknown>): ToolResult {
	const episode = currentEpisode(stateDir, control);
	if (!episode) return { text: NOT_BUGFIX, isError: true };
	if (!transcriptPath) return { text: "bugfix_evidence: HIVE_CLAUDE_TRANSCRIPT is unset, so no tool result can be observed.", isError: true };
	const params: EvidenceParams = {
		phase: typeof args.phase === "string" ? args.phase : undefined,
		tool_call_id: typeof args.tool_call_id === "string" ? args.tool_call_id : undefined,
		reproduction_key: typeof args.reproduction_key === "string" ? args.reproduction_key : undefined,
		hypothesis: typeof args.hypothesis === "string" ? args.hypothesis : undefined,
	};
	const step = applyEvidence(episode.machine, observedResults(readClaudeTranscript(transcriptPath)), params, CLAUDE_BUGFIX_TOOLS);
	if (step.stage) writeEpisode(stateDir, { ...episode, machine: step.machine });
	// A refusal is an answer the model acts on (it lists the ids to bind), not
	// a tool failure — pi returns it as ordinary text too.
	return { text: step.text };
}

export function bugfixRootCause(stateDir: string, control: Control, args: Record<string, unknown>): ToolResult {
	const episode = currentEpisode(stateDir, control);
	if (!episode) return { text: NOT_BUGFIX, isError: true };
	const recorded = applyRootCause(control.opMode, episode.machine.phase, args, CLAUDE_BUGFIX_TOOLS);
	if (recorded.rootCause) writeEpisode(stateDir, { ...episode, rootCause: recorded.rootCause });
	return { text: recorded.text };
}
