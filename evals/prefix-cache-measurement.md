# Shared-prefix cache measurement protocol

Status: **not measured**. This is an experiment specification, not a caching
implementation or evidence of savings. Do not run paid/provider requests until
the operator approves the provider/account, model, total budget and concurrency.
No live harness/global settings changes are part of this experiment.

## Reuse before building

The existing `evals/runner/run.ts` pins Pi, records the harness revision, supports
`--context`, `--reps`, `--only`, `--model`, `--arm` and `--max-cost`, and writes
native JSONL evidence. `report.ts` already aggregates cache reads, tokens, cost
and wall time. Missing usage is **unmeasured**, not zero cost or zero cache hits.
The runner permits OpenRouter models only and spends real money; importing its
helpers is guarded so tests do not start containers. Leave those safeguards intact.

It is a task-quality/cost evaluation, **not** a controlled fan-out cache runner:
trials currently execute sequentially and prompts/tools vary with task behavior.
It has no `--concurrency` or `--cache-warming` switch. Repeated task evals can
provide a baseline, not isolate shared-prefix priming. Do not invent unsupported
flags or attribute a task-quality change to caching.

Pi already has native `cacheWarming` (`off`/`streaming`/`idle`, default
`streaming`). Warming requires model lifetime metadata and sufficient estimated
avoided miss cost. A setting of `streaming` is not proof warming occurred.
Use Pi's recorded decisions/refresh usage; do not build another cache warmer
before demonstrating an eligible workload where native behavior falls short.

## Controlled experiment (after approval)

1. Freeze the Pi and harness SHA, provider/model metadata, account, transport,
   tools and synthetic context. Use disposable agent/runtime directories with
   explicit settings; never edit the operator's settings or forward real session
   transcripts. Fix output length and task, and verify the provider's minimum
   cacheable-prefix size and cache lifetime.
2. Cross two factors: **identical vs changed prefix** and **sequential vs parallel**
   launches. Change content near the beginning of the cacheable model context,
   keeping length, tools and output task fixed. Record the stable-prefix hash,
   length and changed region; changing only a task suffix is not a cache-miss
   control. Common provider headers can still cache: do not call an arm cold
   solely because the user prompt changed.
3. Compare native warming **off vs streaming** for the same workload, documenting
   actual eligibility and refreshes. Fresh one-shot workers may never reach the
   warming threshold; that result does not evaluate keeping a long-lived
   orchestrator warm. Test that separately, with controlled waits around cache
   expiry and refresh cost included. Do not silently enable `idle` in production.
4. Use separate arm namespaces to avoid cache contamination. Randomize paired
   arm order, retain the first-request baseline separately from warmed repeats,
   and repeat complete batches (at least five pairs). Report each trial and
   spread, not only averages. Distinguish simultaneous unprimed launches from
   launches after the first request completed; label priming costs explicitly.
5. Record model calls, start/end timestamps, batch wall time, first-byte latency
   when the transport exposes it, reported input/cache-read/cache-write/output
   tokens, total cost including refresh/priming, retries, throttles and failures.
   Without first-byte events report only wall time. Without pricing/cache fields
   label those metrics unmeasured, not zero or inferred from elapsed time.
6. Abort at the approved total allowance, bound request output/retries, and do
   not add retries after failed trials without accounting for them. Existing
   eval `--max-cost` checks reported spend **between** trials; it is not a hard
   vendor billing cap and can overshoot by a trial. Parallel execution needs
   reservation for all in-flight calls, not just completed spend.

## Evidence and decision

Preserve sanitized per-request JSONL/metrics, explicit configuration, SHAs,
randomization seed, run ordering and missing-field counts in a task-owned
artifact directory. Reuse `evals/runner/report.ts` for ordinary task summaries;
retain raw usage fields for the controlled cache experiment rather than adding a
second persistent store. Cache field conventions/prices must match the pinned
provider adapter; do not guess whether cache-write tokens overlap reported input.

A faux-provider/offline replay can validate event accounting and cleanup. It
cannot measure vendor-side cache hits, lifetime, savings or latency. No result
from the native worker replay tests constitutes a cache benchmark.

Only propose code when paired measurements show a material net benefit beyond
noise **and** identify a supported provider mechanism missing from native Pi.
Count warming/priming costs and failure/throttle effects; confirm unchanged task
correctness on the existing eval corpus. Otherwise keep native behavior and
record no change. Publication/installation of any later implementation remains
a separate authorization.
