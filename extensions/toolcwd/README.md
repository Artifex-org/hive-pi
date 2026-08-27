# toolcwd — a `bash` call that names a directory runs in it

pi's `bash` tool has no `cwd` parameter. **`background_bash` does**, and that
asymmetry is the whole trap: an agent working in a second worktree — which every
launched agent is, by construction — passes `cwd`, pi drops it silently, and the
command runs in the *session's* checkout.

## Why it is worth an extension

A misdirected command does not fail. It answers, about somewhere else, and the
answer is indistinguishable from the truth until something downstream disagrees.
Eleven papercuts in 48 hours (2026-08-17/18), three of them evidence-destroying:

| what ran | where it ran | what the agent concluded |
| --- | --- | --- |
| `uv run pytest …` | the base checkout | a deliberate **negative control** passed — it had never executed |
| `uv run ruff format --check …` | the session checkout | 16 files formatted; *"non-evidence for the repair diff"* |
| `git status --short --branch` | the agent's own worktree | a fresh `asf-3685` checkout was on branch `asf-3686` — filed as a gwq bug, which it was not |

The third is the shape to remember: the misdirection produced a *second*
bug report, against the wrong component.

## What it does

1. **`tool_call`** — rewrites `input.command` to `cd '<dir>' && <command>` and
   drops the stray `cwd`. pi documents `event.input` as mutable for exactly
   this.
2. **`tool_result`** — appends one `[harness]` sentence saying what changed and
   why, so the repair is never invisible. It reuses `toolhints`' appender: one
   way of adding a harness sentence to a tool result is enough for both.

Both halves matter. Honouring silently would be the same class of bug as
dropping silently; refusing outright — which is what the papercuts asked for —
spends a turn to arrive at the command the caller already meant.

## Rules

- **Never prefix a command that already begins with `cd`.** `cd a && cd b` lands
  in `a/b` when `b` is relative. The stray argument is still reported.
- **Never invent a directory.** A non-string, empty or whitespace `cwd` is left
  exactly as pi already treats it.
- **Never validate the path.** A missing directory makes `cd` fail loudly on the
  caller's own terms — a better error than any this extension could compose.
- **Never touch another tool.** `background_bash` honours its own `cwd`.

`PI_TOOLCWD=0` turns it off, matching `PI_TOOLHINTS`.

## Sibling

`toolhints/` answers a *failed* call with its next move. This one repairs a call
that would otherwise have succeeded at the wrong thing — the same instinct
(situational rules belong at the moment of use), one phase earlier.
