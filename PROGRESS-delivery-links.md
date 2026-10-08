# Background PR delivery links — 2026-10-08

## Reproduction and cause

PR [hive-pi#138](https://github.com/Artifex-org/hive-pi/pull/138) was published by
`background_bash` at 21:26:20.785Z. The installed remote reporter recognized only
successful direct `bash` tool results whose command contained `gh pr create`.
Its detector returned the URL for `bash` and null for `background_bash` with the
same command/output. Background starts return a job handle, not the eventual
PR URL; merely widening that detector's accepted tool names would not fix it.

The session started in `/home/joan`. Changing a shell command's `cwd` does not
change pi's session directory. Live reads showed no branch or primary PR,
`conversation/pulls` returned `{"items":[]}`, and `worktree` returned HTTP 204.
The worktree reporter deliberately skips non-repositories, so there was no
branch/worktree fallback. No machine configuration has been changed.

Shell jobs do not emit the owner-to-registry `background.job` bus events.
The actual completion seam is the background extension's custom message.
The producer holds the authoritative command, status, exit code and retained
output before truncating the displayed notification.

## Fix

- One shared created-PR extractor keeps foreground and background command/URL
  recognition consistent. A `gh pr view` or arbitrary printed URL is not a
  creation event.
- Successful shell completion adds an optional structured `pullURL` to its
  existing notification, derived from the actual command and retained output.
  Failed, canceled, timed-out and unconfirmed jobs do not assert delivery.
- The remote reporter consumes that metadata only for the matching native
  session and a terminal success with execution identity. No polling and no
  assistant/user-link scraping are introduced.
- Attempts and accepted URLs are deduplicated; replacement sessions do not
  receive stale asynchronous rejection notices.
- A rejected association produces a visible, non-waking warning with the HTTP
  status/error rather than silently discarding the result. Access controls and
  the server API are unchanged.

Nested codemode calls already emit `tool_execution_*` events with
`parentToolCallId` in installed pi 1.0.2; a regression protects that existing
reporting path. No codemode executor or schema change is needed.

## Separate live visibility blocker

An explicit association POST for #138 returned HTTP 404:
`pull request project not found`. The exact deployed server source at
`e265c364` returns this wording when repository lookup succeeds but project
visibility is denied. An unregistered repository has a different error.
The compact `/projects` list contains only names/run counts and cannot establish
repository registration by inspecting URLs.

This session cannot bypass or widen that visibility boundary. A project
administrator must resolve the session owner's project access before #138 can
be associated. The client fix does not claim to repair authorization, register
a project, retroactively attach an old notification, or deploy itself.

## Verification and limits

Final focused verification: typecheck and 98 tests across `pull-delivery`,
`background-extension` and `hive-remote-wiring` passed. The real-process
completion regression was rerun with the old notification shape: it failed on
the missing `pullURL`; restoring the fix made the exact same command pass.

The producer test runs a real, harmless shell fixture printing a PR URL; it does
not contact GitHub. It verifies structured evidence survives notification-tail
truncation and is absent on command failure. Reporter tests use the real client
HTTP classifier against a fake Hive response and cover completion without
polling, invalid outcomes/session identities, duplicate notifications,
association rejection and nested-call events. Pure lifecycle tests cover
in-flight deduplication, replacement-session races and explicit new-execution
retry after rejection. These do not prove that the live, denied project can be
linked; that remains blocked by the authorization response above.

Full `npm run check` passed typecheck and 4,927 tests across 306 test files;
13 pre-existing tests were skipped in four files. `git diff --check` passed.
`quality_gate` found no recognized repository gate and ran no checks; this is
not called a pass. The declared gate above is mirrored in GitHub CI.
Independent review identified pre-attachment loss and rejected-promise state;
both were fixed with queueing, lifecycle clearing and regressions. Failed
association notices also enter the Hive transcript, not just the local terminal.
Deduplication is in-memory; replay after reload can resubmit an idempotent
association. No durable client ledger or auto-retry loop was added.

A separate Hive-side gap was confirmed: successful associations publish no SSE
doorbell and the open rail never invalidates its pull-reference query. That is
being repaired in a coordinated Hive PR, independently of this client change.
Final-head GitHub checks are followed after publication. No merge, deployment
or live harness replacement is performed by this task.
