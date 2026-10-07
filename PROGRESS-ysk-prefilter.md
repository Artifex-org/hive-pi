# YSK prefilter checkpoint

Base: HEAD=origin/main=228d022 (2026-10-07); task branch agents/hive-pi-0d8d51e6.

Implemented opt-in shadow-only pre-extraction observations, no suppression path.
The original low-tier scan always runs, independent of shadow timeout/busy state.
Dedicated fixed scan/skip/abstain choices, 0.95 confidence bar, 6k evidence bound,
redaction, conservative important/tool/incomplete floor. One prefilter client
survives branch changes and retains pending ignored-abort transport ownership.
Non-context observations retain baseline counts/usage only; no recording writes.

Focused YSK suite: 134 tests pass; tsc --noEmit and git diff --check pass.
Independent final read-only review found no consequential source issues. Additional
capture-truncation and in-flight recording-revocation regressions pass. Gitleaks
working-tree scan passed. quality_gate found no adapter; the public manifest and
GitHub Actions use npm run check (typecheck + full Vitest).

Initial full local check: 4601 passed / 30 failed / 13 unchanged skips, 11 errors.
Failures include sandbox-blocked Unix sockets (EPERM), shared scratch paths (EROFS),
and loopback requests inherited through the egress proxy. Focused watchdog suite
passes all 5 with local proxy isolation. Final full suite with loopback NO_PROXY
is running; Unix-socket/shared-path policy is not bypassed. Publication/final-head
GitHub gate pending at this checkpoint.

Live synthetic replay: 24 frozen labels, 16 IMPORTANT; 9 JEV calls, 4310 input +
378 output reported tokens, median 250ms/p95 406ms. Would skip 2/24, IMPORTANT
false negatives 0/16 (5 positives actually classified; 11 floor-protected), 2
abstentions. Actual calls avoided=0. All 24 low-extraction baselines failed with
zero reported usage. Confirmed proxy policy refusal for api.meta.ai, absent from
this launch allowlist. No retries/alternate hosts or shared config modifications.
Potential tokens/dollar savings and low-extractor relevance remain unverified.
See extensions/you-should-know/prefilter-evaluation.md for evidence/caveats.

Controller received approach, quota, measured results and policy blocker via
steer_agent follow_up. No actual filtering or deployment claimed; keep session
available for controller review/steering after PR delivery.
