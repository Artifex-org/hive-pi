# typesafe-common

The typed client for the TypeSafe ("Jev") System One API, and the two-stage tool
router built on it.

**Consumers:** `agenda/drift.ts` asks Jev first for the drift probe and falls
back to its `pi -p` probe when Jev does not answer; `agenda/ask.ts` asks it when
the phrase list is silent. The router is still unwired. A consumer builds its
client once, at construction, and is only live with `enabled: true` in
`~/.pi/agent/hive-telemetry/typesafe.config.json` plus a key for at least one
route (below).

## Routes: typesafe.ai primary, OpenRouter fallback

Jev is served in two places with the same System One API (`{model, state,
questions}` in, `{model, answers, usage}` out): directly by TypeSafe, and by
OpenRouter. The client tries them in order and fails over on its own, so the
TypeSafe credit running out needs no deploy.

| Route | Endpoint (config key) | Key |
| --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` (`endpoint`) | `$TYPESAFE_API_KEY`, else auth.json `typesafe` |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` (`openrouterEndpoint`) | `$TYPESAFE_OPENROUTER_API_KEY`, else auth.json `typesafe-openrouter` |

- **Order** is `routes` in the config (list or comma string), overridden by
  `$JEV_ROUTES`; default `typesafe,openrouter`. A route with no key is skipped.
  An unknown, duplicated or empty list is `disabled: bad_routes` — fail closed.
  The final cutover is `JEV_ROUTES=openrouter`, then removing the TypeSafe key.
- **The fallback key is NEVER the plain `openrouter` auth.json entry.** That
  entry is a pi provider credential: it makes `openrouter/*` chat models
  routable, which is how chat turns silently spent on OpenRouter (HIV-3617).
  The Hive registry leases the Jev key as `typesafe-openrouter`, which is not a
  pi provider name. `test/typesafe-client.test.ts` pins that `openrouter` is
  never even read.
- **Failover by class, not status.** 401/403 (`auth_failed`), 402
  (`payment_required`), 429, 5xx/529, timeout, transport and 404/405 try the
  next route. 400/422, client-side refusals and `malformed` do not: they are
  request faults and would fail the same way there.
- **Breaker, process-local, per route.** An account-class failure (401/402/403)
  skips the route for 1 h; a transient one for 5 min. After the window the next
  call probes it again. If every route is open they are all tried in order
  anyway. The first account-class trip logs ONE warning per process:
  `jev: route typesafe tripped (payment_required); using openrouter`.
- **One deadline per call.** `timeoutMs` bounds the whole call, not each
  route. A primary that times out has spent it, so that one answer is lost;
  the breaker sends the next call straight to the fallback.
- **The route is a liveness dimension.** Every outcome carries `route` and
  `failover`; the tally splits counts by route (`via typesafe 40 / openrouter
  2`) and sums OpenRouter's `usage.cost`. `drift-jev` and `ask-jev` stay the
  aggregate metrics, with `drift-jev.<route>` / `ask-jev.<route>` beside them
  (a Jev miss is a `skip` on its route).
- OpenRouter answers with a different `model` spelling
  (`typesafe/jev-1.13-20260917`) and extra fields (`id`, `provider`); the
  decoder stores the model and ignores the rest, never compares either.

## This directory is NOT an extension

It deliberately has **no `index.ts`**, the same rule `hive-common/` and
`mcp-common/` follow. pi loads a top-level `extensions/*.ts` file, or a
directory's `index.ts`, as an extension — adding one here would silently turn a
library into loaded code, and this library holds a network client and a
credential reader.

Nothing here registers a pi event handler, and `test/typesafe-client.test.ts`
asserts both facts so the next person cannot undo them by accident.

## What Phase 0 ships

| File | Contents |
| --- | --- |
| `key.ts` | `readApiKey()` / `readOpenrouterApiKey()` — env, else pi's auth store, vetted |
| `config.ts` | `configFrom`/`loadConfig`, with `enabled: raw.enabled === true`, and the route list |
| `client.ts` | questions, answers, the outcome union, the route loop and its breaker |
| `liveness.ts` | the outcome tally that tells "agreed" apart from "never called", per route |
| `router.ts` | `<server>/<group>` categories and the structural floor |
| `replay.ts` | the foldable half of `scripts/typesafe-route-replay.ts` |

## The three things to get right

**1. A noul answer has no confidence.** Measured against jev-1.13.0: a `noul`
answer carries exactly `{"type","noul"}`. A decoder that reads `.confidence` off
one gets `undefined`, every threshold reads "uncertain", and the deterministic
fallback fires on 100% of calls while looking exactly like a classifier that
works. `NoulAnswer.confidence` is typed `never` so the mistake is a compile
error; `certaintyOf()` is the only sanctioned accessor and returns
`|noul - 0.5| * 2`.

**2. `malformed` is an error, not an answer.** An HTTP 200 with no `answers`
map, a missing question key, an answer of the wrong type, or a choice outside
the criteria we supplied is `malformed` — counted apart from timeout,
rate_limited, rejected and disabled. This house has been bitten three times by
success-shaped nothing.

**3. Liveness is a surface.** `liveness.ts` tallies outcome kinds and separates
the two `ok` cases — agreed with the deterministic tier, or differed from it.
`ok 0 / disabled 40` and `ok 40 / agreed 40` produce the heuristic's answer
either way; only the tally tells them apart. HIV-712 is the recorded case where
48 fallback log lines were all present and nobody read them.

## Second tier, advisory, never a gate

Jev sits beside the deterministic ranker, never in front of it. It reorders,
promotes and enriches; it never suppresses, gates, closes, merges, deletes or
kills. It is never handed arithmetic, counting, dates or text generation — it
cannot do them — and it is prompt-injectable, so a tool description is data.

## The structural floor

Stage 2's option set is the chosen category's members UNION `rankByAnyToken`'s
top 8 over the whole corpus. That union is why this design is allowed to exist:
it makes the router structurally incapable of scoring below the lexical
shortlist it replaces. The floor half is non-evictable and the category half is
not, so under the option cap or the token budget the set degrades toward the
lexical shortlist and never below it. `truncated` says when that happened. In a measured pilot the plain hierarchy
missed BOTH benchmark queries `test/mcp-search-fallback.test.ts:89-90` pins. See
`router.ts` for the two failure modes and `test/typesafe-router.test.ts` for the
guard that dies if the union is removed.

## Measuring it

```
node scripts/typesafe-route-replay.ts          # offline, no key needed
node scripts/typesafe-route-replay.ts --live   # + TYPESAFE_API_KEY
```

`--live` is the consent; the key is only the source (`identity.ts:100-103`).
Without both, the live half prints `skipped` and never `0/4`.

## Subagents do not get this

Workers spawn with `--no-extensions`, so anything built on this package serves
the MAIN session only.
