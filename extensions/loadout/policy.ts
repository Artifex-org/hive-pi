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
 *   - loaded by exact name with the `loadout` extension's `load_tools`, whose
 *     system-prompt section lists the names. (`tool_search` ranks with BM25:
 *     measured, `artifact_read` loads `artifact_list` first.)
 *
 * Two kinds of tool must NOT be deferred, because deferring is not "hidden":
 *   - GATED tools, which their owner keeps inactive until consent. Their only
 *     gate is the active set, and a deferred tool is callable from codemode
 *     and loadable whether active or not — deferring `orchestrate` would let a
 *     script start a worker fleet without /ultracode.
 *   - tools the harness tells the model to call at a moment it cannot search
 *     first (a reply, a status update during execution).
 *
 * Mode tools are deferred and their mode activates them: bugfix's for the
 * mode, `plan_write` for as long as a plan exists.
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
	plan_ready: "plan approval; Hive build-mode sessions call it outside plan mode",
	plan_ask: "plan-mode questions; 600 characters",
	agmsg_send: "the harness says 'Reply with agmsg_send' when a message arrives",
	load_tools: "how the model loads every deferred tool by exact name",
};

/**
 * Registered `direct` and kept INACTIVE by their owner until the operator
 * consents (/ultracode, a self-paced /loop). Their gate is the active set, so
 * they must never be `deferred`. Not counted against the declared budget: by
 * default nobody declares them.
 */
export const GATED_TOOLS: Readonly<Record<string, string>> = {
	orchestrate: "agenda: /ultracode consent",
	worker_send: "agenda: /ultracode consent",
	orchestrate_result: "agenda: /ultracode consent",
	agenda_wake: "agenda: a self-paced /loop",
};

/**
 * Deferred, and activated by their mode when it starts. Listed so the
 * conformance test can tell a mode tool from one that was simply forgotten.
 */
export const MODE_TOOLS: Readonly<Record<string, string>> = {
	plan_write: "plan mode, and while a plan exists (14k-character schema; the largest single definition)",
	bugfix_evidence: "bugfix mode",
	bugfix_root_cause: "bugfix mode",
};

export function exposureFor(name: string): ToolExposure {
	return name in DIRECT_TOOLS || name in GATED_TOOLS ? "direct" : "deferred";
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
