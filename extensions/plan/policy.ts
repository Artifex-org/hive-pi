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

export function classifyCommand(command: string): PlanToolVerdict {
	const blocked = findBlockedSegment(command);
	if (blocked === undefined) return { allowed: true };
	return {
		allowed: false,
		reason:
			`Plan mode allows only read-only shell commands, and this one is not on the list:\n  ${blocked}\n` +
			`Redirects, subshells, backgrounding, command substitution and variable assignment are refused outright.`,
	};
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
