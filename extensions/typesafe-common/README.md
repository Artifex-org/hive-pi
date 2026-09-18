# typesafe-common

The typed client for the TypeSafe ("Jev") System One API, and the two-stage tool
router built on it. **Phase 0: nothing here is wired to a consumer.**

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
| `key.ts` | `readApiKey()` — `$TYPESAFE_API_KEY`, else pi's auth store, vetted |
| `config.ts` | `configFrom`/`loadConfig`, with `enabled: raw.enabled === true` |
| `client.ts` | questions, answers, the outcome union, the round trip |
| `liveness.ts` | the outcome tally that tells "agreed" apart from "never called" |
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

Stage 2's option set is ALWAYS the chosen category's members UNION
`rankByAnyToken`'s top 8 over the whole corpus. That union is why this design is
allowed to exist: it makes the router structurally incapable of scoring below
the lexical shortlist it replaces. In a measured pilot the plain hierarchy
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
