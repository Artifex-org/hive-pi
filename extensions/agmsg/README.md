# agmsg — agent-to-agent messaging

Makes this pi session a first-class participant on [agmsg](https://agmsg.cc/):
it has a name other agents can address, arriving messages land in the
conversation, and replying is a tool call rather than a script the model has to
remember.

agmsg itself is a SQLite file and a directory of bash scripts at
`~/.agents/skills/agmsg` — no daemon, no network, no server. Claude Code,
Codex, Gemini CLI and pi all read and write the same table, which is what makes
a mixed team possible.

**No install, no cost.** Without `~/.agents/skills/agmsg` the extension
registers no handlers, no tools and no command.

## Why an extension and not the skill

Every other runtime integrates agmsg by writing a rule file that asks the model
to poll its inbox after each tool call. That is a workaround for a missing
capability, and it has the failure mode you would expect: a session that is
idle — waiting for its human, which is most of the time — checks nothing,
because checking requires a turn that nobody started.

pi can be pushed to. `pi.sendMessage(..., { triggerTurn: true })` delivers into
a running session and starts a turn if none is running, so a message *arrives*
instead of being *found*. The extension holds agmsg's own `watch.sh` open as a
child process and feeds it straight in.

## Delivery modes

Mode is per project, stored by agmsg in `.pi/agmsg.json` and set with
`/agmsg mode` (or `agmsg delivery set <mode> pi <project>`).

| Mode | What happens | Cost |
| --- | --- | --- |
| `monitor` | `watch.sh` runs as a child; each message is injected as `followUp` + `triggerTurn` | one sleeping bash process |
| `turn` | after the agent settles, `check-inbox.sh` runs (it owns the 60s cooldown) | one script call per settle, at most once a minute |
| `off` | nothing; the tools still work on demand | none |

Absent file means `off`. `both` is deliberately unavailable: the watcher already
delivers into an idle session, so a turn poll beside it could only duplicate.

## What the model gets

| Tool | Does |
| --- | --- |
| `agmsg_send` | message another agent by name |
| `agmsg_inbox` | drain unread mail (only needed after downtime, in monitor mode) |
| `agmsg_team` | who is reachable — names, agent types, projects |
| `agmsg_history` | recent messages for this role, including read ones |

Plus one paragraph in the system prompt, once a role is resolved: the session's
name, its team, and the fact that answering means calling `agmsg_send` — text
written outside a tool call reaches *this* session's user, not the sender.

## What the human gets

```
/agmsg                           role, project, delivery mode, watcher state
/agmsg inbox | team | history
/agmsg send <to> <message>
/agmsg join <team> <name>        register this project under a name
/agmsg actas <name> [task]       claim one of several registered identities
/agmsg mode <monitor|turn|off>
/agmsg restart                   restart the watcher
```

The footer shows `◉ alice@team 3✉` while receiving; `◌` means monitor is
configured but the watcher is not running (a refused claim, a crashed watcher).

## Roles, and why ambiguity never resolves itself

`whoami.sh` answers one of four things, and only one of them is a role:

- **one registration** → that is the role;
- **several** → the session waits for `/agmsg actas <name>`. Guessing would make
  it answer under a name its user never chose, which no recipient can detect;
- **a suggestion** (known elsewhere, not here) or **not joined** → no role. The
  tools still exist and explain what to run.

`actas` is also the boot protocol for a spawned agent: agmsg launches
`pi -n <team>-<agent> "/agmsg actas <agent>"` with the task appended, so the
agent claims its identity and starts working in one turn. The claim is
exclusive — if another live session holds the name, nothing is claimed and the
task is dropped, loudly.

## Shape

| File | Job |
| --- | --- |
| `message.ts` | the watcher's line format, parsed (pure) |
| `identity.ts` | `whoami.sh`'s four answers (pure parse + one exec) |
| `mode.ts` | `.pi/agmsg.json` (pure) |
| `watcher.ts` | `watch.sh` as a supervised child |
| `controller.ts` | role × mode × watcher — the state machine |
| `tools.ts` / `commands.ts` | what the model calls / what the human calls |
| `index.ts` | pi wiring only |

The mechanical constraint every extension here shares: pi awaits handlers
serially, so a slow handler *is* the agent loop. Every handler in `index.ts` is
synchronous; identity resolution, script calls and spawning happen on a detached
timer.

## The other half

pi is not a known agmsg agent type out of the box. The driver that teaches
agmsg about it — detection, spawn flags, session-resume lookup, and the writer
for `.pi/agmsg.json` — lives in [`agmsg/`](../../agmsg/) at the repo root.
Install it once per machine:

```bash
agmsg/install.sh
```
