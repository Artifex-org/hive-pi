# context-tree — `/context`, the per-agent cost tree (HIV-1243)

Where did this session's tokens go. One row per agent — the session itself,
each `subagent` task, each `orchestrate` worker, nested to whatever depth the
run actually reached — with own tokens, own dollars, and a context-window bar.

```
agent                          own tok      own $  context
session · openai-codex/gpt-5      128k      $1.84  ▓▓▓▓░ 84%
  code-reviewer                    46k      $0.61  ctx 52k
    critic                        3.9k      $0.04  ctx 14k
  doc-writer                       11k          —  ctx 11k
  orchestrate (3 workers)            0     $1.12*  —
    survey/0 (w1)                  31k          —  —
    survey/1 (w2)                  28k          —  —
    judge (w3)                     12k          —  —
total (8 agents)                  261k      $3.61
* covers that row's workers too — the orchestrate executor bills dollars only for the whole run.
— in the cost column: 1 row(s) spent tokens but reported no price, so the total is a floor, not the bill.
```

## The one property that matters

**Every row is that agent's OWN spend, descendants excluded, so the column
sums to the total.** A tree with subtree sums in the rows double-counts every
ancestor and the root always wins, which answers no question anyone asked.

Exclusivity is nearly free, because each agent is a separate `pi` process and
a process bills only its own LLM calls. The failure mode is therefore not
double-counting but a MISSING level: a subagent's own subagents are reachable
only through that subagent's transcript, so `tree.ts` recurses through
`result.messages`. `test/context-tree.test.ts` pins the sum on a three-level
fixture.

**Tokens are input + output**, matching `harness/usage.ts:budgetTokens` — the
definition the orchestrate executor already journals per node, and which
cannot be recomputed from what it sends. Cache reads/writes are excluded.

## Dollars are a scope, not just a number

pi bills per response, but not every producer forwards a per-agent figure.
Four distinct cases, kept distinct because collapsing them to `0.00` is the
flattering-direction failure `harness/usage.ts` exists to warn about:

| scope | cell | meaning |
| --- | --- | --- |
| `row` | `$0.61` | measured, this agent alone |
| `aggregate` | `$1.12*` | this row **and its descendants** — the orchestrate executor's `spentCost` |
| `covered` | `—` | an ancestor's aggregate already accounts for it |
| `unknown` | `—` | tokens spent, no price reported (an unpriced model returns 0) |

The column still sums exactly: an aggregate sits on exactly one row and its
descendants contribute nothing. Only `unknown` is a real hole, and the report
names the count — the total is then a floor, not a bill.

An orchestrate run that reports **no** dollars is `unknown`, not an aggregate
of zero. The executor sums `result.cost ?? 0` across its workers, so a fan-out
of unpriced models produces a run that really spent tokens and prices it at
`$0`; and the group row normally has no own tokens to betray that, because the
workers carry them all. `unpricedRows` is therefore measured over a row's
**subtree** — identical to own tokens for a leaf, and the one thing that makes
that group row report itself as the hole it is.

## Where the numbers come from

Read at command time from `ctx.sessionManager.getBranch()`; nothing is
tracked as it happens.

- **Session**: its own assistant messages. Deliberately NOT tool-result-level
  `usage` (the advisor sets that so pi folds a consultation into the session
  totals) — counting it here would bill a child process to its parent. So
  `/context` reconciles with status-footer's session line, not with a
  provider invoice.
- **Subagents**: `details.results[].usage`, recursing into `.messages`.
- **Orchestrate**: `details.summary` plus the `context-tree` `hive_widget`
  envelope that the orchestrate half of HIV-1243 already emits
  (`agenda/index.ts`). Reading that envelope rather than re-folding the
  journal keeps both halves describing a run the same way.

A tool result is matched by SHAPE, not by tool name — `details.results[]`
whose entries carry a `usage` object, or a `details.summary` carrying a
numeric `spentTokens`. That picks up a future producer of either shape for
free; the discriminators exist so it cannot invent a phantom row from an
unrelated tool's `results` or `summary` (no other extension emits either
shape today).

## Notes on the design

- **No event handlers at all.** pi awaits handlers serially, so folding the
  transcript on every message would put an O(session) walk in the agent loop
  for a readout nobody is looking at. The whole cost is paid on `/context`.
- **No config file, and nothing for the settings page.** A command is opt-in
  by being typed, sends nothing off the machine, and changes no posture.
- **`appendEntry`, not `sendMessage`.** The envelope is persisted as an
  operator record so it never enters model context — a cost-inspection
  command that grew the conversation each time would be a cost bug of its
  own. Note that `hive-remote` relays only the `customType`s it knows
  (`brief`, `plan`), so reaching the agents workspace needs a line there;
  the envelope shape is what this side guarantees.
- **The bar is 5 cells and withholds the last one below 100%.**
  `status-footer`'s gauge is 10 cells wide and rounds, which is fine there;
  at this width plain rounding saturates at 90%, collapsing exactly the
  distinction a warning bar exists to make. Warning tone at ≥80%.
- **Known duplication.** `status-footer/index.ts:formatContext` computes the
  same percent/clamp/threshold and is neither exported nor pure (it takes a
  theme and returns coloured text). `formatTokens` is imported from
  `status-footer/render.ts` rather than restated; the gauge could not be.
  Collapsing `formatContext` onto `contextPercent`/`contextBar` is a small,
  worthwhile follow-up in that file.
