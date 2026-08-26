# usage — provider quota/spend in the footer (HIV-1221)

In-house replacement for `@narumitw/pi-usage` (2.1k LOC → ~350). Writes the
same `setStatus("usage", …)` key `status-footer` already reads, so the footer
cell is unchanged plumbing with better numbers:

- **Codex**: BOTH rate-limit windows — `codex 5h 12% · 7d 34%` — read from
  the backend usage endpoint via the shared contract in
  `hive-remote/status.ts` (HIV-1188: pi does not surface response headers;
  the endpoint is a plain read costing no tokens). Auth resolves from pi's
  own provider credentials; only the official chatgpt.com origin ever sees
  the token (`isOfficialCodexOrigin`).
- **OpenRouter**: lifetime key spend (+ remaining when capped) from
  `GET /api/v1/key` with `OPENROUTER_API_KEY`.
- The ACTIVE provider's segment leads; `/usage` opens a detail overlay with
  reset times and reading age (and force-refreshes both).

Rules: fetches are detached promises, never awaited in handlers
(handler-serialization); a failed read keeps the last good reading — an
absent answer is not a reset quota; refresh floors 60 s (Codex) / 300 s
(OpenRouter), `/usage` skips them.

Dropped relative to the package: Copilot support (no Copilot provider here),
the extra status-line theming (status-footer owns presentation).
