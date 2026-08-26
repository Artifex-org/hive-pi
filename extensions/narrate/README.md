# narrate

Nudges the agent to say what it is doing when it has gone quiet.

## Why

`workstation/.pi/agent/AGENTS.md` asks for a line of prose before each batch of tool calls. A static instruction at position zero competes with seventy other lines and decays over a long session — measurably:

| | tool calls per prose message |
| --- | --- |
| pi, workstation sessions (7 days, 29 sessions, 668 calls) | **18.6** |
| Claude Code (32 sessions, 20,383 tool-calling messages) | **3.4** |

Claude Code's docs say how it holds the line: an output style is not only added to the system prompt, it *"triggers reminders for Claude to adhere to the output style instructions during the conversation."*

This is that reminder half. The rule stays in AGENTS.md; this pokes the model with a one-line version of it at the moment it is being ignored.

## How it rides

On **`tool_result`** — appended to the content of a tool the agent already ran, which is where Claude Code puts its own reminders.

**Not on `context`.** That is banned here at build level (`test/no-forbidden-events.test.ts`) and the ban is correct in a way that is easy to miss: pi skips the transform path *entirely* when nothing subscribes, so registering a handler switches on work pi would otherwise bypass — on every LLM call, in every session, whether or not this extension ever has anything to say. How little the appended text costs is the wrong question.

Riding on a tool result also keeps the prompt cache working: the text becomes part of history rather than being re-synthesised per request, so once written it is stable.

## When it fires

Two triggers, because they are two different failures with the same remedy.

### 1. A silent streak — many calls, nobody told

- After **5** silent tool calls (configurable; floor 3).
- **Once per streak.** Only prose re-arms it — an agent that narrates normally never sees it.
- Prose *alongside* tool calls counts as narration. That message is the target behaviour; counting its calls as silent would nag the agent that just complied.
- **Reasoning does not count.** A trace is visible in Hive's `/agents` pane and nowhere else — not in a terminal, not to a teammate reading a shared session — and it is the model thinking rather than the model reporting.
- A new user turn clears the streak.

### 2. A silent wait — one call, nothing on screen for 20s

The streak trigger cannot catch the case people actually complain about: a *single* slow tool call with no explanation, where the person watching cannot tell a slow command from a hung one. That fires after **20s** of a silent batch.

Twenty seconds, not five: below that an ordinary slow read or a `git status` trips it, and a reminder that fires on competent work is one the model learns to skip — the same reasoning that keeps the streak at five rather than three.

**It never fires on a batch the agent introduced.** Waiting is fine; waiting unexplained is not, and a model that just complied must not be nagged for the wait it announced.

Its text is deliberately *not* the streak text. The streak asks for a status line about work already done; this one is about a wait in progress, and it names both remedies — say what you are about to wait on, or stop blocking on it at all with `background_bash` / `subagent background:true`.

**It costs no new event subscription.** pi gives `tool_result` no duration, and `tool_execution_start`/`_end` would be two more handlers on a deliberately small hooks budget — but `message_end` already says when the batch was dispatched and `tool_result` already says when one came back. The difference is the wait.

When both triggers apply, the **streak wins**: a long silent stretch that also happens to be slow is still mainly a silent stretch. Either way exactly one reminder is sent.

## Config

`~/.pi/agent/hive-telemetry/narrate.config.json` — **defaults ON**, unlike `hive-telemetry` and `hive-remote`. Those send data off the machine, so consent has to be an explicit act; this one sends nothing anywhere and appends about forty tokens to a request the agent was already making.

```json
{ "enabled": false }
{ "threshold": 8 }
```

Disabled means **no handler is registered at all** — not a no-op handler.

`/narrate-status` shows the current streak.
