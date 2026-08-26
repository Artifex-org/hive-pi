# session-branch — state that follows the branch you are on (HIV-1972)

A pi session is a **tree**. Every entry carries `id`/`parentId`, the active
position is a leaf, and `/tree` moves that leaf while `/fork` and `/clone` start
new files. Our state documents were written as if it were a list.

## The bug

`plan`, `workflow`, `tasks` and the agenda's `goal`/`loop`/`conductor` all
rehydrated with `ctx.sessionManager.getEntries()` — **every entry the file has
ever held** — and only on `session_start`. Two consequences, both real:

1. Rehydration takes the newest matching snapshot regardless of which branch
   wrote it, so a plan abandoned on a side branch can resurface on its sibling.
2. An in-session `/tree` leaf move emits **no** `session_start`, so nothing
   re-derives at all: the deck, the plan and the workflow keep describing the
   branch the operator just left.

oh-my-pi does the opposite explicitly — its `buildSessionContext()` walks the
new root→leaf path and branch-scoped state (todo, advisor, checkpoint) **resets**
on a switch.

## The fix, and why it is shaped this way

`branchEntries(ctx)` returns the root→leaf path via `getBranch()`, falling back
to `getEntries()` if a pin does not expose it — a wrong-but-present list beats
throwing inside a handler pi awaits. `branchFingerprint` is a cheap identity for
"which leaf are we on", and `createBranchWatch` turns that into "did it move".

Re-derivation happens on **`before_agent_start`**, not on a timer. That is the
one moment that matters, because it is the state the model sees this turn.
Explicitly not the deck's 1 s tick: that interval runs only while a live section
shows elapsed time, so an idle session navigating `/tree` would never tick.

**pi exposes no event for an in-session leaf move.** The fingerprint check is the
workaround, and the missing event is worth raising upstream.

## The exception, ruled deliberately

`extensions/explore` reads `getEntries()`, **not** the active branch, and that is
correct for it. An exploration record is appended *while on the side branch*, so
after the operator returns to the trunk it is no longer on the active path — and
a side-lane ledger that vanishes when you leave the side lane records nothing.

The rule this file states is therefore about **state that drives the current
turn** (a plan, a task list, a goal the driver injects against). A LEDGER of
what happened is different in kind and reads the whole file on purpose. A reader
who "migrates" explore to `branchEntries` will break `/explore done`; the
exception is named here so that reading stops before the edit.

## What is pinned, and by what

`test/branch-scoped-state.test.ts` builds a fixture whose abandoned-branch
snapshots sit **later in the entry array** than the active branch's, so an
all-entries read genuinely returns the other answer — without that ordering the
test would pass against the old behaviour and prove nothing.

It also reads the **source** of the four call sites and pins how many
`getEntries()` reads each may keep (agenda keeps one: `/handoff` passes both
views to `deriveSignals` on purpose, because it compares them). That check
exists because the first version of this work shipped a tested helper with **no
caller** — `rehydrateGoalFromBranch` was green while production stayed
branch-blind, and no fold-level test could see it.
