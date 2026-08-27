# worktrees — gwq-native /wt and /mv (HIV-1223)

In-house replacement for `@thurstonsand/pi-wt`. The package shelled to `wt`,
which knows nothing of this machine's layout: no gwq `setup_command`
(submodules, pnpm install, uv sync), no bare-repo `__worktrees/` convention,
no pull-only anchors — the same failure class that got `herdr worktree
create` wrapped and raw `git worktree add` guard-blocked.

- `/wt list` — worktrees of the current repo, current one marked, anchors
  labeled.
- `/wt fork <branch>` — `gwq add -b` (so `setup_command` runs), then the live
  session migrates into the new worktree.
- `/wt checkout <pattern>` — migrate into an existing worktree.
- `/wt rm [pattern]` — confirmed removal via `gwq remove` (branch kept — the
  weekly cleanup owns merged-branch deletion; a dirty worktree is refused by
  gwq). Removing the CURRENT worktree migrates the session to the pull-only
  anchor first, then removes.
- `/mv <dir>` — move the live session anywhere (pi-wt's best trick, adapted
  under its MIT license in `session-move.ts`: snapshot → rewrite header cwd →
  write into the destination's session store → `ctx.switchSession` → delete
  the old file; discard on cancel). The move lands as a MESSAGE, not a
  notification — the model's cwd changed and it must know.

Guards encoded rather than documented:

- A session never moves INTO `…__worktrees/main` / `feature`: anchors are
  hard-reset hourly by repo-sync, non-git mutations there are guard-blocked,
  and hive-pi's anchor is the live stowed config.
- gwq only ever receives EXACT branch names — an ambiguous pattern makes gwq
  open a fuzzy finder, which inside a command handler is a hung process.
  Resolution lives in `model.ts` (exact branch → unique substring → refuse).
