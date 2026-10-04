/**
 * Which harness tools the model sees up front, and which it loads on demand.
 *
 * Every tool an extension registers is declared to the model on every request
 * unless it says otherwise. Measured 2026-10-04 on pi 1.0.2: 71 tools were
 * always declared, about 61k characters (~15k tokens) of definitions, half the
 * input of a request that only says "ok". Anthropic's guidance for large tool
 * sets is to keep a small hot set declared and let the model search for the
 * rest; pi 0.99 provides exactly that with `exposure: "deferred"` and its
 * built-in `tool_search`.
 *
 * This file is the ONE place that decides. Every registration site asks
 * `exposureFor(name)`, and `test/tool-capability.test.ts` fails when a site
 * does not, so a new tool cannot drift back to always-on by omission. The
 * default for a tool not listed here is `deferred`: being always-on costs every
 * request, so it has to be argued for, in this file's diff.
 *
 * A deferred tool is still:
 *   - callable from `codemode` scripts, active or not (pi's contract);
 *   - activated by naming it in a role's `tools:` list or `--tools`;
 *   - found by `tool_search` (the `loadout` extension lists the names in the
 *     system prompt, so the model searches for an exact name, not a guess).
 *
 * Mode tools (plan, bugfix) are deferred too: the mode activates them when it
 * starts. Outside the mode they would be dead weight on every request.
 */

import type { ToolExposure } from "@earendil-works/pi-coding-agent";

/**
 * Always declared. The reason names the 7-day call count across this
 * workstation's pi sessions (2026-09-27..10-04, 18.6k tool calls), or the
 * contract that needs the tool visible without a search.
 */
export const DIRECT_TOOLS: Readonly<Record<string, string>> = {
	// pi's built-ins, re-registered by pretty-tools for rendering.
	bash: "2994 calls",
	read: "2271 calls",
	edit: "1332 calls",
	grep: "1080 calls",
	write: "411 calls",
	find: "134 calls",
	ls: "70 calls",

	background_result: "720 calls",
	background_bash: "495 calls",
	read_symbol: "504 calls",
	kernel: "441 calls",
	papercut: "365 calls; the harness asks for it at the moment friction happens, a search would lose it",
	advisor: "328 calls; the task lifecycle calls it before and after substantive work",
	knowledge_search: "191 calls; the task lifecycle starts with a KB search",
	knowledge_get: "106 calls",
	subagent: "176 calls",
	TodoWrite: "148 calls",
	goal_set: "140 calls",
	hive_watch_run: "107 calls",
	compact_schedule: "103 calls",
	quality_gate: "84 calls; the task lifecycle's verify step",
	handoff: "60 calls; how a session ends cleanly",
	ask_user_question: "51 calls; asking must never depend on a search succeeding",
	report: "a worker's only channel back to its parent",
};

/**
 * Deferred, and activated by their mode when it starts. Listed so the
 * conformance test can tell a mode tool from one that was simply forgotten.
 */
export const MODE_TOOLS: Readonly<Record<string, string>> = {
	plan_write: "plan mode (14k-character schema; the largest single definition)",
	plan_ask: "plan mode",
	plan_ready: "plan mode",
	bugfix_evidence: "bugfix mode",
	bugfix_root_cause: "bugfix mode",
};

export function exposureFor(name: string): ToolExposure {
	return name in DIRECT_TOOLS ? "direct" : "deferred";
}

/**
 * The active set to restore when a mode ends.
 *
 * Restoring the snapshot alone drops every tool `tool_search` loaded during the
 * mode, so the model loses a tool it just found. Keep those, minus the mode's
 * own tools.
 */
export function restoredLoadout(before: readonly string[], current: readonly string[], modeTools: readonly string[]): string[] {
	const drop = new Set(modeTools.filter((name) => !before.includes(name)));
	return [...new Set([...before, ...current.filter((name) => !drop.has(name))])];
}
