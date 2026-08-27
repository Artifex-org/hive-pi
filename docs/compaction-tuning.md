# Compaction tuning

`workstation/.pi/agent/settings.json` → `compaction`.

## The sizing rule

**`reserveTokens` must be larger than the biggest single-turn context jump the
harness can produce — which means larger than the biggest single tool result.**

pi checks compaction twice per assistant message, in this order
(`dist/core/agent-session.js`):

1. **overflow** — `isContextOverflow(assistantMessage, contextWindow)`, i.e. the
   provider already rejected the request. Fires `_runAutoCompaction("overflow")`.
2. **threshold** — `shouldCompact(contextTokens, contextWindow, settings)`, which
   is simply `contextTokens > contextWindow - reserveTokens`. Fires
   `_runAutoCompaction("threshold")`.

Overflow is checked first, so the threshold only ever fires if the context
crosses `window - reserveTokens` *without* blowing past `window` in the same
turn. If one turn can add more tokens than the whole reserve, the proactive
path is skipped and compaction becomes purely reactive — pi compacts only after
a failed request, and the turn has to be retried.

That is worse than compacting early: it costs a wasted provider round-trip, it
can burn the one-shot `_overflowRecoveryAttempted` guard, and the compaction
happens at the least convenient moment (mid-turn) rather than at a message
boundary.

## Why 65536

Measured on this workstation, 2026-08-06. A dogfooding session running Hive MCP
tools compacted once, and that compaction was reason `overflow` at
`compaction_tokens_before = 284001` — the threshold never fired.

The cause is tool-result size. A single `mcp__hive__get_insights(days=3)` call
returned **145,907 characters (~36k tokens)** — more than twice the old
16,384-token reserve. Other Hive readers (`list_runs`, `get_run` on a wide DAG)
are in the same class. So the context could sit comfortably below the threshold,
take one tool result, and land past the context window in a single step.

`65536` covers a ~36k tool result plus the model's own output with headroom.
Raise it further if a tool starts returning more than ~48k tokens in one call;
the better fix at that point is to cap the tool result, not to keep growing the
reserve.

## Reading the telemetry

`compaction_overflows` (reported to Hive by `extensions/hive-telemetry`) counts
only `reason === "overflow"`. With the reserve sized correctly this should be
**0** for a healthy long session, and automatic compactions should show up as
`threshold` instead. A non-zero `compaction_overflows` now means what its name
says: the reserve was too small for something that session did.

Note pi has no dedicated compaction model — `compact()` is called with the
session's own `requestModel`, and the only compaction settings pi reads are
`enabled`, `reserveTokens` and `keepRecentTokens`. Pointing compaction at a
cheap long-context model would need upstream pi support.

## Prefer `/handoff` for planned work

Compaction is lossy and repeated summarization distorts earlier reasoning. For
phase-structured work use `/handoff` at a phase boundary
(`extensions/agenda/handoff.ts`, HIV-1231) — compaction is the fallback for
unplanned overflow, not the intended tool.
