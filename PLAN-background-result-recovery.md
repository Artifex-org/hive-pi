# Background-result recovery

Scope: restore recorded background results across process restart using existing Pi session entries; no pi-durable migration, command replay or new dependency. Restore the active branch only, isolate sessions, reconcile persisted background notification identities, preserve waker approval/handback semantics. Unfinished recovered jobs are unconfirmed, not successful or restarted. Retain bounded output. Allow only background_list/background_result (read-only) in plan/discuss modes.

Acceptance: real process restart restores recorded output; commands are not reexecuted; persisted notices are not resent; queued/unpersisted notices remain recoverable; unfinished jobs stay unconfirmed; session switch/fork/branch/reload cannot leak running state; approvals never auto-wake; persistence failures remain visible. Full npm run check and quality_gate pass.

Delivery: local reviewed branch only; ask before publishing. Source-linked handoffs and cache measurements are separate follow-ups.

Evidence: hive-pi 3cbd8465; installed pi 1.0.2; upstream pi-durable f10993bc (experimental, no cross-process locking); pi-optchat d692f03d. SessionManager synchronously appends JSONL after first user/assistant message without fsync: process-restart recovery, not power-loss durability.

Progress: worktree created, inspected current background/waker/policy/session-manager. No implementation edits yet.
