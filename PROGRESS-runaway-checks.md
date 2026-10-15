# Runaway verification / Navi incident remediation

## Scope
- Fix process-tree cancellation after GNU timeout changes process groups (independent child-tree worker branch, integrated before delivery).
- Serialize duplicate automatic verification per canonical worktree and limit host-wide automatic check concurrency. Never reuse cancellation as green evidence.
- Persist an input-aware attempt receipt before starting a Stop-hook gate; do not repeatedly spend the short hook budget checking unchanged input. Report host-cutoff as incomplete and direct explicit verification.
- Protect workstation Navi execution at the executable boundary against headless interactive finder retry (separate dev-linux PR; no activation performed).

## Acceptance
Regression tests prove escaped descendants die, stale/canceled jobs are not pass, unchanged gate input is not automatically rechecked, concurrent hooks do not launch duplicates, and changed HEAD/content/command re-enables checking. Run typecheck/test and repository gate. Delivery is reviewed PRs, not merge/deploy; existing sessions are preserved.

## Evidence
Incident KB: memory/harness/gnu-timeout-escapes-stop-hook-process-group.md; memory/workstation/navi-headless-finder-retry-memory-growth.md. Investigation baseline hive-pi 1dd133625; delivery rebased onto a52f2da (workspace-consent fix, nonoverlapping files).

## Current checkpoint
- Full baseline gate: `GOMAXPROCS=4 npm run typecheck && npm run test -- --maxWorkers=4` — typecheck and 5,520 tests passed (333 files; 20 existing conditional tests skipped). Stale-session-stamp, exhausted-admission and preparation-budget failures were reproduced and fixed. Latest focused run: typecheck and 104 tests in 12 files passed, including independent Node-process exclusion/two-slot limits, holder termination, queued-owner death without execution, queued input refresh with failure replay, successful-but-stale execution downgraded to incomplete, and Pi session-replacement reoffer/acknowledgement. The delivery PR must record final-head full-suite/CI evidence separately. The default-concurrency run hit workstation saturation (load >150); bounding local runner concurrency preserves every selected check, timeout and assertion.
- Final review followups reproduced obsolete queued command/timeout/disable execution, cross-TMPDIR duplicate admission and unsafe public/symlinked coordination state; each now has a failing-before/passing-after regression. Deadline/cancellation reaches parallel metadata subprocesses and their descendants, with no fresh preparation after exhaustion; post-execution expiry is incomplete rather than pass. Two native fingerprint samples over 1,588 proc entries fell from 477/425 ms to 103/104 ms by excluding older processes from inherited-token environment reads (not a production throughput benchmark). Synchronous filesystem/kernel stalls and owner SIGKILL still require OS containment. Existing unborn-HEAD behavior deliberately reports raw command status, not input-bound verification: a regression proves it cannot create/reuse a receipt.
- Navi PR: https://github.com/joan-arau/dev-linux/pull/95. Ten tests pass against the real backend and actual ZLE Ctrl+G. Mutation controls fail when widget insertion is removed. Final review has no findings. Both final-head checks passed at 1c1f81f; Ubuntu installation uses checksum-pinned upstream Navi 2.24 because no distro package exists. No wrapper activation.
- User approved a TEMPORARY live mitigation in the active `agents-pyerp-ae340365` worktree: `.pi/harness.json` `maxInjections: 3` -> `0`; only that automatic gate is paused. Manual verification and sessions remain available. This setting is intentionally not a pyERP delivery change; restore **3 only after** the permanent fix is activated and verified, without disturbing other worktree edits.
- Cancelled five captured orphaned compiler groups, then two already-started compilers. An in-flight compiler appeared during the first monitor and subsequently exited. Latest sample: no target compilers, CPU 37.9%; not a guarantee of permanent prevention. No live harness code or Navi wrapper installed.

