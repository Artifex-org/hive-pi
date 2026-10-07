# Workspace grant papercuts — 2026-10-07

Branch: `fix/grants-judge-papercuts`, baseline `3cbd8465c`. Companion judge restoration: `fix/grants-registry-judge` in Hive (separate draft PR, still in progress).

Confirmed mechanisms: default-off workspace consent hid both native deferred tools despite CLI advice naming them; an approved one-shot grant value fetch preserves the approved verdict, so HTTP 410 bypassed the old error-only delivery handling. Tools now remain diagnostic-only without opt-in, preserve absent `can_add_workspace`, and distinguish delivery from successful cloning and transient fetch failures. No operator configuration changed.

Verification: standalone baseline/reverification `scripts/grant-papercut-probe.mjs`; focused grant/goal judge tests 239 passed; real SDK `load_tools` and `tool_search` discovery 2 passed with zero model/auth/network calls. `npm run check` passed TypeScript and 4,643 tests (13 existing skips; 281 passed/4 skipped files). Full-suite LSP fixture was made independent of ancestor platform-package resolution; the shutdown failure did not reproduce and no production LSP changes were made. Independent read-only review found no issues. `quality_gate` ran but reported no adapter in this repo; the actual package gate is `npm run check`.

Limits: goal-judge regression tests establish fast-pass/inherited-thinking confirmation, error separation and pause behavior, not live paid-provider or deployed judge behavior. An initial CLI discovery probe used `ctx.executeTool` outside tool context, failed before assertions, and unintentionally invoked an inherited OpenRouter model with read/bash tools; it was terminated. Its transcript showed read-only tool activity, the process check found no surviving probe, and no tracked modifications resulted. It is NOT discovery evidence; the isolated SDK test replaces it. Approval judge remains disabled; grant opt-in unchanged. No merge/deploy/live judge activation authorized.

Delivery: task-owned changes only; raw telemetry/logs excluded. Draft PR and final-head checks pending.

---

# Preserved upstream checkpoint

# YSK implementation — verified, publication pending

Branch: `feat/ysk-findings`. Backend/UI companion: Hive branch `agents/hive-a6a897b1`, worktree `/home/joan/repos/hive__worktrees/agents-hive-a6a897b1` (full evidence in its `PROGRESS.md`).

Implemented exact catalog-low/explicit-override extraction without selected-model fallback; bounded/redacted tool opt-in; fixed-question, confidence-abstaining shadow Jev; durable branch/session-bound findings/receipts; separate recording controls with monotonic revisions and no off-era backfill; bounded authenticated remote transport and real remote-loader integration.

Final current-tree `env -u PI_AGENDA_WORKER npm run check` passed TypeScript and 4,379 tests (13 existing gated skips; 267 passed/4 skipped files), `/tmp/ysk-final-client2.log`. Focused real remote/recording/retry suite passed 28 tests; extraction/guard suite passed 49. `git diff --check` passed. The harness quality-gate helper reports no configured gate here; `npm run check` is the manifest-declared gate.

Tests use fake providers/APIs; scanner fixtures explicitly disable operator Jev configuration/credentials. No live-provider relevance, live destination delivery, or deployed browser behavior verified. Client retries stop after five per capture/control/reconnect; server dispatch is POST/reconnect-driven, not an autonomous outbox. Ambiguous attempted writes remain uncertain and require operator reconciliation. Jev never suppresses/reroutes/grades severity; its unknown monetary cost is not folded into extraction usage.

At this verification checkpoint, no task commits/pushes/PRs existed. Operator subsequently authorized committing/pushing both task branches and linked draft PRs, with associated docs/KB sync. Merge/deploy/live routing and configuration changes remain unauthorized. Preserve test environment fixes: explicit ordinary/launched consent and optional-lock negative control, not weakened production guards.

KB sync: `knowledge-base/infrastructure/cicd/hive.md`, direct commit `1841964e0825afbae45c535f450d95506ec08d90`, records the pending-review contract and evidence qualifications. Publication URLs and final-head checks will be recorded in the PRs.


## Preserved upstream HIV-3757 checkpoint (merged from 629145d)

# HIV-3757 evidence

- Native opt-in classifier added at `extensions/typesafe-common/native.ts`; object state preserves JSON keys, scalar/array state is wrapped under `data`. Remote error envelopes and thrown prose are never surfaced. Missing context/model returns no verdict; old nondefault endpoint is refused.
- SDK-native agenda + plan continuation preserves prior handler drafts, continuation ownership and completed-outcome guard. Active-boundary regression covers both actual extensions in both registration orders; a queued-input regression preserves interruption behavior.
- Real public `createAgentSession` + offline faux provider test proves two model calls, one committed agenda draft, one terminal settle, and false `isIdle()` at both boundaries. Credentials/model-cache paths are temporary; no operator config is modified.
- Independent review found cooperative-only timeout. Native transport now races abort independently and removes its listener; a never-settling provider regression protects the deadline.
- Native Meta provider factory is reused, with only strict-tool compatibility overridden. The exact public `providers/meta` package export is verified; private `/compat` imports remain forbidden and named subpath debt stays empty.
- Prior full check: 4,366 passed, 13 pre-existing skipped tests, typecheck passed (`/tmp/c38589c7-pi-final-check.log`). This predates the final active-boundary, hard-deadline and actual SDK tests: it is NOT final-tree evidence.
- Final complete tree check passed: 4,368 tests, 13 unchanged pre-existing skips, 264 test files passed; typecheck passed (`/tmp/c38589c7-pi-delivery-check.log`). Actual SDK fixture and focused boundary/classifier/plan regressions passed independently. No repository-specific quality_gate adapter was found; `npm run check` is the real package gate. Final-head PR CI remains pending. Test process isolates inherited launch-consent and git optional-lock environment only; no gate is skipped.
- Known SDK limit: before-settle has no core active-run signal after the model turn. Do not infer immediate human-abort cancellation or zero ledger charge from tests using an explicit fake signal. Source delivery does not establish live paid-provider acceptance.
