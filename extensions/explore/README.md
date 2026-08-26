# explore — a labelled side-branch that collapses to a report (HIV-1968)

A detour with a stated purpose, and a report instead of a transcript at the end
of it.

```
/explore does the retry belong in the client or the caller?   state the purpose
… /tree or /fork, then do the work …
/explore done no — the caller owns it; the client only logs        close, report
/explore                                                  what this session explored
```

## What was missing, given that pi already has the tree

pi's navigation primitives are already there and this extension rebuilds none of
them: `/tree` moves the leaf around one session file and can attach a branch
summary at the new position, `/fork` starts a new session file from an earlier
user message, `/clone` duplicates the current position.

What none of them holds is the **why**. You branch off to check whether the retry
belongs in the client or the caller, spend twenty turns on it, and come back to a
session tree that records the shape of the detour and nothing about its point. A
week later that branch is unreadable, so the question gets re-explored.

So the missing piece is not navigation. It is a purpose that outlives the detour,
and a report at the end small enough that someone actually reads it.

## It records and nudges; it does not drive

**pi really does expose the navigation API** — `ctx.navigateTree(targetId, {
summarize, label })` and `ctx.fork(entryId)` are both on `ExtensionCommandContext`
(`core/extensions/types.d.ts:268`, `:275`). This extension calls neither. That is
a decision, and stating it honestly is worth more than a fake automation:

- **The target is a judgement this command does not have.** `navigateTree` and
  `fork` both take an entry id — *which* earlier message to branch from is the
  operator's read of their own conversation, and a command that guessed would be
  wrong most of the time. The cost is asymmetric: a wrong branch is not a wrong
  guess you shrug at, it is a session position you now have to navigate back out
  of, having already lost the place you were.
- **Both replace the session under you.** They return `{ cancelled }`, run
  `withSession` callbacks, and stale every `ctx` held across them. An extension
  that moved you as a side effect of typing a sentence would be a hijack of the
  one part of pi you steer by hand.
- **Branching is not always what you want.** Half of the explorations worth
  labelling happen in place — you want the record and the report, not a new
  branch. Making navigation implicit would force the other half on everyone.

So `/explore` holds the purpose while you navigate however you like, and the
opening notice names the two commands verbatim, because the operator is about to
type one of them.

## The report is assembled, never generated

`/explore done` prints purpose, duration, conclusion, the files the exploration
changed and any `artifact://<id>` refs it produced. **Nothing in that path calls a
model.** Every field is either something the operator typed or a fold over
entries the session already holds.

That is a hard constraint, not an optimisation. A side lane that costs a model
call every time you close it is a lane you stop closing — and closing is where
all the value is. pi's own branch summary (`navigateTree({ summarize: true })`)
is already the paid, model-backed version for the people who want it; two
summarizers would be one too many, and the cheap one has to stay cheap to be
different from it.

The two derived fields are best-effort by design:

- **Files** come from `edit`/`write` tool calls stamped at or after the
  exploration opened, reading `file_path ?? path` — pi's own argument precedence
  (`core/tools/edit.js:91`), because both spellings reach the real tools and a
  scan that knew only one would silently return nothing on half the sessions.
  `read` is excluded: an exploration reads a hundred files and changes two, and
  listing the hundred buries the two.
- **Artifacts** are matched with a local `artifact:\/\/(\d+)` regex rather than
  by importing `parseRef` from `../artifacts/store.ts`. The ref format is frozen
  by that contract, and the question here is "every ref anywhere in a blob of
  text", which is not the question `parseRef` answers ("is this whole string a
  ref"). The import is available if the scan ever needs to *resolve* one.

A session whose entries do not match those shapes yields empty lists and a report
that simply omits the lines — never one that claims nothing was touched.

## State: in the session file, not in the extension

Persistence is `pi.appendEntry("explore", snapshot)`, whole-snapshot, the idiom
`workflow/state.ts` and `plan/state.ts` use: a custom entry is invisible to the
LLM, survives compaction, and is copied into a fork.

The command keeps **no closure state and registers no event handlers**. It
rehydrates from the session on every invocation, which costs one backwards scan
and buys the property the feature exists for — the record survives a `/tree` to
another branch, a compaction, a fork and a `/reload`.

**It reads `getEntries()`, not `getBranch()`, and that is the load-bearing
choice.** `getBranch()` is the root→leaf path of the *active* branch. The whole
shape of this workflow is: open, `/tree` off to a side branch, work, `/tree`
back, close — and the snapshot appended while on the side branch is not on the
trunk's path afterwards. A `getBranch()` reader would lose the record at exactly
the moment the operator asks for the report.

Newest snapshot wins on rehydration, which is safe across branches because there
is exactly one writer and it rehydrates over every entry before each write: any
later snapshot already subsumes every earlier one, wherever each was appended.

## Grammar, and the clamps

`done` is a **first-token** verb here — the rest of the line is the conclusion.
That is the opposite of `btw`'s whole-argument rule, where `/btw end of file
handling?` must stay a question; btw's verbs take no argument, this one's does.
The cost is that a purpose cannot begin with the bare word "done"; "decide
whether…" is a better purpose anyway.

Purpose is clamped to 200 characters, conclusion to 2,000, keeping the **head**
in both cases (the opposite of btw's tail-keeping excerpt: a long purpose puts
its point in the first sentence). Both strings are copied into every fork of the
session and reprinted on every listing, so an unclamped paste would be carried
forever.

One exploration at a time. Nesting is easy to implement and bad to use: `/explore
done` would have to name which one it closes, and the operator three levels deep
is the one who cannot remember. A second `/explore` reports what is already open
— with its purpose, so the refusal itself answers "what was I doing".

## Roads not taken

- **A deck section.** The deck's section-id union is owned elsewhere and under
  active edit; an exploration is also a thing you look at twice (when it opens
  and when it closes), not a thing you watch. Everything renders through
  `ctx.ui.notify`.
- **Driving `/tree` or `/fork`.** See above — the API exists and is deliberately
  unused.
- **A model-written report.** See above — the close has to stay free.
- **Config.** There is nothing to configure: the command is opt-in by being
  typed, sends nothing off the machine, and changes no posture.
