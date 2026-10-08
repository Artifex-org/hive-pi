# Background-result recovery checkpoint

## Scope
- Native versioned snapshots, execution UUIDs, session/active-branch ownership, retained-output recovery; interrupted jobs `unconfirmed`, commands never replay.
- Exact read-only `background_list` / `background_result` permitted in plan/discussion; execution/cancellation remain gated.
- Generation/ownership invalidation before cancellation; shared waker isolates branches and owners.
- Native memory-before-write failures handled fail-closed for background. Canonical JSONL ids/parents validate journal writes, notification acceptance and restoration. Own waker closes, owned jobs canceled, graceful shutdown requested. No private SDK rollback or second database.

## Final verification
- `npm run check`, bg-3: typecheck passed; 281 files passed / 4 skipped, 4,658 tests passed / 13 skipped.
- Actual Pi 1.0.2 JSONL across SIGKILL windows, createAgentSession streaming/settling queues and native reload, output/execution identity and approval holds, real EISDIR start/terminal failures, marker-file no-effects assertion, fresh-manager subsequent write and another disk reopen, orphaned-parent detection, and actual asynchronous native-send failure followed by blocked background journaling.
- Five-pass ancestry scan benchmark with mostly abandoned branches: mean 0.84 ms / 1 MiB, 6.02 ms / 8 MiB, 82.69 ms / 64 MiB. Full-file synchronous scan is an explicitly documented performance tradeoff; incremental validation/runtime commit acknowledgement remains follow-up work.

## Limits / review disposition
- Does NOT fix Pi-wide transactional persistence. Native sends fail asynchronously; validation detects unsafe ancestry before subsequent background writes. Host shutdown and post-request tool-result/other-extension writes are not established stopped.
- No fsync/power-loss or exactly-once effects guarantee; in-memory sessions have no disk recovery. No PID recovery.
- Existing delayed process-group kill/PID-reuse warning is pre-existing, unchanged. Canceling the grace timer would leak stubborn descendants; advisor did not require scope expansion absent a new regression.
- Handoffs, memory hierarchy, model-cache eligibility/priming and Hive claim/ack semantics deferred.
- Advisor reviews drove cancellation fencing, held-notice coverage, real writer failure/reopen tests, native queue tests, ancestry checks and measured performance/guarantee disclaimers.
- User authorized publication with `push`. Commit `6bc6a77` pushed on `fix/background-result-recovery`; PR https://github.com/Artifex-org/hive-pi/pull/131 targets main. GitHub checks all passed (check plus both secret scans), verified at exact head `6bc6a77293da7a69a2cfde5fefca8716c645d807`; bg-4 completed successfully. No install, live settings change, KB publication, merge or deployment performed. Scratch plan/progress notes remain untracked.
