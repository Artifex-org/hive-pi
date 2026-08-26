# compaction

Codex-style **server-side compaction** for OpenAI models. Reimplemented from
[`algal/pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction),
which pins pi `>=0.80.9 <0.81.0` and cannot be installed on 0.84.1.

## 🔴 Off by default, and it should stay off unless you mean it

This is the only extension in this package whose default is a **privacy
posture** rather than a preference.

Enabling it sends conversation context to OpenAI with **`store: true`**, which
means **OpenAI retains that data server-side**. The artifacts that come back are
provider-native opaque blobs stored in your session JSONL — not human-readable,
not auditable by us.

Nothing here runs until you enable it: the factory returns before registering a
single handler, so with the flag off there is no network code reachable and the
API key is never read.

```
/toggles                      # the row, with its warning
/toggles compaction on        # deliberate act
/compaction                    # what it is actually doing
```

## What it does

At a compaction boundary, send the conversation plus a trailing
`compaction_trigger` through `POST /v1/responses` and keep the opaque
`compaction` item the endpoint returns — **alongside pi's own portable text
summary**.

Two artifacts, not one. The blob is higher-fidelity for a compatible next turn;
the text summary is what keeps forks, exports, tree navigation and non-OpenAI
models working. Dropping either is the mistake, and this extension only ever
*adds*: it runs after pi has already produced its summary, and every failure
path below leaves that summary as the sole artifact, unchanged.

## ⚠️ It is not a same-budget win

The headline number invites the wrong conclusion. From the upstream author's own
held-out benchmark on real product defaults:

| | server-side | pi default | full context |
|---|---|---|---|
| exact recall | 78.0% | 48.0% | 100% |

…achieved while emitting **4.58× the compaction output tokens** and leaving a
**29% larger billed downstream context**. The author states plainly that this is
*not* evidence of being better at the same token budget, and that results were
highly variable — every large artifact scored perfectly while three small ones
performed about as poorly as pi's default.

Read it as *"sometimes allocates far more context, usefully"*. That is a
cost/quality trade, not an upgrade.

## Support matrix — read this before wondering why nothing happened

| Provider | Status |
|---|---|
| `openai/*` | **Supported.** Direct `/v1/responses` call with an API key |
| `openai-codex/*` | **Not supported.** See below |
| `azure*` | Opt-in via `includeAzure`, untested |
| everything else | Not applicable; pi's own summary is used |

**This workstation's default model is `openai-codex`, so "enabled and nothing
happens" is the expected first experience.** `openai-codex` uses subscription
OAuth and pi's built-in transport; the upstream extension does not make its own
call there either — it injects reconstructed history through provider-request
hooks, which this package bans (`test/no-forbidden-events.test.ts` forbids
`before_provider_request`). Rather than silently doing nothing, `/compaction`
reports the reason.

An API key is read from `OPENAI_API_KEY`, then `~/.pi/agent/auth.json`. Without
one the extension reports itself inert.

## Safety model

Copied wholesale from upstream, because it is the most valuable part of it. Any
live-continuation state is dropped on **session start, shutdown, fork, switch,
tree navigation, model selection, and every compaction boundary** — each one a
point where the conversation the server believes it holds stops matching the one
we hold.

Stored artifacts are additionally gated on an exact **provider *and* model id**
match before they could ever be replayed. `openai/gpt-x` and
`openai-codex/gpt-x` are the same weights behind different transports and still
must not share an artifact. Cross-model replay is reachable by ordinary use —
resume a session, switch model, keep going — and its damage is very hard to see
after the fact.

## What is verified, and what is not

Everything except the HTTP round trip is unit tested: model eligibility, request
construction, response parsing against six malformed shapes, the replay guard,
and the clear-on-event list.

**The round trip is not tested, and cannot be here** — exercising it means
sending real conversation data to OpenAI, which is the exact act this extension
exists to gate. The first genuine enable is therefore the first live test. That
is why every failure path degrades to "pi's own summary, unchanged" and records
a reason visible in `/compaction`, rather than throwing inside the compaction
path.

## Config

`~/.pi/agent/hive-telemetry/compaction.config.json`

```json
{
  "enabled": false,
  "includeAzure": false,
  "timeoutMs": 30000,
  "keepRecent": 4
}
```

`enabled` is read as `=== true` — the opt-in shape shared with `hive-telemetry`
and `hive-remote`, the other two extensions that send data off this machine. A
typo can never read as ON.
