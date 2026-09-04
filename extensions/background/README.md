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

A finished job injects itself **once**, via `sendMessage({deliverAs: "followUp", triggerTurn: true})` — the `agmsg` shape, for `agmsg`'s reasons:

- **`followUp`** so the message never cuts in between a tool call and its result.
- **`triggerTurn`** so an *idle* session acts on it, rather than sitting on it until the human types something.

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
- **No persistence across restarts.** Jobs die with the session, by design.

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
