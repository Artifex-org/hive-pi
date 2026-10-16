# Bounded owner SDK pilot

This is a restrictive diagnostic protocol, not SDK admission. Hive admission is
default-off and independently verifies the owner, launch, session, node readiness
and assigned account. Deploy the guarded runtime before enabling an owner.

Only a launch explicitly marked `HIVE_CLAUDE_SDK_PILOT=1` registers
`/claude-sdk-pilot --exclude claude-7`. Invoke it once in a fresh session.
Its persistent launch-private attempt latch is acquired before arming and is
never removed or refunded. Reusing the same state root across extension reloads
or process restarts cannot replenish the attempt. The node must preserve that
root for the owned runtime; deleting it is not a supported retry mechanism.

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

Shutdown tracks in-flight fixture setup as well as the scheduled protocol. A
stale UI abort cannot suppress filesystem or query cleanup attempts. A refused
reload cannot publish over an earlier attempt's report.

Cleanup and reporting are separate outcomes. Reports contain fixed categories,
statuses and counts only, including unmeasured HTTP attempts. Artifact, canonical
entry, displayed status and event publication are attempted independently;
detected publication failure marks later reports failed and is counted.
Cancellation during the awaited artifact write is reconciled before subsequent
channels; an earlier stored copy can therefore precede a later failed result. The void
message API is checked against actual canonical custom-message insertion, not
invocation alone; this does not acknowledge UI rendering or post-insertion
listeners. This is not an atomic multi-channel commit. Earlier artifacts can
precede a later channel's failure; consume the final event as well. Missing or
incomplete evidence is not success.

Offline integration tests use real AgentSession, builtin filesystem tools and
MCP transport, with a fake SDK, lease and CLI and an isolated extension loader.
They are not live inference, installed full-harness, billing or native-process
cleanup evidence. Existing procfs cleanup remains Linux/readable-procfs-only,
identity checked, cooperative, groupless and non-atomic, with sticky unknown
ownership failures. Live verification must report those outcomes separately.
