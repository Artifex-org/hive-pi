# You should know

A default-on pi-native adaptation of Claude Code's
[`cc-plugin-you-should-know@builtin`](https://code.claude.com/docs/en/plugins/mods/overview#mods-built-into-claude-code).
Anthropic documents a side agent that surfaces overlooked information above the
prompt; its exact scanning implementation is not public in the linked source
list. This extension implements that idea, not undocumented plugin parity.

**Enabled by default in pi terminal sessions and attached Hive web conversations.** No enable command is required.
Scanning automatically sends assistant-prose excerpts to a configured low-tier
model provider and consumes that account's quota, within the limits below. Set
`PI_YOU_SHOULD_KNOW_MODEL=provider/id` to select an explicit model; otherwise the
extension uses only the exact `low` key from the Hive agent-mode catalog. It
never falls back to the currently selected session model or delegation model.
If the low model or its credentials are unavailable, scanning fails closed.

Disable in the current session with:

```text
/you-should-know off
```

`PI_YOU_SHOULD_KNOW=0` makes new terminal sessions default off. `/you-should-know on`
re-enables scanning explicitly. Command settings are saved to the active session
branch and restored on reload/resume, overriding the startup default. Overrides
are bound to the session ID: fork/clone/import into a different session uses its
startup default instead. No workstation settings files are changed.

| Command | Effect |
| --- | --- |
| `/you-should-know` or `status` | Enabled state, scan budget, reported side-call tokens/cost and failures |
| `/you-should-know on` | Scan future assistant prose; does not backfill old output |
| `/you-should-know show` | All retained notes, with their exact source quotes |
| `/you-should-know dismiss` | Clear notes and cancel pending work; repeated quotes stay suppressed |
| `/you-should-know off` | Stop/cancel scans and hide the widget; retained notes remain available via `show` |
| `/you-should-know record-on` | Request recording of future eligible sources, independently of scanning/highlights |
| `/you-should-know record-off` | Stop unissued recording locally and request an ordered server cutoff; retain actual receipts |

## What it catches

Buried missing-verification caveats, blockers, user actions and consequential
decisions. A tool-less side call to the configured **low-tier model**, using pi's
configured provider/auth, returns up to three short notes with source-grounded
classification and optional expected outcome/impact. Each must include an
exact quote present in the scanned excerpt; expected/impact must also be exact
source excerpts rather than inferred consequences. Routine progress, success summaries,
hypotheticals, quoted examples and resolved issues are excluded by the prompt.

The host's native above-editor widget shows the newest three notes; `show`
includes the evidence. It uses the host's neutral terminal text/wrapping (no
new palette, interactive controls or animation). At most ten notes and one hundred normalized source
quotes are retained. Quote matching suppresses repeats, not every possible
paraphrase. Notes are model interpretations of what the assistant said, **not
verified findings or instructions**. They are highlights of **earlier output**,
not a current blocker ledger; a later resolution does not automatically retract
an old note. Dismiss obsolete notes. Silence is not a clean bill of health.

## Boundaries and cost

- Finalized assistant **text** is scanned. `PI_YOU_SHOULD_KNOW_CAPTURE_TOOLS=1`
  additionally opts into explicit failed SDK tool-result text, bounded to 2,000
  characters and referenced by tool-call ID. Normal results, expected lookup
  misses and scanner/control/papercut acknowledgments are excluded. No thinking,
  user prompts, raw tool arguments, result-detail dumps, files, Claude transcripts
  or independent investigation are captured. Evidence is redacted before model
  or Jev egress; source provenance remains client-reported, not server-verified.
- The excerpt keeps at most 16,000 characters of recent prose, explicitly marking
  an omitted beginning. New output is coalesced while a scan is running.
- First scan is debounced by one second, or scheduled when the agent settles.
  Subsequent starts are at least 30 seconds apart. There is one call at a time,
  a 60-second hard deadline, 2,048 answer tokens, and **20 attempted scans per
  active session branch**. Failures count; toggling off/on does not reset the
  budget. Fork/tree navigation restores the destination branch's state.
- Enabled scanning sends excerpts to the configured low-tier model's provider
  and consumes that account's quota. No separate analytics or telemetry is added.
  `/you-should-know status` reports completed calls' provider-reported usage, separately from
  pi's main-session totals; canceled calls may still incur provider charges.
  Jev's reported tokens are disclosed separately; its unreported monetary cost is
  not estimated or added to extraction cost.
- Event handlers do not await a model. A detached timer performs the scan; it
  does not delay tools, auto-continue the agent or change its context. No tools,
  messages, system-prompt changes or provider-request hooks are registered.
- Session entries contain enabled state, budget, failed-scan count, notes, quotes and
  usage counters, not full excerpts. The failed count is what tells a saved session's
  `scans: 20, notes: [], tokens: 0` apart: twenty provider errors, or twenty scans
  that found nothing. They do not enter LLM context. Existing session export/telemetry
  retains its own behavior and consent policy.
- Off/dismiss/session replacement/tree navigation cancel queued and in-flight
  work; generation checks discard late results. Shutdown clears the UI/timers.
  If a provider ignores cancellation, the detached waiter still times out, but
  further calls remain blocked until that abandoned request settles. This avoids
  overlapping billable requests even across off/on and session changes.
  Provider errors and malformed/unquoted verdicts visibly mark a scan failed,
  without automatic retries or exposing provider error text in the terminal.
- Inert in delegated workers, standalone RPC, print and JSON modes. RPC scanning
  requires a successful `hive-remote` conversation attachment with both prose
  sharing (`streamDeltas`) and status reporting (`reportStatus`) enabled. Losing
  that attachment cancels queued/in-flight RPC scanning, not the saved setting.

## Hive web workspace

The session pane shows a compact **You should know** strip above the composer,
including the latest note. Expand it for all retained notes, assistant quotes,
reported usage, failure/budget information and dismiss. Notes remain explicitly
historical model interpretations; they do not become a verified blocker ledger.

`hive-remote` forwards a bounded snapshot on the authenticated conversation's
status route, **only under transcript-sharing consent**, never through counters
telemetry. Quotes follow the conversation's existing sharing/access and secret
redaction policy. Turning off retains existing notes, just like terminal `show`.

The owner can turn scanning on/off or dismiss via a dedicated command — not a
slash-command prompt sent to the main agent. Controls additionally require
`hive-remote`'s `allowSetMode` spending-control consent and a positively reported
scanner capability. The browser says queued until an agent-reported matching
command ID confirms application. Unsupported clients report no scanner state;
quiet clients retain historical evidence but do not offer live controls. Reload,
branch restore, worker exclusions, quota limits and canceled-transport ownership
remain the same as in the terminal. Requires the companion Hive server/web
scanner-state contract; older servers do not gain web controls from this package
alone.

## Recording and advisory classification

Highlights and recording are independent. Stable SHA-256 finding IDs derive from
session/source/quote, never from model output. Findings persist as non-context
custom session entries separate from the ten dismissible highlights, with a
200-record local cap. Dismissal retains the ledger and receipts. Restore reads
only the active branch; a fork or different server session cannot transplant
recording captures.

An existing authenticated Hive attachment with both `streamDeltas` and
`reportStatus` consent discovers the versioned findings endpoint before uploading.
Recording initially follows the server's policy (default on); standalone findings
remain local, with no destination-delivery claim. A source keeps the recording
flag, server session and revision from capture, checked again at scan start and
completion. Off/re-enable cannot backfill old sources. Local recording controls
use retry-safe, stable-ID compare-and-set PUTs; remote controls apply the revision
allocated by Hive without another PUT. Failed local stop requests stay locally
paused until resolved or superseded by a newer explicit server command.

The server, not either model, establishes owner/tenant/project permissions and
routes eligible friction to papercuts, shared incidents to the project board,
and actionable Hive-product defects/improvements to the configured Hive Linear
report team. Other repositories' automatic Linear routing is blocked. Stable
batches contain at most 20 findings and stay below the server's byte limit.
Responses alone supply receipts: queued is not delivered. Retries are bounded to
five per capture/control/reconnect, and POST drives dispatch; this is not an
autonomous server outbox. Retry exhaustion or client exit can leave an unissued
queue waiting for another capture/reconnect. Ambiguous Linear creates remain
uncertain for operator reconciliation, never blindly retried.

If the existing TypeSafe/Jev config explicitly enables it and provides usable
credentials, a long-lived client performs **shadow-only** attention and category
choices after low-tier extraction. Fixed named choices include `none`; either
choice below 0.85 confidence or `none` abstains. Configuration/key absence,
malformed answers, timeouts and cancellation are explicit outcomes. Redacted,
bounded candidates are data, never question definitions or instructions. Jev
cannot grade severity, suppress a grounded highlight, authorize a destination or
alter routing. Its non-context shadow entries retain baseline/verdict pairs for
future evaluation; this change does not promote it based on unmeasured relevance.

## Opt-in pre-extraction experiment

`PI_YOU_SHOULD_KNOW_JEV_PREFILTER=shadow` additionally opts into a bounded,
redacted **shadow-only** pre-extraction classifier when the existing TypeSafe
config explicitly enables JEV and a key is available. Absent/unknown values
(including `active`) make no new calls. This does not enable JEV globally.
Fixed choices are `scan`, `skip`, `abstain`; confidence below 0.95 abstains.
Important cues, failed tools and incomplete/oversized evidence always retain
extraction. Missing consent/key, timeout/error, malformed answers, cancellation
and a previous pending JEV transport cannot prevent extraction.

The detached observational call starts before and concurrently with extraction;
it never delays or suppresses the low-tier call, changes the 20-attempt cap,
authorizes recording, grades severity or routes findings. Non-context local
`you-should-know.prefilter` entries pair the verdict with pre-dedup baseline
note counts and completed usage, **not evidence text**. Failed extraction is an
unknown baseline, never a safe skip. `/you-should-know status` reports the latest
shadow result/latency/usage independently of extraction cost. Shadow avoids zero
actual calls and adds JEV calls. Ignored-abort transport ownership is preserved
across branch changes without blocking the extractor.

See [the evaluation and remaining review gate](prefilter-evaluation.md): 24
synthetic labels, 2 would-skips, 0/16 IMPORTANT false negatives, but all live
low-model baselines failed under a confirmed endpoint policy refusal. Potential
token savings are **unknown**. No actual filtering was implemented or promoted;
a new authorized paired replay, stronger recall evidence and explicit review
are required before considering it.

## Verification

`test/you-should-know.test.ts` tests quote grounding/control-character validation,
startup defaults/env opt-out, saved settings, headless/worker exclusion,
nonblocking completion, coalescing, deadlines,
budget/cadence, branch restore, deduplication, late-result cancellation and the
real provider-call shape. `test/you-should-know-remote.test.ts` loads the real
scanner/remote extensions together and exercises RPC consent, reported state,
control acknowledgment, off/dismiss/restore, absent extensions and detach
cancellation without main-agent injection. Native `Text` rendering is checked at narrow/wide
widths. `node test/you-should-know-smoke.mjs` drives the real pi terminal through
default-on → synthetic assistant output → note/quote → dismiss → off/on/off,
using a local
fixture provider and temporary agent directory (requires Python 3 + a POSIX PTY).
For an opt-in **live-provider** relevance sanity check using four synthetic
examples (routine chatter, a buried caveat, a resolved caveat and a quoted
example):

```sh
PI_YOU_SHOULD_KNOW_EVAL=1 node --experimental-transform-types test/you-should-know-eval.mjs
```

This consumes your configured provider's quota. It reads the selected model from
`$PI_CODING_AGENT_DIR/settings.json` (defaults to `~/.pi/agent`); use
`YSK_EVAL_PROVIDER` and `YSK_EVAL_MODEL` to override. It is not run by CI.
The independent `test/you-should-know-prefilter.test.ts` suite protects consent,
fixed/redacted choices, floor bounds, malformed/uncertain decisions, cancellation
races and busy transport, concurrent baseline extraction, branch/fork/detach,
recording separation, and unchanged attempted-scan budgets. The synthetic paired
prefilter evaluator is separately opt-in; its quota and results are in the linked
report above. It is not run by CI.

Model relevance is heuristic: neither scripted tests nor four live samples claim
that every model will classify every caveat correctly.
