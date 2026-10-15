# Claude SDK provider: offline implementation and rollout boundary

Status: **opt-in runtime implemented and offline-tested**, not live acceptance.
This does not establish Anthropic subscription eligibility, billing classification,
Extra Usage behavior, real token renewal, or native CLI enforcement. No live
inference or credential access is part of these tests. Hive server admission is a
separate change; an older server correctly returns 403 for Pi launches.

## Enablement contract

The package's normal `./extensions` entry discovers `extensions/claude-sdk/index.ts`.
It registers a native Pi AI `Provider`, with `claude-sdk/<model>` names, **only**
when `HIVE_CLAUDE_SDK=1`. Disabled discovery does not import the SDK or register
models, read credentials, start processes or make network requests.

Hive's node also passes the certified provider file through `--extension`.
Pi deduplicates canonical paths, so manifest plus CLI discovery registers one
provider; project package filters cannot remove that explicit CLI entry.
Offline integration tests cover both ordinary and project-filtered loading.
`typebox` is a **required** `"*"` peer (with development pin 1.3.7), not an
optional peer or second runtime dependency bypassing Pi's shared module identity.
A production consumer install (`npm install --omit=dev`) installs that peer for
the standalone native MCP's eager schema import; this was measured separately.
The hermetic regression uses the real packed chart sources and peer declaration
in a focused consumer fixture, with locally packed TypeBox and an empty cache.
It verifies automatic peer installation, chart imports and absent dev tools;
it does not install the full package's unrelated dependency graph.
The workstation updater (`workstation/.local/bin/hive-pi-update:302`) runs plain
`npm ci --ignore-scripts --no-audit --no-fund`, retaining the development pin.
Running `npm ci --omit=dev` in this repository itself is different: npm omits
its root development pin, so that checkout lacks standalone TypeBox availability.

An enabled launch requires all of:

- `HIVE_CLAUDE_SDK_EXECUTABLE`: absolute path to the provisioned, unchanged,
  pinned native Claude Code **2.1.286** executable. No downloaded replacement,
  patched executable, prompt wrapper or synthetic Claude implementation. Runtime
  checks ownership-safe file permissions, executable access and exact `--version`;
  trusted workstation provisioning, not version text alone, establishes provenance.
- `HIVE_CLAUDE_SDK_STATE_DIR`: canonical absolute path to an owned, non-symlink,
  **0700** private root. Existing unsafe directories are refused, not chmodded.
- `HIVE_URL`, `HIVE_TOKEN`, `HIVE_LAUNCH_ID`: scoped launch connection details.
  HTTPS is required except for loopback test servers. Tokens are never put on argv.

These variables configure transport; **they are not authorization**. Every model
request obtains an access-only lease using:

```
GET /api/v1/agent-launches/{id}/claude-auth
Authorization: Bearer <scoped Hive token>
```

The exact response contains `access_token`, `expires_at`, `credential`, `slot`
only. Full Pi auth documents, refresh tokens, extra keys, invalid identifiers and
unbounded/expired lifetimes are rejected without reflecting response values.
Server acceptance must independently validate the explicit owner allowlist,
workstation Pi model lane, active launch, tenant and assigned account on **every**
lease. Ordinary Pi, forged selections, unauthorized workers and revoked launches
must be denied server-side. This repository cannot implement that server policy.
Factory/cloud principals require separate admission; a worker inheriting env does
not gain authorization by doing so.

The lane has no `/login`, Pi auth-store import/export, native-login fallback,
refresh-token writer, Console/API fallback, or token persistence. Native provider
auth returns an opaque admission marker after a lease, never the access token.
The separate `anthropic-api` lane remains explicitly separate.

## Ownership and request isolation

Pi **1.0.2** owns prompt composition, literal user input, transcript/session,
compaction, branching, hooks, argument validation and tool execution. SDK
**0.3.289** and MCP **1.32.0** are pinned runtime dependencies. The original
prototype implementation moved to `extensions/claude-sdk/`; there is no second
implementation or compatibility shim.

`isolatedOptions()` supplies verbatim prompts and `client_composed` user messages.
It disables SDK builtins, settings sources, hooks, plugins, skills, ambient MCP
and cloud discovery, memory, CLAUDE.md discovery and SDK compaction. Unexpected
permission requests are denied. The only MCP server is the in-process Pi bridge;
only its named tools are preapproved. The child's environment is an allowlist,
not a merge of `process.env`: no Hive token, ambient API keys, gateway, auth.json,
login directory, user settings or inherited proxy reaches it.

A model tool batch ends the Pi assistant stream with `toolUse`, leaving the SDK
iterator and MCP requests parked. Pi executes or denies the tools normally. The
next request must present the exact expected transcript plus one correlated result
per call. The bridge checks Pi names, stream-observed IDs and JSON arguments;
parallel/out-of-order/early results, images and error results remain correlated.
It has no execution callback. SDK dispatch that overtakes an awaited stream
observer waits for registration for at most ten seconds, then fails closed.
Failed registration IDs (including cancelled/timed-out requests and registered-ID
name/argument mismatches) remain tombstoned: late stream registration or corrected
redispatch cannot expose them to Pi execution. A mismatch also settles any already
parked MCP resolver with an error; the entire model batch fails validation. A query admits at most
256 IDs across calls, failed registrations and waiters; exhaustion closes the bridge
rather than evicting safety state. Missing, nonstring, empty, whitespace/control-containing
or overlength correlation metadata cannot identify a safe tombstone: the whole
bridge closes before returning the MCP failure. All parked calls/registration
waiters settle, and even otherwise valid streamed siblings fail batch validation;
no subsequent `assistant.error` is needed to prevent Pi execution.

Tool proposals require an explicit `tool_use` terminal stop before Pi handoff.
Refusal, pause, ordinary end-turn, or unknown terminal stops with tool blocks fail
closed even when a real MCP request is already parked; no later SDK error frame
is required to prevent execution.

The query requires `includePartialMessages:true`: partial `message_start` through
`message_stop` frames are authoritative for response boundaries, stop reason and
usage. Pinned SDK 0.3.289 documents canonical `assistant` frames **per completed
content block**, sharing `message.id`, with null stop reason and nonfinal usage.
Those frames, interleaved with partials or arriving on the following Pi turn, are
ignored once the partial stream has registered their message ID, not executed
again. An unknown-ID canonical frame with null or missing `stop_reason` fails
closed as missing partials/no complete response; canonical-only block aggregation
is unsupported. Full-assistant fallback is retained only for an explicit nonnull
stop reason proving a complete response, with `max_tokens` still taking priority.
This contract is covered offline, not verified against live inference.
Before exposing `toolUse`, the complete batch is revalidated after stream observers:
a registered call cancelled or timed out during observation rejects the entire
batch, including otherwise valid siblings. Cancelled calls retain bounded query
state, not reusable IDs. Native `max_tokens` takes precedence over tool blocks;
Pi receives `length` and supplies error results instead of executing those calls.

Streaming preserves text, thinking/signatures, redacted thinking, tool blocks,
stop/length/error/abort and uncached/output/cache-read/cache-write token counts.
Subscription models report zero monetary cost: this is **not** evidence of free
inference or a billing determination. SDK errors are redacted at the transport
boundary; no token-bearing options or raw stderr are logged.

Only structured SDK `assistant.error` codes `overloaded`, `rate_limit` and
`server_error` retain sanitized classification in `output.diagnostics`
(`claude_sdk_assistant_failure`, allowlisted `error.code`, fixed `error.message`,
`details.retrySafe: false`). SDK text, IDs and credentials are not copied into diagnostics.
Known codes do **not** prove pre-effect rejection: the inspected SDK type contract
(`sdk.d.ts` `SDKAssistantMessage` / `SDKAssistantMessageError`) provides no
nonexecution promise, even for an empty first frame with no visible tools or MCP
activity. Synthetic fixtures cannot establish that promise.

All post-start SDK failures remain generic/nonretryable in `errorMessage` and
quarantine the failed context against explicit replay, including classified
empty failures and synchronous query-launch throws. There is no automatic SDK
post-start failure retry, either here or through Pi's retry classifier, absent a
verified protocol guarantee of nonexecution. Diagnostics preserve failure
classification without authorizing replay; private state is still cleaned up.

## Reasoning capabilities

Reasoning translation reads the pinned Pi catalog's public capability metadata,
not model-name regexes or native Anthropic transport/auth/prompt conversion.
Adaptive models use SDK `thinking: { type: "adaptive" }` and their mapped effort;
`xhigh` remains distinct from `max` on Opus 4.7 and other models advertising it.
Sonnet 5 and Fable 5 follow the same adaptive metadata. Older budget-based models
use explicit token budgets. Omitted reasoning disables thinking only when the
model advertises off; otherwise the default is adaptive/high. Unsupported levels
and budget knobs on adaptive/off requests are rejected, not silently converted.
Budget-based requests require safe integer budgets of at least 1024 tokens,
strictly below the output token limit.

Pinned Pi's `ToolChoice` is `"auto" | "none"`. Both are supported (`none` exposes
no tools); runtime values such as `required` or a specific tool selection are
rejected before creating or resuming a query, never silently treated as `auto`.

## Canonical history and lifecycle

Each new query gets a unique 0700 directory. Canonical Pi history is converted to
a 0600 pinned-CLI JSONL resume chain; the final literal user message (or correlated
native tool-result batch) is the sole input, never a replay of historical prompts.
The SDK uses `persistSession:false`. The native child inherits umask 077 (the
parent mask is immediately restored around synchronous spawn); private state and
SDK-created files cannot default to public modes. No lease or auth document is
written. Native subprocess behavior remains a separately unverified rollout gate.

A parked iterator is reused only for exact context/model/session/account/slot,
unchanged tools, the same access token, and equal normalized effective query
options (thinking/effort or token budget, output-token limit, tool choice and system
prompt). Changed query options rebuild only after correlated Pi results have
settled; historical tools are not replayed. Edits, compaction, fork/tree navigation,
provider switch, account/token rotation or process loss rebuild from Pi's canonical
history in fresh private state. Recorded tools are loaded as history, never sent
to the bridge for re-execution. Unresolved historical calls and ambiguous failed
attempts require reconciliation; there is no automatic crash-after-side-effect
replay. Completed results allow a new account-bound history rebuild.

Failed/aborted assistant frames remain in canonical Pi history but are omitted
from SDK seeds and settlement: Pi does not execute their proposals. An independent
next user prompt can proceed; the exact failed attempt remains quarantined.
Actual unresolved handed-off calls still reject; no synthetic results are added.
Disposing an idle handed-off query also quarantines its original result-free
attempt, including cancellation and parked expiry. Reservation begins at handoff,
so replacement or a different session ID cannot restart the same result-free attempt. The exact attempt cannot
restart a potentially side-effecting batch; canonical correlated results still
permit reconstruction. The extension owns hash-only replay protection across runtime
replacement on model selection, session tree navigation, compaction and session
start; closing a disposable SDK runtime does not erase it. No transcript or token
is persisted as transport recovery state.
SDK history tool-use IDs and both historical/following result IDs share an SDK-only
conversion: valid `[a-zA-Z0-9_-]` IDs of 1–64 characters remain unchanged; others
use the existing SHA-256 fingerprint. Settlement validates uniqueness of converted
IDs (including collisions with valid native IDs) and refuses collisions rather
than miscorrelating results. Canonical Pi and live bridge IDs are never rewritten. Opaque reasoning signatures
are retained only for the same destination model/provider/API; cross-model visible
reasoning becomes text, redacted reasoning is omitted, and empty converted assistant
frames are omitted from SDK seeds only.

Concurrent anonymous helpers receive separate queries/directories. Named sessions
reject overlapping requests. The common subagent/brief worker extension allowlist
explicitly loads this launch-gated provider. Advisor, subagent and helper model
lookups discover native `claude-sdk` models through Pi's registry, with no new
provider-name fallback or bare-model substitution.

Abort (including after `toolUse`), shutdown and lifecycle reset settle pending MCP
calls, close the SDK, terminate verified native tree members, escalate to SIGKILL and
remove private directories. Setup allocations and parked states use the same
cleanup owner: any cleanup failure is reported as requiring operator cleanup,
latches the runtime against subsequent requests, and makes shutdown reject.
This includes query/iterator setup throws after private history has been written;
a removal failure is not treated as successful shutdown. Shutdown awaits in-flight
setup and disposals and is idempotent. Parked queries expire after at most five
minutes or lease expiry.

The SDK spawns the pinned command directly, detached and under umask 077, using
`hive-common/child-tree.ts` ownership rather than retaining numeric PGIDs. Its
unique inherited tree token is added to the SDK's isolated child environment,
not to an ambient environment merge. **SDK execution supports only Linux with
readable procfs ownership.** Both executable preflight and actual spawn check this
boundary. macOS/other portable SDK runtimes are unavailable pending verified
ownership support, not accepted with an unverified fallback.

The SDK opts into the shared utility's strict ownership policy; existing non-SDK
callers retain their portable group fallback unchanged. Strict cleanup never sends
negative-group or bare-child signals, including SDK transport/exit/timer `kill()`
callbacks (also after scope release): each individual PID's starttime is checked
immediately before signalling. TERM-to-KILL escalation and normal close rediscover
ancestry/token descendants and recheck identities. Closed leaders' handles remain
owned until scope close, including silent detached descendants inheriting the token.
An inaccessible environment is not, alone, proof of lost live ownership: Linux
can remove a task's memory before its state becomes zombie. Strict discovery
ignores that environment denial only after fresh matching PID/starttime and
exit-state evidence plus `Threads: 1` prove no surviving user thread. A zombie
leader with other threads remains a live cleanup concern; unavailable or malformed
thread-count evidence fails closed. Ancestor rows and surviving descendants remain
part of discovery, and known members still receive independently checked signals.
Diagnostics contain only fixed operations, allowlisted errno and numeric PIDs,
never raw OS messages or environment/argument content.
Loss of live procfs visibility or a signal failure is sticky: event-close, abort and
shutdown observers do not throw, but explicit tree cleanup/scope close reports
**operator cleanup required**. Restored visibility does not erase the failure.
All other resource cleanup is still attempted and the provider refuses new requests.

This is cooperative-job cleanup, not a sandbox. A descendant that clears its token
and reparents before discovery can evade tracking; strict mode does not adopt an
unverified group occupant as a substitute. Readable procfs does not make the
identity-check-to-signal interval atomic (no pidfd guarantee), and SIGKILL delivery
is not a proof of completed process reaping. Stronger OS-enforced guarantees require
cgroups/job objects or kernel identity handles.
A SIGKILL of the entire parent cannot run cleanup: the provisioner owns root
retention/sweeping after verifying the launch/process is dead. Never use leftover
SDK state as a source of truth or automatically resume it.

Leases are memory-only, coalesced only while a GET is in flight, and reauthorized
on each request. Acquisition is bounded to ten seconds and supports independent
waiter cancellation. Leases with less than sixty seconds remaining are refused;
authd is the sole refresh writer. The provider does not restart-loop on a near-
expiry response containing the same token. A changed token/account rebuilds
settled history instead of updating a running child's identity. Active inference
is stopped at expiry; failure is visible and ambiguous effects require
reconciliation. Real expiry/renewal acceptance has **not** been measured.

## Instrumentation contract

- `onPayload` observes a **structured SDK request envelope**, including explicit
  capability flags, unchanged prompt/history and tool definitions. Returning a
  changed payload, or mutating the observation in place, is rejected explicitly.
  Pi context hooks are the supported place to change the canonical transcript.
- `onProviderStreamEvent` is awaited for each parsed SDK event, before conversion;
  observers receive a clone so they cannot corrupt normalization.
- Observer waits race cancellation: payload observation uses request/shutdown
  signals, while event observation also uses the active query/lease-expiry signal.
  Abort/shutdown never waits for a blocked observer, and eventual observer
  rejections remain handled.
- The Agent SDK does not expose its inference HTTP body/headers/response. Custom
  `fetch`, nonempty HTTP `headers`, arbitrary child `env`, API-key overrides,
  sampling mutation and deferred requests are rejected. `onResponse` is not
  invoked: no fake status, headers or response is manufactured. Pi installs this
  observer even for non-HTTP adapters, so its presence alone is not a request error.

## Offline evidence and commands

```
npm run check
npx --no-install vitest run test/claude-sdk-*.test.ts test/subagent-worker.test.ts
```

When testing from a delegated harness, remove inherited **worker-only execution
flags**, not tests or assertions:

```
env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npm run check
```

Tests use injectable synthetic SDK/leases and real MCP transports. They cover the
real Pi agent loop with multi-tool turns and a Pi guard denial, next-turn history,
stream conversion, duplicate/event ordering, cancellation, private state,
account rotation, concurrent helpers, native model/helper discovery, actual Pi
extension loading, disabled discovery, strict lease shape and bounded renewal.
No test obtains a real token or starts Claude for inference.

## Still required before rollout

1. Deploy separately reviewed server-side admission with explicit owner/account
   scope and negative authorization tests; do not impersonate another harness.
2. With separately authorized named-account scope and bounded live-turn budget,
   test the **unchanged actual Hive/Pi prompt and tools** through this provider,
   using the pinned native CLI and Extra Usage disabled.
3. Verify real native enforcement, resume-chain acceptance, file modes, process
   teardown, token expiry/renewal, cancellation and no ambient/API fallback.
4. Establish subscription/billing/credential-intermediation eligibility with the
   appropriate provider policy. Technical authentication success alone does not.

If the unchanged prompt/tool shape is ineligible, stop this lane. Never rewrite
identity/instructions to defeat checks or silently fall back to paid API billing.

## References

- [Agent SDK with Claude plans](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Agent SDK vs API client SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [SDK TypeScript options](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Credential-use conditions](https://code.claude.com/docs/en/legal-and-compliance)
- [Pi community billing report](https://github.com/earendil-works/pi/issues/6888)

No third-party provider adapter is vendored.
