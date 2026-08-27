# hive-remote

Makes this pi session **visible and steerable** from the Hive Agents workspace
(`$HIVE_URL/agents`): the transcript streams to the browser, and steer, follow-up,
interrupt and kill come back.

Its sibling [`hive-telemetry`](../hive-telemetry/README.md) reports *counters*.
This one carries *prose*, which is a strictly larger decision — so it is a
separate opt-in with its own flag, and enabling one never enables the other.

## Setup, start to finish

```
/hive-login          # once per machine — shared with hive-telemetry
/hive-remote-on      # opt this machine in to conversation + control
/hive-remote-status  # what it is doing, and why it is not
```

`/hive-login` prompts for a token and validates it against `GET /api/v1/me`.
It is refused with an argument: a token in a command line lands in the session
transcript *and* is sent to the model on the next turn.

The token must belong to a **user**. Agent sessions are per-developer and the
routes refuse a machine token outright — `/hive-remote-on` checks this up front
rather than letting you discover it at the first silent 403 an hour later.

Then just use pi. On the next flush the session appears in the workspace under
its project, and the transcript follows it live.

| Command | |
| --- | --- |
| `/hive-remote-on` | enable (validates the credential first) |
| `/hive-remote-off` | stop reporting; keeps the credential |
| `/hive-remote-status` | enabled / attached / queued events / capabilities / **last attach error** |

### Config

`~/.pi/agent/hive-telemetry/hive-remote.config.json` (0600). The directory name
is frozen and shared — see [hive-common](../hive-common/README.md).

| Key | Default | |
| --- | --- | --- |
| `enabled` | `false` | only `/hive-remote-on` sets it |
| `url` | — | endpoint fallback; the credential's URL wins |
| `flushIntervalMs` | `2000` | transcript flush cadence (floor 500) |
| `allowSteer` | `true` | accept steer / follow-up from the browser |
| `allowInterrupt` | `true` | accept interrupt (`ctx.abort()`) |
| `allowKill` | `true` | accept kill — ends the **session**, not the turn |
| `streamDeltas` | `true` | stream partial assistant text for smooth rendering |
| `streamThinking` | `true` | send the model's **reasoning**, live and durably |
| `reportActivity` | `true` | heartbeat: what this session is doing, and that it is still here |
| `reportWorktree` | `true` | the working tree: which files changed, and whether each is committed / staged / unstaged / untracked |

Capabilities default on once enabled — turning this on *is* the larger decision —
but each is separately withdrawable. They are **declared at attach**, so the UI
never renders a control this build will silently ignore.

`allowKill` is separable because the outcome is not recoverable: a steer can be
corrected, a kill ends work in flight. `streamDeltas` is separable because it is
a different privacy trade — deltas send more prose more often (every partial, not
just finalized turns). `streamThinking` is separable again for the same reason
one step further: reasoning is where a model works through what it has just read
— file contents, error messages, half-formed guesses — and where it is least
careful about what it repeats.

`reportWorktree` is separable from the other pure-output switch because it sends
**paths**. A repository's layout is the most specific thing about a private
codebase that a file list can carry. It is also the only reporter that costs
subprocesses (three `git` calls) rather than cached numbers, which is why it runs
at turn end plus a 60s backstop rather than on the 5s status tick.

## What is sent

Assistant and user turns, tool calls with arguments and results, the model's
reasoning, the plan document, and a **catalog** of slash-command
names/descriptions so the workspace can offer them. The catalog is availability
only. Applying a skill is a separate notice (`origin: skill`, `skill activated · <name>`)
folded when `/skill:name` expands or a catalogued skill's `SKILL.md` is read.
A browser `/skill:` steer opts into `expandPromptTemplates` so the slash is
not sent as literal user text. Prose leaves this machine — that is the feature.

Two bounds worth knowing:

- **Results are budgeted in UTF-8 bytes**, not `String#length`, and pruned
  largest-subtree-first with `[dropped: N MB]` markers. The server truncates at
  262 144 bytes on insert, and truncating JSON mid-token makes it unparseable —
  so the client must fit the budget itself.
- **The catalog is clamped before sending.** A skill's description is frontmatter
  prose aimed at model dispatch and routinely runs to thousands of characters;
  Hive caps it at 500 bytes. Sending one whole used to make the server reject the
  *entire attach*, costing every session on the machine its transcript, steer box
  and interrupt button — silently, retried every two seconds forever (HIV-1163).

### Deltas go out one at a time

`streamDeltas` used to fire each `message_update` as its own unawaited POST.
**HTTP does not order across separate requests**, the wire carries no sequence
number, and the server appends whatever arrives — so at token cadence the
fragments landed shuffled and a reply mid-stream rendered as `famThe\`as`: the
tail of "borealis", the start of "The", and a piece of "`as" reassembled wrong.

That is the same SYMPTOM as the earlier garble (a partial reply parsed as
finished Markdown) and a different half of the pipeline, which is why the render
fix did not touch it. `deltaQueue.ts` keeps **one request in flight per channel**
and coalesces everything that arrives meanwhile into the next one, so a burst of
thirty token deltas becomes two round trips instead of thirty — the text is
identical either way, because deltas are append-only.

Serializing rather than numbering is deliberate: a sequence number needs the
server to buffer and reorder, and a reorder buffer needs a policy for the frame
that never comes. One in flight removes the race instead of compensating for it.
A failed batch is **dropped, not re-queued** — re-queueing would place it after
text since sent, which is the very reordering this exists to prevent, and a lost
delta costs one frame of smooth rendering because the durable event supersedes
it anyway.

### …and also straight to disk, when a local reader is watching (HIV-2878)

The coalescing above is the right trade for a browser on the other side of the
internet. It is the wrong one for the Hive **desktop app**, which runs on the
same machine as pi: the text it renders was produced microseconds away and
arrives via a server that may be a continent away.

So when `HIVE_LOCAL_JOURNAL` names a directory — hive-agent sets it per launch,
`hive desktop dev` sets it for a hand-started session — every delta is *also*
appended to `<dir>/<session-id>.ndjson`, **uncoalesced**, in the order it was
produced. Ordering holds there for a simpler reason than on the wire: one
appender, one file, append order.

```json
{"t":1756231045123,"kind":"delta","text":"Hel"}
{"t":1756231045124,"kind":"delta","channel":"thinking","text":"…"}
```

**Deltas only.** Events carry a client-minted `seq` that is both ordering and
idempotency key, and `rebase` can renumber queued events after the fact — a
journalled copy would then disagree with the server about the numbering of the
same event. A delta has no seq and no identity, so a local copy cannot
contradict anything, and the durable event supersedes it either way.

Nothing here is authoritative and nothing is retried. A full disk, a vanished
directory, or an unusable session id disables the journal for that session and
never reaches the caller: this runs on the agent loop's event handlers, where a
throw would cost far more than a lost frame of smooth rendering. One session may
write 32 MiB; past that it records `{"kind":"capped"}` once and stops.

## The working tree (HIV-1382)

Hive's detail pane could say what an agent's work *became* — once a pull request
existed, GitHub lists the files and the gate says what it made of them. Before
that it said nothing, and "twenty minutes in, nothing pushed" is where an
attached agent spends most of its life. Only the client is standing in the
worktree.

`worktree.ts` runs `git status --porcelain=v1 -b -z --untracked-files=all` plus
two `git diff --numstat -z --no-renames` (against `HEAD`, and against
`<upstream>...HEAD` for what is committed but unpushed), and POSTs a bounded,
churn-ordered file list to `/agent-sessions/{id}/worktree`.

Three details that are not incidental:

- **`-z`, not the default format.** Without it git *quotes* any path with a
  space, a quote or a non-ASCII byte, and unquoting that correctly is a parser.
  In `-z` a rename's record carries the NEW path with the ORIGINAL in the next
  NUL field — get that backwards and the original is filed as its own entry with
  a "status" read off the middle of a path. The tests use captured output.
- **Absent is not zero.** A branch with no upstream (or a `[gone]` one) reports
  `ahead: null`, because ↑0 renders as *delivered*. A binary file reports no line
  counts rather than `+0/−0`.
- **Not a repository → no report at all.** Sending an empty tree would render as
  *clean*, which is a much more misleading claim than "this client does not
  report one".
- **Sandbox masks are dropped, and counted.** `srt` neutralizes project-local
  config it will not let the agent read by writing empty, read-only placeholders
  into the checkout — `.bashrc`, `.zshrc`, `.profile`, `.gitconfig`,
  `.gitmodules`, `.mcp.json`, `.ripgreprc`, `.idea`, `.vscode`, `.claude/…` —
  so a launched session's changed-file panel opened on **twelve untracked rows
  of scaffolding before the agent had changed anything** (measured, 2026-08-08).
  The test is a property, not a name list, because a name list rots the moment
  srt masks one more file: a mask is a **regular file of zero bytes with mode
  0444**, and normal work produces neither half on its own. It applies only when
  `.hive-sandbox.json` is in the checkout — the proof this launch is sandboxed —
  and only to untracked entries. The count rides along as `masked` rather than
  disappearing, on the same terms as `truncated`.

The parsers are pure and take git's output as a string; only `collectWorktree`
spawns anything, and it is called from detached timers and `setTimeout(…, 0)` —
never from a handler, which pi awaits serially.

## Reasoning, and the heartbeat (HIV-1212)

The Hive pane could only show this session working while it happened to be
emitting assistant text. A killed pi, a wedged provider call and a four-minute
`bash` all rendered identically — a static transcript. Two signals fix that.

**Reasoning.** pi emits `thinking_start`/`thinking_delta`/`thinking_end`;
`deltaOf()` matched only `text_delta` and dropped every token, which on a
high-thinking model is most of the wall-clock of a turn. They now stream on
`POST /deltas` with `channel: "thinking"` and land durably as an event of kind
`thinking`. A block the provider **redacted** is reported as redacted rather than
skipped: dropping it silently would make a turn that reasoned look like one that
did not — the same ambiguity this feature exists to remove.

**The heartbeat.** `POST /activity` carries a phase (`idle` / `working` /
`thinking` / `responding` / `tool`), the tool if there is one, and when the phase
began. Sent on every transition, and every 10 s while work is in flight.

Why the beat proves anything: it runs on this extension's own timer inside pi's
process. If the agent is waiting on a slow provider call the event loop is free
and the beat lands, correctly reporting work; if the process is gone, or a
handler is blocking the loop synchronously, the beat stops — also correctly,
because that *is* frozen. It is the one signal whose absence means what we want
it to mean.

Three details that are load-bearing rather than incidental:

- **`working`, not `thinking`, is the phase after a tool result.** The model is
  at the provider and has not said what it is doing; naming it `thinking` would
  be a guess the next frame contradicts. Only `turn_end` says `idle`.
- **`since` is the phase's start and never moves on a beat.** Sending the beat's
  own time would restart the pane's elapsed timer every ten seconds, so one
  four-minute tool call would render as a series of short ones.
- **An idle session never beats.** A workstation at a prompt overnight would
  otherwise POST forever to say nothing. It costs the pane nothing: an idle agent
  draws no activity row, so no liveness claim is standing that could go stale.

**Against an older server** both degrade rather than break. A reasoning delta
carries a field the server decodes strictly, so the first `400` withdraws
reasoning deltas for the session — ordinary text deltas carry no `channel` at all
and are untouched. A reasoning *event* is worse, because a permanently-rejected
batch is dropped rather than requeued: the flush detects that case, withdraws the
capability and re-queues the batch **without** its reasoning rows, so the
assistant text and tool calls travelling with it are not lost to a feature they
have nothing to do with.

## Reading the two halves apart

| | `hive-telemetry` | `hive-remote` |
| --- | --- | --- |
| carries | counters, tool **names** | prose, tool args + results |
| row | `agent_sessions` | `agent_session_conversations` |
| visible to | org-wide spend analytics | **the owner only** — no admin bypass |
| opt-in | `/hive-login` | `/hive-remote-on` |

The owner-only rule is deliberate and is where this surface parts ways with the
counters: reading a conversation means reading a colleague's prose and every tool
argument their agent ran, and the same gate guards steer/interrupt/kill. An admin
bypass would be a remote-control credential for every developer's laptop.

## When it does not attach

`/hive-remote-status` answers first. It reports `attached: no` plus **the
server's own explanation** of the last failure — which exists because the client
used to discard it, leaving no way to learn the reason short of replaying the
request with curl.

Order of things to check:

1. **`enabled: false`** → `/hive-remote-on`.
2. **"No run id from hive-telemetry yet"** → `hive-telemetry` is the half that
   creates the session row and announces its id on the in-process bus. Without a
   session there is nothing to attach a conversation *to*. Check `/hive-telemetry`.
3. **`Last attach failed: …`** → the message names the field. It is bounded and
   comes from Hive's problem+json.
4. **Nothing at all after minutes** → the session may have ended. Hive infers
   death from silence after 5 minutes and records `abandoned`, which means "we
   stopped hearing from it", *not* "it finished".

### Launched sessions (Hive "+ New")

A session Hive launched runs inside `srt` and `tmux`. Two consequences:

- **The sandbox's write policy is allow-only**, and a write to an unlisted path
  fails with `EROFS`. An extension writing from a timer has no caller to catch
  that, so it becomes an `uncaughtException` and **pi exits mid-task**. This
  killed launched sessions until `~/.pi-lens` was added to the node's
  `agent_state_paths` — a *sibling* of `~/.pi`, so allowing `~/.pi` never covered
  it (HIV-1170).
- **The tmux control socket is denied**, so `resolveTerminal()`'s
  `tmux display-message` fallback cannot work. Launched sessions learn their
  terminal from `HIVE_TMUX_SESSION` instead, which `hive-agent` must pass with
  `tmux new-session -e` — the tmux *server* forks the command from its own
  environment, so a plain env var never arrives (HIV-1166).

If a launched agent vanishes, its pane is the evidence and Hive now keeps it:
`~/.hive/logs/agent-<launch>.log`, plus `remain-on-exit` so
`tmux capture-pane -p -t <session>` still answers after the process is gone.

## Design constraints

**Every handler is awaited serially by pi's runner — a slow handler IS the agent
loop.** Transcript events are folded synchronously and flushed off-loop; every
network call runs on a detached timer. Nothing here may block a turn.

**The downlink is a poll, not a held-open stream.** A long-lived connection in a
desktop agent has to survive laptop sleep, VPN flaps and server redeploys, and
each of those ends the same way — the steer box quietly stops working, with a
reconnect state machine to get wrong. A poll against an indexed partial index is
cheap, stateless and self-healing; a human-typed steer cannot perceive the
latency. (The *browser* side keeps SSE, where latency is visible.)

**`ctx` goes stale after a session is replaced** (resume, fork, `/reload`), so
the downlink cannot capture one at registration. The newest `ctx` is remembered
on every handler entry and calls are guarded: aborting nothing is an acceptable
miss, throwing into the agent loop is not.

**Prose never rides the in-process bus.** Sibling extensions announce
*identifiers* — a run id, a plan revision — and this extension reads the document
from the session entries under its own consent. Any loaded extension can
subscribe to that bus, so a channel carrying prose would be an exfiltration path
past each extension's own boundary.

## Related

- [`hive-telemetry`](../hive-telemetry/README.md) — the counters half
- [`hive-common`](../hive-common/README.md) — shared credential, HTTP, channels
- KB: `infrastructure/cicd/hive-agents-workspace.md` — the server side, the
  privacy boundary, the widget contract and the launch-lane traps
