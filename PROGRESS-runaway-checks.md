# Runaway verification / Navi incident remediation

## Scope
- Fix process-tree cancellation after GNU timeout changes process groups (independent child-tree worker branch, integrated before delivery).
- Serialize duplicate automatic verification per canonical worktree and limit host-wide automatic check concurrency. Never reuse cancellation as green evidence.
- Persist an input-aware attempt receipt before starting a Stop-hook gate; do not repeatedly spend the short hook budget checking unchanged input. Report host-cutoff as incomplete and direct explicit verification.
- Protect workstation Navi execution at the executable boundary against headless interactive finder retry (separate dev-linux PR; no activation performed).

## Acceptance
Regression tests prove escaped descendants die, stale/canceled jobs are not pass, unchanged gate input is not automatically rechecked, concurrent hooks do not launch duplicates, and changed HEAD/content/command re-enables checking. Run typecheck/test and repository gate. Delivery is reviewed PRs, not merge/deploy; existing sessions are preserved.

## Evidence
Incident KB: memory/harness/gnu-timeout-escapes-stop-hook-process-group.md; memory/workstation/navi-headless-finder-retry-memory-growth.md. Baseline hive-pi 1dd133625.

## Current checkpoint
- Full baseline gate: `GOMAXPROCS=4 npm run typecheck && npm run test -- --maxWorkers=4` — typecheck and 5,518 tests passed (333 files; 20 existing conditional tests skipped). Subsequent stale-session-stamp and completely exhausted admission regressions were reproduced and fixed; final-head results are recorded in the PR. The default-concurrency run hit workstation saturation (load >150); bounding local runner concurrency preserves every selected check, timeout and assertion.
- Navi PR: https://github.com/joan-arau/dev-linux/pull/95. Ten tests pass against the real backend and actual ZLE Ctrl+G. Mutation controls fail when widget insertion is removed. Final review has no findings. Its initial Ubuntu gate found the missing distro package; CI installation is being corrected. No wrapper activation.
- User approved a TEMPORARY live mitigation in the active `agents-pyerp-ae340365` worktree: `.pi/harness.json` `maxInjections: 3` -> `0`; only that automatic gate is paused. Manual verification and sessions remain available. This setting is intentionally not a pyERP delivery change; restore **3 only after** the permanent fix is activated and verified, without disturbing other worktree edits.
- Cancelled five captured orphaned compiler groups, then two already-started compilers. An in-flight compiler appeared during the first monitor and subsequently exited. Latest sample: no target compilers, CPU 37.9%; not a guarantee of permanent prevention. No live harness code or Navi wrapper installed.

