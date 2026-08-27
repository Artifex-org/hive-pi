# test/manual

Drivers you run by hand against a **live Hive**. Not vitest, not CI: they need
`HIVE_URL`/`HIVE_TOKEN`, they spend fleet capacity, and their result is something
you read rather than something that asserts.

They are here because a typecheck is not a smoke test. Between them, on their
first outings, they found four defects that 2,500 green unit tests did not —
each one a piece of code that was type-correct, tested, and wrong about the
world (a rejection's `request_id` adopted as a run id; an `unref`'d poll timer
that let the event loop empty; a run Hive marks `running` while every task is
still `ready`; a verdict line that counted failing *checks* as failing *steps*).

```bash
# Dispatch a real check and follow it, printing every snapshot the widget ships.
node --experimental-strip-types test/manual/gate-hivecheck-dispatch.ts <repo-path> [steps]

# Replay a run that already finished — the cheap one. No fleet cost at all, and
# a run with substeps (any Aurora `ci` run) is the only way to see the two-level
# rows against real data.
node --experimental-strip-types test/manual/gate-hivecheck-replay.ts <run-uuid>
```
