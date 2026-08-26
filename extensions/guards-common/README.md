# guards-common

The guard logic pi enforces itself, rather than by shelling out to a machine's
`~/.claude/hooks/`.

## This directory is NOT an extension

It deliberately has **no `index.ts`**. pi loads a top-level `extensions/*.ts`
file, or a directory's `index.ts`, as an extension. Adding an `index.ts` here
would silently turn a library into a loaded extension — and one with no default
export fails at load rather than being skipped.

## Why these are ported and not bridged

`guards-bridge.ts` used to run `~/.claude/hooks/worktree-guard.sh` per edit. The
rule was that the bash script stayed the single source of truth across Claude
Code, opencode and pi. Two things made that wrong:

1. **It was already false.** opencode has carried its own TypeScript port
   (`opencode/plugin/worktree-guard.ts`) for as long as it has had plugins. The
   "one copy" was three.
2. **hive-pi is a package.** The Hive Code Factory and the Aurora in-app agent
   install it into containers with no `~/.claude` at all, where the bridge fails
   OPEN — `if (!existsSync(script)) return null` resolves to *allow*. The guard
   reported healthy and enforced nothing.

`pre-bash-dispatch.sh` stays bridged on purpose. It encodes workstation-specific
policy — which kubectl contexts exist, which checkouts are guarded, how workmux
is invoked — that has no meaning in a factory container, so failing open there is
correct rather than a gap. Porting it would drag machine facts into a shared
package.

## Which checkouts are protected

Two markers, and the difference between them is **whether they are committed**.

| marker | where it is read | protects |
| --- | --- | --- |
| `.worktree-pull-only` | a LINKED worktree | the fetch/pull anchor |
| `.worktree-guard` | a MAIN worktree | that checkout — **only when untracked** |

A committed marker travels with every `git clone`, and a clone is a main
worktree, so it cannot assert anything about a particular directory. It is
tracked in Aurora, hive-pi and Borealis-Ops, and until 2026-08-19 it therefore
blocked every disposable clone anyone made — a rebase staging area under `/tmp`,
a nested recovery clone, a sandbox's granted workspace. Four papercuts
2026-08-15..19, one blocking, all of them the same sentence: blocked as "the main
worktree" for a directory nobody would call canonical.

So a tracked marker now ALLOWS, with a note saying why and how to fix it; an
untracked one blocks. `.worktree-pull-only` already worked this way and says so
in its own comment ("Committing it would put it in EVERY worktree… which locks
the repo against all work"); this is the same lesson one branch over.

**To protect a main checkout**, create the marker untracked — one line in
`<repo>.git/info/exclude`. The trade-off, stated: a plain clone on a machine with
no worktree layout has no edit protection until its operator does that.

## Shape

`decide()` is pure and takes an injected `GuardProbe`, so the rules are tested
with no git and no filesystem. `realProbe` is the part that cannot be unit-tested
anyway, and it makes **one** `git rev-parse` where the script made three — this
runs inside a `tool_call` handler that pi awaits serially, so it sits directly in
the agent loop on every edit.
