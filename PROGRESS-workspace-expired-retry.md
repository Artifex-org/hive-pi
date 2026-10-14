# Workspace approval retry after expiry

- Root cause: native request_workspace keys every invocation by workspace:<repo>; the server permanently replays terminal rows by design.
- Fix: optional explicit request_id opens fresh consent; default and same-ID calls rejoin. No server row reset, auto-approval or permission changes.
- Regression failed before implementation (same POST ID); focused 22 tests and typecheck pass after implementation.
- Initial full npm run check passed: 328 files, 5479 tests; 4 files / 20 tests skipped by existing suite conditions.
- Review finding resolved: valid grant, temp directory, exact clone command and exactly-one clone assertion; final re-review has no findings. Added concurrent same-ID pending rejoin coverage; focused retry test and typecheck pass.
- Final reviewed-tree npm run check passed: typecheck plus 5479 passed / 20 skipped (328 files passed, 4 skipped). Grant IDs are distinct from request keys; exact delivery URL is asserted. Final foreground review: no findings.
- Affected session's new REST request has actual owner approval (22:30:05Z); grant delivery and node-supported checkout are not yet verified.
