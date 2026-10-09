# HIV-3832 round-2 harness fixes

- Base: origin/main ba83466 (includes #144, #145, #146). No open GitHub PRs at kickoff; Hive list_pulls denied public-project access.
- Implemented: 2-minute foreground follow / 1-minute admission wait; automatic existing watcher handoff for pi and Claude; no fleet cancellation on timeout or abort.
- Implemented: bounded changed-function/caller inventory in review packs and scope classification; reuses lens symbol scanner for body-only changes.
- Focused verification: 60 tests passed across gate handoff, queue classification, caller discovery, review pack and delivery checkpoint suites.
- Adversarial review found and fixed generic-call discovery, body-only Rust impl discovery, and timeout tests coupled to production constants. A mutation restoring 45 minutes fails the independent 120-second test.
- Full local `env -u FORCE_COLOR npm run check`: typecheck passes; 5006 tests pass. 30 failures are Unix socket EPERM and writes into the launch-excluded shared scratch root (EROFS); no tests were skipped or weakened to mask these. Two additional initial failures were local TCP fixtures routed via the launch proxy; loopback NO_PROXY resolves them.
- quality_gate finds no vendored gate here; this public repo's actual gate is npm run check in GitHub Actions.
- Later reviews also found and fixed unbounded source span scans, Rust lifetime/character-literal handling, and cancellation-path handoff. Pi now tests its actual nested-call pipeline and detaches the watch signal; MCP cancellation starts no unannounceable watcher. Source discovery and grep share a budget, with explicit outline/span caps.
- Remaining: final foreground evidence review before first push, one PR, final-head GitHub Actions npm run check and gitleaks green.
