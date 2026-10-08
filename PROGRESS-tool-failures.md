# Codemode and bash tool failures — 2026-10-08

## Scope and method

Local, workstation-retained pi transcripts only, not a census of Hive's factory
or remote fleet. Frozen window: 2026-10-01T21:04:17.532580Z inclusive through
2026-10-08T21:16:00Z exclusive. The initial kernel exploration reread live
files; final numbers below come from a bounded replay over all JSONL files,
filtering each result by its entry timestamp. Excluded this investigation's
session. 145 sessions contain relevant results; no duplicate tool-call ids or
JSON parse failures were found. Runtime versions were not recoverable from the
session headers (their `version: 3` is the transcript format, not pi's version).

`workstation/.pi/agent/scripts/measure-tool-failures.py` reads `message.role ==
"toolResult"`, `toolName`, `isError`, and codemode's explicit `Script failed`
header. Model-change entries supply denominators per model and UTC day. Nested
calls come from `message.nestedCalls`, NOT just the script error footer: caught
exceptions can coexist with a successful outer script. Aggregate evidence is
saved in `docs/analysis/tool-failure-window-2026-10-08.json`. No raw transcripts,
commands, credentials, or private project paths are included here.

Re-run with `uv run --no-project python` and the helper's `--since` / `--until`
options above; pass this investigation's filename stem to `--exclude-session`.
The window is frozen, not the source files: retention, compaction or transcript
rewrites can change a later replay. Keep the saved aggregate as provenance.

## Baseline

| Surface | Results | Failed results | Rate |
| --- | ---: | ---: | ---: |
| Direct bash | 7,157 | 717 | 10.02% |
| Outer codemode script | 11,108 | 1,267 | 11.41% |

These are reported result-error rates, **not harness-defect rates**. A test,
search, or status command's nonzero exit is not automatically a broken tool.
The initial exploration found many test/check-command candidates among the
shell errors; no claim is made that they are all expected or harmless.

| UTC date | Bash errors/results | Codemode errors/results |
| --- | ---: | ---: |
| Oct 1 (partial) | 0/7 | 0/0 |
| Oct 2 | 66/490 | 0/0 |
| Oct 3 | 29/255 | 0/0 |
| Oct 4 | 134/1,405 | 82/727 |
| Oct 5 | 160/2,399 | 296/2,851 |
| Oct 6 | 30/455 | 131/1,402 |
| Oct 7 | 250/1,693 | 650/5,028 |
| Oct 8 (partial) | 48/453 | 108/1,100 |

Codemode has no recorded calls before Oct 4 in this window, so this does not
establish a like-for-like regression. By recorded main-session model:

| Model | Bash errors/results | Codemode errors/results |
| --- | ---: | ---: |
| meta/muse-spark-1.3-contributor | 120/2,841 | 21/379 |
| openai-codex/gpt-6.1-sol | 597/4,316 | 1,246/10,729 |

Do not interpret this as a model ranking: tasks, tool usage, launch posture and
runtime versions were not controlled. Delegated worker internals are not
separately measured here.

10,924 codemode results carry nested-call records; 341 records are explicitly
incomplete. Recorded nested calls include 37,438 ok, 1,423 error and 97
unfinished statuses. Bash accounts for 5,020 ok, 458 error and 25 unfinished
nested calls. 320 successful outer scripts contain 400 nested errors. **Do not
pool nested calls with outer-script results** or read `Script completed` as
proof every operation succeeded.

## Confirmed actionable mechanisms

1. **Native discovery transferred into scripts:** 167 `tools.tool_search does
   not exist` errors across 80 sessions (13.2% of failed outer scripts).
   The saved aggregate includes counts by date.
   Native pi `tool_search` is `model-only`, intentionally absent from the script
   registry. Its description says to always use it for MCP discovery, and the
   harness's deferred-tool prompt repeated that recommendation without the
   script distinction. This contributes ambiguity; the transcripts do not
   prove which instruction caused each of the 167 calls. `tools.tool_search`
   throws on member lookup, before
   `Promise.allSettled` can catch it; earlier sibling tool calls may have
   started. A live reproduction failed before executing any tools, while
   `await searchTools(...)` found callable tools. A node assertion against the
   original `loadoutPrompt` failed because it contained no `searchTools`.

2. **Bash result/diagnostic contract:** the harness override intentionally has
   no output schema. Thus `tools.bash` resolves to text and rejects an Error on
   nonzero exits/timeouts, unlike the structured stock-bash example in pi's
   generic codemode documentation. A live probe confirmed `typeof result ==
   "string"`. Serializing `Promise.allSettled` results without converting the
   rejected Error yields `reason: {}` and loses the diagnostic; observed in
   this investigation too. Preserve error text, not just success output.

3. **Explicit short shell ceilings:** exact `Command timed out after N seconds`
   signatures occur in 55 direct bash errors and 10 nested bash errors. Of the
   55 direct cases in the initial exploration, 34 passed timeout=30 and 10
   passed timeout=20; others passed 10, 15, 25, 40, 60 or 120. Neither bash nor
   codemode imposes a default timeout
   here. Raising a universal default would not fix agent-supplied limits.
   Long commands belong in `background_bash`, and completed side effects must
   be checked before retrying a timeout.

Other clusters need case-by-case investigation: propagated shell/read/edit
failures, malformed JavaScript/JSON, guards, schema errors and store limits.
They are not automatically harness bugs and were not suppressed.

## Changes

- `extensions/loadout/index.ts`: distinguish native discovery from awaited
  script discovery; explain that deferred harness tools need no loader inside
  scripts. Retain the recent no-MCP-configuration refusal fix (`3cbd846`).
- `extensions/toolhints/hints.ts`: an exact, codemode-only recovery hint for
  missing native `tool_search`; preserve the original error and warn about
  earlier side effects. No alias or automatic replay.
- `extensions/pretty-tools.ts`: document actual text/Error contract at the
  bash declaration, explicit Error stringification, background execution and
  timeout side-effect checks. No executor/schema/exit-status change.
- `test/loadout.test.ts`, `test/toolhints.test.ts`: preventative prompt and
  narrowly scoped failure-hint regressions.
- `test/codemode-tool-contract.test.ts`: real pi QuickJS execution with the
  actual registered bash fallback; negative missing-member control, positive
  prompt-derived discovery, text return type, preserved sibling output /
  rejected nonzero-exit diagnostic, and rejected explicit-timeout diagnostic.
  The session seam is a typed test double, not a test of actual session loadout
  filtering, live permissions or PTY behavior.
- `workstation/.pi/agent/scripts/measure-tool-failures.py` and
  `test/measure-tool-failures.test.ts`: reusable, aggregate-only, timestamp-bounded
  reporting with regression coverage for nested errors in successful scripts,
  model denominators, window edges, duplicate ids, excluded sessions and
  malformed JSON entries.

## Verification and limits

The prompt assertion went from failing to passing. Initial targeted suite:
65 tests passed after correcting an incomplete test context. The first full
`npm run check` passed typecheck and 4,904 tests (13 pre-existing skips).
Final `npm run check` passed typecheck and 4,907 tests across 304 test files,
with 13 pre-existing skipped tests in four files. `git diff --check` passed.
The repeated bounded replay exactly matched the saved aggregate (apart from
adding its discovery-by-day field). Independent reviews found no code blockers;
one saw an empty artifact mid-write, resolved by checking the completed 25,551-byte
JSON. Future background replays should write a sibling temporary file and
atomically rename it on success. Installed/test dependency pi version: 1.0.2.

`quality_gate` reported **no recognized gate** and did not run any checks.
This public repo's declared gate is `npm run check`, mirrored in GitHub's
`check` workflow; `gitleaks` runs in its separate GitHub workflow.

No live installation/configuration change, merge or deployment is authorized
by this PR. The worktree preserves unrelated main-checkout configuration WIP.
No controlled agent A/B evaluation or post-deployment failure-rate reduction
has been measured. Tests establish valid guidance and boundary semantics, not
that a model will always follow them. Re-measure the same cohorts after rollout.
