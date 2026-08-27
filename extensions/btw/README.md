# btw — the side-question lane (HIV-1243)

A conversation you can have *next to* the task instead of in it.

```
/btw why is telemetry opt-in but narrate opt-out?   ask (opens the thread)
/btw and what about skillscope?                     follow up (same child)
/btw done                                           fold the conclusion into the main thread
/btw end                                            discard it
/btw                                                status
```

The question, the answer, and the excerpt it was answered from never enter the
session. Only `/btw done` writes anything, and it writes one message.

## The two constraints that make it a lane and not a second agent

**The child is tool-less.** No read, no bash, no grep — `tools` is simply absent
from the request. It gets a 16k-character excerpt of the conversation (the same
budget `extensions/agenda/driver.ts` spends on its transcript excerpt) and the
main session's own system prompt, so it knows the project's conventions and what
you were just doing. When the honest answer needs a file it cannot see, it is
told to name the check that would settle it — one sentence the main agent can
act on beats a guess dressed as a finding.

**It never touches the session JSONL.** The thread is one variable in
`index.ts`. Nothing here calls `appendEntry`; `session_start` drops the thread,
because an excerpt from the previous conversation is a lie in the next one.

## Seeding, and the cache contract

The excerpt comes from `buildSessionContext(getEntries(), getLeafId())` — pi's
own compaction- and branch-aware answer to "what does the model actually see",
which walking `getBranch()` by hand is not. It is then serialized to prose,
because a tool-less request carrying `toolUse` blocks is rejected by every
provider we run: the constraint decides the *shape*, `buildSessionContext`
decides the *content*.

`stripDynamicSystemPromptFooter()` removes the trailing `Current working
directory:` / `Current date and time:` lines from the inherited prompt before
reuse. pi 0.84.1 emits only the first, and it is stable within a session; the
date variants come from whatever a harness appends, and a system prompt whose
last line carries the current minute invalidates the provider's cached prefix on
every request. Upstream (mitsuhiko's `btw.ts`) strips the same two lines for the
same reason, arrived at independently — which is why it is a contract here and
not a nicety. The child's full system prompt is then **frozen at seeding**, so a
follow-up resends a byte-identical prefix.

## Roads not taken

- **A persistent, tool-capable worker.** Three community implementations were
  surveyed and this is what they converge on. Rejected: a side question that can
  read the repo *is* a second agent — second agent's tokens, second agent's
  wall-clock, and a detour that can wander. The trade is real (some questions
  genuinely need a file read); the answer is to ask the main agent, which has the
  tools and the task in hand.
- **An overlay UI.** Deliberately deferred. HIV-1218 is consolidating six
  competing widget-band keys into one; a seventh added now would work against
  that. Answers render into the transcript via `ui.notify`.
- **Esc to exit.** Follows from the above: with no overlay there is no key to
  intercept, and stealing Esc globally for a lane that is usually closed would be
  worse than a word. `/btw end` is the exit.

## Cost

The child's spend is **not** folded into the session totals. `advisor` manages
that by returning `usage` from a tool result, which pi accounts; a slash command
has no such envelope. Each turn is capped at 4k answer tokens and 120s.

## Config

`~/.pi/agent/hive-telemetry/btw.config.json` — opt-out, default ON.

```json
{ "enabled": true, "timeoutMs": 120000, "maxSeedChars": 16000 }
```
