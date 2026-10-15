# Claude SDK provider — offline completion checkpoint

Worktree: `feat-claude-sdk-integration-be584e28`
Delivery constraint: **no commit/push/deploy**, per task; parent owns separate Hive server work.

## Implemented

- Native Pi AI Provider `claude-sdk/<model>` in `extensions/claude-sdk/`, discovered by the existing package `./extensions` manifest entry and gated on `HIVE_CLAUDE_SDK=1`.
- Runtime SDK 0.3.289 + MCP 1.32.0 dependency move preserved in both lockfiles; Pi 1.0.2 development pins unchanged.
- Absolute pinned native CLI 2.1.286/version/permissions validation; owned canonical 0700 state root; per-query 0700 dirs, 0600 canonical JSONL seeds and child umask 077. No wrappers/CLI edits, login, Pi auth import, access-token persistence or API fallback.
- Strict access-only Hive lease route; per-request server admission, coalesced bounded acquisition, independent cancellation, near-expiry refusal, account/token-bound state and canonical rebuild.
- Original Pi prompt/history ownership, literal user/native tool-result input, SDK isolation options and no SDK-owned builtin/tool execution.
- Parked correlated in-process MCP calls across Pi turns; native Pi guards/result hooks execute normally. Parallel/early results, stream-observer/MCP dispatch races and full assistant duplicates crossing tool boundaries covered.
- Text/thinking/signature/redaction/tool/stop/usage/cache streaming conversion; zero subscription monetary cost is not a billing claim.
- Context-edit/compaction/fork/model/account/steering boundary rebuilds, no historical tool replay, unresolved/ambiguous effects fail closed.
- Process-group teardown/escalation, abort including parked queries, private-state removal, idempotent shutdown awaiting setup/disposal, bounded parked lifetime.
- Structured payload/provider-event instrumentation; explicit rejection of HTTP/config mutation without fabricated response headers.
- Shared subagent/brief worker allowlist includes provider; helper/native registry discovery and actual extension-loader tests.
- Original prototype modules moved into runtime (not duplicate compatibility shims); README and compatibility/lifecycle/rollout documentation updated.

## Verification

- Initial `npm run typecheck`: passed before implementation.
- Raw `npm run check` inherited this launch's `PI_AGENDA_WORKER=1` and `PI_SUBAGENT_FAST=1`: 184 failures / 5,486 passed / 20 existing skips. Failures included parent-session tests reporting "inert (worker process)" and fast-mode defaults, plus timing failures during overlapping work. No tests were skipped/deleted/weakened to address this.
- Distinguishing run with only those two worker-only env flags removed: agenda-driver, communication-aide, fast and real Claude extension loader: 102 passed.
- Intermediate clean full gate: 5,672 passed / 20 existing skips.
- Focused final runtime/loader/lease/MCP/worker suite before last history/input hardening: 87 passed.
- **Final `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npm run check`: typecheck passed; 349 test files passed, 4 existing skipped files; 5,696 tests passed, 20 existing skipped.** Duration 49.58s. No live Claude inference or credential endpoint was used.
- Synthetic Node child process tests verify 077 inheritance, 0700/0600 creation, process-group cleanup and SIGKILL escalation. They do not substitute for native Claude acceptance.

## Four production review fixes — verified offline

- `extensions/claude-sdk/tool-bridge.ts`: failed pre-registration IDs remain tombstoned for the query. Late stream registration throws before `toolcall_end`/Pi execution; MCP cancellation and timeout are also terminal for that ID. Calls, tombstones and registration waiters share a 256-ID admission bound; exhaustion closes the bridge rather than evicting safety state. Duplicate pre-registration dispatch cannot accumulate waiters.
- `extensions/claude-sdk/provider.ts`: a run records its session reservation only after acquisition, so rejected B cannot release winning A's reservation and admit C.
- `extensions/claude-sdk/provider.ts` / `runtime.ts`: payload observers race request/shutdown cancellation; stream-event observers also race the active query controller (including lease expiry). Cancellation still observes eventual callback rejection, including promises supplied after the signal already aborted. Shutdown no longer waits for blocked observers.
- `extensions/claude-sdk/options.ts` / `provider.ts`: reasoning uses the pinned built-in catalog's public capability metadata (`forceAdaptiveThinking`, `thinkingLevelMap`, supported levels), not model-ID regexes or native Anthropic stream/auth/prompt helpers. SDK .289 explicitly supports `xhigh`; Opus 4.7 keeps `xhigh` distinct from `max`, and Sonnet 5/Fable 5 use adaptive thinking. Models that do not support off default to adaptive thinking when no level is requested. Unsupported levels, adaptive/off thinking-budget knobs and invalid/oversized budget requests fail before dispatch instead of silently downgrading or promoting them.
- Durable regressions added in `test/claude-sdk-tool-bridge.test.ts`, `test/claude-sdk-provider.test.ts`, and `test/claude-sdk-runtime.test.ts`: late timeout with zero execution through the real Pi Agent, pre-registration cancel/timeout, bounded tombstones/duplicate waits, A/B/C lease ownership, blocked observers under abort/shutdown/expiry, late rejection handling, and all 16 advertised models across all six requested reasoning levels plus omitted/default reasoning.

Commands/results:

- `node --experimental-transform-types /tmp/sdk-review-probe.mjs`: initial nine deterministic failures, final nine passes. Distinct `/tmp/sdk-review-instrument.mjs` measured forgotten registration state, admitted C, blocked callbacks, and wrong SDK options; final re-run passes all nine checks. These temporary probes are not delivery dependencies; the repository tests retain the regressions.
- Focused `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npx vitest run test/claude-sdk-provider.test.ts test/claude-sdk-tool-bridge.test.ts test/claude-sdk-options.test.ts test/claude-sdk-runtime.test.ts`: final 101 passed (4 files); duration 3.83s.
- **Final `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npm run check`: typecheck passed; 349 test files passed / 4 existing skipped; 5,727 tests passed / 20 existing skipped; duration 49.47s.** This includes all 31 new regression cases. No existing assertions were weakened or removed.
- `git diff --check`: passed. `npm ls @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk @earendil-works/pi-ai`: SDK 0.3.289, MCP 1.32.0, Pi AI 1.0.2 unchanged. Trusted native CLI pin remains 2.1.286; no native inference or credential access was attempted.

Server-owned default-off admission, Pi-only tool authority, isolated child environment and no ambient-auth fallback remain unchanged. No repository commit/push, live credential request, inference or deploy performed.

## Unverified / separate rollout gates

No live account credential read, SDK inference, billing/subscription/Extra Usage eligibility, actual native CLI enforcement/resume acceptance, real expiry/renewal acceptance, deploy, commit or push. Server-side owner allowlist + Pi workstation model + active-launch validation on every lease remains the parent's separate Hive change. Native token/CLI/eligibility acceptance needs separately authorized scope and turn budget; offline green is not a rollout authorization.


## Final review follow-up — verified offline

- `extensions/claude-sdk/events.ts`: native `max_tokens` takes precedence over tool blocks, including full-assistant fallback. Pi receives `length`, supplies truncated-call error results and executes zero tools. The completed truncated query is disposed instead of waiting for MCP progress.
- `extensions/claude-sdk/tool-bridge.ts`: validate every ID in the completed batch immediately before exposing `toolUse`, after awaited observers. Cancellation/timeout of an already registered MCP call fails the entire batch closed, including siblings. Cancelled calls remain bounded, non-reusable query state; no tombstone eviction or relaxed admission bound.
- `extensions/claude-sdk/provider.ts`: parked state stores normalized effective thinking/effort/budget, output-token limit, tool choice and system prompt. A change rebuilds from settled canonical history plus native correlated tool-result input; historical tools are not replayed. The effective output-token limit is explicitly sent to the SDK environment.
- Pinned Pi 1.0.2 `ToolChoice` is only `auto | none`. Runtime `required`/specific-tool choices now fail explicitly before query creation/resumption rather than silently becoming auto.
- Corrected dependency declaration: TypeBox is a REQUIRED `*` peer, no optional metadata, dev pin remains 1.3.7. Both lockfiles regenerated offline; comparison of package-lock versions against HEAD reports zero version changes. The native MCP contract requires the shared peer. The initial full-package offline consumer regression reused checked-in lock resolutions but still depended on ambient cached registry tarballs; this was not hermetic (corrected below). A TS loader hook is required because Node does not strip TypeScript inside node_modules; it does not inject or replace the schema dependency.
- Important npm distinction measured directly: repository-root `npm ci --omit=dev` omits root dev TypeBox even with a required peer. The supported packed-package consumer installation installs the required peer and imports it successfully; docs explicitly distinguish these paths. No availability assertion was removed or bypassed.
- Parent's combined-loader regressions were left untouched and pass (manifest + explicit CLI canonical-path dedup; project-disabled package + explicit CLI override).

Commands/results:

- Initial native MCP suite: 1 failure at the dependency contract; initial real-Agent instrument: seven deterministic failures, including one actual tool execution for each unsafe response and unchanged single-query reuse for all three shaping changes.
- `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npx vitest run test/claude-sdk-provider.test.ts -t 'final review agent-loop'`: final **9 passed** (56 unrelated filtered tests). Covers partial/full tool-containing truncation, post-registration cancellation and timeout while observing message_stop (whole batch zero execution), low/high reasoning, budget and maxTokens changes across real Agent continuations (exactly one historical execution), and rejected runtime tool selections.
- `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npx vitest run test/claude-mcp.test.ts`: final **30 passed**, including required peer contract and actual offline production consumer install/import.
- **`env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npm run check`: typecheck passed; 349 files passed / 4 existing skipped; 5,739 tests passed / 20 existing skipped.** Duration 74.17s. Includes both preserved combined-loader regressions.
- `git diff --check`: passed. SDK 0.3.289, MCP 1.32.0 and development TypeBox 1.3.7 unchanged. No commit/push, live credential access, inference or deploy.

Unverified rollout gates above remain unchanged. The subsequent empty-cache review found and corrected a test-fixture regression (below).

## Hermetic native chart peer regression — empty-cache handback

- Scope: only `test/claude-mcp.test.ts` and this progress note changed in this follow-up; no production/provider changes.
- Reproduced the original regression with a fresh `npm_config_cache`: the consumer's offline install failed `ENOTCACHED` fetching `zod-to-json-schema-3.25.2.tgz`. A lockfile fixes resolutions, not availability of registry tarballs.
- The test now packs installed TypeBox locally and uses a fresh per-test npm cache/config. A focused minimal-package fixture retains the real packed chart sources and actual TypeBox peer declaration/metadata. The consumer overrides TypeBox to the local tarball without declaring it as a direct dependency, so npm must auto-install the required peer. No registry cache or network is needed.
- Both the existing Claude MCP chart import and the actual eager TypeBox native chart tool import succeed; schema/tool assertions and the Vitest-absent assertion remain. The existing manifest contract remains intact. Full-real-package isolated consumer installation was measured separately by sub5 (parent evidence), not repeated or replaced by a claim of full installation coverage here.
- Repository-root `npm ci --omit=dev` is not supported by this regression: npm root-dev semantics omit the development TypeBox pin. Normal repository provisioning uses plain install/ci; do not infer root omit-dev support from the packed-consumer result.
- Reproduction: `npm_config_cache="$cache" npm run test -- test/claude-mcp.test.ts -t 'offline production package install'` with `cache=$(mktemp -d)`: initially **1 failed** (`ENOTCACHED`), after fix **1 passed / 29 filtered**.
- Verification: `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST npm_config_cache="$cache" npm run test -- test/claude-mcp.test.ts` with another fresh cache: **30 passed**, 38.84s. The fixture also independently forces its own fresh cache. `git diff --check`: passed.
- Full gate/typecheck deferred to parent after handback. No live credentials/inference, commit, push or deploy.

## Per-block canonical assistant contract — offline handback

- `extensions/claude-sdk/events.ts`: after known-ID suppression, unknown-ID canonical assistant frames with null/missing `stop_reason` fail closed before content synthesis or ID registration. Explicit nonnull complete-response fallback and `max_tokens` precedence remain. Corrected `private open` indentation.
- Root cause measured with a direct converter probe: the first null-stop tool block returned `tools`, registered the shared ID and defaulted to `end_turn`; later same-ID blocks and max_tokens were ignored. The exact assertion now passes; the trace now rejects with empty content, IDs and registration events.
- `test/claude-sdk-provider.test.ts`: canonical-only shared-ID multiple blocks plus later max_tokens result reject with zero tools and no silent text success (tool-first, text-first, missing stop). Interleaved partial/canonical per-block frames execute each allowed tool once, preserve Pi guard denial, and do not duplicate content across the tool boundary. Partial/canonical interleaving with max_tokens executes zero tools; explicit full-response truncation coverage remains.
- `docs/claude-sdk-compatibility.md`: documents pinned sdk.d.ts per-block/shared-ID/null-stop/nonfinal-usage contract, required partial response boundaries, unsupported canonical-only incomplete frames and explicit complete fallback. No native SDK mapper changes.
- Final delta verification: `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts`: **119 passed, 5 files**. `npm run typecheck` and `git diff --check`: passed.
- Full gate deferred to parent after handback; earlier 5,739-pass evidence predates this delta. No commit/push/live credentials/inference/deploy.

## Incomplete tool JSON under truncation — offline handback

- `extensions/claude-sdk/events.ts`: retain invalid tool JSON/object shape as block state until `message_stop`. `max_tokens` preserves `length`; other stop reasons reject before batch exposure. Invalid arguments never register with the bridge; valid arguments still register at block stop, and `validateBatch` cancellation timing is unchanged. Tool block events remain balanced.
- Deterministic converter reproduction initially threw `SyntaxError` at block stop, before `max_tokens`. Paired valid/incomplete JSON instrumentation confirmed early valid registration versus zero invalid registration; after the fix both reach `length` with balanced events. Exact failing reproduction now passes.
- `test/claude-sdk-provider.test.ts`: real Agent incomplete-JSON/max_tokens case verifies length, zero execution, correlated failed tool result and successful subsequent model continuation. Malformed JSON with `tool_use` or `end_turn` reaches the definitive stop reason and fails closed with zero execution. Prior canonical/partial and cancellation regressions remain intact.
- Verification: focused `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts`: **122 passed, 5 files** (previous 119 plus 3). Combined SDK/MCP run: **152 passed, 6 files**. `npm run typecheck` and `git diff --check`: passed.
- Parent bg17 full gate predates this delta and does not cover it; parent must rerun after handback. No full-gate claim, commit/push/live credentials/inference/deploy. KB CLI search timed out; no durable KB update attempted.

## Correlation mismatch and conservative failure classification — sub11 handback

- `extensions/claude-sdk/tool-bridge.ts`: retained terminal registered-ID name/argument mismatch bookkeeping, batch cancellation, parked resolver settlement and bounded tombstones. Corrected dispatch cannot revive the ID. Real-Agent observer regressions retain zero whole-batch execution, independent-request reservation reuse and private-state cleanup coverage.
- Contract correction: known `assistant.error` codes do **not** prove pre-effect rejection. Inspected installed `sdk.d.ts:3611–3693`: `SDKAssistantMessageError` supplies an enum, not a nonexecution promise. Empty content, fresh context, no response events or visible MCP activity cannot establish hidden nonexecution; synthetic tests cannot supply the missing protocol guarantee.
- `extensions/claude-sdk/events.ts`: renamed typed classifier to `SdkAssistantFailure`; only `overloaded`, `rate_limit`, `server_error` cross into sanitized diagnostics. Removed speculative response-progress tracking.
- `extensions/claude-sdk/provider.ts`: all post-start failures, including classified empty failures, keep generic nonclassifier `errorMessage` and ambiguity quarantine. Diagnostics carry fixed failure wording, allowlisted code, timestamp and `retrySafe:false`. No automatic post-start failure retry absent a verified protocol guarantee. Removed `safeRejection`/fresh-query eligibility and bridge activity-only machinery. Retained attempted-prefix quarantine for synchronous query-launch throws. This is conservative functional policy, not error suppression.
- Deterministic actual-AgentSession baseline outside the checkout: all three known codes incorrectly made **3 queries / 2 retries** with `retrySafe:true`. Distinct direct exact-context probe incorrectly made **2 queries**. After correction the same probes pass (**4/4**): one query per failure and explicit replay quarantined.
- `test/claude-sdk-provider.test.ts`: replaced speculative safe-retry success/budget policy assertions with retry-enabled actual AgentSession coverage proving all three empty classified failures nonretryable, sanitized diagnostics retained, no raw secrets, cleanup and zero execution. Explicit exact-context replay tests now include all three classified empty failures; separate independent-request success verifies reservation reuse without implying retry safety. Existing unknown/post-start/tool/MCP/history/continuation coverage remains; no tests skipped or weakened.
- `docs/claude-sdk-compatibility.md`: documents classification-only contract, lack of nonexecution promise and conservative no-auto-retry policy.
- Final focused verification: `npm run typecheck` passed; `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts test/claude-mcp.test.ts`: **180 passed / 6 files**, 60.54s. `git diff --check` passed.
- No full gate, commit, push, PR, live credentials, inference or deployment, per delegation. Full-gate evidence predates this delta; parent owns integration review and final gates. Initial authenticated KB CLI search succeeded; no KB write tool is available (installed CLI lacks `knowledge write`), so durable boundary documentation is retained here and in compatibility docs.
- Ownership returned to parent; all seven task paths remain uncommitted atop `6c9d40b`.

## Parked delivery quarantine and setup cleanup — offline handback

- `extensions/claude-sdk/provider.ts`: record attempted canonical continuation before delivering any Pi result, and quarantine it even when parked state still exists. Preserve old-prefix quarantine too. Cancellation after toolUse (including successful first completion followed by cancelled sibling) cannot rebuild/replay the identical results context. Independent requests remain usable.
- Bridge construction now sits inside setup cleanup ownership; optional bridge teardown closes the MCP instance, and directory removal runs in finally. Invalid tool names leave the root empty after both request and shutdown.
- `test/claude-sdk-provider.test.ts`: real Agent/MCP post-toolUse cancellation regressions for one/two calls, partial completion trace, exact-context ambiguity with no additional SDK query, independent-request success and cleanup. Actual provider invalid-name and duplicate-declaration cleanup tests added. Source correction: pinned Pi canonicalizes tools by name before bridge construction, so ordinary duplicate declarations do not throw at provider level; the test preserves that existing canonicalization rather than introducing new rejection semantics.
- Deterministic `/tmp/sdk-parked-cleanup-probe.mjs` initially measured query #2 on identical continuation replay and an invalid-name directory surviving shutdown. Distinct instrument confirmed complete threw before prefix advancement, with only old-prefix replay quarantined. Both exact probe and instrument now pass (one query, ambiguous continuation, empty roots).
- Verification: `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts test/claude-mcp.test.ts`: **184 passed / 6 files**. `npm run typecheck` and `git diff --check`: passed. Terminal mismatch and conservative nonretryable diagnostics regressions remain green.
- No full gate, commit, push, dependency changes, live credentials/inference or deployment. Parent owns normal commit, generic full review and frozen gate.

## Failed-frame settlement and foreign tool IDs — solewriter handback

- `extensions/claude-sdk/history.ts`: failed/aborted assistant frames are excluded only from SDK settlement/seeds, not canonical Pi history. Actual unresolved toolUse calls still fail closed, including across failed frames; orphan results are rejected, never synthesized. Existing exact-attempt ambiguity quarantine is unchanged.
- SDK-only `sdkToolCallId` preserves valid 1–64-character native IDs and fingerprints invalid/long IDs with existing SHA-256. Both JSONL tool_use/results and `provider.ts` rebuilt following tool_result input use it. Settlement validates converted-ID uniqueness, including collisions with valid native IDs. Pi canonical IDs and live MCP bridge IDs are untouched.
- `test/claude-sdk-provider.test.ts`: existing malformed nontruncated JSON tests now continue on the same real Agent after zero execution/error, verify independent next-prompt success, canonical failed-frame preservation, clean seed, and exact-attempt replay refusal. New fixtures cover error/aborted omission without synthesized results, unresolved handoff refusal, completed OpenAI history and reconstructed following-result batches with pipe IDs, 450-character shared prefixes, special-character collisions, valid native preservation, canonical immutability and explicit normalized-ID collision refusal.
- Deterministic direct Node baseline failed both settlement and ID assertions; distinct JSONL/settlement instrumentation measured failed frames counted as pending and five invalid raw seed IDs. Exact reproduction now passes; instrument shows error/aborted settled, real toolUse still unresolved, all six seed pairs valid/correlated and canonical history unchanged. Full Pi transform-messages.js was read, not reused: its synthetic orphan results would weaken this boundary.
- Verification: `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts test/claude-mcp.test.ts`: **189 passed / 6 files** (62.71s). After one additional unresolved-before-failed assertion: provider suite **108 passed**; `npm run typecheck` and `git diff --check` passed. Compatibility docs updated narrowly.
- No full gate, commit/push/PR, live credentials/inference or deploy. Parent owns diff review, commit and generic full review. Native CLI resume acceptance and all earlier offline rollout limits remain unverified. Authenticated KB search succeeded; durable boundary notes remain here and in compatibility docs (no KB write interface available).

## Three additional audit defects — solewriter pre-freeze handback

- Preserved all incoming uncommitted failed-frame/foreign-ID history changes, including `history.ts`, provider wire-ID conversion, provider regressions and documentation. No reset, staging, commit or push.
- `extensions/claude-sdk/tool-bridge.ts`: missing/nonstring/empty/whitespace/control/overlength correlation metadata closes the whole bridge before returning MCP failure. There is no attributable safe ID to tombstone. Registered-ID mismatch handling remains terminal and unchanged. Real-Agent fixtures send malformed MCP requests while observing message_stop, without any subsequent assistant.error, and verify zero whole-batch Pi execution, settled parked replies and private-state removal. Direct MCP fixtures also verify unregistered waiters settle and fresh registration/completion fail after closure.
- `extensions/claude-sdk/provider.ts`: setup allocations and parked states now use the same cleanup owner and persistent failure latch. Query/iterator construction failures still dispose query/process/MCP resources and attempt directory removal. Cleanup failure reports operator cleanup required, refuses subsequent independent requests and rejects idempotent shutdown. Fault-injected rm tests confirm seeded sensitive history survives only as an explicitly failed/operator-owned orphan, not a successful cleanup. Normal setup/private-directory regressions remain green.
- `extensions/claude-sdk/runtime.ts`: directly spawn the supplied pinned command with detached:true and synchronous 077 mask, using the existing `treeSpawnOptions` / `trackTree` / `killTree` ownership utility. Scope retains owned ChildProcess handles rather than numeric PGIDs; every TERM/KILL uses shared ownership discovery/validation. Exited leaders with pipe-holding descendants remain tracked, and shared normal-close cleanup reaps silent descendants. No wrapper, executable substitution, ambient environment merge, login, auth fallback or unrelated child-tree helper refactor.
- `test/claude-sdk-runtime.test.ts`: actual offline Node leader exits while a detached, TERM-resistant, token-inheriting descendant retains stdout; scope teardown finds and kills it. Existing actual Node mode/process-group/escalation tests pass. New `test/claude-sdk-process-ownership.test.ts` supplies synthetic procfs identities and changes root/member starttimes/tokens before teardown and between TERM/KILL; no recycled identities receive either unsafe abort/close signalling or escalation. Existing child-tree descendant, birth-bound and unreadable-procfs fallback suites pass unchanged.
- Actual boundary: Linux readable procfs supplies starttime/token/descendant ownership verification at each signal. Other OSes/unreadable procfs retain the utility's existing group-only fallback, which does NOT establish recycled-PID safety. Environment-scrubbing plus out-of-group reparenting can evade discovery; parent SIGKILL cannot run cleanup. Stronger guarantees need OS cgroups/job objects. No portable-proof or sandbox claim is made; compatibility docs record these limits.
- Deterministic `node --experimental-transform-types /tmp/sdk-sub18-probe.mjs`: initial 3/3 failures (valid batch accepted after malformed MCP error; two query starts/two orphan dirs with successful shutdown after rm faults; negative TERM/KILL for absent exited PID), final 3/3 passes. Distinct `/tmp/sdk-sub18-instrument.mjs` confirms pending resolver/registration state, private setup allocations and exited-handle/procfs state; final rerun passes. These temporary probes are not repository delivery dependencies.
- Final focused command: `env -u PI_AGENDA_WORKER -u PI_SUBAGENT_FAST VITEST_MAX_WORKERS=2 npx --no-install vitest run test/claude-sdk-*.test.ts test/claude-mcp.test.ts test/child-tree*.test.ts`: **221 passed / 11 files**, 39.04s. `npm run typecheck` and `git diff --check`: passed. An intermediate typecheck caught two fixture typing mistakes; both were corrected before this final run.
- Authenticated KB search succeeded; durable boundary findings are recorded here and in compatibility docs. No full gate, commit, push, PR, real Claude process/inference, credential access or deployment. Parent owns final generic review after commit and frozen npm gate. Native CLI/platform/billing/renewal rollout limits remain unverified.


## Final SDK platform/cleanup boundary — solewriter handback

- Supersedes the preceding SDK portable/group-fallback boundary: **SDK requires Linux with readable procfs ownership; unsupported platforms/unreadable procfs fail before executable preflight or actual spawn.** Non-SDK callers retain the existing shared portable fallback unchanged. All incoming sub16/19/history/MCP/provider changes were preserved; no reset/staging/commit/push.
- `extensions/hive-common/child-tree.ts`: optional fourth `trackTree` argument `{ requireIdentity: true }`; strict mode discovers token/ancestry members and sends only individually rechecked positive PIDs, never group or bare-child fallback. Initial root capture also checks the unique inherited token. No unverified group-membership adoption. Close/error/shutdown observers latch failures rather than throwing; explicit `killTree`/scope close surfaces operator cleanup required even after visibility recovers. Strict ownership survives leader/pipe close until explicit release; WeakMap retains strict policy for delayed callbacks after release.
- `extensions/claude-sdk/runtime.ts`: SDK-only strict tracking, readability assertions, query-bounded ChildProcess handle retention through close, TERM/KILL rechecks, all-child cleanup attempts and sticky failure. The returned SDK process interface routes `kill()` through strict cleanup: inspected installed SDK transport delayed TERM/KILL and exit-tracker callbacks, which otherwise bypassed the policy via native ChildProcess.kill.
- `extensions/claude-sdk/provider.ts`: cleanup attempts every resource even if query/bridge/process teardown fails, then latches the failure and refuses later requests. Setup failure regression verifies query.close throwing does not bypass process cleanup/private-state removal.
- Tests: unsupported macOS and unreadable procfs before spawn/preflight; recycled root/member identities before close and during escalation; post-spawn visibility loss from abort/close/shutdown/escalation; own-UID orphan environment denial; sticky explicit errors; SDK kill callbacks before/after release; retained token orphans after leader/pipe close; real detached Node orphans, including all pipes closed. No real Claude or host configuration.
- Investigation caught a real procfs exit race: an unrelated Go compiler became zombie between stat and environ, returning EACCES with own UID. Instrument measured its Z state. Strict discovery now ignores dead/recycled identities before classifying environment denial as live visibility loss; mocked regression preserves fail-closed behavior for live candidates. One fully parallel MCP run hit its existing 5s startup timeout; final bounded-worker run passed without changing timeout/assertions.
- Final verification: `npm run typecheck` passed; `npx vitest run --maxWorkers=2 test/claude-sdk*.test.ts test/claude-mcp.test.ts test/mcp-common-config.test.ts test/mcp-gateway*.test.ts test/mcp-lazy.test.ts test/mcp-search-fallback.test.ts test/readiness-mcp.test.ts test/child-tree*.test.ts`: **320 passed / 17 files**, 48.09s. `git diff --check` passed. Exact initial unreadable-procfs Node reproduction changed from negative-group SIGKILL to zero signals; distinct post-track-denial instrument now produces zero signals, explicit operator-cleanup error and nonthrowing close observer (protocol reverify recorded).
- Safety limits remain explicit in README/compatibility docs: cooperative cleanup, not a sandbox; token clearing plus pre-discovery reparenting can evade tracking, procfs check-to-signal is not atomic/pidfd-backed, SIGKILL delivery is not completed-reaping proof, parent SIGKILL cannot run cleanup. No portable SDK runtime acceptance, full gate, commit/push/PR, credential access, inference or deployment. Parent owns final review/commit/gate.

### Final cleanup review corrections

- Strict process cleanup now records each signalling failure but still attempts every other verified member and the root, including escalation; EPERM regression preserves the operator-cleanup latch.
- Shutdown awaits all cleanup/setup settlements before reporting failure, including concurrent cleanup where one disposal rejects and another is still pending; repeated close calls share that barrier.
- Typecheck and both focused ownership/setup-cleanup files passed (18 tests). Full frozen gate and exact-head hosted checks remain pending; no live activation or subscription/renewal acceptance is inferred.

### Terminal-stop and platform review corrections

- Completed tool proposals require an explicit tool_use stop; refusal/pause/end-turn/unknown terminals fail closed before Pi handoff. Real-Agent regressions include parked MCP requests without a later masking SDK error.
- Positive SDK process/ownership tests are Linux-scoped; unsupported-platform/preflight rejection tests remain unconditional. Existing non-SDK portable behavior is unchanged.
- Typecheck and 142 focused tests passed. Earlier full gate bg-28 passed 5,820 tests/20 skips but predates these changes and is not final-tree evidence.

### Parked-disposal replay review correction

- Every idle handed-off query quarantines its original result-free attempt before disposal, covering cancellation and parked expiry even after the active stream has completed. Canonical correlated results still rebuild safely.
- Typecheck and 121 provider regressions passed. Prior full gates are superseded by this change; final frozen full gate/review/hosted checks remain required.

### Final invariant review batch

- Result-free attempts are reserved at tool handoff, before replacement or a different session can replay them. Canonical correlated continuation remains supported.
- Failed descendant discovery latches the error but does not prevent independently identity-verified root/member cleanup.
- History conversion now takes the destination model identity: signatures are same-model/provider/API only; cross-model visible reasoning becomes text, opaque/empty assistant frames are omitted from SDK seed only.
- Typecheck and focused provider/ownership regressions passed. Mixed-tree intermediate gates bg-28/bg-29 are not final evidence. Final-tree Hive snapshot #14328 passed lint and both DB shards on tree2063ccf7; logs prove 738 API/762 store tests exercised Postgres and strengthened SDK lease assertions passed.
