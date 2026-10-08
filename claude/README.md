# hive-pi Claude adapter

Gives a Hive-launched **Claude Code** session the hive-pi features that run on
*other* model families or that pi injects: the opening brief, subagents on the
catalog ladder, You Should Know, the goal judge and drift probe, the status
recap, a cross-family advisor, op-mode enforcement, the worktree guard,
format-on-edit and `quality_gate`.

The Claude loop stays Anthropic. Every outside-model call is a `pi` child
(`pi --mode json -p --no-session …`) on the launch's **leased** pi store. The
adapter reuses hive-pi's own cores — nothing here is a second implementation;
where a core was entangled with pi's runtime it was lifted into a shared
module (`agenda/chain.ts`, `agenda/goal-tool.ts`, `subagent/delegate.ts`,
`gate/tool.ts`, `opmode/verdict.ts`, `harness/roles-core.ts`, …) that the pi
extension and this adapter both import.

Run by the plugin as `$HIVE_NODE $HIVE_PI_BASE/claude/cli.ts <command>` —
plain Node 24 with type stripping. Nothing here imports `@earendil-works/*` at
runtime; pi's frontmatter parser and conversation serializer are loaded from
the **pinned** pi install that `HIVE_PI_BIN` points into (`pi-runtime.ts`).

## Environment (from the launch)

| Variable | Use |
| --- | --- |
| `HIVE_URL`, `HIVE_TOKEN` | catalog (`GET /api/v1/agent-modes`) and session REST calls |
| `HIVE_SESSION_ID` | the session's **client run id**; the server uuid is resolved once via `GET /api/v1/agent-sessions/by-run/{id}` and cached (`session.json`). Unresolved → that settle's Hive posts are skipped (stderr) |
| `HIVE_PI_BIN` | the pinned `pi`; a `.js` entry runs under this node |
| `HIVE_PI_AGENT_DIR` | the leased pi store; set as `PI_CODING_AGENT_DIR` for every pi child, never mirrored. **Unset ⇒ every model-backed feature is off**: hooks print one stderr line and exit 0; MCP tools return `isError`. Never falls back to `~/.pi/agent` |
| `HIVE_PI_BASE` | this checkout (roles in `agents/`) |
| `HIVE_CLAUDE_CONFIG_DIR` | state lives in `$HIVE_CLAUDE_CONFIG_DIR/hive-pi/` (0700): `goal.json`, `agenda.json`, `ysk.json`, `recap.json`, `session.json`, locks |
| `HIVE_AUX_SPOOL` | append-only JSONL for the driver; unset ⇒ no records (said once on stderr) |
| `HIVE_CLAUDE_TRANSCRIPT` | the Claude JSONL, for MCP tools (hooks get `transcript_path`) |

`control.json` in the state dir is the **driver's** (read-only here):
`{"opMode":"build|plan|discuss|bugfix","ysk":{"enabled":bool,"recording":bool?,"recordingRevision":int?}}`.
Absent ⇒ defaults; present but invalid ⇒ the hook fails loudly (an unreadable
op mode is never read as `build`).

## Models

Chosen only by catalog key. "Configured" = the provider has an entry in the
leased `auth.json`. The catalog is cached in the state dir for its 5-minute
TTL (`catalog.json`): hooks are fresh processes, and a cold `/agent-modes`
has been measured at 90 s. Judges, drift, recap and YSK take the catalog's `low` mode
if leased, else the cheapest leased mode (`PI_AGENDA_EVALUATOR_MODEL` /
`PI_YOU_SHOULD_KNOW_MODEL` override). No resolvable model is reported — for
the goal it is a judge error on the goal (three pause it). Advisor:
`pickConfiguredAdvisor` with Claude as an unranked caller (strongest leased
mode; `PI_ADVISOR_MODEL` overrides). Subagents: `chooseWorkerModel` with
`requireExplicitModel` (an unpinned role takes the cheapest leased mode, never
pi's default; a bare model id never counts as configured). Every one-shot
passes `--model` and `--thinking` explicitly (`oneshot.ts` refuses otherwise),
takes its prompt on STDIN (never argv, which `/proc/<pid>/cmdline` exposes),
and runs with no extension discovery (`--no-extensions` + the worker allowlist)
so it never connects the lease's MCP servers: judge fast pass and drift/recap/YSK `off`;
the judge's confirming pass uses the evaluator mode's level, else `low`.

## Commands (stdin = Claude Code's hook JSON)

- **`hook pre-tool`** — in `plan`/`discuss`/`orchestrate` EVERY tool is
  classified: Edit/MultiEdit/Write/NotebookEdit/Bash and this server's tools
  under pi's names, other `mcp__*` tools by pi's MCP classifiers (reviewed
  read-only cards pass), Claude's read-only built-ins (Read, Grep, Glob, LS,
  WebFetch, WebSearch, TodoWrite, Task*, ExitPlanMode, AskUserQuestion) by
  name, anything else denied. **Plugin matcher needed:**
  `Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__.*` covers the mutating set and
  all MCP tools; a built-in outside the matcher is not seen (use `.*` to deny
  unknown built-ins too). Then the worktree guard (`decide`) on edited paths. Prints a `deny` or
  nothing — never `allow`/`ask`; any internal error (bad `control.json`,
  malformed input) is a `deny` with the cause, since Claude treats a failing
  PreToolUse hook as "proceed". Other Claude tools and MCP tools are not
  classified. **Bugfix**: Edit/Write/MultiEdit/NotebookEdit are denied with
  opmode's refusal until the episode records a root cause; Bash stays open,
  as in pi (the investigation is the work).
- **`hook post-tool`** — while a bugfix investigation is live, tags the
  result `[bugfix evidence id: <tool_use_id>]` (pi's evidence tag; Claude runs
  PostToolUse only for successful calls, so the plugin should match all tools);
  format-on-edit (`planFor` + `formatFile`) for
  Edit/MultiEdit/Write; prints `additionalContext` with pi's note when the
  file changed or the formatter failed; "not installed" said once per config.
- **`hook prompt`** — discuss/bugfix: the op mode's prompt as `additionalContext`
  (bugfix names the tools `mcp__hive-pi__bugfix_evidence` / `mcp__hive-pi__bugfix_root_cause`).
- **`hook stop`** (sync) — `walkChain` over repo gate (`.pi/harness.json`) →
  drift (every 5th settle with an active goal) → goal judge; the driver's
  turn-failure and hand-back guards first. At most one continuation:
  `{"decision":"block","reason":…}`. Budget 110 s: every model call's timeout
  is clamped to what is left (a clamped timeout is a judge error,
  fail-closed), the gate keeps 70 s back for the goal judge when it will run, is
  not started with under 15 s for it, and a check cut short by that cap (not
  by the repo's own `checkTimeoutMs`) is a skip — never "TIMED OUT", never
  charged; drift is skipped below 100 s left. Drift and the judge (and the
  evaluator lookup) are not even considered on a hand-back or a failed API
  turn (`isApiErrorMessage` → `stopReason: error`). The repo gate is not model-backed, so it runs even without
  `HIVE_PI_AGENT_DIR`. `stop_hook_active` is **not** a reason to stand down — a goal loop is
  a chain of such continuations; the persisted caps (goal iterations,
  no-progress/pending streaks, budget, three judge errors, gate
  `maxInjections`, drift realignments) bound it, and every charge is written
  before the block is printed.
- **`hook settle`** (async) — status recap (`mechanicalTaskState`, recap
  prompt on the evaluator, `POST /agent-sessions/{id}/activity` with
  `{phase, since, recap?}`), then You Should Know: assistant prose since a byte
  cursor, ≥30 s between scans (waits), ≤20 per session, the scanner prompt as
  `--append-system-prompt`, findings grounded (`groundNotes`) and uploaded by
  hive-remote's `YouShouldKnowFindingsTransport`. `control.ysk.enabled:false`
  stops it; `recording`+`recordingRevision` are applied as a remote policy
  (accepted only if not older than the server's).
- **`brief --cwd <dir> --prompt-file <file>`** — `{"brief":"<markdown>"}` or
  `{"brief":null,"reason":"…"}`; detect.ts suppression, per-lane walls,
  `compileBrief`. One usage record per lane.
- **`mcp`** — stdio MCP (protocol 2025-06-18, also 2025-03-26/2024-11-05):
  - `subagent` — pi's delegation (`delegate.ts`): single / parallel ≤8 (4
    concurrent) / chain; roles from `agents/` + the store's `agents/`; writer
    lock and worktree guard per worker; 50 KB/task cap. Project-local roles
    are refused (no trust UI); `schema` is not offered (typebox). **Op mode
    applies to workers**: discuss/plan/orchestrate refuse writer roles; bugfix
    refuses writers that do not carry `op_mode: bugfix` themselves.
    `background:true` returns at once with a line `hive-pi-job: <id>`; the
    worker runs detached from the request (aborted and awaited when the server
    exits) and on completion writes a `wake` with that `job` (plain text). A
    job cancelled by the server's own shutdown still writes its usage and a
    wake: "background job <id> was cancelled because the helper server
    restarted; delegate it again".
  - `advisor` — the transcript serialised by pi's `serializeConversation`,
    capped by `capTranscript` (400k), sent as an `@file`.
  - `goal_set {condition, replace?, budget?{tokens,hours}}`, `goal_status`,
    `goal_clear` — agenda's rules (`goalSetDecision`, `describeGoal`). The
    budget is SESSION-scoped: `/hive:goal clear` runs as the model, so a goal
    set after one was cleared, capped or out of budget revises it and keeps
    its spent iterations and tokens.
  - `quality_gate` — `gate/tool.ts` (agent-check / vendored gate / `hive check`).
  - `bugfix_evidence {phase, tool_call_id?, reproduction_key?, hypothesis?}`,
    `bugfix_root_cause {summary, evidence}` — opmode's protocol
    (`opmode/bugfix.ts`): reproduce → hypothesize → instrument → confirm →
    root cause (unlocks edits) → reverify. Results are observed from the
    transcript by `tool_use_id`, failed calls included. State is one episode in
    `bugfix.json`, discarded by any reader that finds control.json out of
    bugfix mode (the driver also deletes it whenever it writes a non-bugfix
    opMode, and owns that reset); outside bugfix both tools say there is nothing to record into.

## Spool records

One line each, one `write` (O_APPEND), < 4 KiB; integers for token counts,
`turns` and `ms`, `model` as `<provider>/<id>` (otherwise not written, said on
stderr):
`usage` (roles `goal-judge`, `drift`, `ysk`, `recap`, `brief`, `advisor`,
`subagent:<agent>`; a worker is summed per model with its call count),
`gate` (`goal`/`drift`: `passed|failed|timed_out|skipped`), `wake`.

## Processes

The adapter marks itself `HIVE_PI_HELPER_CHILD=1` (inherited by its pi
children only — not inferred from `HIVE_PI_AGENT_DIR`, which every process in
the launch has). Helper children spawn as process groups and are killed by
group on timeout or cancel (`hive-common/child-tree.ts`); a hook or `brief`
told to stop (SIGTERM/SIGINT/SIGHUP) kills every group it started. The MCP
server on SIGTERM/SIGINT, or when its parent dies (ppid polled every 5 s),
stops reading, aborts and awaits in-flight requests and background jobs, then
exits. **Residual:** SIGKILL cannot be caught — detached groups then outlive
their parent until they finish. `PI_CODING_AGENT_DIR` is only ever
`$HIVE_PI_AGENT_DIR`. Transcript reads ignore a half-written last line and
skip (with one stderr line) a corrupt one.

## Open gaps

- **MCP servers in pi children.** pi's built-in MCP connects every enabled
  server in `<agent dir>/mcp.json` when a child starts. Inside pi, one-shots
  and workers read a tmp mirror with no (or HTTP-only) servers; here the only
  agent dir Hive's node accepts is the lease itself, so children read its
  `mcp.json` as-is. The lease's `mcp.json` must be empty or HTTP-only, or every
  judge, scan and worker spawns the stdio servers it names.
- The recap POST carries no `completion_summary_seq`: hive-remote sends its
  OWN transcript-stream sequence number, and for a Claude session that
  numbering belongs to the driver's transcript upload — the adapter cannot
  derive it honestly. Its `idle` phase can land after a Stop-hook
  continuation has started; the next heartbeat corrects it.
- Worktree-guard advisory notes (allow-with-note) are not surfaced.
