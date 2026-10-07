# background

Start work, walk away, get told when it lands.

## Why

Every tool call in this harness blocks the session. A four-minute build is four minutes in which the orchestrator — the expensive model — does nothing but wait, and the human watches a tool call that looks frozen. pi 0.84 has no native backgrounding to lean on, so the mechanism is ours.

## The shape

| | |
| --- | --- |
| `background_bash` | run a shell command detached; returns immediately |
| `hive_watch_run` | watch a CI run to completion; returns immediately |
| `background_list` | what is running, what finished |
| `background_result` | the full retained output of one job |
| `background_cancel` | stop a job and its children |
| `subagent` + `background: true` | the same, for a delegation |
| `/background` | the list, for the human |

## `hive_watch_run`, and why a Hive tool lives here

Measured on Borealis run #2047 (2026-08-17, HIV-1998): a session spent **eight** `wait_for_run` calls on one run — ~6 minutes, ~23KB of near-identical payload, eight turns of narration saying nothing new. It was not the agent's fault. It passed `timeout_seconds: 900` every time and Hive answered at 45s every time, because `pi-mcp-adapter` sends no MCP progress token and the server clamps a wait it cannot keep alive. The timeout message then told it to re-call.

`hive watch` has no such ceiling — it is a stream, not a request, and it ends when the run does. Composed with this extension: one call, no turns spent waiting, one report whose status *is* the run's verdict.

That composition was already possible. **The session had `background_bash` and used it elsewhere in the same run.** Nothing connected the two, which is the argument for a tool rather than a sentence: as the narration note below puts it, a required parameter cannot decay over a long session the way a system-prompt instruction measurably does.

**Layering.** A Hive tool belongs beside the other Hive extensions, and cannot be. pi builds a fresh jiti instance per extension with `moduleCache: false`, so a different extension importing this one's job registry would get its own private copy — starting jobs nothing here would ever reap or report. A tool that starts a background job must be registered by the extension that owns the registry. The Hive-specific knowledge is quarantined in `watch-run.ts` as pure functions, and `index.ts` keeps one thin tool.

**The command is always `hive watch <uuid>`**, never `hive watch #N --project …`. Run-number resolution landed in the CLI on 2026-08-16; a workstation binary older than that answers `flag provided but not defined: -project`. Resolving the number here means the command works on every version.

## Completion is pushed. Status is pulled.

A finished job uses the shared waker (`hive-common/waker.ts`). Streaming notices never request a follow-up turn; idle notices wake only if the active branch has not handed control to a person. Plan approvals and pending grants remain gates, including after recovery. Settling notices wait for classification.

Everything else is a tool the model calls when it wants, plus a footer segment that costs no context at all.

**There is deliberately no periodic status injection.** `agenda/loop.ts` states the doctrine — *the timer NEVER injects* — and the economics agree: a timer that injects bills a turn every time it fires whether or not anything changed, while a completion message bills one turn per actual event. "Periodically check" is the model's job, and it has three tools for it.

## The notification is capped, and that asymmetry is the design

An injection lands in context **unconditionally** — the model did not ask for it and cannot decline it, which makes it the most expensive text here per byte. So:

- `OUTPUT_CAP_BYTES` (256KB) is what we **retain**.
- `NOTIFY_TAIL_BYTES` (2KB) is what we **volunteer**.

Two orders of magnitude apart, on purpose. 2KB carries a stack trace or a test summary — the cases where the model should act now — and everything else is one `background_result` away.

Retention keeps the **tail**. A build that fails prints its error last; keeping the head would reliably discard the only part anyone wants.

## Narration is a required parameter, not a nudge

`what` is required on every entry point. A required field cannot decay over a long session the way a system-prompt instruction measurably does — see `narrate/README.md`: 18.6 tool calls per prose message in pi workstation sessions, against Claude Code's 3.4. Claude Code's Bash `description` parameter is the same trick. `narrate` remains the reactive half; this is the structural half.

## Deliberate limits

- **Refuses in headless/`-p` mode.** The session is replaced after settle, so a completion message would have nowhere to land. A job that runs, finishes and tells nobody is *worse* than no backgrounding, because the model believes it will be told.
- **The tool call's `AbortSignal` is not forwarded.** Surviving the turn that started it is the whole feature. This is the one place in the harness where dropping the signal is correct rather than a bug — which is exactly why `session_shutdown` reaping is not optional.
- **8 concurrent jobs**, 30-minute default wall clock, 4-hour ceiling.
- **No process recovery or command replay.** Graceful shutdown reaps owned processes. After abrupt process death a detached command may still be running or may already have performed external effects; its unrecorded outcome is **unconfirmed**, not canceled or failed.

## Recorded-result recovery

`journal.ts` stores versioned start and terminal records using Pi's `appendEntry`, with bounded retained output and a UUID per execution. Terminal evidence is recorded before notification. On resume/reload, only the active branch and original session owner are restored: abandoned branches and forks do not inherit jobs. Recorded completions remain available through `background_list` and `background_result`, including in discussion/plan mode; execution and cancellation remain prohibited there.

Persisted background messages carry that execution identity. Recovery suppresses notices already present in the transcript, but a notice queued or held only in memory is retried through the waker. This is **not an exactly-once external-effect guarantee**: neither commands nor uncertain effects are replayed. An interrupted start is restored as unconfirmed, with explicit advice to verify effects before retrying.

Pi 1.0.2 synchronously appends JSONL after a user/assistant message exists, without `fsync`. This restores records surviving a **process restart**, not guaranteed power-loss durability. In-memory sessions have no disk recovery. A start-record failure prevents spawning a locally owned shell/watch job; externally owned delegations remain their owner's responsibility and registration errors are surfaced to the UI. A terminal-record failure remains visible in the live result and UI rather than silently promising recovery. Pi mutates its in-memory tree before attempting a disk write, leaving parent ids that may not exist on disk. Before each journal write, notification acceptance, and recovery, the active branch is checked against canonical JSONL ids and parents. A missing ancestor or known write failure cancels owned jobs, discards pending notices, and requests graceful shutdown. A same-manager `/reload` cannot repair this: restart/resume a healthy saved session through a fresh native manager (or explicitly repair/select a valid saved branch). Failed payload metadata identifies unsafe in-memory state; it does not repair ancestry. Native send failures are asynchronous runtime errors, so validation also blocks later background writes after an unacknowledged failed send. This is not a transactional/exactly-once delivery guarantee for Pi or other extensions.

Ancestry validation deliberately performs a synchronous full JSONL scan. A local five-pass benchmark with mostly abandoned branches measured means of 0.84 ms at 1 MiB, 6.02 ms at 8 MiB, and 82.69 ms at 64 MiB. Cost grows with history and repeats at lifecycle/write boundaries; long sessions or bursts of completions can block the event loop. This first slice accepts that measured safety tradeoff, not an incremental-index performance guarantee. Native transactional append/commit acknowledgement remains the cleaner follow-up.

Shutdown is a **request to the host**. Tests establish that subsequent background journal writes are blocked and that fresh-manager recovery preserves ancestry. They do not establish that Pi tool-result persistence, other extensions, or every host stop writing after that request.

`test/background-recovery.test.ts` kills real processes after command effects but before the terminal record, after the record but before notification, and after notification persistence but before the volatile notification flag. It resumes through Pi's real SessionManager and checks retained evidence, deduplication, and that effects happen only once. It also checks approval-held recovery in the real Pi runtime, process death with native streaming/settling queues, native reload deduplication, and a real JSONL write failure after Pi has mutated memory.

## Reaping, and the test that was worth nothing

Backgrounding without reaping is a factory for orphaned processes — a measured defect in this house (agent sidecars OOMing a pod hours after the run that spawned them). Children are spawned `detached`, so each gets its own process group and `killTree` signals the **negative pid**: killing only the shell would leave a `make` or a `pytest` running with nothing watching it.

The test guarding that was vacuous twice over, and both are worth remembering:

1. It reused one fixed pid-file path and deleted it only at the **end**. A leftover file from an earlier run made it read a stale pid whose process was long dead, so `kill(pid, 0)` threw immediately and it reported success without reaping anything.
2. Its timeout was generous. With the group kill deliberately broken the grandchild still died eventually, for reasons unrelated to the group kill, and the test counted that as a pass.

It passed with `process.kill(-pid)` sabotaged to `process.kill(pid)`. It now uses a fresh path per run, asserts the grandchild is **alive before** reaping, and has a 1.5s deadline that sits below the SIGKILL sweep — measured ~200ms with the group kill, still alive past 3.2s without.

## `exit` is the verdict; `close` is only the fast path

A job settles on **`exit`** after a two-second grace, not on `close` alone. `close` waits for stdio EOF as well as exit, and the pipes are inherited by every descendant: a wrapper that starts a worker and returns — a quality gate leaving a `basedpyright` behind — keeps fd 1 and 2 open with nothing to write to them, and `close` never comes. Wired to `close` alone the record stayed `running` with node already holding the exit code, the completion message the model was told to wait for instead of polling never arrived, and thirty minutes later the wall clock reported `timeout` — the one status that explicitly says nothing about the command's own verdict.

The grace is load-bearing in the other direction: `data` can still be delivered after `exit`, so settling synchronously would drop the tail this file exists to keep. `settle` refuses a job that is no longer running, so `close`, a cancel or a timeout winning the race makes the grace timer a no-op.

Settling **kills the surviving descendant first**, deliberately: `settle` releases the process handle, and after that the survivor is unreachable by `killTree` and by the `session_shutdown` reaper. Leaving it alive would trade a wrong verdict for exactly the orphan this feature is written not to industrialise.

## The seam to `subagent`

pi builds a fresh jiti instance per extension with `moduleCache: false`, so two extensions importing one registry module get two registries and the second silently never sees the first's jobs. `channel.ts` is therefore a **bus** (`pi.events`), the established cross-extension seam here.

The subagent extension keeps its own worker, its own abort controller and its own writer lock, and merely *narrates* the job into this registry. The alternative — having `background` spawn subagents itself — would have meant a second copy of role discovery, the project-trust gate and the writer lock, drifting from the first.

Ids are namespaced by owner (`bg-N` here, `sub-N` there). A shared counter would need a round trip the owner cannot await, and two owners minting `bg-3` would make `background_result bg-3` quietly return the wrong job.

**`background_cancel` on an external job asks its owner and does not settle it.** The owner still has to unwind the worker and release its writer lock; announcing the job as over while that lock is held would let the next writer past a gate that has not actually opened.

## Guarding

`background_bash` runs a shell, and a new tool is **unguarded by default** — `guards-bridge` matched the literal tool name `bash`. It now matches a *set* of shell tools which this one is in, so the guard stays in one place rather than being copied here. A tool added to that set must take its command in a `command` parameter.
