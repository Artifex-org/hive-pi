import { canonicalMcpToolName, nativeMcpToolName } from "../mcp-common/names.ts";
/**
 * What a session may do while a plan is being written.
 *
 * ADAPTED from `@narumitw/pi-plan-mode` (MIT, https://github.com/narumiruna/
 * pi-extensions), whose shell classifier is the best part of that package and
 * is reused here in substance: an allowlist of read-only commands, a fail-closed
 * segment splitter, and per-command argument checks for the flags that turn a
 * reader into a writer (`sed -i`, `find -exec`, `sort -o`, `date -s`).
 *
 * TWO DELIBERATE DIVERGENCES.
 *
 * 1. `setActiveTools` is advisory here, never the enforcement. pi force-activates
 *    every registered tool when it builds the session and AGAIN on `/reload`
 *    (`agent-session.js`), so a mode that gated only by narrowing the active set
 *    would silently reopen every write tool the first time a user typed
 *    `/reload` — configured, green, enforcing nothing. The enforcement is the
 *    `tool_call` deny hook, which pi consults on every call. We use both:
 *    `setActiveTools` to keep write tools out of the prompt so the model does
 *    not plan around them, `tool_call` to make it true.
 *
 * 2. Unknown tools are DENIED, not merely flagged for opt-in. This harness loads
 *    a large MCP surface (hive, linear, kubernetes, borealis, playwright…) where
 *    plenty of tools mutate production. Defaulting an unrecognized tool to
 *    "allowed with a warning" would put `kubectl_delete` one model mistake away
 *    from running inside a mode whose entire promise is that nothing happens.
 *    A read-only allowlist is the only defensible default at this blast radius.
 */

/** Built-in tools that read and nothing else. */
const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls", "glob", "list"]);

/** Built-in tools that mutate. Named explicitly so a deny reads clearly. */
const MUTATING_BUILTINS = new Set(["edit", "write", "multiedit", "notebook_edit", "apply_patch"]);

/**
 * Tools from other extensions that are safe in plan mode.
 *
 * Prefix matching, because a tool family is namespaced (`plan_approve`,
 * `tasks_list`) and the useful unit of trust is the family, not the individual
 * tool. Note what is NOT here: an MCP server prefix. A server's tools are
 * allowed one at a time, by exact reviewed name — see below.
 */
const READ_ONLY_PREFIXES = [
	"plan_", // this extension's own tools
	"tasks_",
	"todo",
];

/** Individually allowed non-builtin tools, by exact name. */
const READ_ONLY_TOOLS = new Set([
	// pi's native MCP gateways (HIV-3745). Safe in every read-only mode because
	// they are gateways, not actions: every call a codemode script makes runs
	// through the session's tool pipeline with `tool_call` hooks
	// (`agent-session.js` `_executeNestedToolCall` → `_beforeToolCall`), so the
	// mode classifies `tools.write(...)` inside a script exactly as it would a
	// direct `write`. `tool_search` only declares tools for the next call.
	"codemode",
	"tool_search",
	// Harness wrappers around the same reviewed Hive knowledge reads.
	"knowledge_search",
	"knowledge_grep",
	"knowledge_get",
	"knowledge_multi_get",
	"knowledge_collections",
	// sessionIdentity.ts stores only this session's kickoff metadata (also
	// synced to its own Hive identity by identitySync.ts), never work state.
	"session_context",
	"web_search",
	"web_fetch",
	"subagent", // read-only roles are enforced by the role, not here
	"advisor", // one plain completion: no tools, no session, no recursion
	"background_list", // reads session-owned job state; never starts or stops work
	"background_result", // reads retained output, including recovered results
	// Asking the user a question writes nothing — and plan mode is the mode that
	// most needs it. Denying it was the same defect HIV-1313 found with
	// `advisor`: an allowlist that omits a read-only tool does not merely
	// inconvenience the model, it makes the harness's own instructions
	// unfollowable. The grill stage (HIV-2080) *requires* rounds of this tool
	// before a declined plan may be re-presented, so without it the mode would
	// deny the one call the operator explicitly asked for.
	"ask_user_question",
	"TodoWrite",
	"TaskList",
	"TaskGet",
]);

export type PlanToolVerdict = { allowed: true; updatedInput?: Record<string, unknown> } | { allowed: false; reason: string };

/**
 * Shared, exact MCP reads for plan, discussion and orchestrate research.
 *
 * Each Hive name below was checked against its handler in internal/mcp/ at
 * hive 20267981ffa9b67e7e8a3582ff60a77c4aa46f31 (2026-10-09), including the
 * called read helpers. None changes tickets, claims, communications, documents,
 * scheduler configuration, runs or deployments. Knowledge reads record access
 * provenance/counters; pull reads may fill a read-through cache. Those are read
 * bookkeeping, not permission to write content or dispatch work.
 *
 * Linear's external handlers are not in Hive's tree: the three exact Linear
 * names were checked against their published retrieve/list contracts instead.
 * No server prefix or name heuristic, and no assumption about readOnlyHint.
 */
export const READ_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
	// Tickets: linearticket.go, related_work.go, work_context.go, linearboard.go.
	"hive_get_ticket",
	"hive_search_tickets",
	"hive_find_related_work",
	"hive_get_work_context",
	"hive_get_board",
	"hive_my_tickets",
	// Coordination snapshots: occupancy.go, communications_tools.go.
	"hive_get_occupancy",
	"hive_list_communications",
	"hive_get_communication",
	// Knowledge content/collection reads: knowledge.go (NOT knowledge_write.go).
	"hive_knowledge_search",
	"hive_knowledge_grep",
	"hive_knowledge_get",
	"hive_knowledge_multi_get",
	"hive_knowledge_collections",
	// Fleet snapshots/analytics: agentcapacity.go, observability.go, queues.go,
	// scheduler_settings.go, breadth.go and metrics.go.
	"hive_list_clusters",
	"hive_fleet_status",
	"hive_list_queues",
	"hive_get_scheduler_settings",
	"hive_get_topology",
	"hive_get_constraint_cost",
	"hive_get_queue_wait",
	"hive_get_step_durations",
	// Runs: tools.go, runtests.go, reads.go; explain_failure delegates to
	// internal/diagnose/explain.go, which only assembles diagnostic evidence.
	"hive_list_runs",
	"hive_get_run",
	"hive_get_run_tests",
	"hive_get_run_reports",
	"hive_get_task_logs",
	"hive_explain_failure",
	// Health/state: testpghealth.go (sampler snapshot), deploy.go, tools.go,
	// reads.go (GitHub GETs and Hive queries, never a merge/deploy).
	"hive_get_test_pg_health",
	"hive_get_deploy_status",
	"hive_get_readiness",
	"hive_list_projects",
	"hive_get_pull",
	"hive_list_pulls",
	"linear_get_issue",
	"linear_list_issues",
	"linear_list_comments",
]);

// Keep the existing discussion-only surface, without promoting supervision or
// generic profile grants into restricted modes. wait_for_run is a blocking
// supervision request, not a bounded research snapshot. Its old permission in
// discussion/orchestrate stays intact; plan reads get_run instead.
const DISCUSSION_READ_ONLY_MCP_TOOLS = new Set(["hive_wait_for_run"]);
function isExactMcpName(name: string, names: ReadonlySet<string>): boolean {
	const canonical = canonicalMcpToolName(name);
	if (!names.has(canonical)) return false;
	// Flattening loses the server/tool boundary: mcp__hive_get__run is NOT
	// mcp__hive__get_run. Canonical aliases are usable only inside a bound gateway.
	const separator = canonical.indexOf("_");
	return separator > 0 && (name === canonical || name === nativeMcpToolName(canonical.slice(0, separator), canonical.slice(separator + 1)));
}

const isReviewedMcpRead = (name: string) => isExactMcpName(name, READ_ONLY_MCP_TOOLS);

function directMcpVerdict(name: string): PlanToolVerdict {
	const canonical = canonicalMcpToolName(name);
	return {
		allowed: false,
		reason: `Direct MCP call \`${name}\` has no trusted raw server/tool identity. Use the bound gateway \`mcp({tool: "${canonical}"})\` instead.`,
	};
}

const MCP_DISCOVERY_KEYS = new Set([
	"connect",
	"describe",
	"instructions",
	"search",
	"regex",
	"includeSchemas",
	"limit",
	"offset",
	"server",
]);

export function classifyTool(name: string, input?: unknown): PlanToolVerdict {
	if (name === "mcp") return classifyMcpRequest(input, "Plan", isReviewedMcpRead);
	if (isReviewedMcpRead(name)) return directMcpVerdict(name);
	if (MUTATING_BUILTINS.has(name)) {
		return { allowed: false, reason: `\`${name}\` writes to disk. Plan mode is read-only.` };
	}
	if (READ_ONLY_BUILTINS.has(name)) return { allowed: true };
	if (READ_ONLY_TOOLS.has(name)) return { allowed: true };
	if (READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) return { allowed: true };
	if (name === "bash") return { allowed: true }; // the command itself is classified below
	return {
		allowed: false,
		reason:
			`\`${name}\` is not on plan mode's read-only allowlist. Plan mode denies unrecognized tools rather ` +
			`than assuming they are safe, because this session can reach production systems.`,
	};
}

/** Single-call MCP gateway, matching the adapter's dispatch order. */
function classifyMcpRequest(input: unknown, posture: string, permits: (name: string) => boolean): PlanToolVerdict {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { allowed: false, reason: `${posture} mode requires a structured MCP request.` };
	}
	const params = input as { tool?: unknown; action?: unknown; server?: unknown };
	// action wins over tool: an auth action must not smuggle past a safe name.
	if (params.action !== undefined) {
		return params.action === "ui-messages"
			? { allowed: true }
			: { allowed: false, reason: `${posture} mode permits MCP discovery and UI messages, not authentication actions.` };
	}
	if (params.tool !== undefined) {
		const tool = typeof params.tool === "string" ? params.tool : "";
		const canonical = canonicalMcpToolName(tool);
		if (tool && permits(tool)) {
			// Only fixed Hive/Linear inventories reach this branch. Profile grants
			// are gated: native sanitization cannot authenticate raw dispatch IDs.
			const server = canonical.slice(0, canonical.indexOf("_"));
			if (params.server !== undefined && params.server !== server) {
				return { allowed: false, reason: `${posture} mode requires the reviewed MCP tool's own server and an unambiguous identity.` };
			}
			// Bind implicit dispatch too: flattened hive_get_run could otherwise
			// select hive_get/run. Translate native spelling for every permitted
			// gateway operation, including discussion/orchestration-specific cards.
			return { allowed: true, updatedInput: { ...input, tool: canonical, server } };
		}
		return {
			allowed: false,
			reason: posture === "Orchestrate" ? orchestrateMcpRefusal(canonical) :
				`${posture} mode permits only reviewed read-only MCP tools; \`${String(params.tool)}\` is not one of them.`,
		};
	}
	return Object.keys(params).every((key) => MCP_DISCOVERY_KEYS.has(key))
		? { allowed: true }
		: { allowed: false, reason: `${posture} mode permits only MCP discovery or reviewed tools.` };
}

function isDiscussionMcpRead(name: string): boolean {
	const canonical = canonicalMcpToolName(name);
	if (READ_ONLY_MCP_TOOLS.has(canonical)) return isReviewedMcpRead(name);
	if (DISCUSSION_READ_ONLY_MCP_TOOLS.has(canonical)) return isExactMcpName(name, DISCUSSION_READ_ONLY_MCP_TOOLS);
	return false;
}

/** Discussion retains fixed cards and supervision reads, not profile grants. */
export function classifyDiscussionTool(name: string, input: unknown): PlanToolVerdict {
	if (name === "mcp") return classifyMcpRequest(input, "Discussion", isDiscussionMcpRead);
	const base = classifyTool(name, input);
	if (base.allowed || name === "render_chart") return { allowed: true };
	return isDiscussionMcpRead(name) ? directMcpVerdict(name) : base;
}

/** Direct tools whose whole contract is coordination or verification. */
const ORCHESTRATE_TOOLS = new Set([
	"TaskCreate",
	"TaskUpdate",
	"goal_set",
	"hive_watch_run",
	"knowledge_collections",
	"knowledge_get",
	"knowledge_grep",
	"knowledge_multi_get",
	"knowledge_search",
	"list_symbols",
	"list_workspace_catalog",
	"papercut",
	"quality_gate",
	"read_ref",
	"read_symbol",
	"readiness",
	"render_chart",
	"request_workspace",
	"session_grep",
	"workflow_write",
]);

/**
 * MCP operations reviewed as orchestration, never implementation.
 *
 * Exact adapter paths rather than a `hive_` prefix: Hive also exposes generic
 * trigger, deploy and secret mutations. A newly added MCP tool stays denied
 * until somebody reads its contract and adds it here deliberately.
 */
// Alphabetical mode-specific extras; research reads are inherited from the
// shared set above. Keep legacy supervision reads here, not in plan mode.
//
// The list permits reading one ticket (get_ticket, get_board) and even WRITING
// them (claim_ticket, comment_ticket, move_ticket_state), but until this fix it
// omitted search/preflight — so an orchestrator could CLAIM a ticket it had no
// sanctioned way to find, or to check was not already somebody else's. That is
// backwards for a mode whose entire job is vetting work before delegating it,
// and it cost one session three refusals inside sixty seconds: "Orchestrate
// mode refuses read-only hive_search_tickets ... backlog discovery is needed to
// assign workers", and "also refuses hive_get_work_context (read-only
// ticket/claim preflight), blocking full ticket vetting before delegation".
//
// The rule applied is "every READ-ONLY ticket tool is permitted", not "anything
// ticket-shaped". watch_ticket registers a subscription; it stayed out until
// the week of 2026-09-21, when leads were refused it while supervising a
// teammate's ticket. claim_ticket, a stronger write, was already permitted, and
// a watch is how a lead tracks that ticket without appearing as its worker.
//
// Second pass, 2026-09-10, from the papercut corpus (seven days, both
// developers): a coordination-only lead was refused, in this order of
// frequency, the project communication board (`hive_list_communications` ×4,
// `hive_reply_communication`), Linear reads (`linear_list_issues` at the
// mandatory inventory step), the read-only pipeline preview
// (`hive_evaluate_pipeline`, "documented as a DAG preview that starts no run"),
// and queue ordering (`hive_prioritize_run`, "a non-preemptive ordering
// operation required launching a low-tier worker and harvesting it"). Each
// addition below is one of those, read for what it mutates:
//
// - The communication board is the coordination surface by definition — the
//   house rules REQUIRE a lead to search it before diagnosing anything and to
//   reply with evidence. Reads, replies, encounters, claims and patches are all
//   statements about the project, never implementation.
// - `hive_evaluate_pipeline` renders a DAG and inserts no run.
// - `hive_prioritize_run` / `hive_set_run_priority` reorder the queue; they
//   dispatch nothing new.
// - The `linear_*` entries are the LIST/GET half of the Linear adapter; every
//   `save_*`/`create_*`/`delete_*` stays out, since an issue write is exactly
//   the kind of decision this mode wants made by a visible teammate.
// - The remaining `hive_get_*`/`hive_list_*` entries are pure reads a lead
//   needs to vet work (PR comments, origin state, run reports, review
//   rejections, the project goals it links work to).
//
// Third pass, 2026-09-21, from the week's papercuts (6 sessions refused a
// supervision call). Each name below was a real tool, read for what it does:
//
// - hive_answer_question unblocks a worker parked on plan_ask. diagnose names
//   it as the action; steer interrupt throws the question away.
// - hive_fleet_status is read-only coordination data (HIV-3435 named it).
// - hive_get_project_goal_work is the work list under the goals tool already
//   permitted.
// - hive_watch_ticket is the supervision subscription described above.
//
// Fourth pass, 2026-09-28..10-04, same method:
//
// - hive_list_clusters / hive_get_test_pg_health are fleet reads. The first
//   was refused three times while a lead read agent_lane capacity BEFORE a
//   launch — the vetting this mode exists to do.
// - hive_report_issue files a Hive product bug: a statement about the tool,
//   never a change to the code under supervision. Refusing it left a
//   controller that had watched a factory failure unable to report it.
// - linear_save_comment is the Linear twin of hive_comment_ticket, already
//   permitted. It is the one `save_*` admitted: a comment adds a statement to a
//   ticket and changes none of its state, owner or scope, whereas save_issue
//   (create/edit) and every delete stay a visible teammate's decision.
//
// Fifth pass, 2026-10-04, from the Hive agent/Factory papercut sweep: a root
// lead supervising its controlled verifier was refused
// `mcp__hive__read_agent_transcript` — "not on orchestrate mode's
// coordination allowlist" — while trying to read that worker's transcript.
// - hive_read_agent_transcript is the supervised-transcript read: a read-only
//   view of an owned/shared agent session's transcript, with the server (not
//   this policy) authorising whose sessions a caller may see. Admitted by
//   exact name only — not a `hive_get_*` prefix, not a generic run trigger.
//
// Names that are not tools (hive_list_pending_launches, hive_interrupt_agent,
// hive_list_team_notes) stay denied. The refusal names the real coordination
// tool instead of saying "delegate implementation".
const ORCHESTRATE_MCP_ALIASES: Record<string, string> = {
	hive_interrupt_agent: "hive_steer_agent",
	hive_list_pending_launches: "hive_list_agent_launches",
	hive_list_team_agents: "hive_list_teammates",
	hive_list_team_notes: "hive_read_team_notes",
	hive_list_linear_teams: "linear_list_teams",
};

export function orchestrateMcpRefusal(name: string): string {
	const alias = ORCHESTRATE_MCP_ALIASES[name];
	if (alias) {
		return `No MCP tool \`${name}\`. The coordination tool is \`${alias}\`.`;
	}
	return `Orchestrate mode does not permit MCP tool \`${name}\`; delegate implementation to a teammate or Factory run.`;
}

const ORCHESTRATE_MCP_TOOLS = new Set([
	"hive_add_teammate",
	"hive_answer_question",
	"hive_approve_plan",
	"hive_assign_teammate_squad",
	"hive_cancel_agent_launch",
	"hive_cancel_run",
	"hive_claim_communication",
	"hive_claim_ticket",
	"hive_comment_ticket",
	"hive_create_communication",
	"hive_create_squad",
	"hive_create_team",
	"hive_delete_squad",
	"hive_diagnose_agent_session",
	"hive_encounter_communication",
	"hive_end_agent_session",
	"hive_evaluate_pipeline",
	"hive_find_similar_failures",
	"hive_force_kill_agent_session",
	"hive_get_agent_command",
	"hive_get_agent_spend",
	"hive_get_agent_startup",
	"hive_get_factory_provider_limits",
	"hive_get_factory_tier_health",
	"hive_get_origin_pull",
	"hive_get_project_goal_work",
	"hive_get_project_goals",
	"hive_get_pull_comments",
	"hive_get_review_rejections",
	"hive_get_run_changes",
	"hive_launch_teammate",
	"hive_list_agent_launches",
	"hive_list_agent_sessions",
	"hive_list_credential_catalog",
	"hive_list_run_completions",
	"hive_list_teams",
	"hive_list_teammates",
	"hive_message_teammate",
	"hive_move_ticket_state",
	"hive_offload_to_factory",
	"hive_patch_communication",
	"hive_post_team_note",
	"hive_prioritize_run",
	"hive_read_agent_transcript",
	"hive_read_inbox",
	"hive_read_team_notes",
	"hive_recap_session",
	"hive_remove_teammate",
	"hive_rename_squad",
	"hive_reply_communication",
	"hive_report_issue",
	"hive_retry_run",
	"hive_set_run_priority",
	"hive_steer_agent",
	"hive_wait_for_run",
	"hive_watch_ticket",
	"hive_whoami",
	"linear_get_document",
	"linear_get_issue_status",
	"linear_get_milestone",
	"linear_get_project",
	"linear_get_team",
	"linear_get_user",
	"linear_list_cycles",
	"linear_list_documents",
	"linear_list_issue_labels",
	"linear_list_issue_statuses",
	"linear_list_milestones",
	"linear_list_projects",
	"linear_list_teams",
	"linear_list_users",
	"linear_save_comment",
	"linear_search_documentation",
]);

/**
 * What a coordination-only lead may call.
 *
 * The read-only base remains available for inspecting work. Mutations are an
 * exact list of team, Factory, ticket-state and verification operations. The
 * generic MCP script, generic run trigger and child-agent tools are absent on
 * purpose: each can perform implementation outside the reviewed team topology.
 */
export function classifyOrchestrateTool(name: string, input: unknown): PlanToolVerdict {
	const canonical = canonicalMcpToolName(name);
	if (["background_bash", "mcpScript", "orchestrate", "orchestrate_result", "subagent", "worker_send"].includes(name)) {
		return {
			allowed: false,
			reason: `\`${name}\` can execute hidden implementation work. Orchestrate mode requires visible Hive teammates or Factory runs.`,
		};
	}
	// Preserve coordination operations via the bound gateway, never direct
	// names whose registrations may capture a different raw dispatch target.
	if (isExactMcpName(name, ORCHESTRATE_MCP_TOOLS)) return directMcpVerdict(name);
	if (name === "mcp") {
		return classifyMcpRequest(input, "Orchestrate", (tool) => isExactMcpName(tool, ORCHESTRATE_MCP_TOOLS) || isDiscussionMcpRead(tool));
	}

	const base = classifyDiscussionTool(name, input);
	if (base.allowed || ORCHESTRATE_TOOLS.has(name)) return { allowed: true };
	if (isDiscussionMcpRead(name)) return base;
	if (ORCHESTRATE_MCP_ALIASES[canonical]) return { allowed: false, reason: orchestrateMcpRefusal(canonical) };
	return {
		allowed: false,
		reason:
			`\`${name}\` is not on orchestrate mode's coordination allowlist. ` +
			"Delegate implementation to a Hive teammate or Factory run instead.",
	};
}

/* -------------------------------------------------------------------------- */
/* Shell classification                                                        */
/* -------------------------------------------------------------------------- */

const MUTATING_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
	"tee", "truncate", "dd", "sudo", "su", "kill", "pkill", "killall", "reboot",
	"shutdown", "vim", "vi", "nano", "emacs", "code", "subl", "npm", "pnpm",
	"yarn", "pip", "uv", "cargo", "go", "make", "docker", "kubectl", "helm",
]);

const READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "rg", "find", "fd", "ls", "eza", "pwd", "echo",
	"printf", "wc", "sort", "uniq", "diff", "file", "stat", "du", "df", "tree",
	"which", "whereis", "type", "printenv", "uname", "whoami", "id", "date",
	"uptime", "ps", "jq", "yq", "bat", "sed", "awk", "cut", "basename", "dirname",
	"realpath", "readlink", "column", "nl", "tr", "comm", "join", "seq", "true",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "remote", "ls-files", "grep",
	"rev-parse", "blame", "describe", "merge-base", "ls-tree", "cat-file",
	"shortlog", "config", "worktree", "ls-remote", "stash",
]);

/**
 * `git stash` verbs that only read. `git stash` alone PUSHES, and pop/drop/
 * clear/apply rewrite the tree or the stash list — so, like `worktree`, the
 * verb is safe only with its listing sub-verb (papercut 2026-10-0x: a lead
 * refused `git stash list` while inventorying a worker's checkout).
 */
const SAFE_GIT_STASH_VERBS = new Set(["list", "show"]);

/** `git branch` flags that only shape a LISTING. Everything else may write. */
const GIT_BRANCH_READ_FLAGS = new Set([
	"--show-current", "--list", "-l", "-r", "--remotes", "-a", "--all", "-v", "-vv",
	"--verbose", "--color", "--no-color", "--column", "--no-column", "--merged",
	"--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format",
	"--omit-empty", "-i", "--ignore-case", "--abbrev", "--no-abbrev",
]);

/**
 * Flags that put `git branch` in list mode, where positionals are PATTERNS.
 * `--sort` and `--format` are NOT among them: they only shape a listing, and
 * with a positional `git branch --format=x newb` still CREATES newb (verified
 * on git 2.55).
 */
const GIT_BRANCH_LIST_MODE = new Set([
	"--list", "-l", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at",
]);

/**
 * Is this `git branch` invocation a read?
 *
 * The verb both lists and writes: `git branch x` CREATES x, and -d/-m/-c/-f/
 * --set-upstream-to change refs. It reads when every flag is a listing flag
 * and any positional word is a pattern — which git only takes it to be in list
 * mode (`--list` or a filter). With no positional it lists. `--show-current`
 * prints one name. Papercuts 262 and 877 were exactly these two reads.
 */
function isReadOnlyGitBranch(args: string[]): boolean {
	const flags = args.filter((arg) => arg.startsWith("-"));
	if (!flags.every((flag) => GIT_BRANCH_READ_FLAGS.has(flag.split("=")[0]))) return false;
	const positional = args.length - flags.length;
	if (positional === 0) return true;
	return flags.some((flag) => GIT_BRANCH_LIST_MODE.has(flag.split("=")[0]));
}

/** The verb-specific half of a git read, shared by every posture. */
function gitVerbArgsReadOnly(verb: string, rest: string[]): boolean {
	if (verb === "stash") return SAFE_GIT_STASH_VERBS.has(rest[0] ?? "");
	if (verb === "branch") return isReadOnlyGitBranch(rest);
	if (verb === "worktree") return rest[0] === "list";
	if (verb === "config") return isReadOnlyGitConfig(rest);
	if (verb === "remote") return isReadOnlyGitRemote(rest);
	return true;
}

/**
 * The git verb, past the global flags (`-C path` takes a value). Undefined when
 * there is none.
 */
function gitVerbOf(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
	return args[i];
}

/**
 * `git config` reads only in its explicit read forms. An ALLOWLIST of flags,
 * because the write forms are many and abbreviable (`--ed` is `--edit`), and
 * the old "a positional after the key" test was fooled by a value equal to the
 * key: `git config user.name user.name` WRITES (indexOf found the first copy).
 *
 *   git config <key>                       one positional: an implicit get
 *   git config --get|--get-all <key> [re]  explicit gets
 *   git config --get-regexp <re> [re]
 *   git config --list / -l
 *   git config get <key> / list            the 2.46+ subcommand spelling
 */
const GIT_CONFIG_READ_FLAGS = new Set([
	"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope",
	"--global", "--system", "--local", "--worktree", "-z", "--null", "--name-only", "--includes",
	"--no-includes", "--bool", "--int", "--path", "--expiry-date", "--all",
]);
const GIT_CONFIG_VALUED = ["--type", "--default", "--regexp", "--value", "--url"];

function isReadOnlyGitConfig(rest: string[]): boolean {
	let explicitGet = false;
	const positional: string[] = [];
	for (const arg of rest) {
		if (arg.startsWith("-")) {
			const name = arg.split("=")[0];
			if (GIT_CONFIG_READ_FLAGS.has(name)) {
				if (name.startsWith("--get") || name === "--list" || name === "-l") explicitGet = true;
				continue;
			}
			if (GIT_CONFIG_VALUED.includes(name) && arg.includes("=")) continue;
			return false;
		}
		positional.push(arg);
	}
	if (positional[0] === "get" || positional[0] === "list") return positional.length <= 3;
	// Since git 2.46 the first word may be a SUBCOMMAND (`edit`, `set`, `unset`,
	// `rename-section`, `remove-section`), and `git config edit` opens an editor.
	// A config KEY always contains a dot, so a dotless first word in the legacy
	// form is a subcommand we did not allow — refused rather than enumerated, so
	// a subcommand added later fails closed too.
	if (positional.length > 0 && !positional[0].includes(".")) return false;
	return explicitGet ? positional.length <= 2 : positional.length <= 1;
}

/**
 * `git remote` lists, and `show` / `get-url` read. add/remove/rename/set-url/
 * set-head/set-branches/prune change config or refs, and `update` FETCHES.
 */
function isReadOnlyGitRemote(rest: string[]): boolean {
	const words = rest.filter((arg) => !arg.startsWith("-"));
	if (!rest.every((arg) => !arg.startsWith("-") || arg === "-v" || arg === "--verbose" || arg === "-n" || arg === "--all" || arg === "--push")) return false;
	return words.length === 0 || words[0] === "show" || words[0] === "get-url";
}

/**
 * `tmux` verbs that only READ the server's state.
 *
 * A verb list, never the bare binary: the same command that prints a pane also
 * types into one. `send-keys`, `kill-*`, `new-*`, `respawn-*`, `run-shell`,
 * `if-shell`, `source-file` and `set-option` all reach arbitrary execution
 * inside somebody else's session, so tmux fails closed exactly the way `git`
 * and `hive` already do.
 *
 * MEASURED 2026-09-06..07: three orchestrator sessions were refused
 * `tmux -L hive-agent capture-pane -p` and `list-panes` while trying to find out
 * why a launched worker sat idle. `diagnose_agent_session` reported the worker
 * "attached/idle" from the RECORD, and the pane was the only place the actual
 * provider error was written — so the one posture whose job is supervising
 * workers could not read the workers. The lead filed it as blocking.
 */
const SAFE_TMUX_SUBCOMMANDS = new Set([
	"capture-pane", "display-message", "has-session", "info", "list-clients",
	"list-panes", "list-sessions", "list-windows", "ls", "lsp", "lsw",
	"show-options",
]);

/** tmux global flags that take a separate value, e.g. `-L hive-agent`. */
const TMUX_GLOBAL_VALUE_FLAGS = new Set(["-L", "-S", "-f"]);

/**
 * The verb, skipping server-selection globals in both spellings.
 *
 * `-L hive-agent` and `-Lhive-agent` are the same flag, and the attached form is
 * the one the agents actually type. Returns undefined when no verb follows,
 * which fails closed.
 */
function tmuxVerb(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		i += TMUX_GLOBAL_VALUE_FLAGS.has(args[i]) ? 2 : 1;
	}
	return args[i];
}

const SAFE_GH_PATHS = ["pr view", "pr list", "pr diff", "pr checks", "issue view", "issue list", "repo view", "run view", "run list"];

/**
 * `hive` read verbs. Diagnosing CI is the most common thing a plan needs to do,
 * and none of it was allowed.
 *
 * MEASURED on this workstation's transcripts, 2026-08-21..24: plan mode refused
 * 31 commands, and 14 of them were `hive get` / `hive explain` / `hive runs` /
 * `hive wait` — pure reads of a run's state and failure, refused only because
 * `hive` appeared in neither allowlist and `isSafeStructured` falls through to
 * `return false`. "Why is this PR red" is a planning question, so a policy that
 * cannot answer it pushes the work out of plan mode rather than keeping it safe.
 *
 * The list is verbs, not a prefix, because the same binary MUTATES: `hive
 * check` dispatches a run on the fleet, `retry`/`cancel`/`trigger`/`prioritize`
 * change queue state, and `worktrees reap` deletes checkouts. Those must keep
 * failing closed, so a verb earns its place here only if it cannot change
 * anything — which is why `watch` is present (it subscribes to a feed) and
 * `check` is not (it starts a run, and the fact that it is a "check" is exactly
 * the confusion this comment exists to prevent).
 */
const SAFE_HIVE_SUBCOMMANDS = new Set([
	"get", "runs", "logs", "tasklog", "explain", "watch", "wait", "insights", "papercuts", "open",
]);

/**
 * The offending segment, or `undefined` when every segment is safe.
 *
 * Returns the segment rather than a boolean so the deny message can name what
 * was blocked — a model told only "blocked" retries the same command.
 */
export function findBlockedSegment(command: string): string | undefined {
	const segments = splitSegments(command);
	// Fail closed: an unparseable command is not a safe command. Newlines,
	// backticks, redirects, subshells and background jobs all land here.
	if (!segments) return command.trim() || "(unparseable command)";
	return segments.find((segment) => !isSafeSegment(segment));
}

/**
 * The one refusal that has a sanctioned alternative, named on the refusal.
 *
 * `$VAR` is refused wholesale and correctly: the classifier cannot see through
 * an expansion, so `$X` may be any command at all. But reading an environment
 * variable is a legitimate, read-only thing an agent needs — the launch id in
 * particular, which the startup guidance tells it to look up — and the refusal
 * said only that expansions are refused, leaving the reader to conclude there
 * is no way to read one. There is: `printenv` is already on every posture's
 * reader allowlist and needs no expansion to do the job.
 *
 * Measured 2026-09-04, an orchestrator refused on
 * `printf '%s\n' "$HIVE_LAUNCH_ID"` and filed it as blocking "the documented
 * whoami launch_id lookup". `printenv HIVE_LAUNCH_ID` was allowed the whole
 * time.
 */
function envReadHint(blocked: string): string {
	const name = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(blocked)?.[1];
	return name ? `\nTo read one variable without an expansion, use:  printenv ${name}` : "";
}

/**
 * `git fetch` stays refused, and the refusal says why and what reads instead.
 *
 * It is not a pure read: it writes FETCH_HEAD and the remote-tracking refs,
 * and a `hive worktrees` checkout shares its git dir with every other worktree
 * of the repository — so a lead's fetch moves `origin/*` under its workers
 * mid-task (papercut 2026-10-03, a lead wanting current source). The remote's
 * state is readable without touching the local repository.
 */
function gitFetchHint(blocked: string): string {
	return /(^|\s)git(\s+-\S+(\s+\S+)?)*\s+fetch\b/.test(blocked)
		? "\ngit fetch writes refs shared by every worktree of this repository. Read the remote instead: " +
				"`git ls-remote origin <ref>` for a sha, `gh api repos/<o>/<r>/contents/<path>?ref=<sha>` for a file."
		: "";
}

export function classifyCommand(command: string, posture = "Plan"): PlanToolVerdict {
	const blocked = findBlockedSegment(command);
	if (blocked === undefined) return { allowed: true };
	return {
		allowed: false,
		reason:
			`${posture} mode allows only read-only shell commands, and this one is not on the list:\n  ${blocked}\n` +
			`Redirects, subshells, backgrounding, command substitution and variable assignment are refused outright.` +
			envReadHint(blocked) +
			gitFetchHint(blocked),
	};
}

/**
 * Plan mode's whole gate for one call: the tool, then a shell command's text.
 * The plan extension's `tool_call` hook and the Claude adapter's PreToolUse
 * hook both answer from this, so the composition exists once.
 */
export function planToolVerdict(name: string, input: unknown): PlanToolVerdict {
	const verdict = classifyTool(name, input);
	if (!verdict.allowed || name !== "bash") return verdict;
	const command = (input as { command?: unknown } | undefined)?.command;
	return classifyCommand(typeof command === "string" ? command : "");
}

// Orchestrate promises more than plan/discuss: the lead must NEVER implement.
// Keep its shell subset intentionally small. In particular, sed/awk programs
// can write from inside a quoted script (`sed 'w file'`, awk `> file`), which a
// token-level redirect check cannot see; git's branch/remote/config verbs and
// `--output` flags mutate despite looking like readers.
const ORCHESTRATE_SHELL_READERS = new Set([
	"basename", "bat", "cat", "column", "comm", "cut", "date", "df", "diff",
	"dirname", "du", "echo", "eza", "file", "find", "grep", "head", "id",
	"jq", "join", "ls", "nl", "printenv", "printf", "ps", "pwd", "readlink", "realpath",
	"rg", "seq", "sort", "stat", "tail", "true", "type", "uname", "uniq", "uptime",
	"wc", "which", "whoami",
]);

const ORCHESTRATE_GIT_READERS = new Set([
	"blame", "describe", "diff", "grep", "log", "ls-files", "ls-remote", "ls-tree",
	"merge-base", "rev-parse", "shortlog", "show", "status", "branch", "stash",
]);

export function classifyOrchestrateCommand(command: string): PlanToolVerdict {
	const base = classifyCommand(command, "Orchestrate");
	if (!base.allowed) return base;
	const segments = splitSegments(command);
	if (!segments) return { allowed: false, reason: "Orchestrate mode could not prove that shell command read-only." };
	for (const segment of segments) {
		const tokens = shellWords(segment);
		if (!tokens || tokens.length === 0) return { allowed: false, reason: "Orchestrate mode could not parse the shell command." };
		const executable = tokens[0].toLowerCase();
		const args = tokens.slice(1);
		if (ORCHESTRATE_SHELL_READERS.has(executable)) continue;
		if (executable === "git") {
			let i = 0;
			let safeGlobals = true;
			while (i < args.length && args[i].startsWith("-")) {
				if (args[i] === "-C" && args[i + 1]) i += 2;
				else if (args[i] === "--no-pager") i++;
				else { safeGlobals = false; break; }
			}
			const verb = args[i];
			const unsafeGitFlag = args.slice(i + 1).some((arg) =>
				arg === "-o" || arg.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv",
			);
			if (safeGlobals && verb && ORCHESTRATE_GIT_READERS.has(verb) && !unsafeGitFlag && gitVerbArgsReadOnly(verb, args.slice(i + 1))) continue;
		}
		if (executable === "gh" || executable === "hive" || executable === "tmux") {
			if (isSafeStructured(executable, args)) continue;
		}
		return {
			allowed: false,
			reason: `Orchestrate mode permits only its strict inspection shell subset; delegate this command:\n  ${segment}`,
		};
	}
	return { allowed: true };
}

/**
 * Split on `;`, `|`, `&&`, `||` outside quotes.
 *
 * Returns `undefined` — meaning "refuse the whole command" — for anything this
 * cannot reason about: redirects, subshells, backticks, newlines, backgrounding
 * and unbalanced quotes. Each of those is a way to write to disk that a
 * per-command allowlist would not see.
 */
function splitSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === ">" || ch === "<" || ch === "(" || ch === ")") return undefined;

		const next = trimmed[i + 1];
		if (ch === "&" && next !== "&") return undefined; // backgrounding

		const sepLength =
			ch === ";" || ch === "|" ? (next === ch ? 2 : 1) : ch === "&" && next === "&" ? 2 : 0;
		if (sepLength === 0) continue;

		const segment = trimmed.slice(start, i).trim();
		if (!segment) return undefined;
		segments.push(segment);
		i += sepLength - 1;
		start = i + 1;
	}

	if (quote || escaped) return undefined;
	const last = trimmed.slice(start).trim();
	if (!last) {
		// ONE trailing `;` terminates the last command and runs nothing more —
		// `date; gh pr view …;` is two reads. A trailing `|`, `&&`, `||` or `;;`
		// is an incomplete or malformed command and stays refused.
		const tail = trimmed.slice(0, start).trimEnd();
		if (segments.length > 0 && tail.endsWith(";") && !tail.endsWith(";;")) return segments;
		return undefined;
	}
	segments.push(last);
	return segments;
}

function isSafeSegment(segment: string): boolean {
	// `$(…)`, `${…}`, globs and `VAR=value` prefixes all defeat token inspection.
	//
	// The assignment check is anchored to the segment's START, which is the only
	// place the shell reads `NAME=value` as an assignment (an env prefix such as
	// `PAGER=… git log`, or a bare `X=1`). Scanning the whole text matched inside
	// QUOTED arguments too — jq's `length==2` read as an assignment to `length`,
	// refusing a pure read (papercut 2026-09-30T08:54).
	if (hasExpansion(segment) || hasBraceExpansion(segment) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) return false;

	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return false;

	const command = tokens[0].toLowerCase();
	if (MUTATING_COMMANDS.has(command)) return false;

	const args = tokens.slice(1);
	if (!hasSafeArguments(command, args)) return false;
	if (READ_ONLY_COMMANDS.has(command)) return true;
	return isSafeStructured(command, args);
}

/**
 * Does the UNQUOTED text contain a brace expansion — `{a,b}` or `{1..3}`?
 *
 * bash -c expands it BEFORE the command sees its argv, so every flag check
 * above can be walked around: `sort {-o,/tmp/x} f` is `sort -o /tmp/x f`
 * (verified, independent review of #104). Precise rather than "any `{`":
 * bash only expands a brace pair whose body holds an unquoted comma or a
 * `..` sequence, so `stash@{0}`, `HEAD@{1}`, `{}` and quoted jq filters stay
 * readable. A nested or unclosed brace fails closed.
 */
export function hasBraceExpansion(segment: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let depth = 0;
	let body = "";
	for (const ch of segment) {
		if (escaped) {
			escaped = false;
			if (depth > 0) body += "x";
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			if (depth > 0) body += "x";
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "{") {
			if (depth > 0) return true;
			depth = 1;
			body = "";
			continue;
		}
		if (ch === "}" && depth > 0) {
			depth = 0;
			if (body.includes(",") || body.includes("..")) return true;
			continue;
		}
		if (depth > 0) body += ch;
	}
	return depth > 0 && (body.includes(",") || body.includes(".."));
}

function hasExpansion(segment: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const ch of segment) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "$" && quote === '"') return true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "$") return true;
	}
	return false;
}

function shellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const ch of segment) {
		if (escaped) {
			word += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (/\s/.test(ch)) {
			if (word) words.push(word);
			word = "";
		} else word += ch;
	}

	if (quote || escaped) return undefined;
	if (word) words.push(word);
	return words;
}

/**
 * Does `arg` name one of `denied`, ABBREVIATIONS INCLUDED?
 *
 * GNU getopt_long and git's parse-options both accept any unique prefix of a
 * long option, so `sort --o=/tmp/x` is `sort --output=/tmp/x` and
 * `git grep --open='cmd'` is `--open-files-in-pager` (both verified under
 * `bash -c`, independent review of #104). A denylist matched on the full
 * spelling refuses only the one spelling nobody needs to type. So a long
 * option is refused when its name is the denied name or ANY prefix of it —
 * fail-closed even where the prefix would be ambiguous and getopt itself
 * would reject it. A different option that merely shares a first letter
 * (`--only-matching` vs `--output`) is not a prefix and still reads.
 */
export function longOptionHit(arg: string, denied: readonly string[]): boolean {
	if (!arg.startsWith("--") || arg.length <= 2) return false;
	const name = arg.slice(2).split("=")[0];
	if (!name) return false;
	return denied.some((d) => d === name || d.startsWith(name));
}

/** A short-flag cluster (`-uo`) containing any of `letters`. */
function shortClusterHas(arg: string, letters: string): boolean {
	if (!/^-[^-]/.test(arg)) return false;
	return [...arg.slice(1)].some((ch) => letters.includes(ch));
}

/** Long options that write a file or run a program, refused for EVERY reader. */
const UNIVERSAL_DENIED_LONG = ["output", "in-place", "write", "fix", "delete"];

/**
 * Per-reader long options that write or execute, matched with longOptionHit.
 *
 *   sort  --output writes; --compress-program runs a program on spill
 *   date  --set changes the clock
 *   git   --output writes; --open-files-in-pager, --ext-diff, --textconv,
 *         --upload-pack/--exec (ls-remote) and --exec-path/--config-env
 *         (globals) all name programs git runs
 *   rg    --pre runs a preprocessor per file
 *   bat   --pager runs a pager
 *   fd    --exec / --exec-batch run a command per match
 *   yq    --inplace rewrites the input
 *   file  --compile writes a .mgc next to the magic file
 */
const DENIED_LONG: Record<string, readonly string[]> = {
	sort: ["output", "compress-program"],
	date: ["set"],
	git: ["output", "open-files-in-pager", "ext-diff", "textconv", "upload-pack", "exec", "exec-path", "config-env"],
	rg: ["pre"],
	bat: ["pager"],
	fd: ["exec", "exec-batch"],
	yq: ["inplace"],
	file: ["compile"],
	awk: ["file", "exec", "source", "include", "load", "dump-variables", "profile", "pretty-print", "debug"],
	sed: ["file", "in-place"],
};

/**
 * Per-reader short flags that write or execute, as letters refused anywhere in
 * a short cluster (`-uo`, `-Pi`) — fail closed even where the letter would be
 * another flag's attached value.
 */
const DENIED_SHORT: Record<string, string> = {
	sort: "o",
	fd: "xX",
	yq: "i",
	file: "C",
	sed: "if",
	perl: "i",
};

/** Flags that turn an otherwise-read-only command into a writer. */
function hasSafeArguments(command: string, args: string[]): boolean {
	const universallyForbidden = new Set(["-i", "-delete", "-o"]);
	// grep/rg -i means ignore case, not in-place editing. Do not weaken -i
	// for writers such as sed/yq, or change quote/redirect/subshell handling.
	const caseInsensitiveReader = command === "grep" || command === "rg";
	if (args.some((arg) => (universallyForbidden.has(arg) && !(arg === "-i" && caseInsensitiveReader)) ||
		longOptionHit(arg, UNIVERSAL_DENIED_LONG))) return false;
	const deniedLong = DENIED_LONG[command];
	if (deniedLong && args.some((arg) => longOptionHit(arg, deniedLong))) return false;
	const deniedShort = DENIED_SHORT[command];
	if (deniedShort && args.some((arg) => shortClusterHas(arg, deniedShort))) return false;

	if (command === "awk" && !isReadOnlyAwk(args)) return false;
	if (command === "sed" && !isReadOnlySed(args)) return false;
	if (command === "find") {
		const writers = ["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
		if (args.some((arg) => writers.includes(arg))) return false;
	}
	if (command === "date" && args.includes("-s")) return false;
	if (command === "tee") return false;
	// `uniq IN OUT` writes OUT: one input operand at most. -f/-s/-w take a value.
	if (command === "uniq" && operands(args, new Set(["-f", "-s", "-w"])).length > 1) return false;
	// tmux chains commands with a `;` ARGUMENT (`\;` in the shell), which is how
	// `list-panes \; run-shell …` reached execution past a reader verb.
	if (command === "tmux" && args.some((arg) => arg.endsWith(";"))) return false;
	if (command === "git") {
		// `-O<pager>` on git grep runs it; `-u <prog>` on ls-remote is
		// --upload-pack (but on log/show `-u` is just "patch").
		if (args.some((arg) => arg.startsWith("-O"))) return false;
		if (gitVerbOf(args) === "ls-remote" && args.some((arg) => /^-u/.test(arg))) return false;
	}
	return true;
}

/** Operand (non-flag) arguments, skipping the value of each flag in `valued`. */
function operands(args: string[], valued: Set<string>): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return [...out, ...args.slice(i + 1)];
		if (valued.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") continue;
		out.push(arg);
	}
	return out;
}

/**
 * awk is read-only only while its PROGRAM is: `system()`, a `| cmd` pipe,
 * `getline` from a command, and `> file` redirection all live inside the
 * quoted program text. Flags are an allowlist (`-F`, `-v`) because every other
 * one names a program file or a dump target the classifier cannot read.
 */
function isReadOnlyAwk(args: string[]): boolean {
	let program: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-F" || arg === "-v") {
			i++;
			continue;
		}
		if (arg.startsWith("-F") || arg.startsWith("-v")) continue;
		if (arg.startsWith("-")) return false;
		program = arg;
		break;
	}
	if (program === undefined) return false;
	return !/system|getline|[|>]|\bclose\b|\bfflush\b/.test(program);
}

/**
 * sed is read-only only while its SCRIPT is: `w`/`W` write files, `e` and the
 * `s///e` flag execute, and none of that is visible to a flag check. The
 * script is parsed against a small grammar — addresses (line, `$`, `/re/`,
 * ranges, `!`) followed by `p d q = n N`, or `s` with only the g/p/i/I/m/M/digit
 * flags — and anything else is refused. Flags are an allowlist.
 */
function isReadOnlySed(args: string[]): boolean {
	const scripts: string[] = [];
	const files: string[] = [];
	const shortOk = /^-[nErzsu]+$/;
	const longOk = new Set(["--quiet", "--silent", "--regexp-extended", "--null-data", "--separate", "--unbuffered", "--posix", "--sandbox"]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-e" || arg === "--expression") {
			if (args[i + 1] === undefined) return false;
			scripts.push(args[++i]);
			continue;
		}
		if (arg.startsWith("--expression=")) {
			scripts.push(arg.slice("--expression=".length));
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			if (!shortOk.test(arg) && !longOk.has(arg)) return false;
			continue;
		}
		files.push(arg);
	}
	if (scripts.length === 0) {
		const first = files.shift();
		if (first === undefined) return false;
		scripts.push(first);
	}
	return scripts.every(sedScriptReadOnly);
}

export function sedScriptReadOnly(script: string): boolean {
	let i = 0;
	const n = script.length;
	const delimited = (d: string): boolean => {
		while (i < n) {
			if (script[i] === "\\") {
				i += 2;
				continue;
			}
			if (script[i] === d) {
				i++;
				return true;
			}
			if (script[i] === "\n") return false;
			i++;
		}
		return false;
	};
	const address = (): boolean => {
		if (/\d/.test(script[i] ?? "")) {
			while (i < n && /\d/.test(script[i])) i++;
			return true;
		}
		if (script[i] === "$") {
			i++;
			return true;
		}
		if (script[i] === "/") {
			i++;
			return delimited("/");
		}
		return true;
	};
	for (;;) {
		while (i < n && /[\s;]/.test(script[i])) i++;
		if (i >= n) return true;
		if (!address()) return false;
		if (script[i] === ",") {
			i++;
			if (!address()) return false;
		}
		while (i < n && /\s/.test(script[i])) i++;
		if (script[i] === "!") i++;
		const cmd = script[i++];
		if (cmd === undefined) return false;
		if ("pdq=nN".includes(cmd)) {
			while (cmd === "q" && i < n && /\d/.test(script[i])) i++;
		} else if (cmd === "s") {
			const d = script[i++];
			if (!d || d === "\\" || d === "\n" || /\s/.test(d)) return false;
			if (!delimited(d) || !delimited(d)) return false;
			while (i < n && /[gpiImM0-9]/.test(script[i])) i++;
		} else {
			return false;
		}
		if (i < n && !/[\s;]/.test(script[i])) return false;
	}
}

/**
 * `gh api` flags that make the call WRITE.
 *
 * `gh api <path>` is a GET and nothing else, which makes it the natural way to
 * read the parts of GitHub the `pr`/`issue` subcommands do not expose — an
 * issue's close/reopen event timeline, for one, which an orchestrator was
 * refused while trying to confirm a worker's claim. But the same command POSTs
 * the moment a field or a method appears, and `-f query=mutation{...}` reaches
 * every GraphQL mutation there is. So the path is not what decides it: the
 * presence of any of these flags is.
 */
const GH_API_WRITE_FLAGS = new Set([
	"-X", "--method", "-f", "--raw-field", "-F", "--field", "--input",
]);

function isReadOnlyGhApi(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		// An abbreviated spelling of a write flag is refused outright, even
		// `--meth GET`: fail closed rather than reason about the abbreviation.
		if (longOptionHit(arg, ["method", "field", "raw-field", "input"]) && !/^--(method|field|raw-field|input)(=|$)/.test(arg)) return false;
		if (GH_API_WRITE_FLAGS.has(arg)) {
			// `-X GET` is still a read; anything else, and any field, is not.
			if ((arg === "-X" || arg === "--method") && args[i + 1]?.toUpperCase() === "GET") {
				i++;
				continue;
			}
			return false;
		}
		// Attached spellings: `-XPOST`, `-fq=…`, `--method=PATCH`.
		if (/^-X./.test(arg)) {
			if (arg.slice(2).toUpperCase() !== "GET") return false;
			continue;
		}
		if (/^--method=/.test(arg)) {
			if (arg.slice("--method=".length).toUpperCase() !== "GET") return false;
			continue;
		}
		if (/^-[fF]./.test(arg) || arg.startsWith("--field=") || arg.startsWith("--raw-field=") || arg.startsWith("--input=")) {
			return false;
		}
	}
	return true;
}

/** Commands whose safety depends on the subcommand: `git`, `gh`, `tmux`. */
function isSafeStructured(command: string, args: string[]): boolean {
	if (command === "git") {
		// Skip global flags (`-C path`, `--no-pager`) to reach the verb.
		//
		// `-c key=value` is REFUSED, not skipped: it sets any config for this one
		// command, and `core.pager`, `diff.external` or `core.fsmonitor` name a
		// program git then runs — arbitrary execution behind an allowed reader.
		// The old blanket VAR= scan never saw it either (`core.pager=` has a dot).
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) {
			if (args[i] === "-c" || args[i].startsWith("--config-env") || args[i].startsWith("--exec-path")) return false;
			i += args[i] === "-C" ? 2 : 1;
		}
		const verb = args[i];
		if (!verb || !SAFE_GIT_SUBCOMMANDS.has(verb)) return false;
		return gitVerbArgsReadOnly(verb, args.slice(i + 1));
	}

	if (command === "gh") {
		const words = args.filter((arg) => !arg.startsWith("-"));
		if (words[0] === "api") return isReadOnlyGhApi(args);
		return SAFE_GH_PATHS.includes(words.slice(0, 2).join(" "));
	}

	if (command === "tmux") {
		const verb = tmuxVerb(args);
		return verb !== undefined && SAFE_TMUX_SUBCOMMANDS.has(verb);
	}

	if (command === "hive") {
		// Positional words only: `hive --json get 4928` and `hive get 4928
		// --project hive` must reach the same decision. A bare `hive` commits to
		// nothing and is not approved.
		const words = args.filter((arg) => !arg.startsWith("-"));
		const verb = words[0];
		// hive's OWN usage: `hive --help`, `-h` and `help` print it from the
		// top-level dispatch and return (cmd/hive/main.go) before any command
		// runs. A VERB's `--help` is not approved by extension: each verb parses
		// its own argv, and this policy cannot prove every one stops at the flag.
		if (!verb) return args.length > 0 && args.every((arg) => arg === "--help" || arg === "-h");
		if (verb === "help") return args.length === 1;
		// `hive linear get HIV-1` reads a ticket; `hive linear report` FILES one.
		// The nested verb decides, and the group itself is never safe on its own.
		if (verb === "linear") return words[1] === "get";
		return SAFE_HIVE_SUBCOMMANDS.has(verb);
	}

	return false;
}
