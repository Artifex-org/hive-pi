import { readOnlyMcpTools } from "../profile-common/profile.ts";
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
 * allowed one at a time, by exact name, from the house profile — see below.
 */
const READ_ONLY_PREFIXES = [
	"plan_", // this extension's own tools
	"tasks_",
	"todo",
];

/** Individually allowed non-builtin tools, by exact name. */
const READ_ONLY_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"subagent", // read-only roles are enforced by the role, not here
	"advisor", // one plain completion: no tools, no session, no recursion
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

export type PlanToolVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * The small MCP/card surface discussion mode may use without becoming a way to
 * mutate a live system. Keep this explicit: MCP tool names are not sufficient
 * evidence of safety, and plan mode deliberately does not inherit this list.
 */
const DISCUSSION_READ_ONLY_TOOLS = new Set([
	"render_chart",
	"knowledge_search",
	"knowledge_grep",
	"knowledge_get",
	"knowledge_multi_get",
	"knowledge_collections",
	"hive_get_task_logs",
	"hive_wait_for_run",
	"hive_get_run",
	"hive_get_pull",
	"hive_explain_failure",
]);

/**
 * Live cards whose server contracts are read-only monitoring queries.
 *
 * EXACT NAMES, from the house profile, never a server prefix. The list is an
 * assertion that somebody read that tool's implementation; a prefix would
 * silently extend the claim to every tool the server grows afterwards, which is
 * precisely the review this list stands in for. MCP servers in practice do not
 * publish read-only annotations the harness could consume instead.
 *
 * Empty with no profile: nothing is pre-approved, and plan mode asks. That is
 * the conservative direction, and the only safe default for a server this
 * harness knows nothing about.
 */
// A function, not a module-level constant, so the value is not pinned at IMPORT
// — which on a machine being provisioned would be whatever existed before the
// profile was linked in. `houseProfile()` caches on first read, so this is still
// resolved once per process, not once per call; what it buys is that the first
// read happens when the gate is first consulted rather than when some unrelated
// extension imported this module.
const discussionReadOnlyMcpTools = () => readOnlyMcpTools();

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

export function classifyTool(name: string): PlanToolVerdict {
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

/**
 * Discussion shares plan's read-only base but may inspect live state through
 * cards. `mcpScript` remains denied because arbitrary JavaScript can call a
 * mutating MCP tool; the single-call gateway is admitted only for discovery or
 * the named read-only Borealis cards above.
 */
export function classifyDiscussionTool(name: string, input: unknown): PlanToolVerdict {
	const base = classifyTool(name);
	if (base.allowed || DISCUSSION_READ_ONLY_TOOLS.has(name)) return { allowed: true };
	// Same both-envelopes rule as orchestrate below: a promoted MCP tool arrives
	// under its own name, and a read-only card is read-only either way round.
	if (discussionReadOnlyMcpTools().has(name)) return { allowed: true };
	if (name !== "mcp") return base;
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { allowed: false, reason: "Discussion mode requires a structured MCP request." };
	}

	const params = input as { tool?: unknown; action?: unknown };
	// Match the adapter's dispatch order: action wins over tool. Otherwise an
	// auth action could smuggle past the card allowlist by naming a safe tool.
	if (params.action !== undefined) {
		return params.action === "ui-messages"
			? { allowed: true }
			: {
					allowed: false,
					reason: "Discussion mode permits MCP discovery and UI messages, not authentication actions.",
				};
	}
	if (typeof params.tool === "string") {
		return discussionReadOnlyMcpTools().has(params.tool)
			? { allowed: true }
			: {
					allowed: false,
					reason:
						`Discussion mode permits only its read-only MCP cards; \`${params.tool}\` is not one of them. ` +
						"Switch to build mode for a mutating or unreviewed MCP call.",
				};
	}
	const keys = Object.keys(params);
	return keys.every((key) => MCP_DISCOVERY_KEYS.has(key))
		? { allowed: true }
		: { allowed: false, reason: "Discussion mode permits only MCP discovery or reviewed read-only cards." };
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
// Alphabetical, and it includes the READ-ONLY ticket tools on purpose.
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
// ticket-shaped": watch_ticket registers a subscription, so it stays out.
const ORCHESTRATE_MCP_TOOLS = new Set([
	"hive_add_teammate",
	"hive_approve_plan",
	"hive_assign_teammate_squad",
	"hive_cancel_agent_launch",
	"hive_cancel_run",
	"hive_claim_ticket",
	"hive_comment_ticket",
	"hive_create_squad",
	"hive_create_team",
	"hive_delete_squad",
	"hive_diagnose_agent_session",
	"hive_end_agent_session",
	"hive_explain_failure",
	"hive_find_related_work",
	"hive_force_kill_agent_session",
	"hive_get_board",
	"hive_get_occupancy",
	"hive_get_pull",
	"hive_get_run",
	"hive_get_task_logs",
	"hive_get_ticket",
	"hive_get_work_context",
	"hive_launch_teammate",
	"hive_list_agent_launches",
	"hive_list_agent_sessions",
	"hive_list_pulls",
	"hive_list_run_completions",
	"hive_list_teams",
	"hive_list_teammates",
	"hive_message_teammate",
	"hive_my_tickets",
	"hive_move_ticket_state",
	"hive_offload_to_factory",
	"hive_post_team_note",
	"hive_read_inbox",
	"hive_read_team_notes",
	"hive_recap_session",
	"hive_remove_teammate",
	"hive_rename_squad",
	"hive_retry_run",
	"hive_search_tickets",
	"hive_steer_agent",
	"hive_wait_for_run",
	"hive_whoami",
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
	if (["background_bash", "mcpScript", "orchestrate", "orchestrate_result", "subagent", "worker_send"].includes(name)) {
		return {
			allowed: false,
			reason: `\`${name}\` can execute hidden implementation work. Orchestrate mode requires visible Hive teammates or Factory runs.`,
		};
	}
	// The SAME allowlist answers both calling conventions.
	//
	// An MCP tool reaches the model two ways: wrapped, as `mcp {tool: "x"}`, and
	// DIRECT, as a tool literally named `x` — the adapter promotes them, so both
	// are live in one session. Consulting ORCHESTRATE_MCP_TOOLS only inside the
	// `mcp` branch made the wrapper the sole permitted route, which is a
	// distinction the allowlist never meant to draw: it is a list of OPERATIONS,
	// not of envelopes.
	//
	// Measured 2026-09-04 on the first orchestrator launched after the posture
	// went live (session cb62a18c): `hive_message_teammate`, `hive_steer_agent`,
	// `hive_read_inbox`, `hive_launch_teammate`, `hive_post_team_note`,
	// `hive_end_agent_session` and `hive_list_teammates` were ALL refused
	// direct — every coordination verb the mode exists to permit — while each
	// was allowed through the wrapper. The lead filed it as
	// "refuses native `hive_message_teammate` ... while operating contract
	// requires messaging supervised workers" and fell back to durable notes,
	// which reach nobody until someone reads them.
	if (ORCHESTRATE_MCP_TOOLS.has(name)) return { allowed: true };
	if (name === "mcp") {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			return { allowed: false, reason: "Orchestrate mode requires a structured MCP request." };
		}
		const params = input as { tool?: unknown; action?: unknown };
		if (params.action !== undefined) {
			return params.action === "ui-messages"
				? { allowed: true }
				: { allowed: false, reason: "Orchestrate mode permits MCP discovery and UI messages, not authentication actions." };
		}
		if (typeof params.tool === "string") {
			return ORCHESTRATE_MCP_TOOLS.has(params.tool) || discussionReadOnlyMcpTools().has(params.tool)
				? { allowed: true }
				: {
						allowed: false,
						reason: `Orchestrate mode does not permit MCP tool \`${params.tool}\`; delegate implementation to a teammate or Factory run.`,
					};
		}
		const keys = Object.keys(params);
		return keys.every((key) => MCP_DISCOVERY_KEYS.has(key))
			? { allowed: true }
			: { allowed: false, reason: "Orchestrate mode permits only MCP discovery or reviewed coordination tools." };
	}

	const base = classifyDiscussionTool(name, input);
	if (base.allowed || ORCHESTRATE_TOOLS.has(name)) return { allowed: true };
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
	"shortlog", "config", "worktree",
]);

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

export function classifyCommand(command: string, posture = "Plan"): PlanToolVerdict {
	const blocked = findBlockedSegment(command);
	if (blocked === undefined) return { allowed: true };
	return {
		allowed: false,
		reason:
			`${posture} mode allows only read-only shell commands, and this one is not on the list:\n  ${blocked}\n` +
			`Redirects, subshells, backgrounding, command substitution and variable assignment are refused outright.` +
			envReadHint(blocked),
	};
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
	"rg", "seq", "stat", "tail", "true", "type", "uname", "uniq", "uptime",
	"wc", "which", "whoami",
]);

const ORCHESTRATE_GIT_READERS = new Set([
	"blame", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "merge-base",
	"rev-parse", "shortlog", "show", "status",
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
			if (safeGlobals && verb && ORCHESTRATE_GIT_READERS.has(verb) && !unsafeGitFlag) continue;
		}
		if (executable === "gh" || executable === "hive") {
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
	if (!last) return undefined;
	segments.push(last);
	return segments;
}

function isSafeSegment(segment: string): boolean {
	// `$(…)`, `${…}`, globs and `VAR=value` prefixes all defeat token inspection.
	if (hasExpansion(segment) || /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) return false;

	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return false;

	const command = tokens[0].toLowerCase();
	if (MUTATING_COMMANDS.has(command)) return false;

	const args = tokens.slice(1);
	if (!hasSafeArguments(command, args)) return false;
	if (READ_ONLY_COMMANDS.has(command)) return true;
	return isSafeStructured(command, args);
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

/** Flags that turn an otherwise-read-only command into a writer. */
function hasSafeArguments(command: string, args: string[]): boolean {
	const universallyForbidden = new Set(["-i", "--in-place", "--fix", "--write", "-delete", "--delete", "-o", "--output"]);
	if (args.some((arg) => universallyForbidden.has(arg))) return false;

	if (command === "sed" || command === "perl") {
		// `-i`, `--in-place=BAK`, and bundled short flags like `-ri`.
		if (args.some((arg) => arg.startsWith("--in-place") || (/^-[^-]/.test(arg) && arg.slice(1).includes("i")))) {
			return false;
		}
	}
	if (command === "awk" && args.some((arg) => arg.startsWith("-i") || arg.includes("inplace"))) return false;
	if (command === "find") {
		const writers = ["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
		if (args.some((arg) => writers.includes(arg))) return false;
	}
	if (command === "date" && args.some((arg) => arg === "-s" || arg.startsWith("--set"))) return false;
	if (command === "sort" && args.some((arg) => arg.startsWith("-o") || arg.startsWith("--output"))) return false;
	if (command === "tee") return false;
	return true;
}

/** Commands whose safety depends on the subcommand: `git`, `gh`. */
function isSafeStructured(command: string, args: string[]): boolean {
	if (command === "git") {
		// Skip global flags (`-C path`, `--no-pager`) to reach the verb.
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) {
			i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
		}
		const verb = args[i];
		if (!verb || !SAFE_GIT_SUBCOMMANDS.has(verb)) return false;
		// `git config --global x y` writes; only reads are allowed.
		if (verb === "config" && args.slice(i + 1).some((arg) => !arg.startsWith("-") && args.indexOf(arg) > i + 1)) {
			return false;
		}
		if (verb === "worktree" && args[i + 1] !== "list") return false;
		return true;
	}

	if (command === "gh") {
		const path = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ");
		return SAFE_GH_PATHS.includes(path);
	}

	if (command === "hive") {
		// Positional words only: `hive --json get 4928` and `hive get 4928
		// --project hive` must reach the same decision, and an invocation with no
		// verb at all (`hive`, `hive --help`) is not a read this policy approved.
		const words = args.filter((arg) => !arg.startsWith("-"));
		const verb = words[0];
		if (!verb) return false;
		// `hive linear get HIV-1` reads a ticket; `hive linear report` FILES one.
		// The nested verb decides, and the group itself is never safe on its own.
		if (verb === "linear") return words[1] === "get";
		return SAFE_HIVE_SUBCOMMANDS.has(verb);
	}

	return false;
}
