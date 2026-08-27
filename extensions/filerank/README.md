# filerank

Reorders `find`'s results so the file the model wants comes back first.

## Why only the ranking half of `fff`

[`@ff-labs/pi-fff`](https://www.npmjs.com/package/@ff-labs/pi-fff) replaces `find` and `grep` with a Rust SIMD engine plus frecency ranking. This rebuilds the second half and deliberately not the first.

**The engine is not worth rebuilding.** `rg` and `fd` already answer in milliseconds on our repos. A background index built at session start is pure overhead for a one-shot factory run that will read forty files and exit. And a native binary is a new dependency in an epic whose headline property is that it adds none.

**The ranking layer is.** It needs no binary, and it is the part that changes what a model does. Putting the right file first saves a round trip — a whole request, its prefill, its latency, and the tokens of a `find` result the model had to read past. Shaving 8ms off `fd` saves nothing an LLM can perceive.

## How it rides — and why it does *not* register a `find` tool

The spec for this extension said to override the built-in with `registerTool({ name: "find", … })`. pi does support that, and `pretty-tools.ts` already does it. **That is exactly why filerank must not.**

pi resolves duplicate tool names **first-registration-wins** across extensions:

```js
// core/extensions/runner.js — getAllRegisteredTools()
for (const ext of this.extensions)
  for (const tool of ext.tools.values())
    if (!toolsByName.has(tool.definition.name)) toolsByName.set(…)
```

and extension discovery order is raw `fs.readdirSync` order — filesystem order, not sorted (`core/extensions/loader.js` → `discoverExtensionsInDir`). So two extensions claiming `find` is a coin flip decided by inode ordering:

- filerank loses → ranking is silently absent;
- filerank wins → `pretty-tools`' compact find renderer is silently lost.

Both failures are invisible, and neither is reproducible. That is precisely the nondeterminism `rank.ts` goes to lengths to keep out of the ordering itself, so importing it through the back door would be absurd.

So the ranking rides on **`tool_result`**, the same place `narrate` puts its reminder. pi hands the handler the finished result and accepts a replacement `content`. This:

- **composes** with whichever extension owns the tool name instead of fighting it;
- **preserves the parameter schema and the result shape by construction** — we never see the schema, and we only reorder lines inside one text block;
- is **deterministic**, regardless of load order.

It also costs no second subscription, because the same handler does the learning half.

## What it ranks by

Strongest signal first. These are **tiers**, not a weighted sum: there is no amount of "I read this a lot last week" that should outrank "this file is staged for commit right now".

| Tier | Signal | Why it is where it is |
| --- | --- | --- |
| 1 | **Query → path selection history** | This exact pattern was searched before and *that* is the file it turned out to mean. It is the model answering its own question. |
| 2 | **Git status** — staged > modified > untracked | What the user is working on *right now*, read from the working tree with no decay parameter at all. Untracked is the weakest because it is also every stray scratch file `.gitignore` misses. |
| 3 | **Frecency** — count × 2^(−age / 7 days) | This week's working set: the files you were in on Tuesday that are not currently dirty. |
| 4 | **`fd`'s own order** | Unknown paths are not dropped and not randomised. |

### The half-life is 7 days, and here is the argument

The number is about **division of labour between the signals**, not about how memory decays. Git status already answers "what is being touched right now", precisely. Frecency's job is the tier below it. A half-life of hours would collapse that into a duplicate of the git signal; a half-life of months would rank last quarter's migration alongside today's work.

Seven days puts the crossover where it reads correctly:

| | score |
| --- | --- |
| read once yesterday | 1 × 2^(−1/7) = **0.91** |
| read ten times a month ago | 10 × 2^(−30/7) = **0.51** |
| read ten times today | **10** |

One day of staleness costs ~9%; a fortnight costs 75%.

### The order is total and stable

The comparator ends in the original index, so no two elements ever compare equal and the result does not depend on the sort implementation's stability, on object key order, or on how the caller built the list. Two runs on the same inputs give the same list — **tested directly**, because a ranker that reshuffles identical inputs turns every cached prefix of a session into a cache miss, and nothing about that failure points back here.

## Not blocking the agent loop

pi awaits handlers serially, so a slow handler *is* the agent loop. Three things could have broken that, and none of them do:

- **git** — `git status --porcelain` is run by a *detached* subprocess (via `git rev-parse --show-toplevel`, because porcelain paths are root-relative), refreshed on a 15s TTL, and its result lands for the **next** find. A find never awaits it. Outside a repo the first call fails and the map stays empty, which the ranker reads as "no git signal" — never an error.
- **the store** — an in-memory object, flushed on a 5s debounce (unref'd timer, so it can never hold the process open) and synchronously once at `session_shutdown`.
- **the reorder** — string splitting and one `path.resolve` per result line, capped at 5,000 lines.

## When it does nothing

`reorderFindOutput` returns *null* — leave the result exactly as it was — for anything it does not fully understand: an empty body, a single result, `"No files found matching pattern"`, a body containing blank lines, a rank callback that returned the wrong number of paths, a first content block that is not text, a failed tool call, or a reordering that changed nothing. Same ethos as `pretty-tools`' edit diagnosis: an augmentation that can break the tool it augments is a bad trade, and here the augmentation is worth strictly less than the tool.

find's trailing notice block (`[1000 results limit reached…]`, `[Truncated: …]`) is split off and kept at the end. It is metadata about the *search*, not a result, and sorting it into the middle of the list would be a lie about which file it refers to.

## What it learns

On `tool_result` for `read` / `edit` / `write`, the path is resolved against the session cwd (pi does the same before opening it, so keying on the raw argument would file one file under two names) and folded into the store.

A read that follows a find, of a file **that find returned**, is additionally recorded as a **selection** against that find's pattern — the tier-1 signal. It is consumed once, so a second read from the same result set does not overwrite the first: the first pick is the one the model committed to.

## Files

`~/.pi/agent/filerank.json` — the store, mode 0600, written tmp + rename.

Deliberately **not** under `~/.pi/agent/hive-telemetry/`. That directory is the credential store, and a file written on a timer from every session has no business sharing a directory whose whole point is "review what is in here before asking what can leave this machine". Nothing in the store is ever transmitted.

Caps: 4,000 paths, 500 selections, evicted by recency (ties on count, then on the path itself, so eviction is deterministic too).

## Config

`~/.pi/agent/hive-telemetry/filerank.config.json` — the house `configPathFor("filerank")` convention. **Defaults ON.** Nothing leaves the machine and nothing is destructive; the entire observable effect is that a list of paths comes back in a different order.

```json
{ "enabled": false }
{ "maxPaths": 10000, "gitTtlMs": 60000 }
```

Disabled means **nothing is registered at all** — no handler, no command, no subprocess. A no-op `tool_result` handler would still force pi to await it after every tool call in the session.

`/filerank-status` shows the store size, the git snapshot's age and whether anything is unflushed.

## Known gaps

- **Ranking happens after `fd`'s cap.** find truncates at 1000 results *before* this sees anything, so filerank reorders what came back; it cannot pull a good file into a result set that was already cut.
- **`grep` is not ranked.** grep results are line matches with context, not a file list, and reordering them would break the shape. A file-grouped variant is a separate piece of work.
- **A one-result find teaches nothing.** The selection set is only captured when there were at least two candidates to choose between.
- **`core.quotepath` escapes are not un-escaped** — a filename with a literal backslash loses its git signal. That is the correct failure: a missing boost, never a wrong one.
