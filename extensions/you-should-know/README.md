# You should know

An opt-in pi-native adaptation of Claude Code's
[`cc-plugin-you-should-know@builtin`](https://code.claude.com/docs/en/plugins/mods/overview#mods-built-into-claude-code).
Anthropic documents a side agent that surfaces overlooked information above the
prompt; its exact scanning implementation is not public in the linked source
list. This extension implements that idea, not undocumented plugin parity.

Enable in a **pi terminal session**:

```text
/you-should-know on
```

Off by default. `PI_YOU_SHOULD_KNOW=1` opts new terminal sessions in. The command's
setting is saved to the active session branch and restored on reload/resume.
Consent is bound to the session ID: fork/clone/import into a different session
uses the startup default, not inherited opt-in. No workstation settings files
are changed.

| Command | Effect |
| --- | --- |
| `/you-should-know` or `status` | Consent, scan budget, reported side-call tokens/cost and failures |
| `/you-should-know on` | Scan future assistant prose; does not backfill old output |
| `/you-should-know show` | All retained notes, with their exact source quotes |
| `/you-should-know dismiss` | Clear notes and cancel pending work; repeated quotes stay suppressed |
| `/you-should-know off` | Stop/cancel scans and hide the widget; retained notes remain available via `show` |

## What it catches

Buried missing-verification caveats, blockers, user actions and consequential
decisions. A tool-less side call to the **currently selected model**, using pi's
configured provider/auth, returns up to three short notes. Each must include an
exact quote present in the scanned excerpt. Routine progress, success summaries,
hypotheticals, quoted examples and resolved issues are excluded by the prompt.

The host's native above-editor widget shows the newest three notes; `show`
includes the evidence. It uses the host's neutral terminal text/wrapping (no
new palette, interactive controls or animation). At most ten notes and one hundred normalized source
quotes are retained. Quote matching suppresses repeats, not every possible
paraphrase. Notes are model interpretations of what the assistant said, **not
verified findings or instructions**. They are highlights of **earlier output**,
not a current blocker ledger; a later resolution does not automatically retract
an old note. Dismiss obsolete notes. Silence is not a clean bill of health.

## Boundaries and cost

- Only finalized assistant **text** is scanned. No thinking, user prompts, tool
  arguments/results, files, Claude transcripts or independent investigation.
- The excerpt keeps at most 16,000 characters of recent prose, explicitly marking
  an omitted beginning. New output is coalesced while a scan is running.
- First scan is debounced by one second, or scheduled when the agent settles.
  Subsequent starts are at least 30 seconds apart. There is one call at a time,
  a 60-second hard deadline, 2,048 answer tokens, and **20 attempted scans per
  active session branch**. Failures count; toggling off/on does not reset the
  budget. Fork/tree navigation restores the destination branch's state.
- Explicitly opting in sends excerpts to your selected model's provider and
  consumes that account's quota. No separate analytics or telemetry is added.
  `/you-should-know status` reports completed calls' provider-reported usage, separately from
  pi's main-session totals; canceled calls may still incur provider charges.
- Event handlers do not await a model. A detached timer performs the scan; it
  does not delay tools, auto-continue the agent or change its context. No tools,
  messages, system-prompt changes or provider-request hooks are registered.
- Session entries contain consent, budget, notes, quotes and usage counters, not
  full excerpts. They do not enter LLM context. Existing session export/telemetry
  retains its own behavior and consent policy.
- Off/dismiss/session replacement/tree navigation cancel queued and in-flight
  work; generation checks discard late results. Shutdown clears the UI/timers.
  If a provider ignores cancellation, the detached waiter still times out, but
  further calls remain blocked until that abandoned request settles. This avoids
  overlapping billable requests even across off/on and session changes.
  Provider errors and malformed/unquoted verdicts visibly mark a scan failed,
  without automatic retries or exposing provider error text in the terminal.
- Inert in delegated workers, RPC, print and JSON modes. This initial version is
  terminal-only; it does not add a Hive web workspace attention panel.

## Verification

`test/you-should-know.test.ts` tests quote grounding/control-character validation,
opt-in, headless/worker exclusion, nonblocking completion, coalescing, deadlines,
budget/cadence, branch restore, deduplication, late-result cancellation and the
real provider-call shape. Native `Text` rendering is checked at narrow/wide
widths. `node test/you-should-know-smoke.mjs` drives the real pi terminal through
on → synthetic assistant output → note/quote → dismiss → off, using a local
fixture provider and temporary agent directory (requires Python 3 + a POSIX PTY).
For an opt-in **live-provider** relevance sanity check using four synthetic
examples (routine chatter, a buried caveat, a resolved caveat and a quoted
example):

```sh
PI_YOU_SHOULD_KNOW_EVAL=1 node --experimental-strip-types test/you-should-know-eval.mjs
```

This consumes your configured provider's quota. It reads the selected model from
`$PI_CODING_AGENT_DIR/settings.json` (defaults to `~/.pi/agent`); use
`YSK_EVAL_PROVIDER` and `YSK_EVAL_MODEL` to override. It is not run by CI.
Model relevance is heuristic: neither scripted tests nor four live samples claim
that every model will classify every caveat correctly.
