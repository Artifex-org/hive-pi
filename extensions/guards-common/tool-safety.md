# Shell safety classification

The harness already has deterministic path, identity, shell-policy and operating-mode
checks. `guards-bridge.ts` now also observes shell-call risk through the shared native
Jev client. **This is advisory, not a security boundary or an approval system.**

## Enable

Both files under `~/.pi/agent/hive-telemetry/` must contain `"enabled": true`:

- `typesafe.config.json`: the existing global Jev opt-in, provider/model and timeout.
- `tool-safety.config.json`: separate consent to send redacted shell command arguments.

Reload extensions after configuration changes. Defaults are off; enabling agenda's
Jev probes alone does not enable shell classification. Pi's model registry owns the
classifier model (`typesafe/jev-latest` by default), credentials and routing. There
is no HTTP fallback or additional dependency. SDK pilot sessions remain disabled
by the shared native transport.

## Behaviour

`bash` and `background_bash` are observed after guards-bridge's native/bridged
checks and any required human confirmation. Those checks can still deny the call
without contacting Jev. Nested calls through codemode use pi's same tool hooks;
the outer JavaScript is not classified. Other extensions' guards still run in
extension load order and are not bypassed. User-typed `!` commands, arbitrary MCP
tools and processes spawned internally by extensions are outside this seam.

One fixed-choice question classifies the command as read-only inspection, ordinary
local development, destructive operation, external mutation, data exposure,
untrusted execution, security change, or unknown. This describes effects, **not
whether the user authorized them**. The question treats the entire command as
untrusted data; Jev remains prompt-injectable and cannot inspect referenced scripts
or know the filesystem/remote state.

High-confidence risky categories produce a UI warning before execution. Unknown,
confidence below 0.8, or a winner/runner-up probability margin below 0.2 abstains
from warning. These are conservative initial warning thresholds, not calibrated
accuracy or safety guarantees. A benign label never grants permission; even a
high-risk label never blocks, asks for approval, changes arguments or steers the
agent. Existing approval requirements and deterministic guards remain authoritative.
In particular, these warnings **do not prevent the warned action from executing**.

The shared timeout (3 seconds by default), cancellation and strict answer decoding
bound the call. Each shell call awaits classification, so a slow or unavailable
provider can add up to that timeout to every observed call; there is no outage
backoff in this first opt-in observer. Disabled/missing model, timeout, malformed
response, and transport failure are not benign labels. Commands over 8,000 characters, either before or
after redaction, are skipped whole, not truncated (a dangerous suffix must not
disappear). Known secret environment values and the shared token-shape patterns
are redacted before egress. Redaction is
best-effort, not a guarantee against arbitrary inline sensitive content: only enable
this if sending redacted command text to the configured provider is acceptable.
No transcript, cwd, file contents or tool output is sent.

## Observe and verify

`/tool-safety` reports per-session outcome counts, warnings, uncertainty, skipped
commands and reported input tokens. Sanitized `tool-safety` custom session entries
record the call id, outcome, category/confidence, warning/uncertainty, latency and
reported usage/cost when answered. They never contain command text or provider error
prose. Headless sessions retain these entries even without UI notifications. These
entries do not themselves add classifier cost to pi's session footer.

`test/tool-safety.test.ts` exercises the real guard hook and native transport with a
stubbed registry: opt-in, direct/background/nested event coverage, deterministic
precedence, redaction, warnings/abstention, missing/malformed responses, cancellation
deadline and session replacement. `test/tool-safety-native.test.ts` also runs the
pinned Pi runtime with stub tools and a stub classifier provider to verify actual
nested dispatch and observation before execution. The representative command cases verify wiring
and policy, **not Jev accuracy**. No live classification evaluation or adversarial
benchmark has been run for this seam. A blocking rollout would require an explicit
policy decision and measured labels; it is not implemented here.
