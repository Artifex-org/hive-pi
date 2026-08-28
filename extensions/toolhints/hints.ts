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

import { corpusStaleness, rankByAnyToken, type McpToolCorpus } from "../mcp-common/search.ts";

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

/**
 * The adapter's two miss messages, `proxy-modes.ts:528`.
 *
 * BOTH forms. The server suffix is emitted only when the search was scoped to
 * one server, and the first version of this pattern required it — so an
 * unscoped `mcp({search})`, which is how most searches are written, matched
 * nothing and got no hint at all.
 */
export const MCP_NO_MATCH = /No tools matching "([^"]*)"(?: in "([^"]+)")?/i;

/**
 * Name the tools the search should have found.
 *
 * Two different failures print that one sentence, and they need opposite
 * answers — so this says which one happened. If the named server's cache entry
 * is one the adapter has stopped accepting, the search never saw those tools
 * and no rewording will help; otherwise the query simply failed the coverage
 * gate and the candidates below are what an OR ranking over the same corpus
 * returns. See `mcp-common/search.ts` for both mechanisms.
 */
export function mcpMissAmendment(text: string, ctx: HintContext): string | null {
	const matched = MCP_NO_MATCH.exec(text);
	if (!matched) return null;
	const query = matched[1] ?? "";
	const server = matched[2];
	const corpus = ctx.corpus;
	if (!corpus || corpus.tools.length === 0) return null;

	const sentences: string[] = [];
	const stale = server ? corpusStaleness(corpus, server, ctx.now ?? Date.now()) : null;
	if (server && stale) {
		sentences.push(
			`THE SERVER WAS NOT IN THE CORPUS: "${server}" is ${stale}, so the adapter dropped its tools at startup ` +
				`and this search could not have found them — that is not the same as the tool not existing, and ` +
				`rewording the query will not help. Run \`mcp({connect:"${server}"})\` and retry, or call the tool ` +
				`with the server named (\`mcp({server:"${server}", tool:"…"})\`), which connects first.`,
		);
	}

	const pool = server ? corpus.tools.filter((tool) => tool.server === server) : corpus.tools;
	const ranked = rankByAnyToken(pool, query);
	if (ranked.length > 0) {
		sentences.push(
			`Closest in the harness's copy of the tool cache for "${query}"${server ? ` in "${server}"` : ""}: ` +
				`${ranked.map((r) => r.tool.qualifiedName).join(", ")}. Call one with \`mcp({tool:"<name>"})\` — ` +
				`the proxy resolves the PREFIXED name shown here, and \`mcp({server:"…", describe:"<name>"})\` reads ` +
				`its schema.`,
		);
	}
	return sentences.length > 0 ? sentences.join(" ") : null;
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
		// WHAT THIS HINT USED TO SAY WAS FALSE, and agents caught it: it claimed
		// the search "takes tool-NAME fragments, not a description of what you
		// want". `FIELD_WEIGHTS` in the adapter includes `description: 5`, and a
		// live probe over the real corpus proves it — `search("booster")` returns
		// `get_metering_usage`, whose NAME has no "booster". Two sessions (P0175,
		// P0556) noticed the contradiction with the adapter's own tool
		// description and burned turns on it. The real filter is a coverage gate,
		// which is a different problem with a different answer.
		id: "mcp-proxy-no-match",
		tools: ["mcp"],
		match: MCP_NO_MATCH,
		hint:
			"Do NOT conclude the tool does not exist. The proxy's search reads names AND descriptions, but it keeps a " +
			"row only when the tool's own words cover almost the whole query — every token of a one- or two-word " +
			"query, 60% of a longer one (`search-ranking.ts:82`) — so a phrase describing a capability scores zero " +
			"even when the tool is right there. Retry with the one or two most distinctive words rather than a " +
			"sentence, or list a server's tools with `mcp({server:\"<name>\"})`. " +
			"The tools this house uses most are registered DIRECTLY and need no search at all: `hive_wait_for_run`, " +
			"`hive_get_run`, `hive_get_task_logs`, `hive_get_pull`, `hive_explain_failure`, `hive_message_teammate`.",
		amend: mcpMissAmendment,
		evidence:
			"108 sessions / 7d: 697 discovery calls against 3,269 real ones; efb2830c spent 5 round trips finding `linear_list_issues`. " +
			"Eight papercuts (P0032, P0135, P0175, P0219, P0540, P0556, P0561, P0689) are the coverage gate; two (P0035 asfam `vpm_resync`, " +
			"P0246 sentry `search events`) are a server whose cache entry had aged past the 7d TTL — both queries score rank 1 once the corpus is present",
	},
	{
		id: "mcp-schema-rejection",
		tools: ["mcp"],
		match: /unexpected additional properties \[|missing properties: \[/i,
		hint:
			"That is a schema rejection from the server, not a transport failure: the parameter set is wrong. Read the " +
			"real schema with `mcp({server:\"<name>\", describe:\"<tool>\"})` before retrying — retrying the same shape " +
			"is the single most repeated wasted call in this harness (one session sent an identical rejected " +
			"`hive_wait_for_run` six times).",
		evidence: "108 sessions / 7d: 292 rejected proxy calls, the top messages all this class",
	},
];

/** One matching hint for a tool result, or null. First match wins. */
export function matchHint(toolName: string, text: string, hints: readonly ToolHint[] = HINTS): ToolHint | null {
	if (!text) return null;
	for (const hint of hints) {
		if (hint.tools && hint.tools.length > 0 && !hint.tools.includes(toolName)) continue;
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
