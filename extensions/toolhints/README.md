# toolhints — a failed call carries its next move (HIV-1976)

The instruction usually exists. It is just nowhere near the moment of use.

Session `efb2830c` (Aurora, 2026-08-16) needed a pull request. It searched the
Hive MCP for `"create pull request"`, then for `"pull"` with `limit: 50`, then
fell back to `hive --help` — while `gh`, the actual answer, had been reported
**unauthenticated by `readiness` at session start**, forty turns earlier. Hive's
MCP has no create-PR tool and never did; nothing in that session's context said
so at the moment it mattered.

This appends the house's answer to the failing tool result. Technique #4:
situational rules belong in the tool output, at the instant the decision is
made. Errors work; warnings and READMEs do not.

## The table

The signatures live in `hints.ts`, each with the session or measurement that
produced it. The rules the table will not bend:

1. **Append, never replace.** The original error is the evidence.
2. **Silence when unsure.** No fuzzy matching. A wrong next move costs more than
   no next move — the same reasoning `devservices/pg.ts:startFailureHint` states.
3. **Every entry cites what produced it.** A table nobody can audit becomes
   folklore, and folklore goes stale silently. A test enforces the citation.

## What belongs somewhere else

Anything a **schema** fixes. Half the wasted calls that motivated this were
`unexpected additional properties ["tail"]`-class rejections on proxied MCP
tools, and the fix for those is promoting the tool so the model can SEE the
parameter — `mcp.json` `directTools`, in the same change:

```
3,269 proxy calls · 697 discovery calls · 292 rejected  (108 sessions / 7 days)
```

Six tools (`get_task_logs`, `wait_for_run`, `get_run`, `get_pull`,
`message_teammate`, `explain_failure`) are **1,563 tokens** and cover 76% of the
calls and 60% of the rejections. Everything else stays behind the proxy, because
promoting all 723 cached tools would cost ~133k tokens.

## Cost

A `tool_result` handler runs inside the agent loop, which pi awaits serially.
The static table scans at most the last 4KB. Successful calls stay quiet except
MCP error-as-success lookups, confirmed codemode truncation, and Go selections
that omit added tests. At most one hint is appended; verdicts and structured
payloads are unchanged. No network or model calls.

HIV-3802 contextual checks in `contextual.ts` have explicit budgets:
- Go `-run`: merge-base + working tree + untracked tests, last flag **per
  invocation**, at most two invocations / eight untracked files / 100 names /
  256KiB / a 2s Git deadline. Unsupported regexes or exhausted scans say
  **NOT checked**, never infer coverage from a green selected run.
- Codemode: actual truncation marker plus spill metadata, at most 16 observed
  reads / 256KiB, attributed against the full retained spill. Ordinary terminal
  previews do not count. Missing or over-budget evidence says NOT attributed.
- Sandbox timeouts: inspect at most four timed-out Vitest failure sections'
  source files, each a bounded 256KiB regular file. Only a socket-path bind
  fixture earns the sandbox pointer; unrelated assertion and TCP failures do not.

`PI_TOOLHINTS=0` registers nothing at all.

## Adding one

Only after you have watched an agent fail to answer it. Put the error in
`REAL_ERRORS` in the test verbatim, write the hint as the next MOVE rather than
a restatement of the error, and cite the session. If you cannot name the
evidence, the entry is a guess and guesses do not go in a table that speaks with
the harness's voice.
