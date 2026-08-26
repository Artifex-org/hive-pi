---
description: You implement, the code-reviewer role reviews, you apply what survives scrutiny
argument-hint: "<task>"
---
Implement and then review: $ARGUMENTS

**Step 1 — implement.** Write the change yourself. You hold the worktree and the guards apply to you; one writer per worktree is a hard rule. Delegate only mechanical steps a narrow role already covers (`lint-fixer`, `test-fixer`, `doc-writer`, or the matching domain role).

**Step 2 — delegate the review.** Call the `subagent` tool with the `code-reviewer` role. It is read-only by construction, so it cannot touch your worktree. Give it the concrete diff to look at — the changed paths and the commands you ran — not just the task description, and ask for findings with severity, file, line, evidence and a concrete fix.

**Step 3 — apply what survives.** Triage the findings; a confident reviewer is not evidence. Fix what is real, and say plainly which findings you rejected and why. Re-run the repo's gate — `quality_gate` runs the real one from inside this loop — and report the actual result.

Report what changed, what the reviewer raised, what you applied, and what you deliberately did not.
