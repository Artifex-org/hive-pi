# SDK owner pilot — runtime-first preparation

Fresh branch `feat/claude-sdk-live-pilot-be584e28`, based on merged #183 (`927e8e661`). Original integration branches remain unchanged. This prepublication checkpoint precedes live-phase PRs and rollout; no admission activation, real credential lease or Claude inference has occurred.

## Implemented, not delivered

- Launch-owned nonrefundable [2,1] SDK turn reservations, fixed account/exclusions, 512-token output cap, pre-lease stream/canonical-result checks. Pilot auth preflight issues no lease; actual per-request server admission remains mandatory.
- Real `/claude-sdk-pilot --exclude claude-7` driver: exclusive persistent launch-private latch, private random fixture, real Pi read and guard-denied write, correlated canonical results and true `agent_settled`, strict close/reset, then tool-free nonce recall from seeded canonical history. Original system prompt/tool registrations remain; unexpected tools are guarded, not hidden.
- Deadline and fixed sanitized status/count report; independent fixture/query cleanup and report publication channels. Reporting failures are counted and later channels receive a failed status. Failed attempts cannot rearm, reload or restart into another attempt.
- Pilot-only automatic inference restrictions at actual helper initiation paths: brief, recap, goal judge, drift, advisor-watch, native classifier, scanner, aide and btw. Worker identity unchanged. Deterministic agenda gate/driver are NOT disabled.
- Protocol marker `extensions/claude-sdk/pilot-protocol.json` (v1). The Hive companion now contains uncommitted node certification/advertisement and fresh owner/node enforcement; those changes are not deployed or Postgres-verified.

## Offline evidence

- Real AgentSession, default builtin tools, real filesystem and real in-process MCP transport: successful two-query authority/history protocol; canonical read result and denied write; unchanged fixture; one strict explicit reset; recall sourced from the actual seeded JSONL, with no nonce in recall prompt.
- Same real-session fixture tests concurrent commands, reload refusal and unarmed positional/unknown-slash fallback with zero leases/queries.
- Latch tests cover concurrent/existing/symlink/unsafe-root and an actual fresh Node process.
- Immutable preflight bg-41: typecheck and 5,926 tests passed (20 existing skipped), identical before/after source fingerprint `d123c23c8fa374426017ce469dbc5163e9b2fb07e8400a595c6f4b16ec75ef02`. This precedes review fixes: restored-enabled aide interception and independent report publication.
- Review fixes add a restored-settings delivery regression and actual exclusive artifact-write failure in the real session. Added real-session deadline, strict query-close failure and fixture-alteration cases. Authorization is uncached per Pi request: the initial stream and its tool-result continuation each check the lease, without creating another SDK query.
- Prior immutable bg-43: typecheck and 5,931 tests passed (20 existing skipped), fingerprint `6e19449645f74f5572c6971125afb8e8d4be5494f92e70dc3e9bd91c03359bc2`. A subsequent review found continuation ownership and setup/shutdown races; this gate predates their fixes.
- Fixed ownership is claimed before awaited admission, including cancellation of the former parking timeout. Shutdown now tracks awaited fixture setup as well as the scheduled protocol; stale context abort cannot suppress cleanup attempts. Only the latch owner publishes a setup failure.
- Current focused verification: 137 tests, typecheck and diff check passed. Restoring the three faulty behaviors caused all three targeted tests to fail assertions, with no import/runtime errors; fixed sources were restored exactly. Deterministic gates cover competing anonymous continuations, parking expiry during admission, and real AgentSession reload during a held fixture write.
- Complete final gate and generic review are required for the final source; their evidence belongs in the PR. These are offline fakes, NOT live inference, installed full-harness, native execution or billing evidence.

## Still required before activation

Node-derived flag, runtime/package/pin certification and old-node refusal before issuance; server-side renewal account freeze; current managed Postgres assertions; production-exclusive activation rendering; adversarial protocol/deadline/cleanup tests; complete final reviews, gates, PRs and normal rollout. Admission stays off.

## Authorized budget and unchanged restrictions

Operator explicitly chose **Allow three SDK turns**: at most three SDK agentic turns, with native internal retries permitted to issue additional HTTP requests. HTTP attempts are unbounded/unmeasured; no retry environment setting or three-request/billing claim.

`claude-7` is forbidden before issuance, including preferred, renewal and resumed routing. Extra Usage-off is operator-confirmed, not independently measured. Preserve owner/tenant, assignments, Pi/CLI/SDK/MCP/native-driver/Node pins, content-only resources, normal prompts/tools/guards and no paid fallback. Runtime first; production-scoped owner admission last. End the owned pilot runtime and await strict cleanup; failure requires normal admission rollback, never a rerun.
