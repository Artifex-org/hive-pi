# Communications aide delivery

- DRAFT PR: https://github.com/Artifex-org/hive-pi/pull/160
- Head: 247e56cfea5eef5b185b0490cdf475b34d4335fa; branch feat/communication-aide.
- Verified exact final tree: npm run check, 5,327 passed / 20 conditional skips; 153 focused tests passed; diff whitespace and gitleaks clean. Final committed-diff foreground reviewer: No findings.
- CI GREEN at final head: check/check passed (3m1s), push gitleaks passed (7s), PR gitleaks passed (8s). bg-14 completed successfully; final gh pr checks exits 0. Draft remains unmerged.
- Feature: opt-in in-session low/medium tool-less communications aide, not teammate; archive, bounded digests/inbox, unchanged controller/wake safeguards. SDK write failures, native fresh-session persistence, tree recovery, cancellation/settlement, origin-bound usage and telemetry consent covered.
- No merge, rollout, live activation or workstation config changes authorized/performed. Original Hive worktree clean. Live provider judgment/team traffic untested; reported usage is not a billing cap. Inactive-origin deferred usage can be lost on process exit; server claim-to-archive gap remains.
- Hive Delivery association failed HTTP404 because public hive-pi is not a registered Hive project; actual GitHub draft exists.
- Kept checkpoint outside repository temporarily for review stamping: every untracked file makes delivery diff unstampable. Restored here after push/PR; keep untracked.

- Before promoting beyond draft, follow-up coverage: eight-message/24k batching boundaries, cumulative 100-batch cutoff, throwing fail-open delivery, and full native fallback end-to-end flow. These are coverage gaps, not demonstrated defects.
