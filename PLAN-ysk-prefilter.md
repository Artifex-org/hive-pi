# YSK pre-extraction JEV experiment

Controller: Hive session f41d57b6-b0c7-43dc-9132-0c771794141b.
Scope: hive-pi only; no Hive UI or shared config changes.

- [x] Refresh main and inspect scanner/typed-client lifecycle and prior art.
- [x] Add separately opt-in, fixed-choice, bounded/redacted shadow classifier.
- [x] Keep low-tier extraction/caps/recording/routing unchanged and nonblocking.
- [x] Freeze author-labelled synthetic corpus and test lifecycle/fail-open behavior.
- [x] Run capped synthetic eval (<=24 Jev + 24 low calls, no retries).
- [x] Run quality_gate (no adapter), manifest gate, focused tests, independent review and gitleaks.
- [x] Open separate draft PR #124 and report artifacts/results to controller.
- [ ] Observe final-head GitHub checks; local full gate is sandbox-blocked, not green.

Promotion is not authorized. Paired live baseline/token savings remain unknown
because api.meta.ai is blocked by launch policy. Any future rerun/promotion needs
explicit review and a new quota in an appropriately authorized launch.
