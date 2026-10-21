# Test temporary storage

Use `npm test -- <vitest arguments>` or `npm run check`. The latter still runs
full TypeScript checking followed by the full Vitest suite. Direct `npx vitest`
bypasses invocation ownership and is not the supported test entrypoint.

The wrapper creates a private run directory under
`${XDG_CACHE_HOME:-$HOME/.cache}/hive-pi/tests`. Set `HIVE_PI_TEST_TMP_ROOT` to an
absolute, short, disk-backed directory when that cache location is unavailable.
Existing roots must belong to the current user, have mode 0700, and have no
symlink ancestors or control characters. Linux tmpfs and ramfs are rejected.
Keep paths short enough for Unix socket fixtures. No dependencies are copied to
system temporary storage, and no shared `/tmp` cleanup is attempted.

Before starting Vitest, the wrapper sets `TMPDIR`, `TMP`, `TEMP`, and
`NODE_COMPILE_CACHE` inside the run. This covers Vite startup and fixtures, not
just test hooks. npm and the wrapper's own Node startup precede this boundary:
their earlier caches are neither relocated nor swept. For reproducible leak
measurements, keep the parent npm cache configuration identical before/after.
Explicit writes outside the run are not redirected.

## Cooperative ownership and admission

The wrapper owns the runner's process group and inherited child-tree token.
A test-only Node `--import` preload also publishes durable PID/start-time reader
leases before Node descendants execute their test/application modules. Hermetic
fixture environments retain the preload, run directory and temp settings through
`test/temp-env.ts`. Intentional native/session-changing fixtures explicitly
register before accessing run artifacts. A native subprocess must remain covered
by its live registered owner/group until exit, or be registered before handoff.

Admission has a per-run barrier, not a whole-host liveness requirement:

1. A reader atomically publishes its PID/start-time lease, then checks that the
   run exists unchanged and has no `closing` marker. Rejected readers must not
   access artifacts. Temporary unpublished records confer no admission.
2. Cleanup first verifies the owner/runner and runner group are finished, then
   exclusively creates `closing` before inspecting the reader leases.
3. A reader admitted before closing is visible to cleanup. A late publisher
   sees closing and fails before artifact use. A live or unreadable registered
   reader retains the run; the cleaner removes its own barrier to allow later
   admission/recovery. A dead cleaner's barrier is quarantined, not stolen.
4. Only after these checks does cleanup claim the directory by rename and remove
   it. Versioned ownership, private directories, inode checks and symlink fences
   restrict deletion to that run. Interior symlinks are unlinked, never followed.

The existing child-tree helper handles termination. INT, TERM and HUP propagate;
TERM-resistant children receive KILL after a grace period. Successful cleanup
preserves the test exit code. Test failures remain failures; cleanup I/O errors
or unverified normal Linux completion also produce a nonzero exit with a reason.
Recovery itself never signals another run.

## Recovery and limits

A later invocation can recover a killed wrapper's run once its owner, runner,
group and registered readers are dead. Boot/PID-namespace mismatch, incomplete
bootstrap or ownership publication, unreadable **owned** identities and an
interrupted cleaner retain artifacts with distinct diagnostics. A kernel-existing
runner group is also retained, even when its only observable members are zombies:
a filtered process snapshot cannot rule out an unreadable live member. A
non-reaping init can therefore prevent recovery until those zombies are reaped.
Other POSIX
platforms still get disk-backed isolation but retain rather than claim verified
process cleanup. SIGKILL cannot execute a finalizer; reclamation is not universal.

As additional protection, Linux cleanup preserves observable token, cwd,
executable, descriptor, mmap and Unix-socket references to the run. The original
unregistered, env-cleared detached FD/cwd/socket regressions exercise this check.
It is best effort, not an absence proof: unrelated opaque services and host PID
churn do not block ordinary tests. Arbitrary unregistered FD transfers, future
reopens, native escapes that abandon their registered owner, or deliberately
removing the registration preload are outside the cooperative contract. Register
such readers **before** handing off artifacts; do not rely on a snapshot scanner.
No privileged inspector or systemd dependency is installed.

The private root is not a security sandbox against a malicious same-user process
continually replacing paths between syscalls. No age-based sweep is used.
Lifecycle, admission-race and symlink-substitution tests run in the normal suite;
real Unix sockets require an unsandboxed runner. GitHub Actions runs the full
`npm run check`, including those tests, without new skips or narrower gates.
