# pi 0.83 → 0.84 upgrade — impact assessment (HIV-1259)

Upstream `@earendil-works/pi-coding-agent` 0.84.0 (2026-08-06). This is the
assessment the ticket required **before** the bump, plus the bump itself and a
go/no-go on the experimental RemoteSession client.

## Verdict: LOW RISK — one code change, tsc-caught

The 0.84 breaking changes were audited against hive-pi's actual usage. Only one
touches us, and the compiler catches it. The headline concern — the durable RPC
workers (HIV-1106) against the v4 session model — resolves to **zero impact**.

## Breaking change → hive-pi impact

| 0.84 change | hive-pi surface | Impact |
|---|---|---|
| `message_update` emits only `assistantMessageEvent` deltas; cumulative `message`/`.partial` removed | `hive-remote/transcript.ts` `deltaOf`, `subagent/lifecycle.ts` | **None.** `deltaOf` already reads `assistantMessageEvent.delta` with the `text_delta`/`thinking_delta` discriminator — exactly the surviving shape. Every `event.message` read elsewhere is on `message_end`, which still carries `message`. |
| `getApiKeyAndHeaders()` returns `ProviderHeaders` with `string \| null` values | `hive-remote/status.ts`, `usage/index.ts` (Codex quota/usage fetch) | **The one real change.** Both spread `auth.headers` into a `Record<string,string>` forwarded to `fetch`; a `null` (pi-ai's header-deletion marker) is a tsc type error. Fixed with a `pickStringHeaders` filter — for a plain fetch a deletion marker has nothing to delete, so it is dropped. `advisor/index.ts` also calls it but doesn't spread into a typed record → no error. |
| v4 lane-based `Session`/`SessionStorage`/`SessionRepo`; legacy JSONL/in-memory repo APIs **removed**; `AgentHarness` v2 default export | grep of `extensions/` | **None.** hive-pi imports only surviving *types* from `pi-agent-core` (`AgentToolResult`, `ThinkingLevel`). It uses no `JsonlSessionRepo`/`InMemorySessionRepo`/`SessionRepo`/`SessionStorage`/`AgentHarness`. |
| `RemoteSession.sessions` lost runtime phase/model/lock fields (#7708) | — | **None.** hive-pi does not use `RemoteSession` at all (see spike below). |
| Durable RPC workers (HIV-1106) vs v4 session | `agenda/rpc-worker.ts`, `agenda/rpc-protocol.ts` | **None — and this is the load-bearing finding.** `rpc-protocol.ts` documents *why not `RpcClient`*: hive-pi deliberately spawns its own subprocess (`node:child_process`) and frames JSON over stdio itself, rather than using pi's `RpcClient`/session APIs. So the entire v4-session/RemoteSession rework cannot touch it — it never depended on those APIs. |
| Event-bus listeners no longer survive session reloads (#7656) | 14 `pi.events.on` subscriptions | **Neutral/beneficial.** #7656 is a *fix* — listeners are now cleaned up on disposal instead of leaking. hive-pi extensions re-run their subscribes on reload (fresh jiti per extension), and the two that track long-lived subscriptions (`hive-remote`, `hive-telemetry`) already keep explicit `unsubscribe` handles. |
| `ModelsStreamTransforms`→`ModelsRequestTransforms`, `setRuntimeApiKey`, `refreshModels`/`context.publish` provider-refresh contract | grep of `extensions/` | **None.** These are provider-implementation APIs; hive-pi implements no custom provider, so nothing references them. |

## The change made

- Bumped all four `@earendil-works/*` pins (`pi-agent-core`, `pi-ai`,
  `pi-coding-agent`, `pi-tui`) 0.83.0 → 0.84.0.
- `pickStringHeaders` filter in `hive-remote/status.ts` and `usage/index.ts`.
- `npm run check` (typecheck + full pinned suite) is the safety net for a pin
  bump — behavioral changes not covered by a type error surface there.

## Also available in 0.84 (adopt later, not here)

`AGENTS.override.md` per-directory context, `shouldStopAfterTurn` graceful
stop-after-turn (cleaner than our abort paths), vendor-neutral telemetry
schemas (compare against hive-telemetry), markdown transformer hooks. None
adopted in this PR — the bump stays minimal.

## RemoteSession client spike — go/no-go: **WAIT** (experimental)

0.84 ships experimental remote-session client APIs (`PiClient`, a CBOR
protocol, Unix-socket transport, a `RemoteSession` controller with transcript
reducers). The appeal: a first-party attach path that could replace parts of
hive-remote's custom transcript bridging (the `postDelta`/`postEvents`/frame
machinery) and give the Hive workspace a supported way to reach a live session.

**Verdict: do not adopt yet.**
- Upstream marks it **experimental**, and 0.84 already reshaped `RemoteSession`
  (#7708 removed phase/model/lock from `.sessions`) — the surface is still
  moving, exactly what a transport we depend on must not do.
- hive-remote's current bridge is transport-over-HTTP to the Hive server
  (browser-facing), not process-local attach; `RemoteSession`/Unix-socket is a
  *different* topology (local IPC), so it is not a drop-in for what hive-remote
  does — it would serve a new capability (local attach), not replace the
  existing one.
- Revisit when the client APIs leave experimental and `RemoteSession`'s shape
  settles across a release. Tracked as a follow-up on HIV-1259.
