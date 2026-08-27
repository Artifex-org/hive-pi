---
description: Review the current git diff with a read-only subagent
---
Spawn a read-only review subprocess with exactly:

```bash
pi -p --no-session --model openrouter/deepseek/deepseek-v4-flash "Review the current git diff. Use read-only tools only. Report actionable findings with severity, file and line, evidence, and a concrete fix. If there are no findings, say so explicitly. Do not edit files, commit, or run deployment/destructive commands."
```

Return the subprocess findings verbatim, followed by a short disposition. The subprocess must inspect the current git diff and relevant surrounding code, and must not modify the worktree.
