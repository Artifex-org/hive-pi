/**
 * The answers to failures we have watched agents fail to answer (HIV-1976).
 *
 * ## Why a table of error signatures rather than a line in AGENTS.md
 *
 * Every entry here was learned the expensive way — by an agent hitting the
 * error, not knowing the next move, and either burning turns searching for one
 * or abandoning the task. Session `efb2830c` did all three in one hour: it
 * needed a pull request, searched Hive's MCP for `"create pull request"`, then
 * for `"pull"` with `limit: 50`, then fell back to `hive --help` — while `gh`,
 * the actual answer, had been reported unauthenticated by `readiness` at
 * session start forty turns earlier.
 *
 * That is the whole argument for putting the answer HERE. The instruction
 * existed; it was just nowhere near the moment of use. Stripe measured the same
 * thing and it is technique #4 in the house notes: situational rules belong in
 * the tool result, at the instant the decision is made. Errors work; warnings
 * and READMEs do not.
 *
 * ## Three rules this file will not bend
 *
 * 1. **Append, never replace.** The original error is evidence. A hint that
 *    swallowed it would leave the model reasoning about our paraphrase.
 * 2. **Silence when unsure.** No fuzzy matching, no "probably this". A wrong
 *    next move costs more than no next move — the same reasoning
 *    `devservices/pg.ts:startFailureHint` states for its own three signatures.
 * 3. **Every entry cites what produced it.** A table nobody can audit becomes
 *    folklore, and folklore is what goes stale silently. If you cannot name the
 *    session or the ticket, it does not go in.
 *
 * ## What does NOT belong here
 *
 * Anything a schema fixes. Half of the rejected calls that motivated this
 * ticket were `unexpected additional properties ["tail"]`-class errors on
 * proxied MCP tools, and the fix for those is promoting the tool to a direct
 * registration so the model can SEE the parameter (`mcp.json` `directTools`),
 * not a note telling it to look again.
 */

import { nativeMcpServer } from "../mcp-common/names.ts";
import { rankByAnyToken, type McpToolCorpus } from "../mcp-common/search.ts";

/**
 * What a hint may know about the session beyond the failing text.
 *
 * Everything here is READ-ONLY and ALREADY IN MEMORY — loaded once at
 * `session_start` by `index.ts`. A hint that went to disk would break the one
 * promise this extension makes about running inside the agent loop.
 */
export interface HintContext {
	/** The adapter's cached tool inventory; absent when it could not be read. */
	corpus?: McpToolCorpus | null;
	/** Injectable clock, so a staleness assertion is not time-dependent. */
	now?: number;
}

export interface ToolHint {
	/** Stable id, so a test can name the case and a reader can grep for it. */
	id: string;
	/** Tool names this applies to. Empty means any tool. */
	tools?: readonly string[];
	/** Also applies to any tool this accepts — for name families such as `mcp__*`. */
	toolMatch?: (toolName: string) => boolean;
	/** The signature, matched against the tool's OUTPUT (and its error text). */
	match: RegExp;
	/** What to do now. One or two sentences; it lands in the model's context. */
	hint: string;
	/**
	 * Sentences computed from THIS failure — candidate names, a stale server —
	 * appended after `hint`. Pure: it may read `ctx`, never the world. Returning
	 * null (nothing useful to add) leaves the static hint exactly as it was.
	 */
	amend?: (text: string, ctx: HintContext) => string | null;
	/** Where this came from, for the audit rule above. */
	evidence: string;
}

/** pi's own message for a call to a tool name nothing registered (pi-agent-core). */
export const UNKNOWN_TOOL = /Tool (\S+) not found/;

/**
 * Name the MCP tools a misspelt `mcp__<server>__<tool>` call probably meant.
 *
 * Native MCP registers each server tool by its exact name, so a guessed name —
 * often the old adapter form, `hive_get_run`, or a near miss — is simply not
 * found. The ranker runs over the LIVE registry (`ctx.corpus`, rebuilt from
 * `pi.getAllTools()` when the hint fires), scoped to the named server when the
 * guess names one.
 */
export function unknownMcpToolAmendment(text: string, ctx: HintContext): string | null {
	const matched = UNKNOWN_TOOL.exec(text);
	if (!matched) return null;
	const corpus = ctx.corpus;
	if (!corpus || corpus.tools.length === 0) return null;
	const guess = matched[1] ?? "";
	const server = nativeMcpServer(guess);
	const query = (server ? guess.slice(`mcp__${server}__`.length) : guess).replace(/_/g, " ");
	const pool = server && corpus.servers[server] ? corpus.tools.filter((t) => t.server === server) : corpus.tools;
	const ranked = rankByAnyToken(pool, query, 5);
	if (ranked.length === 0) return null;
	return `Closest registered MCP tools: ${ranked.map((r) => r.tool.qualifiedName).join(", ")}.`;
}

export const HINTS: readonly ToolHint[] = [
	{
		id: "gh-unauthenticated",
		tools: ["bash", "background_bash"],
		// `gh` says several different things depending on the subcommand; all of
		// them carry one of these two phrases.
		match: /gh auth login|not logged into any GitHub hosts|authentication token is invalid|gh: To use GitHub CLI/i,
		hint:
			"Do NOT re-authenticate yet — three different failures print this, and only one of them is a credential. " +
			"(1) The BINARY may not have run: on a mise-managed node `gh` on PATH is a shim that reinstalls before " +
			"exec'ing, which fails read-only (`mise ERROR … Read-only file system`); try `/usr/bin/gh` — it is " +
			"usually there and works. (2) `gh auth status` aggregates every saved profile: an unrelated stale profile can " +
			"make it fail while the active token works. Check active authentication with `gh api user --jq .login`; " +
			"`curl -sS -o /dev/null -w '%{http_code}' https://api.github.com` separately tests GitHub transport. " +
			"From a sandboxed agent that is normally 200, so `gh pr create` works from right here. (3) Only if `gh auth " +
			"token` fails for its own reasons is `gh auth login` the answer. And do not go " +
			"hunting for a Hive tool that opens pull requests: Hive's MCP is read-only about PRs " +
			"(`hive_get_pull`, `hive_list_pulls`); `gh pr create` is the only path.",
		evidence:
			"session efb2830c (Aurora, 2026-08-16): searched the Hive MCP twice for a create-PR tool, then ran `hive --help`, then stopped — its credential was valid, the sandbox could reach api.github.com (curl 200), and the real fault was the mise shim (HIV-1979)",
	},
	{
		id: "gh-attach-flag-unsupported",
		tools: ["bash", "background_bash"],
		// gh prints this when a flag the running version does not know is passed;
		// the `#alt` attach syntax is a 2.99 feature, and this node pins 2.98.
		match: /unknown flag: --attach/i,
		hint:
			"The `gh` running here is too old for `--attach` — that flag arrived in gh 2.99.0, and this node's " +
			"mise pins 2.98. `/usr/bin/gh` may be newer, so retry the exact command with `/usr/bin/gh` first " +
			"(`/usr/bin/gh --version` to check). If it is still below 2.99.0, do NOT keep retrying: post the PR or " +
			"issue WITHOUT images (drop the `--attach` flags, keep `--body-file`) and list the screenshot paths in " +
			"your final message so a human can attach them. The images are a nicety; a green PR is the goal.",
		evidence:
			"HIV-3240: `gh … --attach '<file>#<alt>'` is a gh 2.99.0 feature; this workstation's mise pins gh 2.98.0, so an agent that follows the pr-attachments nudge on the shim binary hits `unknown flag: --attach`",
	},
	{
		id: "mise-shim-readonly",
		tools: ["bash", "background_bash"],
		match: /mise ERROR Failed to install .*Read-only file system/i,
		hint:
			"That is the TOOL LAUNCHER failing, not the tool: `mise` tried to (re)install before exec'ing and the " +
			"sandbox is read-only. The binary is almost always already installed — run it directly instead. " +
			"`/usr/bin/<tool>` first; otherwise `mise which <tool>` on the host names the real path. Nothing about " +
			"your credentials, your network or the tool's own state can be concluded from this error.",
		evidence:
			"HIV-1979: every mise-managed tool (gh, pi, claude, codex) fails this way inside a launched agent, because the shim dirs precede /usr/bin on hive-agent's systemd PATH; it stalled session efb2830c for 49 turns",
	},
	{
		id: "hive-check-only-flag",
		tools: ["bash", "background_bash"],
		match: /flag provided but not defined: -only/i,
		hint:
			"`hive check` has no `--only` flag — it selects work with `--step <name>` (repeatable, and it pulls in " +
			"transitive deps), or `--full`. A bare `hive check` is refused on purpose. If an instruction told you to " +
			"pass `--only`, that instruction is stale: fix it where you read it.",
		evidence: "session efb2830c: Aurora guidance named `hive check --step lint --only=typescript`; the CLI rejects it",
	},
	{
		// THE REMOTE HALF, and it is a separate entry because the remedy is
		// different — listed FIRST because `matchHint` takes the first match and
		// a rejected push carries BOTH messages: the server echoes its own
		// "cannot lock ref … exists" above the rejection line, so the local entry
		// would otherwise answer a push with the local remedy (its test pins
		// this). An agent that took the advice above still has a local
		// branch to publish, and `git push origin HEAD:feature/tes-7787` is
		// refused by the SERVER with a message that shares no words with the
		// local one — no "cannot lock ref", no ref path, just a parenthesis.
		// 2026-08-17T19:07 is that, and it is blocking: the work was finished
		// and could not be published.
		id: "git-branch-ref-collision-remote",
		tools: ["bash", "background_bash"],
		match: /\(directory\/file conflict\)|\(directory file conflict\)/i,
		hint:
			"The REMOTE refuses this branch name for the same reason a local one would: something is already a " +
			"branch at a prefix of it (in Aurora, `feature`), and git cannot have both a ref and a directory of refs " +
			"at one path. Renaming your local branch is not enough — the name on the remote is what is rejected. " +
			"Push to a flat one instead: `git push -u origin HEAD:tes-NNNN-short-slug`, and open the PR from that. " +
			"If a PR already exists against the rejected name, it does not exist server-side; open a new one. The " +
			"Linear link comes from the ticket key in the branch name and the PR body, never from the prefix.",
		evidence:
			"2026-08-17T19:07 (blocking): `git push -u origin HEAD:feature/tes-7787` → `! [remote rejected] … (directory file conflict)`, after the local rename had already been made",
	},
	{
		id: "git-branch-ref-collision",
		tools: ["bash", "background_bash"],
		match: /cannot lock ref '[^']*': '[^']*' exists; cannot create/i,
		hint:
			"A git branch cannot be nested under a branch name that already exists — some repos have a real `feature` branch, " +
			"so Linear's suggested `feature/tes-NNNN` cannot be created verbatim there. Use a flat name " +
			"(`tes-NNNN-short-slug`); the Linear link is made by the ticket key in the branch name and the PR body, " +
			"not by the prefix.",
		evidence:
			"7 papercuts 2026-08-16/18 across Aurora and Borealis (`gwq add -b feature/tes-7728`, `git switch -c feature/tes-7731`, `git checkout -B feature/tes-7973`): Linear hands out the one branch name the repo cannot have",
	},
	{
		id: "git-index-lock",
		tools: ["bash", "background_bash"],
		match: /Unable to create '[^']*index\.lock': File exists/i,
		hint:
			"Answer these in order — the lock is the SECOND question, not the first. " +
			"(1) DID THE WORK LAND? A commit that timed out has usually finished: `git -C <dir> log -1 --stat` and " +
			"`git -C <dir> status --short`. Re-running a commit that already succeeded is how one change becomes two, " +
			"and concluding the work was lost is how it gets redone. " +
			"(2) IS ANYTHING HOLDING IT? `pgrep -af 'git |pre-commit|quality-gate'` — the hook's GRANDCHILDREN " +
			"outlive the kill, and they are what still holds the lock: one session found six live " +
			"`quality-gate --changed` shells after its commits were killed. Searching only for `git ` or " +
			"`pre-commit` reports 'no holder' while the lock is genuinely held, which is the one answer that " +
			"leads to deleting it under a live process and corrupting the index. A live hit means WAIT. " +
			"Anything else writing the same tree counts too — a concurrent `quality_gate` or `hive check` in that " +
			"worktree takes the same lock. " +
			"(3) ONLY with no live process is the lock stale: `rm -f <the path in the error>`, then re-read status " +
			"before retrying. Use the path git PRINTED, not `<dir>/.git/index.lock` — in a worktree (every Aurora, " +
			"hive and Borealis checkout is one) `.git` is a FILE pointing elsewhere, so that path does not exist and " +
			"checking it tells you nothing. `git -C <dir> rev-parse --git-dir` gives the real one. " +
			"(4) NEXT TIME: run the commit through `background_bash`. A foreground `bash` is killed at its timeout " +
			"while the hook is still going — Aurora's pre-commit runs the quality gate — and that kill is what " +
			"strands the lock in the first place.",
		evidence:
			"22 papercuts 2026-08-17/19 across Aurora and Borealis worktrees, five blocking. Six of them post-date the first version of this hint, and name the two things it got wrong: 2026-08-18T22:58 found six live `quality-gate --changed` shells holding the lock (invisible to a `git |pre-commit` pgrep), 2026-08-18T17:00 and 08-17T20:31 concluded 'no holder' against a lock that was really held, and 2026-08-19T00:37 reports \"the worktree's `.git` indirection made the first lock check ineffective\"",
	},
	{
		// srt's seccomp filter refuses socket(AF_UNIX) for every process in a
		// sandboxed launch. Two spellings, both anchored on a socket PATH so a TCP
		// bind refusal (`listen EPERM: … 0.0.0.0:80`) never matches: Node's
		// `listen EPERM: operation not permitted /tmp/x.sock` (and `connect EPERM
		// /x.sock`), and Go's `listen unix /tmp/x.sock: socket: operation not
		// permitted` (also `dial unix`).
		id: "unix-socket-refused",
		tools: ["bash", "background_bash"],
		match:
			/\b(?:listen|connect) EPERM(?:: operation not permitted)? \/[^\s'"]+|\b(?:listen|dial) unix(?:gram|packet)? \S+: (?:socket|bind|connect): operation not permitted/,
		hint:
			"In a sandboxed launch that is the SANDBOX, not your code (`readiness` shows it as `unix sockets` absent): " +
			"srt's seccomp filter refuses socket(AF_UNIX), so every unix-socket listen or connect fails with EPERM — and a test harness that does not surface the listen error just " +
			"times out instead. Do not debug it further locally and do not weaken the test: run those tests on the " +
			"fleet — `quality_gate` (it lists this repo's steps) or `hive check --step <step>` — and report them as not " +
			"run locally. TCP on 127.0.0.1 is unaffected.",
		evidence:
			"HIV-3802 A/B eval 2026-10-08: the pi arm's vitest unix-socket transport suite timed out 7×5s and the agent " +
			"isolated `listen EPERM: operation not permitted /tmp/hc-simple.sock` by hand; the Claude arm's `go test` failed " +
			"`listen unix /tmp/claude/…/capability.sock: socket: operation not permitted`",
	},
	{
		id: "bash-foreground-timeout",
		tools: ["bash"],
		match: /timed out after \d+ seconds/i,
		hint:
			"The command was KILLED at the ceiling; nothing here says whether it finished its work first. Do not " +
			"assume either way — check the effect (for a commit: `git log -1`; for a build: the artifact; for a test " +
			"run: the report) before retrying, because a retry that duplicates a completed side effect is worse than " +
			"the timeout. Then re-run it with `background_bash`, which has no such ceiling and takes a `cwd`. " +
			"A killed `git commit` in particular leaves `index.lock` behind and the next git command fails on it.",
		evidence:
			"5 commit timeouts in 24h (2026-08-17/18, 30s/60s/120s ceilings), each followed by an index.lock failure or an unclear commit state; one reported 'Aurora guidance says pre-commit is ~2s' against a 120s timeout",
	},
	{
		// Native MCP (HIV-3745) names a server tool `mcp__<server>__<tool>`. A
		// call by any other name — the adapter's `hive_get_run`, or a near miss —
		// fails with pi's bare "Tool X not found". The amendment names the live
		// registry's closest matches; the static half says how to look one up.
		id: "mcp-unknown-tool",
		toolMatch: (name) => name.startsWith("mcp__") || /^(hive|linear|asfam|freecad|filecloud|homectl)_/.test(name),
		match: UNKNOWN_TOOL,
		hint:
			"MCP tools are registered as `mcp__<server>__<tool>`; the flattened `hive_get_run` is not a tool name. " +
			"In build or bugfix mode, call the exact registered name — find it with `tool_search` or, inside `codemode`, " +
			"`searchTools(\"<words>\")` / `describeNamespace(\"mcp__<server>\")`. In plan, discuss or orchestrate mode " +
			"direct MCP calls are refused: use the gateway, `mcp({tool: \"hive_get_run\", args: {...}})`.",
		amend: unknownMcpToolAmendment,
		evidence:
			"HIV-3745: the adapter promoted tools as `<server>_<tool>`; native MCP registers `mcp__<server>__<tool>`, and role files, " +
			"skills and model habit still carry the old form",
	},
	{
		id: "codemode-model-only-search",
		tools: ["codemode"],
		match: /(?:^|\n)TypeError: tools\.tool_search does not exist\./,
		hint:
			"`tool_search` is model-only, not a member of `tools` in scripts. Use " +
			"`await searchTools(\"<words>\")`, then `await describeTool(\"<exact name>\")`; " +
			"searchTools is async, so await it before using array methods. " +
			"Earlier calls in this script may already have run: inspect their effects before retrying side effects.",
		evidence:
			"2026-10-01..08 frozen workstation transcript window: 167 tools.tool_search TypeErrors across 80 sessions; " +
			"reproduced against pi 1.0.2: native tool_search has model-only exposure and is absent from ALL_TOOLS",
	},
	{
		id: "mcp-schema-rejection",
		tools: ["codemode"],
		toolMatch: (name) => name.startsWith("mcp__"),
		match: /unexpected additional properties \[|missing properties: \[/i,
		hint:
			"That is a schema rejection from the server, not a transport failure: the parameter set is wrong. Read the " +
			"real schema first — `describeTool(\"mcp__<server>__<tool>\")` inside `codemode`, or the tool's own " +
			"declaration when it is direct — before retrying; retrying the same shape is the single most repeated " +
			"wasted call in this harness (one session sent an identical rejected `wait_for_run` six times).",
		evidence: "108 sessions / 7d: 292 rejected proxy calls, the top messages all this class",
	},
];

/** One matching hint for a tool result, or null. First match wins. */
export function matchHint(toolName: string, text: string, hints: readonly ToolHint[] = HINTS): ToolHint | null {
	if (!text) return null;
	for (const hint of hints) {
		const scoped = (hint.tools?.length ?? 0) > 0 || hint.toolMatch !== undefined;
		if (scoped && !(hint.tools?.includes(toolName) || hint.toolMatch?.(toolName))) continue;
		if (hint.match.test(text)) return hint;
	}
	return null;
}

/**
 * The line appended to a tool result. Prefixed so its origin is never a guess.
 *
 * `text` and `ctx` are optional so the static half stays callable — and
 * assertable — on its own. A hint with no `amend` renders identically either
 * way.
 */
export function renderHint(hint: ToolHint, text: string = "", ctx: HintContext = {}): string {
	const amendment = hint.amend?.(text, ctx) ?? null;
	return `\n\n[harness hint · ${hint.id}] ${hint.hint}${amendment ? ` ${amendment}` : ""}`;
}

/**
 * Cap on the text we scan.
 *
 * A tool result can be a 256KB build log, and every one of these signatures
 * appears in the last few lines of a failure — nothing is gained by regexing
 * the whole thing on every tool call, and a `tool_result` handler runs inside
 * the agent loop, which pi awaits serially.
 */
export const SCAN_TAIL_BYTES = 4096;

export function scanTail(text: string, maxBytes: number = SCAN_TAIL_BYTES): string {
	if (text.length <= maxBytes) return text;
	return text.slice(text.length - maxBytes);
}
