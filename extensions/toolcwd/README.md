# toolcwd — where a `bash` call runs

A library, not an extension: `cwd.ts` has no `index.ts` beside it and is
imported directly by `pretty-tools.ts`, the same shape `pty-exec/` uses. pi
discovers extensions by directory, so a second registration of `bash` would be a
coin flip decided by `readdirSync` order — there is exactly one, and it lives in
`pretty-tools.ts`.

## What this used to be, and why it changed

pi's `bash` tool has no `cwd` parameter. **`background_bash` does**, and that
asymmetry is the whole trap: an agent working in a second worktree — which every
launched agent is, by construction — passes `cwd`, pi drops it silently, and the
command runs in the *session's* checkout.

A misdirected command does not fail. It answers, about somewhere else, and the
answer is indistinguishable from the truth until something downstream disagrees.
Eleven papercuts in 48 hours (2026-08-17/18), three of them evidence-destroying:

| what ran | where it ran | what the agent concluded |
| --- | --- | --- |
| `uv run pytest …` | the base checkout | a deliberate **negative control** passed — it had never executed |
| `uv run ruff format --check …` | the session checkout | 16 files formatted; *"non-evidence for the repair diff"* |
| `git status --short --branch` | the agent's own worktree | a fresh `asf-3685` checkout was on branch `asf-3686` — filed as a gwq bug, which it was not |

The first answer was an extension: rewrite `input.command` at `tool_call`, append
one `[harness]` sentence at `tool_result`. It worked, and it was a turn late by
construction — 23 of the next thirty papercuts (2026-08-21..28) complain about
exactly that, and the other seven passed **`workdir`**, which the repair did not
recognise at all: no rewrite, no note, silently wrong answers.

So `bash` now **declares `cwd`** on its schema. An extension tool replaces a
built-in of the same name in pi's registry, and `pretty-tools.ts` was already
replacing `bash` — the parameter was always ours to declare. The `tool_call`
repair and the `PI_TOOLCWD=0` switch are gone with it; what remains here are the
rules, pure and tested in `test/toolcwd.test.ts`.

## Rules

- **The declared `cwd` is prefixed unconditionally**, including onto a command
  that begins with `cd`. That is what a working directory means: a relative `cd
  sub` in the command has to resolve against it. It earns no `[harness]`
  sentence — honouring a declared parameter is the contract, not a repair.
- **`workdir` and `dir` are honoured and reported.** They are inferences about
  intent, so the result says what was done and which spelling to use. Refusing
  would spend a turn arriving at the command the caller already meant; staying
  silent is the bug this whole directory exists about.
- **Never prefix a guessed key onto a command that already begins with `cd`.**
  `cd a && cd b` lands in `a/b` when `b` is relative. The stray key is still
  reported.
- **Never invent a directory.** A non-string, empty or whitespace value is left
  exactly as pi already treats it.
- **Never validate the path.** A missing directory makes `cd` fail loudly on the
  caller's own terms — a better error than any this file could compose.
- **Never touch another tool.** `background_bash` honours its own `cwd`.

## Sibling

`toolhints/` answers a *failed* call with its next move, and lends its appender
(`appendHint`) to the one sentence this module still produces. One way of adding
a harness sentence to a tool result is enough for both.
