---
description: Delegate a read-only sweep to the research role, then write the plan yourself
argument-hint: "<task>"
---
Produce an implementation plan for: $ARGUMENTS

**Step 1 — delegate the sweep.** Call the `subagent` tool with the `research` role. Read-heavy exploration is exactly what a subagent is for: it burns tens of thousands of tokens and must return a 1–2K summary, not raw dumps. Ask it for:

- every file relevant to the task, with exact paths and line ranges
- the existing patterns and conventions the change must match
- the tests that already cover this area
- what it could NOT determine

Split genuinely independent questions across parallel `research` tasks. Never spawn a writer.

**Reading code.** Know the name? `read_symbol` returns that declaration with its doc comment and line range rather than a whole file. Don't know it? `list_symbols` outlines the file first. Whole-file `read` when you actually need the whole file.

**Step 2 — plan it yourself.** Planning is a judgment call, which is what the flagship model in this session is for. Spot-check anything load-bearing before you rely on it — a confident subagent summary is not evidence.

Return:

- **Goal** — one sentence.
- **Plan** — numbered steps, each naming a concrete file and change.
- **Files** — paths to modify, and new files with their purpose.
- **Tests** — what proves it works, and where those tests live.
- **Risks** — what could break, and what you are still unsure about.

Do NOT implement anything. Return the plan only.
