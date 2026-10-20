# Compaction method reporting

Branch: fix-compaction-method-reporting; base d9f632706.
Companion Hive UI branch: fix-agent-compaction-indicator.

## Changes
- Successful session_compact folds a durable notice: Compaction completed · method: Pi summary/Extension summary · trigger: manual/threshold/overflow · actual saved tokensBefore.
- fromExtension identifies the built-in/extension category, not a third-party algorithm. Missing category is unreported, never guessed.
- Failure/cancellation may precede method selection; report outcome without inventing a method.
- Enum-only handoff channel emitted only after seed write succeeds on command/tool or opted-in threshold branches. Notice says seed written, never successor launched.
- Ordinary hooks remain detached. Terminal-only shutdown joins the serialized send and drains queued notices within an overall 4s deadline, then releases listeners; transient refusal stops draining rather than retrying indefinitely.

## Verification
- Initial missing-method, truthful-outcome, handoff and shutdown regressions RED before fixes.
- Wiring now 48 passed, including success/failure/cancel heartbeat clearing, switch/reattach, immediate shutdown, in-flight batch, transient refusal and overall deadline. Handoff producer tests 7 passed.
- Final normal-session npm run check: 4670 passed, 13 pre-existing skips; 283 test files passed, 4 pre-existing skipped; typecheck clean.
- Worker-context full check reported worker/harness failures; these did not reproduce under normal-session check (PI_AGENDA_WORKER unset). No test suppression used.
- Cleanup only runs from stop and shutdown. Switching rebinds via telemetry run id; exact-one-notice delivery to the new session is tested. Reload recreates the extension factory.
- Generic quality_gate adapter absent; actual public-repo CI .github/workflows/check.yml runs typecheck + npm test, exercised through npm run check.
- Operator authorized companion DRAFT PR publication after final checks. No merge, deploy, live trading change or running-session reload.
