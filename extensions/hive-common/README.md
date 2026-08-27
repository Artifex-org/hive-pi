# hive-common

Shared code for the extensions that talk to Hive: `hive-telemetry` (metrics) and
`hive-remote` (transcript + steering).

## This directory is NOT an extension

It deliberately has **no `index.ts`**. pi loads a top-level `extensions/*.ts`
file, or a directory's `index.ts`, as an extension — which is why
`hive-telemetry/accumulator.ts` is not loaded as one either. Adding an
`index.ts` here would silently turn a library into a loaded extension.

## Why the code lives here rather than in one of them

Both extensions need the same credential, the same endpoint, and the same
`/hive-login`. Two copies would mean two places to review when answering "what
can leave this machine", and two logins for one server.

| File | Contents |
| --- | --- |
| `identity.ts` | credential + config paths, `resolveAuth`, `resolveProject`, `resolveBranch` |
| `http.ts` | timeouts, error redaction, the 4xx/5xx retry classification, `validateToken` |
| `channels.ts` | in-process event-bus channels between Hive extensions |

## Two invariants

**The state directory name is frozen** at `~/.pi/agent/hive-telemetry`. It is no
longer an accurate name. A real credential already lives at that path on every
machine that has run `/hive-login`, so renaming it would silently log all of
them out, and the failure would present as "it mysteriously stopped working"
rather than as a migration.

**Nothing here may be called from a pi event handler.** All of it does blocking
I/O (file reads, `git`), and pi awaits handlers serially — a 15ms `git` call
inside one is 15ms of stalled agent loop. Callers resolve on a timer or in a
command handler.
