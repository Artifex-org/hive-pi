# Claude subscription transport: offline compatibility slice

Status: **non-serving prototype**. This does not add a selectable model, enable
subscription access in Pi, or establish subscription billing/eligibility.

## What this slice proves

`prototypes/claude-sdk/` is outside the package's auto-discovered `extensions/`
root and is not imported by a runtime extension. The SDK and MCP packages are
**development dependencies only**, pinned to 0.3.289 and 1.32.0 in both lockfiles.
No SDK binary is started by the tests.

- `options.ts` compiles against the real SDK 0.3.289 `Options` and
  `SDKUserMessage` declarations. It constructs explicit isolated options and
  preserves supplied system/user text, with `verbatimPrompts` and
  `client_composed`. It does not call `query()`.
- `accessLease` checks the existing Hive access-only response's exact shape
  (`access_token`, `expires_at`, `credential`, `slot`) and bounded future
  expiry. It rejects full auth documents/refresh tokens and never includes input
  values in validation errors. **It does not authorize the caller, establish
  account identity, or make the upstream bearer token session-scoped.**
- The child environment is built from an allowlist, never `process.env`.
  SDK 0.3.289 documents that supplying `env` replaces the child environment.
  Options disable built-in tools, filesystem settings, hooks, plugins, skills,
  cloud MCP discovery, memory and compaction. Only named Pi MCP tools are
  preapproved; unexpected permission requests are denied. These assertions test
  option construction, not the native executable's enforcement.
- `tool-bridge.ts` uses the real MCP server/client protocol over in-memory
  transports. It accepts only stream-registered tool-use IDs with matching names
  and arguments. Calls remain parked until Pi supplies a result; parallel/early
  results, guard-error results, images, duplicate IDs/results, individual request
  cancellation/timeouts, transport disconnects and whole-bridge abort cleanup are tested. It has no tool execution callback and does not execute files or
  shell commands. The fixture is limited to 256 calls and is not a persistent
  session manager.
- The bridge accepts Pi 1.0.2 `Tool` and `ToolResultMessage` types. The tests
  supply synthetic results; they do **not** prove the full Pi agent loop or its
  real hook pipeline. Supplying a result is the future provider's trusted
  responsibility after Pi checks and executes (or denies) the call.

Run the local gate with:

```sh
npm ci --ignore-scripts
npm run check
```

Focused checks:

```sh
npm run typecheck
npx --no-install vitest run test/claude-sdk-options.test.ts test/claude-sdk-tool-bridge.test.ts
```

All credential fixtures are synthetic. No test reads a login, calls authd/Hive
credential endpoints, performs an SDK query, or accesses Anthropic inference.

## Existing authd compatibility and the next gate

Reuse registered credential provider **anthropic** and its existing assigned
account chain. A future Pi model prefix `claude-sdk/` would map explicitly to
that provider; it would not create another login or subscription registration.
Keep the separate **anthropic-api** Console-credit lane explicit, without an
automatic paid fallback.

Current Hive source deliberately excludes Anthropic from Pi's full-document
leases (`internal/pilease/provider.go`). Its access-only
`GET /api/v1/agent-launches/{id}/claude-auth` route currently permits only
`claude-code` launches. This slice changes neither restriction.

Before implementing a serving provider, obtain a separately authorized account
scope and bounded live-turn budget, then test the **unchanged actual Hive/Pi
prompt** and intended MCP tool shape through a legitimate access-only test path,
with Extra Usage disabled. Do not impersonate another harness to obtain a token.
A historical successful native-Claude-driver probe is not proof for this bridge.
If this prompt/tool combination is ineligible, stop this lane; do not rewrite
identity/instructions to defeat billing checks or fall back to API billing.

Anthropic's current legal guidance also leaves shared personal-account and
third-party credential intermediation eligibility as a rollout question.
Technical authentication success does not resolve that question.

## Deferred implementation and acceptance

After the feasibility gate, the remaining work is:

1. Narrow server-authorized admission for SDK-backed Pi launches, with existing
   tenant/owner/account assignments; ordinary Pi, forged provider selections,
   revoked assignments and unauthorized workers must still be refused.
2. Access-only credential acquisition and bounded renewal. Authd remains the
   only refresh-token writer. Its current expired-only refresh means a near-expiry
   GET can return the same token: do not restart-loop or assume renewed validity.
   Add server-bounded/coalesced minimum validity only if measurements require it.
3. Real provider registration and SDK-to-Pi event conversion, usage accounting,
   SDK-boundary instrumentation, dynamic tools and explicit worker loading.
   Raw HTTP body/response hooks are not supplied by this prototype; do not
   silently discard mutations or fabricate response headers.
4. Authorized private state provisioning/retention, native CLI enforcement,
   process-tree cleanup, account-bound resume, compaction, branching, provider
   switching and concurrent helpers. Never replay recorded completed tools;
   ambiguous crash-after-side-effect outcomes require reconciliation.
5. Actual Pi extension-loader/agent-loop tests, final-head CI and separately
   authorized billing/expiry/no-ambient-fallback tests. SDK 0.3.289 import and
   declarations alone do not prove behavior with Hive's pinned CLI 2.1.286.
   Factory/cloud need their own principal-scoped delivery/runtime admission.

## Research references

- [Anthropic: Agent SDK with Claude plans](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Agent SDK vs API client SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Public SDK TypeScript options](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Authentication/credential-use conditions](https://code.claude.com/docs/en/legal-and-compliance)
- [pi-claude-subscription source reference](https://github.com/jkeskikangas/pi-claude-subscription/tree/1ed9e15b5f0e53ba906ad0df7a07ed86225e5163):
  parked MCP-call design; local-login/global-state/prompt-replacement behavior
  is not adopted here.
- [pi-claude-agent-sdk source reference](https://github.com/pi-pod/pi-claude-agent-sdk/tree/36a20bcb28e23bbd948f47fd0661120556e2620c):
  OAuth injection and lifecycle comparison; its Pi-auth-store assumption does
  not fit Hive's current boundary.
- [Pi community billing-classification report](https://github.com/earendil-works/pi/issues/6888):
  evidence for the early unchanged-prompt test, not an eligibility guarantee.

No third-party adapter code is vendored in this compatibility slice.
