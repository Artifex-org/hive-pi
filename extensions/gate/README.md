# gate

`quality_gate(mode?, scope?, only?, skip?, stopEarly?, tests?, install?)` — run the repository's
**real** quality gate from inside the agent loop.

## One agent check (`mode: "verify"`, HIV-3818)

A repo can declare **one command that answers "is this change done?"** —
`scripts/agent-check` — and when it does, that is what `quality_gate` runs by
default. pyERP's bootstraps missing dependencies and env files, runs the quick
gate, type-checks the touched TypeScript packages and runs the tests CI would
select for the diff.

**Why it is the default when present.** `quick` is lint only. That is the right
default for a tool meant to run constantly, and the wrong answer to the question
an agent asks before saying "done": lint-green is not test-green, and an agent
that read `PASS — 20 check(s)` had no way to know no test had run. A repo that
writes an agent check has decided what "verified" means for itself; this tool
should run that rather than its own narrower guess. It is the default only when
the call does not ask for the vendored gate — no `mode`, and none of its knobs
(`only`, `skip`, `scope`, `stopEarly`): `scope:"all"` asks for a lint of every
file, not a 30-minute test run. `mode: "quick"` stays exactly what it was: lint
only, fast, for the inner loop. Discovery stops at the repository root — an
agent check in an enclosing repo verifies that repo's tree, not this one.

| | |
| --- | --- |
| `mode: "verify"` | run `scripts/agent-check` (found from the cwd upwards); refused, naming `quick`, where there is none |
| `tests: false` | `--no-tests`: deps, gate, type-check, no suites |
| `install: false` | `--no-install`: report missing dependencies, install nothing |
| `scope`, `stopEarly`, `only`, `skip`, `project` | with an explicit `mode:"verify"`: ignored, and the report says so. `tests`/`install` on any other path: likewise named as ignored |

**The contract it reads, and nothing more:** exit 0 only if every step that ran
passed, and a FINAL line `AGENT-CHECK: PASS|FAIL ran=<steps> failed=<steps>
skipped=<steps>` (comma-separated, `-` for none), read from STDOUT's final line
so a late stderr chunk cannot displace it. A step named in `failed=` but missing
from `ran=` is still a failure (pyERP's merge-base exit prints `ran=- failed=scope`):
an explicit failure is never dropped as "no verdict". Per-step lines a particular
script prints are diagnostics for the model, never parsed — reading them would
turn one implementation's formatting into an interface it never agreed to.

The same honesty rules as the vendored path, each a way this could have lied:

| | |
| --- | --- |
| a **skipped** step | `not run: …` in the text, an `advisory` row and a `missing_tools` entry on the card — never passed |
| `PASS` with `ran=-` | NOTHING CHECKED, not a pass |
| no summary on the **final** line | NO VERDICT — a crash, or a summary-shaped line echoed earlier, is not a verdict |
| summary vs exit code disagree | NO VERDICT, naming the contradiction — neither half is trusted |
| a step both run and skipped | NO VERDICT, naming it |
| killed (ceiling or abort) | NO VERDICT — terminated, on the card too even after a FAIL summary; the ceiling is 30 min, as for `thorough` |
| long output | keeps the END, and says how much it dropped |

Two fixes to the shared streaming path, for both modes: an abort is no longer
mistaken for a spawn failure (`spawn`'s `signal` reports it as an `AbortError`,
which sent the call to the buffered fallback — running the whole gate again for
a call just cancelled); and a killed run whose detached descendant still holds
the output pipes (`setsid`, a test runner's `start_new_session`) settles 2 s
after the kill instead of waiting on the pipes forever.

## Why the real gate rather than a language server

This is the half of pi-lens worth keeping, which pi-lens got wrong. It offered
`lsp_diagnostics`: a language server's opinion — a *different* rule set from the
one that decides whether a PR merges. An agent that satisfies the language
server and then fails `ruff`, `basedpyright` or the 750-line file-length check
has learned nothing, twice.

So the diagnostics here are the same checks the pre-commit hook and CI run,
**discovered from the repo** (`vendor/quality-gate/quality-gate`,
`scripts/quality-gate`, `quality-gate`, from the cwd upwards) rather than
assumed. Vendored beats installed: a repo pins a gate version deliberately, and
silently running a different one from PATH would report against rules it has not
adopted.

## Defaults, and why

| | |
| --- | --- |
| `mode: verify` | when the repo declares `scripts/agent-check` — see "One agent check" above |
| `mode: quick` | otherwise: lint only, no test suites |
| `scope: changed` | vs the merge base |
| `stopEarly: false` | **`--no-fast-fail`** — see below |

**`--no-fast-fail` is the default, which is the opposite of what a human wants
at a pre-commit hook.** Measured against the real gate: on fast-fail it prints
`QUALITY GATE FAILED` and exits *before* the summary, so there is no
machine-readable trailer at all — and worse, the agent sees only the first
failing check. An agent's cost is round trips, not seconds; being handed every
finding at once beats fixing one, re-running, and discovering the next.

## What it reports

```
FAIL — 1 of 20 check(s) in 44.9s
failed: npm lock sync
not run (tool missing): python/basedpyright — these checks made no claim about this code

<findings>
```

Three deliberate details:

- **A missing tool is reported separately from a failure**, because they mean
  opposite things. A failure is work to do; a skipped check is a claim the gate
  did *not* make. Reading "passed" without knowing three checks never ran is how
  a green gate stops meaning anything.
- **Truncation keeps the END** and says how much it dropped. The gate prints
  check by check, so the last output is the one being looked for, and a
  head-truncation drops exactly that.
- **"Nothing to check" is not "passed."** With no changed files the gate
  short-circuits with exit 0 and no summary; reporting that as a pass would
  claim the code was checked when nothing was.

## Speed

`quick` targets <5 s, but that is per-repo: Aurora's gate runs 20 custom checks
and takes ~45 s. The timeout is 300 s so a cold cache or a large changed set
reads as slow work rather than as a broken tool.

## Discoverability is the whole adoption problem

A tool's own description string is not enough to get it used. Measured over the
481 `mcp` calls and 3,345 total tool calls the Hive control plane retained on
2026-08-06/07 — with this extension merged and the installed package current —
`quality_gate` was called **zero times**. The same thing had just happened to
`lens`: 50 of its 51 calls succeeded, so it was never broken, only unfound,
competing with a core `read` the model has years of prior on.

The fix in both cases was three sentences in `prompts/implement.md`, not a
change to the tool. If you add a tool here, name it in the prompt that should
reach for it — otherwise you have shipped something nobody calls.

## Repos whose gate runs on the fleet (HIV-1929)

A Hive-gated repo has no gate script: its gate is `hive check --step <name>`,
which runs the real pipeline on the fleet against the **uncommitted** working
tree. This tool used to tell the agent so and let it shell out — which is how the
single most important verification path in the house came to render as a bash
call that says nothing for twenty minutes. For a sandboxed agent it is not merely
the most important path, it is the *only* one: its netns cannot reach a host
Postgres, so every DB-backed test runs there.

So when no vendored gate is found and a `.hive/` exists, `quality_gate` runs that
instead, and reports it through the **same widget**:

```
hive check --step lint --no-wait     → run #2481, id, url
  ↓  every 2 s
GET /runs/{id}          → steps  (lint, test-1, web-check) + their states
GET /runs/{id}/substeps → checks (ruff, mypy, …), ingested ~1/s WHILE the step runs
  ↓  fold
{hive_widget:{v:1,type:"gate",spec}}   ← the same envelope the vendored path emits
```

The CLI is used only for what only it can do — pack the working tree, upload the
snapshot, evaluate the pipeline from the snapshot's own `.hive/` — and then gets
out of the way with `--no-wait`. Its human progress stream is a *rendering*;
parsing it would be reading the UI instead of the facts, and it carries no
per-check rows at all.

Deliberate details, each one a way this could have lied:

| | |
| --- | --- |
| the meter counts **steps** | that is the denominator the run plan actually knows. Checks are the rows. `group` says which step a row came from |
| a **canceled** run is `nosummary`, not `fail` | it reached no verdict. Drawing a red one claims the code was checked and found wanting |
| a **skipped** step is `advisory`, not `passed` | Hive pruned it; it made no claim about this code |
| an **unknown** substep outcome is `error` | an outcome this build does not recognise is not evidence of a pass |
| the fold is a **snapshot**, never accumulated | a task retried after a node failure moves backwards, and an appending fold would show one check twice with two verdicts |
| `only` names **steps** here | an unknown one comes back with the pipeline's own list — a better error than anything this code could guess |
| the run is **cancelled** if the call is aborted | an abandoned run would otherwise spend fleet capacity producing a verdict nobody reads |
| a run with nothing started says **queued** | "waiting for a fleet slot" and "checking your code" are different facts, and one check sat behind a PR gate for 15 minutes claiming the second |

Decided by the TASKS, never by the run's own word: Hive marks a run `running` the
moment it is admitted — observed on run #3262, `state: "running"` with its only
task still `ready` eleven minutes in.

`missing_tools` is always empty on this path, honestly: a missing tool inside a
step fails that step's own check, and Hive publishes no separate signal for it.

## The TUI half

Both paths publish a `gate` section to the pinned deck (HIV-1219) while they run:
a meter, the failures so far, and what is still going. A running gate says
`running ✗1` rather than `FAIL` — no verdict has been reached — but it carries the
count of checks that already failed, because that is the number worth
interrupting a twenty-minute wait for. The section clears when the call ends; the
verdict lives in the transcript card.
