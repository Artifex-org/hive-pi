# JEV pre-extraction shadow experiment — 2026-10-07

**Decision: retain shadow-only, default off. Do not promote actual filtering.**
No production configuration, extraction cap, recording policy or routing changed.
This source prototype is not deployed behavior.

## Frozen setup and quota

`test/you-should-know-prefilter-corpus.ts`: 24 synthetic author-labelled cases,
16 IMPORTANT, 8 negative. A read-only review found the labels generally defensible;
this is not multi-rater adjudication, a held-out corpus or production prevalence.
Cases cover buried/implicit caveats, blockers, actions, decisions, resolved caveats,
quoted/hypothetical examples, routine/success, patterned secret redaction,
adversarial prose, opted-in failed tools and evidence truncation/source overflow.
Expected tool lookup misses are assistant summaries: actual failed-tool capture
excludes them. Arbitrary successful tool output is outside scanner consent/capture.

Before running, the controller was notified of the cap: at most 24 JEV and 24
catalog-low extraction calls, no retries; 6,000 classifier characters, configured
3-second JEV deadline, 60-second extraction deadline, 2,048 extraction answer tokens
per call (49,152 maximum over the replay). Actual JEV calls: **9**; the floor
prevented 15 network calls. Explicit eval invocation authorized in-memory consent
for this process only; the shared disabled TypeSafe config was not modified.
Only synthetic data was sent. Initial strip-only loader failed before any calls;
the successful replay used `--experimental-transform-types` and proxy-aware Node.

The retained [row-level report](prefilter-evaluation.json) includes model verdicts,
confidence, latency, reported usage and extraction completion status, never real
transcripts or credentials. Its potential-token field is explicitly `null` for
unchecked would-skip baselines.

## Measured results

| Metric | Observed |
| --- | --- |
| Potential extraction calls avoided | 2/24 (8.3%); `routine`, `redacted-routine` |
| Actual extraction calls avoided | **0** — shadow always extracts |
| IMPORTANT false negatives | 0/16; floor + JEV retained all 16 |
| IMPORTANT recall | 16/16 on this small synthetic corpus only |
| IMPORTANT examples actually classified by JEV | 5; the other 11 were floor-protected |
| JEV abstentions | 2/24 (`hypothetical`, `tool-lookup`, low confidence) |
| JEV latency (9 completed calls) | median 250 ms, p95 406 ms |
| JEV provider-reported tokens | 4,310 input + 378 output |
| JEV model | `jev-1.13.0` (configured `jev-latest`) |
| Low extractor | `meta/muse-spark-1.3-contributor` |
| Low extraction successes | **0/24**; all returned `stopReason=error`, zero reported usage |
| Potential extraction tokens avoided | **UNKNOWN**, no successful paired baselines |
| Monetary savings | **NOT MEASURED**; shadow adds JEV calls, saves no actual calls |

JEV classified seven examples (two skip, five scan), abstained on two. Floor
reasons: important evidence 10, failed-tool evidence 2, incomplete evidence 3.
`adversarial-important` was classified scan; adversarial routine text with explicit
instruction override was floor-protected. No observed important false negative
on five classifier-exposed positive examples is **not** proof of calibrated safety.
Resolved/quoted cases containing important keywords deliberately cost potential
savings rather than risking recall.

The 24 failed low-extractor responses cannot label skips as safe or establish
extractor relevance/recall. They are unknown baselines, not empty-note successes.
The two would-skip examples both have unknown baselines. An observed sum of zero
completed extraction tokens is not an estimate of tokens saved; the evaluator now
reports `null` when any would-skip baseline is unchecked.

## Confirmed policy boundary

The native Meta provider uses `https://api.meta.ai/v1`. This launch allowlist
included `api.typesafe.ai` but omitted `api.meta.ai`. After the replay,
proxy-aware `curl -sSI https://api.meta.ai/v1` returned:

```text
HTTP/1.1 403 Forbidden
X-Proxy-Error: blocked-by-allowlist
```

This is a sandbox policy refusal, **not** provider downtime. Error messages from
individual extraction responses were not retained, so their precise SDK failure
reason is not asserted. The endpoint refusal independently proves that a paired
live Meta evaluation cannot succeed in this launch. No retry, alternate host,
credential/configuration change or network-policy widening was attempted.
A future replay needs an authorized launch that can reach `api.meta.ai` and a
fresh explicit call quota. Existing extractor caps must not be lifted to compensate.

## Contract and review gate

`PI_YOU_SHOULD_KNOW_JEV_PREFILTER=shadow` plus existing explicit JEV config/key
opts into the experiment. Every other value, including `active`, stays off. Fixed
trusted choices are `scan`, `skip`, `abstain`; skip requires confidence >=0.95.
Tools, source overflow, excerpts over 6,000 characters, omission markers and
explicit important cues force scan. Missing consent/key, malformed answers,
uncertainty, timeout/error, empty evidence, busy transport and cancellation are
fail-open. This floor is conservative, not a comprehensive semantic detector.

The detached shadow call begins before the low extractor, **concurrently**, never
serially gating its start or completion. Results pair with pre-dedup extraction
counts/usage in non-context local session entries; no evidence text, severity,
destination authority, receipts or remote recording is introduced. An ignored
abort owns the long-lived prefilter client across branch changes and blocks only
new JEV requests, not extraction. Generation guards discard stale observations.
Original 20 attempted extraction scans / 30-second cadence / 60-second deadline /
2,048 answer tokens remain unchanged. No unbounded retries or off/on budget reset.

Before any actual opt-in filtering, obtain explicit controller/operator review,
a larger independently labelled held-out corpus, representative capture-boundary
and adversarial tests, successful paired baselines with provider usage, and an
agreed IMPORTANT false-negative acceptance criterion. This experiment has no
suppression implementation to turn on. Historical highlights are not current
verified blockers, and JEV has no severity or routing authority.

## Reproduce (consumes quota; not CI)

```sh
NODE_USE_ENV_PROXY=1 PI_YOU_SHOULD_KNOW_PREFILTER_EVAL=1 \
  YSK_PREFILTER_EVAL_REPORT=/tmp/ysk-prefilter-report.json \
  node --experimental-transform-types test/you-should-know-prefilter-eval.mjs
```

The evaluator resolves the exact Hive catalog-low model, never the main model.
Do not rerun merely because a policy denial or provider error is returned.
Deterministic tests use fake providers; they prove invariants, not live accuracy.
