# PR132 conflict integration — 2026-10-07

User requested resolution of the new main conflict. Both PRs remain open; they
were initially published as drafts then marked ready externally, not by this
agent. Current main0a24abb adds durable background recovery and generation fences.
Four background/index.ts conflicts were composed, not resolved by discarding a
side: journal before spawn, existing generation fences, per-child credential
environment, redaction before retained output/journal/notifications and consumer
release only at shutdown are retained. TypeScript and60 focused background,
recovery, credential integration and non-login-shell tests passed. Full native
validation (bg-30) passed TypeScript +4,746 tests/289 files,13 existing skips.
No test or gate was suppressed; all merged source was exercised before push.

Review continuation: overlapping conversation metadata refreshes need controlled
ordering/persistent-failure coverage in both clients. This is separate from the
requested text conflict and is not declared solved. Native earlier publication
head5dd6acb passed all GitHub checks. Hive8313/c55e4387 CI12713 is being watched;
no source snapshot test result is a claim that an old live process recovered.

---

# Final-source acceptance — 2026-10-07

Final local native gate (bg-25): TypeScript and 4,725 tests/288 files passed;
13 existing skips remain. Final Factory gate (bg-26): 169 tests/15 files,
pinned Pi1.0.2 typecheck and every shipped module load, actual synthetic shell
smoke, refreshed Factory Go embedding race suite, metrics and file-length passed.
Final pre-publication Hive fleet snapshot passed lint:
https://app.hiveci.io/runs/ebb1f752-39eb-4bea-bd31-852164de4c3f
Other fleet steps were NOT RUN in that snapshot: Hive ignores mode=thorough and
uses named steps; this was the single permitted fleet dispatch. Required PR CI
at the publication head remains the authoritative full delivery gate.

Native npm run check passed 4,721 tests/288 files with 13 existing skipped tests
at 85dd491. Final review added four regression cases, not skips: independent
same-session detach, local and generation replacement; delayed/failed capability
refresh. Instrumentation reproduced discovery before acknowledgement and a
second bind. Current code gates discovery until a successful, current-identity
whole-record capability PUT; both reproductions pass. Focused TypeScript and
75 focused tests passed; the final full rerun result above supersedes earlier counts.

Managed-session Postgres Go acceptance (bg-23): all 12 selected package targets
passed race testing (five package targets reran, six reused unchanged cached
results; judge-runtime-smoke has no tests) and subsequent vet passed. API and MCP
actually ran against the explicitly supplied managed DB. Prior dedicated request,
discovery, ownership/readiness and atomic one-shot tests also exercised that DB.
Final Factory embedding/type/load/shell acceptance passed (bg-26), as recorded
above. Native/Factory receiver and runtime are byte-identical.

Secret scans of task history and staged files passed; one purely synthetic
fixture was rewritten to an unmistakable repeating literal, with assertions
unchanged and no scanner exclusion. Raw papercuts.json is not published.
Native quality_gate has no repository adapter: npm run check plus configured
GitHub checks are the real native gate, not a claimed absent-adapter pass.
Final Hive fleet snapshot and exact-current-head draft PR checks remain delivery
requirements; no historical #127 check substitutes for them.

Delivery limits: no merge, rollout, live/local consent or machine configuration
change, original-session recovery, live broker/provider/Jev round trip, or
production Node22 execution. HIVE_JUDGE_ENABLED stays false. Request defaults do
not grant access: ownership/tenant/scopes/approval/opt-outs/prerequisites remain.
Output protection covers accidental literal output, not deliberate exfiltration.
Archives and earlier receipts below are preserved; later receipts supersede them.

---

# Rebased review checkpoint — 2026-10-07

Native follow-up branch is fix/grant-receivers-defaults; #127 was externally
merged, not by this agent. Rebase preserves upstream compaction/deferred-steer
and generation guards. Full native gate passed 4,715 tests (13 existing skips)
at 4ea6778, before the final review-driven recovery tests and actual pretty-tools
PTY/retry integration. Latest focused TypeScript plus 71 tests passed.

Initial 503 and post-attach 503 failures formerly left no re-probe path while
conversation identity remained attached. Instrumented entrypoint regressions
proved the stopped HTTP counters; current bounded, identity-checked recovery
passes both cases and rejects stale/incompatible responses. Stateful fixtures now
model pre-attach 409 and post-attach 200. Same-session resume and new-local-session
announcement ordering are covered. Actual registered pretty-tools Bash tests use
a real PTY/raw sink under an isolated temporary home and force the stock retry;
no operator home/configuration is written. Native and Factory receiver/runtime
modules were compared across the actual repository paths, byte-identical.

Factory final-source acceptance (bg-21): 169 tests/15 files passed, published
Pi 1.0.2 image-contract typecheck and all shipped extension loads passed, and the
actual synthetic credential-shell smoke passed (split/interleaved streams,
updates/result/spill, detach and unchanged parent env). Stage modules match source.
Local Hive metrics and file-length passed. Final native/managed-DB Go gates,
one final Hive fleet snapshot and linked draft/current-head CI remain pending.

Limits remain: no live broker/provider/Jev round trip, production Node22 runtime
execution, original-session recovery, merge/deployment, judge activation, or live
consent/local machine configuration change. HIVE_JUDGE_ENABLED remains false;
credential broker remains opt-in and approval/tenant/ownership/scopes are intact.
Literal-output protection is not containment of deliberately malicious commands.
Archives below are preserved and superseded where noted.

---

# Receiver integration checkpoint — 2026-10-07

Native credential requests and MCP-origin metadata discovery now share a one-shot
coordinator. Values are installed only into future shell children bound to the
local SDK session, Hive session and generation. A process-local symbol bridges
isolated extension loaders. Catalog mappings, reserved keys, expiry, duplicate
and extra bindings are validated; stale responses cannot install. Expiry timers
and identity-checked detach discard overrides without touching process.env,
existing provider/MCP processes, consent files or machine configuration.

Stock SDK Bash, pretty-tools PTY/retry, and background consumers protect literal
output before SDK accumulation, retained output and raw terminal sinks. Independent
stdout/stderr redactors plus a combined-output redactor cover split UTF-8,
interleaved streams and overlap. Per-child snapshots survive receiver detach or
expiry. This is accidental literal-output protection, NOT containment against
commands deliberately encoding, writing or transmitting secrets.

Current focused gate: TypeScript and 60 tests across receiver/runtime/real-shell/
capability/wiring passed. Actual SDK shell tests include updates, returned output,
and spilled files; actual background tests cover notifications/retained output
after detach. Earlier full gate ran 4,679 passing tests and one failure solely for
the undeclared read-only list_credential_catalog; its reviewed read-only metadata
is now added and the conformance test passes. Final full gate still required.

PR #127 was externally merged; this agent did not merge it. Its prior green SHA
is historical, not acceptance of this expanded tree. A NEW follow-up draft and
Hive companion draft remain to publish and verify. No live broker credential,
provider/Jev round trip, original-session sandbox recovery, deployment or live
judge activation is claimed. HIVE_JUDGE_ENABLED remains false. Archives below
are preserved and superseded where noted.

---

# Grant defaults and papercuts — 2026-10-07

Latest authorized scope: default request availability for workspace, credential,
and host grants in supported sessions. This supersedes the earlier source
workspace opt-in policy, not authorization/approval or explicit opt-outs. No
operator config, consent file, deployment, or live judge setting was changed.

Current checkpoint: workspace defaults on for existing configs without a flag;
explicit false and malformed flag values remain disabled. Remote enablement
stays off by default. Focused config/workspace/wiring/real-SDK discovery: 61
passed. Credential receiver/consumer lifecycle, counterpart Factory wiring,
final combined checks, and delivery of the expanded scope remain pending.

Shell prerequisite: pretty-tools now forwards SDK context through stock/PTY and
fallback execution while retaining explicit cwd precedence. Parent replaced the
initial double-unknown call adapter with a public ToolDefinition binding. A
plain-object spread introduced during cleanup lost inherited/non-enumerable
context fields; failing real-shell regression plus actual-expression probe
confirmed the cause. A typed cwd shadow now preserves the context prototype.
Same probe and all 7 cwd/metadata cases pass; TypeScript passes. Earlier parent
focused wrapper run passed 16 tests; delegate's earlier 7-file run passed 120.
No live credential was delivered. API counterpart discovery test only compiled
and skipped for lack of managed DB; no native/MCP credential wiring is proven.

Draft #127 exists at fe58376 (previous required checks green); that SHA predates
these uncommitted default changes. Earlier package results below are historical,
not final-tree evidence. Companion Hive draft has not yet been opened.

---

## Earlier workspace-discovery checkpoint — 2026-10-07

Branch: `fix/grants-judge-papercuts`, baseline `3cbd8465c`. Companion judge restoration: `fix/grants-registry-judge` in Hive (separate draft PR, still in progress).

Confirmed mechanisms: default-off workspace consent hid both native deferred tools despite CLI advice naming them; an approved one-shot grant value fetch preserves the approved verdict, so HTTP 410 bypassed the old error-only delivery handling. Tools now remain diagnostic-only without opt-in, preserve absent `can_add_workspace`, and distinguish delivery from successful cloning and transient fetch failures. No operator configuration changed.

Verification: standalone baseline/reverification `scripts/grant-papercut-probe.mjs`; focused grant/goal judge tests 239 passed; real SDK `load_tools` and `tool_search` discovery 2 passed with zero model/auth/network calls. `npm run check` passed TypeScript and 4,643 tests (13 existing skips; 281 passed/4 skipped files). Full-suite LSP fixture was made independent of ancestor platform-package resolution; the shutdown failure did not reproduce and no production LSP changes were made. Independent read-only review found no issues. `quality_gate` ran but reported no adapter in this repo; the actual package gate is `npm run check`.

Limits: goal-judge regression tests establish fast-pass/inherited-thinking confirmation, error separation and pause behavior, not live paid-provider or deployed judge behavior. An initial CLI discovery probe used `ctx.executeTool` outside tool context, failed before assertions, and unintentionally invoked an inherited OpenRouter model with read/bash tools; it was terminated. Its transcript showed read-only tool activity, the process check found no surviving probe, and no tracked modifications resulted. It is NOT discovery evidence; the isolated SDK test replaces it. Approval judge remains disabled; grant opt-in unchanged. No merge/deploy/live judge activation authorized.

Delivery: task-owned changes only; raw telemetry/logs excluded. Draft PR and final-head checks pending.

---

# Preserved upstream checkpoint

# YSK implementation — verified, publication pending

Branch: `feat/ysk-findings`. Backend/UI companion: Hive branch `agents/hive-a6a897b1`, worktree `/home/joan/repos/hive__worktrees/agents-hive-a6a897b1` (full evidence in its `PROGRESS.md`).

Implemented exact catalog-low/explicit-override extraction without selected-model fallback; bounded/redacted tool opt-in; fixed-question, confidence-abstaining shadow Jev; durable branch/session-bound findings/receipts; separate recording controls with monotonic revisions and no off-era backfill; bounded authenticated remote transport and real remote-loader integration.

Final current-tree `env -u PI_AGENDA_WORKER npm run check` passed TypeScript and 4,379 tests (13 existing gated skips; 267 passed/4 skipped files), `/tmp/ysk-final-client2.log`. Focused real remote/recording/retry suite passed 28 tests; extraction/guard suite passed 49. `git diff --check` passed. The harness quality-gate helper reports no configured gate here; `npm run check` is the manifest-declared gate.

Tests use fake providers/APIs; scanner fixtures explicitly disable operator Jev configuration/credentials. No live-provider relevance, live destination delivery, or deployed browser behavior verified. Client retries stop after five per capture/control/reconnect; server dispatch is POST/reconnect-driven, not an autonomous outbox. Ambiguous attempted writes remain uncertain and require operator reconciliation. Jev never suppresses/reroutes/grades severity; its unknown monetary cost is not folded into extraction usage.

At this verification checkpoint, no task commits/pushes/PRs existed. Operator subsequently authorized committing/pushing both task branches and linked draft PRs, with associated docs/KB sync. Merge/deploy/live routing and configuration changes remain unauthorized. Preserve test environment fixes: explicit ordinary/launched consent and optional-lock negative control, not weakened production guards.

KB sync: `knowledge-base/infrastructure/cicd/hive.md`, direct commit `1841964e0825afbae45c535f450d95506ec08d90`, records the pending-review contract and evidence qualifications. Publication URLs and final-head checks will be recorded in the PRs.


## Preserved upstream HIV-3757 checkpoint (merged from 629145d)

# HIV-3757 evidence

- Native opt-in classifier added at `extensions/typesafe-common/native.ts`; object state preserves JSON keys, scalar/array state is wrapped under `data`. Remote error envelopes and thrown prose are never surfaced. Missing context/model returns no verdict; old nondefault endpoint is refused.
- SDK-native agenda + plan continuation preserves prior handler drafts, continuation ownership and completed-outcome guard. Active-boundary regression covers both actual extensions in both registration orders; a queued-input regression preserves interruption behavior.
- Real public `createAgentSession` + offline faux provider test proves two model calls, one committed agenda draft, one terminal settle, and false `isIdle()` at both boundaries. Credentials/model-cache paths are temporary; no operator config is modified.
- Independent review found cooperative-only timeout. Native transport now races abort independently and removes its listener; a never-settling provider regression protects the deadline.
- Native Meta provider factory is reused, with only strict-tool compatibility overridden. The exact public `providers/meta` package export is verified; private `/compat` imports remain forbidden and named subpath debt stays empty.
- Prior full check: 4,366 passed, 13 pre-existing skipped tests, typecheck passed (`/tmp/c38589c7-pi-final-check.log`). This predates the final active-boundary, hard-deadline and actual SDK tests: it is NOT final-tree evidence.
- Final complete tree check passed: 4,368 tests, 13 unchanged pre-existing skips, 264 test files passed; typecheck passed (`/tmp/c38589c7-pi-delivery-check.log`). Actual SDK fixture and focused boundary/classifier/plan regressions passed independently. No repository-specific quality_gate adapter was found; `npm run check` is the real package gate. Final-head PR CI remains pending. Test process isolates inherited launch-consent and git optional-lock environment only; no gate is skipped.
- Known SDK limit: before-settle has no core active-run signal after the model turn. Do not infer immediate human-abort cancellation or zero ledger charge from tests using an explicit fake signal. Source delivery does not establish live paid-provider acceptance.
