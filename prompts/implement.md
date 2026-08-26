---
description: Research sweep, then you plan and implement, delegating the mechanical parts
argument-hint: "<task>"
---
Implement: $ARGUMENTS

**Step 1 — delegate the sweep.** Call the `subagent` tool with the `research` role for the relevant files, patterns and existing test coverage. Parallelise genuinely independent questions; never spawn a writer. Verify anything load-bearing yourself before building on it.

**Reading code.** When you know the name you want, use `read_symbol` — it returns that declaration with its doc comment and line range instead of a whole file. When you do not know the name, `list_symbols` outlines the file so you can pick one. Reach for whole-file `read` when you genuinely need the whole file.

**Step 2 — plan, then implement.** Decompose and decide yourself, then write the code. Keep the writes in this session: you hold the worktree, the guards apply to you, and one writer per worktree is a hard rule. Delegate a step only when it is mechanical *and* a narrow role already covers it:

| Delegate to | For |
| --- | --- |
| `lint-fixer` | mechanical lint/format/type-error passes |
| `test-fixer` | making an already-written failing test pass |
| `doc-writer` | prose, README and docstring passes |
| `aurora-developer` · `omarchy-config-manager` · `k8s-deployment-manager` · `borealis-trader` | work squarely inside that domain |

No role fits? Do it yourself — do not invent one.

**Step 3 — prove it.** Run the repo's own gate. `quality_gate` runs it from inside this loop — it discovers the repo's *vendored* gate and reports every finding at once, plus which checks never ran because a tool was missing. In a Hive-gated repo (hive, Aurora, Borealis-Ops) the same tool runs `hive check` on the fleet against your uncommitted tree, with the same live per-check progress — so call it there too instead of shelling out to `hive check` yourself, and pass `only` to name the steps (`only:"lint"`, `only:"test-1"`). Prefer it over shelling out to `ruff`/`eslint`/`tsc` piecemeal: a language server's opinion is a different rule set from the one that decides whether the PR merges. Fall back to the command the repo's `AGENTS.md`/`CLAUDE.md` names. Report the actual result. Root-cause fixes only: no fallbacks, no silenced errors, no loosened assertions. If a proper fix is out of scope, stop and say so.

Report what changed, which files, what you ran, and what you did not verify.
