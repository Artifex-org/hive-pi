# hive-telemetry

Reports a pi session's **metrics** to hive under the developer's own API key, so
local agent spend can be analysed alongside factory spend (HIV-1050/HIV-1052).

Counters only. To also see the **transcript** in the Hive Agents workspace and
steer the session from a browser, enable its sibling
[`hive-remote`](../hive-remote/README.md) — a separate, larger opt-in. This
extension is the one that creates the session row and announces its id, so
`hive-remote` cannot attach anything until this is working.

## It is off until you turn it on

With no config this extension registers two commands and does nothing else: no
event handlers, no timers, no files, no network. Verified by running pi with the
extension present and confirming `~/.pi/agent/hive-telemetry/` is never created.

`$HIVE_TOKEN` existing in your environment is a **credential source, not a
consent signal** — that token is there for the `hive` CLI, and finding it must
not switch reporting on. A successful `/hive-login` is the single act of consent.

```
/hive-login          # prompts for a token, validates it against GET /api/v1/me, enables
/hive-telemetry      # prints the EXACT payload this session would POST right now
/hive-telemetry off  # stop reporting
/hive-telemetry logout
```

`/hive-login <token>` is **refused**: an argument would be written into the
session transcript *and* sent to the model on the next turn. Use the prompt, or
`/hive-login --from-env` to validate what the environment already provides.

## What is sent

Model and provider ids, token counts, cost, turns, tool **names** with call and
error counts, **a count per error kind from a fixed ten-value vocabulary**
(see the exception below), gate outcomes, session duration, the git remote as a
normalized `owner/repo`, agent + version, source.

## What is never sent

Prompts, completions, thinking blocks, tool arguments, tool results, file paths
or names, error message strings, commit SHAs or messages, **branch names** (a
branch like `feature/acme-corp-migration` names a client), cwd, hostname,
username, environment variables, session file paths.

There is no code path that reads `tool_execution_*.args`, and no config option
that could add one. `payload.ts` is the entire boundary — review that one file
and you have reviewed what leaves the machine. A directory that is not a git
repo becomes `local-<12 hex of the realpath>`: a stable bucket that groups the
same directory over time without revealing it.

### The one exception: `.result`, on failure, reduced to an enum

This file used to say `.result` was never read either. That is no longer true,
and saying so plainly matters more than keeping a tidier sentence.

When — and only when — a tool call **fails**, the `tool_execution_end` handler
passes the result to `classifyToolError`, which returns one of ten fixed
strings: `guard_blocked`, `not_found`, `nonzero_exit`, `bad_args`, `no_match`,
`timeout`, `permission`, `unreachable`, `interrupted`, `other`. Those counts are
what get sent, so an error-rate stops being a bare number and starts naming a
remedy.

The vocabulary is only worth as much as its match against the messages the
harness actually sees. Shipped with eight values and never measured, it reported
**65.7%** of the fleet's tool errors as `other` — `explained_errors` read 100%
the whole time, because that field counts whether a kind was reported, not
whether it says anything. The phrase lists here were rebuilt against a corpus of
1,854 real failures and are now at 5.0% `other`. Re-measure before adding a
value, and re-measure again if that share starts climbing.

What keeps this narrow, and what to check if you are reviewing it:

- **Failures only.** A successful result is never inspected.
- **The string dies on that line.** It is classified inline in the handler and
  never stored; `foldToolEnd` takes a `ToolErrorKind`, so the type system, not a
  convention, is what prevents text reaching run state.
- **Substring matching only.** No capture groups, no path extraction, no
  sampling, no first-N-characters. No fragment of a result can survive inside
  the value, because the only possible values are the ten literals above.
- **Bounded input.** A result can be an entire file; only 2KB of it is ever
  matched against. That 2KB is taken from **both ends** — the first and last
  kilobyte, joined by a newline and nothing else. A shell result puts its
  diagnostic last, so a head-only window discarded the one classifiable
  sentence on precisely the results too large to read. The budget did not
  change; only which 2KB it spends. The join carries no marker and no byte
  count, because either would be a fact about the payload surviving into a
  value that is supposed to carry none.

`pi` exposes no structured error code on the event (`isError` is a bare
boolean), so this is currently the only way to distinguish a guard refusal from
a missing file. If pi later carries an `errorKind`, this exception should be
removed and the guarantee restored verbatim.

## State (never in git)

```
~/.pi/agent/hive-telemetry/config.json        0600  non-secret settings
~/.pi/agent/hive-telemetry/credentials.json   0600  the token
~/.pi/agent/hive-telemetry/spool/             0700  offline snapshots
```

That directory is **not** one of the paths stow symlinks into this repo, so a
credential written there is structurally incapable of being committed.
`.gitignore` entries exist as belt and braces. The token must never go in
`settings.json`, which *is* symlinked into git and which pi rewrites on its own.

## Design constraints

Two are mechanical, verified in pi 0.83.0's source, and stronger than style:

1. **No handler may await, spawn, or touch the filesystem.** pi awaits each
   extension handler serially (`dist/core/extensions/runner.js`), so a slow
   handler *is* the agent loop. Flushes go out on `setTimeout(0)`; git and config
   reads happen on timers or in command handlers.
2. **No handler on `context` / `before_provider_request` / `before_provider_headers`.**
   pi *skips* those transform paths entirely when nothing registers for them
   (`dist/core/sdk.js`), so registering one doesn't merely risk a prompt-cache
   bug — it switches on a path pi otherwise bypasses.

**Totals come from events, never from re-scanning the session.** `status-footer.ts`
sums `getBranch()`, which is right for a live display and wrong for telemetry:
after a compaction the summarized entries leave the branch and branch-derived
totals *decrease*, so money already spent vanishes. Folding `message_end` and
`tool_execution_end` makes compaction, tree navigation and fork structurally
incapable of double- or under-counting.

**One row per agent process run, not per session.** A resumed session starts a
fresh accumulator at zero; if rows were keyed by session id that first flush
would overwrite yesterday's totals with a smaller number. `client_session_id`
groups runs back together server-side.

**Cumulative snapshots, guarded by `seq`.** A lost flush self-heals on the next
one and a replayed flush is a server-side no-op, so the client is only ever
"retry until 2xx" — no journal, no exactly-once delivery, no gap detection.

**An idle session still has to speak.** Usage is only flushed when the
accumulator is dirty, so a session doing nothing would be indistinguishable from
a dead one — and the server infers death from silence. Every interval tick
therefore either flushes usage *or* posts a heartbeat, never both: reporting
usage **is** contact — but only a flush that is actually *going* counts, so a
flush refused by the auth latch or by a backoff falls through to the heartbeat.
Client interval 120 s; the server's stale-after is 5 min, so a single missed
tick is survivable and two are not.

**A rejected credential decays the heartbeat, it does not silence it** (HIV-1639).
Before, a 401 stopped the usage flush and left the heartbeat running once per
interval forever — a revoked token presented indefinitely, which is the
credential-stuffing pattern the flush guard exists to avoid, arriving through
the door beside it (measured: usage froze at 3 posts while heartbeats reached
33). Stopping the beat outright was the obvious fix and the wrong one: silence
is how the server reaps a session, so a bad-token session would vanish from the
fleet view rather than show as unauthenticated, and a token repaired mid-flight
could return to find itself already reaped. The heartbeat now rides the flush's
existing exponential backoff instead.

> [!note] Known tension, deliberately accepted
> The backoff caps at 30 min while the server's stale-after is 5 min, so from
> roughly the fourth step onward a long-rejected session oscillates
> alive/stale rather than reading steadily unauthenticated. Resolving it
> properly means the heartbeat carrying auth state so the server can render
> "credential rejected" — a server change, not a client one.

**The run id is re-announced on every tick**, not broadcast once. A single
broadcast is a race: a sibling extension that had not yet subscribed when it
fired can never learn the id, because the bus carries no way to ask for one.
`hive-remote` lost exactly that race and sat "enabled, not attached" forever.
Re-announcing turns a broadcast anyone can miss into a state anyone can observe.

## Other extensions can report gates

Emit on the in-process bus; no import and no load ordering required.

```ts
pi.events.emit("hive.metric", { kind: "gate", name: "verification-loop",
                                outcome: "pass", value: 1234 /* ms */ });
```

Bus input is untrusted: names are sanitized to `[a-z0-9_.-]`, length-clamped and
cardinality-capped. Never put free text on this channel — it would be a path
straight past the payload allowlist.

## Eval runs

`HIVE_TELEMETRY_SOURCE=eval` tags a run as an eval rather than interactive work,
and `HIVE_TELEMETRY_TOKEN` lets an unattended harness use a dedicated token
without disturbing `hive` CLI auth. The global extensions dir is the only one
that loads in headless mode under `defaultProjectTrust: "ask"`, which is why
this lives here and needs no per-repo setup.
