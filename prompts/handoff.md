---
description: Write a durable handoff for the current task
argument-hint: "<topic>"
---
Write `HANDOFF-$1.md` in the current repository with the current task state. Include:

- Task and objective
- What is complete and what remains
- Exact worktree path and branch
- PR URL/number (or explicitly say none yet)
- Tests/checks run and their results
- Risks, blockers, and next steps

Use concrete paths, commands, and identifiers. Do not claim work was done if it was not verified. After writing it, summarize the file contents and path.
