# readiness — what the environment can already do (HIV-1969)

Capabilities in this harness announce themselves by **failing**. `dev_db_start`
reports missing Postgres binaries on first call. The MCP adapter defaults every
server to `lifecycle: "lazy"`, so the first `mcp` call of a session pays connect
+ handshake, mid-task. A delegation dies on an OpenRouter 402 that was already
true before the session began. Three of those cost a turn each on 2026-08-16
alone, in three different sessions (`~/.pi/agent/papercuts.md`).

This probes them at session start and says so — once, cheaply, off the critical
path.

## The shape

| | |
| --- | --- |
| `readiness` (tool) | every row, re-probed; the model calls it before relying on a capability |
| `/readiness` | the same, for the human |
| deck section `env` | only the rows that are **not** ready — nothing at rest |
| `[Environment Snapshot]` | injected once at first agent start — **opt-in**, `PI_READINESS_SNAPSHOT=1` |
| `PI_READINESS=0` | registers nothing at all |

Rows today: one per configured MCP server, plus `hive`, `openrouter`, `gh`,
`devservices.postgres`, `browser`, `repo`, and `harness.update`.

A product MCP (`borealis`, `aurorasvc`) is **not** a capability of every session
just because it is in the global `mcp.json` (HIV-2639). Off-project it gets
**no row** — a Aurora launch listing Borealis as 353-tools-warming was the card
inventing a capability, and an `absent` row in every other repo would be the
same invention the other way. A stdio server whose entrypoint is missing
*does* report `absent`, with the path; "the first call will discover it" is
reserved for a server that can actually start.

`harness.update` is the odd one out and earns its place (HIV-1974). The
hive-pi package is **unpinned**, so a merge is supposed to reach every session
within one `hive-pi-update.timer` period (~17 min). On 2026-08-16 that unit
failed three runs in a row on a stale `index.lock` and the harness sat two
merges behind for hours, visible only to `systemctl --user status`. The symptom
that produces is worse than "old code": stow-symlinked config stops tracking
`main`, so a merged config change appears to do nothing and the search starts in
the wrong place. The probe reads the run record the updater now writes, and
judges the **age of the last success** rather than the last exit status — a unit
that stopped running at all would otherwise report ok forever.

## Five statuses, and `unknown` is not `absent`

`ready` · `warming` · `degraded` · `absent` · `unknown`.

A probe that could not tell must say `unknown`. Collapsing it into `absent`
makes a timed-out probe read as "you cannot do this", and the agent then stops
using a capability it has — the flattering-direction failure, inverted. Every
probe is deadline-bounded and `runProbe` converts a throw into `unknown`.

## Two things the first smoke run disproved

Both were plausible, both were in the first draft, and neither survived running
`pi -p` against the extension. This is the `typecheck-is-not-a-smoke-test` rule
paying for itself twice in one afternoon:

1. **pi does not name MCP tools `mcp__server__tool`.** That is Claude Code's
   shape. `pi-mcp-adapter` registers ONE proxy tool, `mcp`, and routes through
   it unless a server opts into `directTools`. Measured: 63 registered tools,
   zero with that prefix. A probe counting the prefix reports every server
   missing, forever, and its tests pass because they mock the prefix.
2. **The tool inventory is on disk, not in the registry.** The adapter writes
   `~/.pi/agent/mcp-cache.json` (754 KB here) with a `tools` array per server
   and serves deferred handles from it before any connection exists. So the
   cache answers "what can this server do" with no connection and no cost —
   which is exactly the distinction the row draws: **tools known ≠ connected**.

## Why the snapshot is opt-in

Everything else here is free of model context: the probes cost no tokens, the
tool is called only when the model wants it, the deck section is terminal-only.
The snapshot is the one part that puts tokens into the window **unasked**, and
it is therefore the one part whose value is a claim rather than an observation.

HIV-1633 says not to ship it on plausibility, and it is gated on HIV-1629's
eval corpus being able to tell whether it moves mean turns and mean tool calls.
So it ships **off** (`PI_READINESS_SNAPSHOT=1` to arm it), and the flag flips
when the corpus discriminates — not before. Shipping it on by default while the
ticket says "measure first" would be the thing this repo files tickets about.

## Why there is no push

`background/README.md` states the asymmetry: an injection lands in context
unconditionally, so it is the most expensive text per byte, and it is reserved
for a completion the agent is waiting on. "Postgres finished warming" earns a
turn only if the agent asked for Postgres and was refused — and there is no such
signal here yet. Until there is, readiness is a snapshot plus a tool. A timer
that injected would bill a turn per firing whether or not anything changed
(`agenda/loop.ts`: *the timer NEVER injects*).

The one timer here is a **settle, not a poll**: exactly one delayed re-probe
after the adapter has had time to register, unref'd, publishing only if
something actually moved.

## Cost

Nothing runs inside an event handler. `session_start` captures ctx, rehydrates
the previous snapshot and arms an unref'd `setTimeout(…, 0)`; every probe runs
after the handler has returned. pi awaits handlers serially, so the alternative
would have made seven probes part of the first turn — buying the latency this
extension exists to remove.
