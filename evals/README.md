# Harness evals (HIV-1035)

Measurement equipment for harness changes. Method: KB `infrastructure/harness/harness-evals.md`.

```bash
npm run eval                                   # dev split, 3 reps, WITH hive-pi installed
npm run eval -- --only edit-anchor-near-miss --reps 5
npm run eval -- --arm candidate --env PI_HOUSE_X=1   # the other side of an A/B
npm run eval -- --arm ctx --context path/to/AGENTS.md  # A/B the system context file
npm run eval -- --no-harness                   # bare pi, no hive-pi — measures the MODEL, not us
npm run eval:compare -- eval-baseline.json eval-candidate.json
npm run eval -- --test                         # held-out split; once per milestone
```

## The harness under test is in the container — since 2026-08-10, and not before

Until HIV-1629 the container held bare pi and the task fixture, and **nothing of
hive-pi entered it**. That is worth stating plainly because it invalidates a claim this
file used to make by its first line:

- Every `--env PI_HOUSE_*` arm was **inert**. The variable reached the container; the
  extension that would read it was not installed. `run.ts`'s own usage example
  (`--arm diagnosis-off --env PI_HOUSE_EDIT_DIAGNOSIS=0`) documented a workflow that could
  not work.
- Two arms differing only by a harness change produced **identical containers**, so
  `compare()` returned `inconclusive` by construction — and `inconclusive` reads as
  *"no regression"* when it actually meant *"not measured"*.
- It retro-explains the model sweep below: the corpus could only find discrimination by
  varying the **model**, because the model was the only thing in the container that varied.

Two things now carry hive-pi in, matching how a workstation gets it:

| Harness content | How it enters | Flag |
|---|---|---|
| `extensions/`, `prompts/`, `themes/`, `agents/` | `pi install /hive-pi` (repo mounted read-only) | on by default; `--no-harness` opts out |
| `AGENTS.md` — the system context file | copied into the trial's working directory, where pi's resolver reads it | `--context <file>` |

They are separate because pi has no package resource type for the context file: per
`workstation/README.md` it is read from `~/.pi/agent/` and the cwd and nowhere else, so
`pi install` cannot carry it and a second lever is not a design preference.

**`--no-harness` must be asked for by name.** The default is the configuration where a
harness change is actually in the measured surface — a flag that defaults to "measure
nothing" reproduces the original bug for anyone who does not know to pass it. A run that
cannot install hive-pi **errors the trial** rather than warning: an eval that silently
measures bare pi while its report says "harness" is worse than no eval.

Every report and every `eval-*.json` now carries the hive-pi git SHA (with `-dirty`).
Once arms can differ by repo content, `arm: "baseline"` identifies nothing on its own —
the same label one commit later is a different measurement. `eval:compare` refuses to
stay quiet about a **harness mismatch** between the two files it is given, including the
case where one predates this change and its harness state is *unknown* rather than false.

Each trial: a clean `node:22.19.0` container, the pinned pi installed, `pi -p --mode json`
against the task's `fixture/`, then `grade.sh` — **its exit code is the verdict**.

## What is enforced in code rather than written down

| Rule | Where |
|---|---|
| No unattended runs on the Codex subscription | container gets only `OPENROUTER_API_KEY`; `assertOpenRouterModel` refuses a non-OpenRouter spec before spending |
| Distrust a delta smaller than the sampling noise that produced it | `compare()` returns `inconclusive` unless the delta clears a two-standard-error band on the difference of the two pass rates — the same discipline `compareEfficiency()` applies to turns and tokens |
| A delta that is one flipped trial is not a finding | subsumed by that band: one trial is `100/n` pp and the narrowest possible band is `~283/(n+2)` pp |
| Too few trials for the normal approximation | `MIN_GRADED_TRIALS_PER_ARM = 4`; below it no delta is a verdict, because 0/3 vs 3/3 is p=0.10 by an exact test |
| Held-out split is touched deliberately | `--test`, or `selectTasks` filters it out |
| Runaway spend | `--max-cost`, default $5 |
| A task must say where its failure was observed | `loadTask` requires `provenance`; a test requires it to say DERIVED |

## Baseline — 2026-08-09

`openrouter/deepseek/deepseek-v4-flash`, pi 0.84.0. Three sweeps, 42 trials, $0.034 total.

| sweep | tasks × reps | pass@1 | mean turns | mean tokens |
|---|---|---|---|---|
| first 7 dev tasks | 7 × 3 | 90.5% (19/21) — **invalid, see correction** | 4.33 | 10,964 |
| four harder dev tasks | 4 × 3 | 100% (12/12) | 5.25 | 13,974 |
| five unstated-defect tasks | 5 × 3 | 100% (15/15) | 5.40 | 16,219 |

The first sweep's 90.5% is superseded: its only failures came from a missing `pytest`, not
from the model. On the stdlib runner that task passes 3/3, so **the corrected pass rate is
100% across every sweep**.

## Correction: there are no discriminators, and pass rate is the wrong axis

An earlier version of this file claimed `no-silenced-error` was a discriminator at 1/3, and
that its failures were the model "thrashing rather than fixing the defect". **That was wrong,
and the harness itself produced the wrong number** — which is the failure mode it exists to
prevent, so it is written down rather than quietly edited away.

The cause: those tasks ran `python3 -m pytest`, and **pytest is not installed in
`node:22.19.0`**. The task was measuring "did the model think to `pip install pytest`" at
least as much as it measured debugging. Converted to stdlib `unittest` (no install, no egress,
no network dependency) the same task passes **3/3**.

So the honest position after 20 tasks: **every task is ceilinged on
`deepseek-v4-flash`.** Two deliberate attempts to build discriminators failed —
first traps around a stated instruction, then unstated defects the model must diagnose. Both
were reasonable hypotheses; neither survived contact.

**The useful finding is that pass rate is the wrong axis for this corpus.** Across 15 trials
at a saturated 100%, token spend varied with an **11.4% coefficient of variation** (13,487 →
19,099 on the same five tasks). The method already says a cost/turn regression at equal pass
rate is a real regression; nothing was computing it. `compareEfficiency()` now does, gated on
a two-standard-error band so a change counts only when it exceeds the spread of the trials
that produced it.

## The negative control — 2026-08-10, the first evidence this corpus can gate

An eval that has never been shown to catch a known regression is not measurement equipment;
it is a number generator whose failure mode — a green *"no significant change"* on a change
that broke something — looks exactly like success. So there is now a control in-tree.

`evals/control/regressed-AGENTS.md` is a deliberately-regressed harness arm: plausible-looking
house rules that quietly forbid what every task requires (*"do not modify existing source
files"*, and a redefinition of **done** as "you have written your review comment"). Plausible
on purpose — anyone can detect obvious nonsense; the realistic failure is a well-meaning
convention landing in a context file.

```bash
npm run eval -- --model openrouter/openai/gpt-oss-20b --reps 2 --arm control-baseline
npm run eval -- --model openrouter/openai/gpt-oss-20b --reps 2 --arm control-regressed \
  --context evals/control/regressed-AGENTS.md
npm run eval:compare -- eval-control-baseline.json eval-control-regressed.json
```

| Arm | pass@1 | mean turns | mean tokens | cost |
|---|---|---|---|---|
| `control-baseline` | **86.2%** (25/29) | 6.31 | 11,403 | $0.0121 |
| `control-regressed` | **50.0%** (15/30) | 4.60 | 11,899 | $0.0136 |

```
PASS RATE: WORSE
  -36.2pp over 29+30 graded trials, outside the ±22.1pp two-standard-error band on the difference
```

**A verdict, not `inconclusive`.** The corpus detects a harness regression, on this model, at
this size. That is the claim this file could not make before, and it is now reproducible with
three commands for about $0.03.

**Restated 2026-08-15 under the recalibrated floor (HIV-1708) and unchanged.** −36.2pp against a
±22.1pp band is a regression by a comfortable margin, which is the point: a threshold can always
be tuned until it agrees with you, so the recalibration was required to keep this result while
dropping the one below it. If a future change to the floor cannot keep both, it has broken the
instrument in whichever direction it moved.

### The most useful thing the control found

**`TURNS: BETTER — -27.1%`.** The sabotaged arm finished in *fewer turns* while getting the
answer wrong less than half the time — it stopped early because it had been told stopping early
was the job.

So an efficiency improvement, read on its own, is indistinguishable from a harness that has
persuaded the agent to give up sooner. **Never read turns, tokens or cost without pass rate
beside them.** The method's "a cost/turn regression at equal pass rate is a real regression" is
true and now has a mirror: *a cost/turn improvement at degraded pass rate is a real
regression wearing the opposite costume* — and it is the one an eager reader is most likely to
quote.

Tokens and cost both returned `inconclusive` here, correctly: the spread across trials is wider
than the change. Only pass rate moved, and only pass rate should have.

## First real use: the 0.84.0 → 0.84.1 pin bump (HIV-1625)

The first question asked of the fixed instrument, and the first result that must be read
rather than quoted.

| Arm | pi | pass@1 | mean turns | mean tokens |
|---|---|---|---|---|
| `pi-0840` (`main` @ e76a33b) | 0.84.0 | 83.3% (25/30) | 5.67 | 10,019 |
| `pi-0841` (@ 74c366f) | 0.84.1 | 90.0% (27/30) | 6.30 | 11,053 |

**The verdict on this run is `INCONCLUSIVE`** — restated 2026-08-15, and it is not what the
instrument said at the time:

```
PASS RATE: INCONCLUSIVE
  +6.7pp is 2.0 flipped trials over 30+30 graded trials, inside the ±18.1pp two-standard-error
  band — NO DETECTABLE DIFFERENCE, which is not the same as no difference. A delta this size
  needs ~449 graded trials per arm before it means anything.
```

When this run was made, `compare()` printed **`PASS RATE: BETTER, +6.7pp`**. That was the
instrument being wrong, not the pin bump being good. +6.7pp at n=30 is **two flipped trials**;
it cleared a fixed **3pp** floor that had been set at half the **6pp** swing the same comment
cites for infrastructure alone on a benchmark an order of magnitude *larger* — i.e. more
permissive exactly where this corpus is noisier. A fixed percentage-point floor is also the
wrong *shape*: two flipped trials is 6.7pp at n=30 and 0.7pp at n=300. **HIV-1708** replaced it
with the band above, and the honest reading of this bump is **no detectable change** — the
expected and welcome answer for a patch release.

The numbers in the table are the ones that were measured; only the verdict over them changed.
Anywhere else this run is quoted (KB `infrastructure/harness/harness-evals.md` carries the same
figures) needs the same restatement.

Two things worth keeping from it:

- **`inconclusive` now means something.** Before the harness was actually in the container it
  meant "not measured". The same corpus demonstrably catches a −36.2pp regression, so a null
  result here is evidence rather than a shrug.
- **A verdict is not a conclusion.** The instrument's job is to produce a number with its
  uncertainty attached; deciding what the number supports is still a judgement, and the floor
  being wrong is exactly why it cannot be delegated to the threshold.

## Canaries — what the corpus is actually for

A ceilinged task is not worthless: it is a **canary**. If a harness change makes one start
failing, that is a real alarm, and these tasks would discriminate on a weaker model. But a
corpus of canaries cannot show an *improvement*, which is what an eval is usually asked about.

Two things would change that, in order of value:

1. **Run against a weaker model** (`--model`) so pass rate has room to move. Cheapest by far,
   and it is one flag.
2. **Efficiency as the primary axis**, which is now implemented — `npm run eval:compare`
   reports turns, tokens and cost with their own noise discipline, alongside pass rate.

## The measuring model, measured (2026-08-09)

Option 1 above is no longer a suggestion — it was run. Four candidates, full 33-trial sweeps
on the two that could drive the loop at all:

| model | pass | of | rate | verdict |
|---|---|---|---|---|
| `meta-llama/llama-3.1-8b-instruct` | — | — | — | **floor** — 1 turn, **0 tool calls**; never enters the agent loop |
| `mistralai/mistral-nemo` | 9 | 33 | **27%** | discriminates, near the floor |
| `openai/gpt-oss-20b` | 21 | 26 | **81%** | discriminates, near the ceiling |
| `qwen/qwen3-30b-a3b` | — | — | — | still ceilinged on the probe |

**A floor is exactly as useless as a ceiling**, and that is the trap this table exists to
close. The intuition "weaker model ⇒ more signal" is wrong at the bottom end: a model that
makes zero tool calls fails 100% of tasks *for one reason that has nothing to do with the
harness*, so every A/B against it returns the same answer. `llama-3.1-8b` was rejected on
that basis, not on its pass rate.

The usable band is the two middle rows, and they bracket the corpus from both sides:
`mistral-nemo` at 27% has room to move **up**, `gpt-oss-20b` at 81% has room to move **down**.
Both pass some tasks and fail others — the property the corpus lacked and the reason
`compare()` could only ever say `inconclusive`.

Neither number is a quality judgement of the model. They are the measuring instrument's
scale, chosen so a harness change has somewhere to show up.

## What this is NOT yet — read before quoting a number

- **20 tasks, against the method's 20-50** — the count is met. Discrimination is no longer
  missing, but it is a *property of the pairing*: these tasks discriminate on `mistral-nemo`
  and `gpt-oss-20b` and remain ceilinged on `deepseek-v4-flash`. Quote the model with the rate,
  always — a pass rate without its model is not a number.
- **It cannot measure the production orchestrator.** `gpt-5.6-sol` is Codex-only, and Codex
  is exactly what unattended runs may not use. Every report prints this.
- **No egress allowlist.** Containers get default bridge networking.
- **Not wired into CI**, deliberately: trials cost money and need a credential, so PR-gating
  is the wrong shape. It is a local CLI run before and after a harness change.
- **Single machine, single time of day.** The method asks for runs spread across the day.
- **Installed is not the same as ACTIVE.** `guards-bridge` is installed with the rest of
  hive-pi and is then **inert in every trial**: it shells out to
  `~/.claude/hooks/pre-bash-dispatch.sh`, which lives on the workstation, is not part of this
  repo, and is never created in the container — so `runHook` finds nothing and allows
  everything. Guard behaviour therefore **cannot be measured here at all**, and an A/B of a
  guard change would return `inconclusive` for the same reason the whole harness used to: the
  thing under test is not in the container. Same trap as the one HIV-1629 closed, one layer in.
  Before trusting an `inconclusive` on any extension, check the extension actually *does*
  something in a bare container.
- **Every number above the negative-control section was measured with `--no-harness`
  semantics** — i.e. bare pi, before hive-pi entered the container. They remain valid as
  measurements *of the model on this corpus*; they are not measurements of our harness, and
  a new baseline is needed before any of them is compared against a run made today. This is
  why `eval:compare` prints a harness mismatch banner instead of silently differencing them.
