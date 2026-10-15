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
