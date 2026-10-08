/**
 * Bugfix mode for a Claude session: opmode's evidence protocol
 * (`extensions/opmode/bugfix.ts`), persisted per bugfix EPISODE.
 *
 * pi keeps the protocol in the opmode extension's closure and resets it when
 * the mode is entered or left. Here every hook and tool call is its own
 * process, so the protocol lives in `$HIVE_CLAUDE_CONFIG_DIR/hive-pi/bugfix.json`
 * under an episode id, and the reset is the same rule read from the driver's
 * control.json: any reader that finds the session OUT of bugfix mode discards
 * the file. A root cause therefore never carries into a later investigation —
 * an unlocked gate for a bug nobody diagnosed is the failure pi's reset exists
 * to prevent.
 *
 * Evidence is observed from the session transcript: every tool result Claude
 * recorded, keyed by its `tool_use_id`, classified by opmode's own `observe`.
 * (pi observes its tool_result events; a Claude transcript carries the same
 * facts, failed calls included — which a PostToolUse hook would never see.)
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	INITIAL_EVIDENCE,
	observeToolResult,
	type BugfixToolNames,
	type EvidenceMachine,
	type ObservedResult,
	type ProtocolState,
	type Reproduction,
	type RootCause,
} from "../extensions/opmode/bugfix.ts";
import type { Control } from "./state.ts";
import { readJson, writeJsonAtomic } from "./state.ts";
import type { PiEntry } from "./transcript.ts";

/** The MCP server is `hive-pi`, so Claude calls its tools `mcp__hive-pi__<name>`. */
export const CLAUDE_BUGFIX_TOOLS: BugfixToolNames = {
	evidence: "mcp__hive-pi__bugfix_evidence",
	rootCause: "mcp__hive-pi__bugfix_root_cause",
};

export interface BugfixEpisode {
	episode: string;
	machine: EvidenceMachine;
	rootCause: RootCause | null;
}

const PHASES: readonly ProtocolState[] = ["reproduce", "hypothesize", "instrument", "confirm", "fix", "done", "blocked"];

export function bugfixPath(stateDir: string): string {
	return join(stateDir, "bugfix.json");
}

function validEpisode(raw: unknown): BugfixEpisode {
	const doc = raw as { episode?: unknown; machine?: { phase?: unknown; reproduction?: unknown }; rootCause?: unknown } | undefined;
	if (!doc || typeof doc.episode !== "string" || !doc.machine || !PHASES.includes(doc.machine.phase as ProtocolState)) {
		throw new Error("bugfix.json is not a valid bugfix episode");
	}
	const repro = doc.machine.reproduction as Reproduction | null | undefined;
	if (repro !== null && repro !== undefined && (typeof repro.key !== "string" || typeof repro.failingCallID !== "string")) {
		throw new Error("bugfix.json carries an invalid reproduction");
	}
	const cause = doc.rootCause as RootCause | null | undefined;
	if (cause !== null && cause !== undefined && (typeof cause.summary !== "string" || typeof cause.evidence !== "string")) {
		throw new Error("bugfix.json carries an invalid root cause");
	}
	return { episode: doc.episode, machine: { phase: doc.machine.phase as ProtocolState, reproduction: repro ?? null }, rootCause: cause ?? null };
}

/**
 * The current episode while the session is in bugfix mode (a fresh one when
 * none is open), or null outside it — and outside it any leftover episode is
 * discarded. The fresh episode is not written until something is recorded.
 */
export function currentEpisode(stateDir: string, control: Control): BugfixEpisode | null {
	const path = bugfixPath(stateDir);
	if (control.opMode !== "bugfix") {
		if (existsSync(path)) unlinkSync(path);
		return null;
	}
	const raw = readJson(path);
	return raw === undefined ? { episode: randomUUID(), machine: INITIAL_EVIDENCE, rootCause: null } : validEpisode(raw);
}

export function writeEpisode(stateDir: string, episode: BugfixEpisode): void {
	writeJsonAtomic(bugfixPath(stateDir), episode);
}

/** Claude's tool names in pi's vocabulary, where `observe` keys a family on them. */
function piToolName(claudeName: string): string {
	return claudeName === "Bash" ? "bash" : claudeName;
}

/**
 * Every completed tool result in the transcript, as opmode observes it, keyed
 * by `tool_use_id`, oldest first. The protocol's own tools are not evidence.
 */
export function observedResults(entries: readonly PiEntry[]): Map<string, ObservedResult> {
	const results = new Map<string, ObservedResult>();
	for (const entry of entries) {
		const message = entry.message;
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		if (message.toolName === CLAUDE_BUGFIX_TOOLS.evidence || message.toolName === CLAUDE_BUGFIX_TOOLS.rootCause) continue;
		const texts = message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
		const { key, observed } = observeToolResult(piToolName(message.toolName), message.toolCallId, message.isError, texts);
		results.set(key, observed);
	}
	return results;
}
