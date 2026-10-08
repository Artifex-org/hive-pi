# Offline native spawned-worker replay

`test/subagent-native-worker-replay.test.ts` runs production `runSingleAgent`
against a spawned fixture using the existing `PI_HOUSE_PI_BIN` executable seam.
The child builds a real native `AgentSessionRuntime`, in-memory `SessionManager`,
`ModelRuntime`, and `SettingsManager`, then calls Pi's actual `runPrintMode` JSON
printer. The model transport is `fauxProvider`; transcripts are synthetic, not
operator history. Runtime auth/model/config paths and tool cwd are temporary;
fetch requests are refused. This is a fetch safeguard, not an OS network
sandbox; no network-capable provider or MCP extension is provisioned. No real
credentials or provider charges.

The fixture checks JSON/no-session/no-extensions argv and honors the supplied
`--tools` selection and task. It does **not** load the production worker extension
allowlist, resolve production provider models, or test the CLI argument parser.
This exercises worker JSON transport and native orchestration, not vendor
HTTP/SSE, real authentication, extension provisioning, or caching behavior.

## Verified scenarios

- Native `read` executes once against a temporary evidence file; the next model
  call checks its tool-result content. User/tool messages do not inflate
  assistant usage; the parent folds native assistant usage and model identity.
- Pi's own JSON printer transforms native events; serialized delayed split
  stdout writes exercise actual parent framing without interleaving records.
- Native assistant retries a faux 429 with configured 5 ms backoff, succeeds on
  call two, or exhausts after three calls (5+10 ms). Retry events are emitted by
  the native runtime, not invented by the fixture. Parent classification notices
  failed assistant results even when JSON-mode exit code is zero.
- Parent cancellation occurs during an actual second-response text delta, after
  native tool evidence. Production termination and native SIGTERM cleanup (verified by a signal
  observation plus a native session_shutdown hook marker) yield
  `DelegationAborted` with retained partial accounting; the child PID is reaped.
- Startup failure returns non-success with zero assistant turns and no prompt
  accidentally presented as an answer. All completed cases verify PID reaping.

Only completed assistant messages are billed by the parent fold; this does not
claim final usage for a killed response or exactly-once external effects. A
faux-provider cost of zero says nothing about real-provider billing. The framing
fixture uses synthetic ASCII and is not a byte-decoder/Unicode torture test.

Focused gate: `npx vitest run --pool=forks test/subagent-native-worker-replay.test.ts`.
Full gate: `npm run check`. No production source changed for this slice.
