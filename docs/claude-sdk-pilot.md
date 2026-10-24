# Bounded owner SDK pilot

This is a restrictive diagnostic protocol, not SDK admission. Hive admission is
default-off and independently verifies the owner, launch, session, node readiness
and assigned account. Deploy the guarded runtime before enabling an owner.

Profile discovery is separate from provider selection. Pinned Pi's explicit
`--extension` path does **not** disable package/directory plugin discovery. A
single `pi.extensions` directory entry can load multiple factories and lifecycle
handlers. `test/claude-sdk-loader.test.ts` exercises that behavior and explicit
entry deduplication through the real pinned loader and event runner using only
synthetic plugins. `noExtensions: true` excludes discovered siblings, so it is
**not** a substitute for the required complete private-profile composition.
These offline tests execute no private profile or SDK/provider, and do not
establish full-profile safety, bootstrap or installed readiness.

## Private native transport primitive (not bootstrap authority)

Linux `extensions/claude-sdk/native/private-ipc.c` uses public Node-API v8 and
pinned, header-only `node-api-headers`. Build explicitly, never from an install
hook or as an automatic runtime fallback:

```sh
node scripts/build-claude-sdk-private-ipc.mjs --output /absolute/private/artifact.node
python3 scripts/claude-sdk-private-ipc-check.py
```

The sender accepts only inherited fd3 as a nonblocking Unix seqpacket socket,
burns its loaded native instance before validation, retains a duplicate for the
operation and invokes `SYS_sendmsg` once with `MSG_DONTWAIT | MSG_NOSIGNAL`.
EINTR, EAGAIN, short send, malformed input and lost reply cannot restore that
instance. A fresh JS consumer or require-cache deletion does not reset it. Node's
`fs.writeSync` is not used: its libuv path retries EINTR. A local complete send
is neither a parent reply, a purpose client grant nor an archive acknowledgment.
The clock accessor returns Linux BOOTTIME, not a new deadline or authority.

The Linux x86_64 CI fixture traces the direct Node child's initial thread and
checks actual successful packet credentials against that retained child. Fault
cases intercept entry, suppress kernel execution and synthesize syscall-exit
EINTR/EAGAIN/short-send results; they are not real kernel-returned failures.
The current C callback is synchronous; this is not an all-thread regression
counter against a future worker fallback. The unprovisioned-fd fixture closes
fd3 before Node starts, so it is not an isolated EBADF proof if Node reuses that
number. Missing compiler/ptrace/platform support fails rather than skips. These are transport fixtures, not genuine Pi
session/process binding, approved full-profile capture, a provider/private-service
route, original-deadline enforcement, client ACK or installed readiness. Separate
artifact verification/distribution and actual bootstrap integration remain
required. Multiple native artifact copies or replacement processes must never
recreate authority; the parent still has to enforce the one-use challenge and
exact retained process/session independently of this loaded-instance latch.

Only a launch explicitly marked `HIVE_CLAUDE_SDK_PILOT=1` registers
`/claude-sdk-pilot --exclude claude-7`. Invoke it once in a fresh session.
Its persistent launch-private attempt latch is acquired before arming and is
never removed or refunded. Reusing the same state root across extension reloads
or process restarts cannot replenish the attempt. The node must preserve that
root for the owned runtime; deleting it is not a supported retry mechanism.
Exclusive creation consumes the latch before write/sync/close. Those subsequent
operations must all succeed before arming; a failure still owns a failed outcome.

The first SDK query reserves two agentic turns. Normal Pi filesystem tools must
produce a successful nonce read and an actual guard-denied write, with matching
canonical tool results and an unchanged fixture. After correlated `agent_settled`,
a private extension input is queued: pinned Pi defers it until every settlement
listener returns. The pilot acknowledges and consumes it before authentication,
history insertion or model execution. The idle flag alone is not a barrier.
Intercepted or failed acknowledgments cannot advance the protocol; cancellation
or the deadline closes the attempt. Late reserved controls after reload are
consumed without inference. After strict runtime reset, one fresh SDK query
reserves the final turn and recalls the nonce from
canonical history without tools. Neither the recall prompt nor report contains
the nonce. Query output is capped at 512 tokens.

Three SDK turns are **not** three HTTP requests. The native CLI may retry HTTP
internally; HTTP attempts remain unmeasured. There is no account switching, paid
fallback, automatic protocol retry or second attempt after an ambiguous failure.

The real Pi prompt, tool definitions, resource loader and guards remain in place.
The pilot adds tool-call restrictions; it does not replace tools with a facade.
Pilot-only initiation guards suppress optional recap, brief, goal judge, drift,
advisor-watch, classifier, scanner, communications aide and btw inference.
Deterministic Agenda gates remain active. Worker identity is unchanged.
A restored aide declines new interception, so ordinary teammate delivery remains
responsible. Native hooks, memory and compaction remain disabled by SDK options;
Pi compaction is refused during the pilot. SDK models do not advertise a prompt
cache TTL, so the core cache warmer has no eligible SDK model.

The local extension deadline starts before latch/fixture setup, not after it.
It does **not** yet establish or enforce the original Hive DB acceptance +180s
authority deadline across startup or restart; that remains an admission blocker.
Local expiry closes admission and fences late setup/read/reset completions from advancing the
protocol. Query and fixture cleanup start independently with a shared observation
window of at most five seconds (or the shorter configured attempt duration).
Artifact publication has its own equally bounded observation window, so a stalled
write cannot suppress subsequent channels or keep `done()` pending indefinitely.

Bounded observation is not OS cancellation or confirmed cleanup. Outstanding
operations retain their settlement handlers and ownership: late exclusive opens
are closed/removed without starting a write; already-open writes retain independent
close/removal attempts. Unconfirmed cleanup is reported failed, not passed. The
one-use latch is never refunded, including after timeout/reload. A stale UI abort
cannot suppress independent cleanup attempts. Filesystem confirmation includes
latch completion as well as fixture cleanup. Shutdown bounds its observation of
the cached runtime close instead of waiting on it indefinitely a second time.
A refused reload cannot publish over an earlier attempt's report.

If exclusive open itself is still unresolved at expiry, bounded command/shutdown
observation may finish before ownership is known. A later successful open closes
its handle and owns exactly one failed outcome, never another query. A previously
returned `done()` promise does not establish that this late outcome was delivered;
missing durable owner receipt remains failure/unverified, not a retry grant.

Cleanup and reporting are separate outcomes. Reports contain fixed categories,
statuses and counts only, including unmeasured HTTP attempts. Artifact, canonical
entry, displayed status and event publication are attempted independently;
detected publication failure marks later reports failed and is counted.
Cancellation during the awaited artifact write is reconciled before subsequent
channels; an earlier stored copy can therefore precede a later failed result. The void
message API is checked against actual canonical custom-message insertion, not
invocation alone; this does not acknowledge UI rendering or post-insertion
listeners. This is not an atomic multi-channel commit. Earlier artifacts can
precede a later channel's failure; an artifact alone is not final proof. A timed-out
artifact channel is failed and its owned work retains cleanup attempts; late work
cannot advance the protocol or publish a later successful canonical status.
Missing or incomplete evidence is not success.

The event is local: a production EventBus consumer and custom-message remote
folding are not established. Existing ended-session JSONL upload is best-effort,
and fresh-profile transcript retention through private-config teardown still
requires verification. Offline tests reopen real public `SessionManager.create`
files: genuine pilot user messages are already on disk before the fake lease is
called, and canonical tools/final outcomes survive a reopen. A refused fake lease
also leaves the genuine prompt and failure outcome on disk with zero SDK queries.
Unarmed positional input is persisted while refusing before leasing. These tests
add no dummy messages or private flush flags. However, a fresh custom-only setup
failure still creates no JSONL at all in pinned Pi 1.0.2; a passing in-memory append
is not native persistence. None of these tests proves archival, owner readback,
remote ACK or retention after node-private profile cleanup. Before live admission, the controller must establish
owner-readable retrieval of the final sanitized outcome; local emission or a
successful upload on an unrelated path is insufficient.

Offline integration tests use real AgentSession, builtin filesystem tools and
MCP transport, with a fake SDK, lease and CLI and an isolated extension loader.
They are not live inference, installed full-harness, billing or native-process
cleanup evidence. Existing procfs cleanup remains Linux/readable-procfs-only,
identity checked, cooperative, groupless and non-atomic, with sticky unknown
ownership failures. Live verification must report those outcomes separately.
