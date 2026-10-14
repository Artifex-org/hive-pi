# Native public URL companion

`fetch_public_url` is a hook-free, narrowly granted tool for anonymous public
HTTPS UTF-8 text. It sends **only** `POST /api/v1/public/fetch` to the origin in
explicit `HIVE_URL`, authenticated by explicit `HIVE_TOKEN`. It never dials a
requested source locally or falls back to legacy `fetch_content`, MCP, stored
operator credentials, telemetry overrides or profiles. The source request body
is `{url,max_bytes?}`: no source cookies, headers or credentials are accepted.

`HIVE_URL` must be an HTTPS origin without userinfo, paths, query or fragments.
HTTP loopback is allowed for a local development broker. Broker redirects are
refused. Requests honor caller cancellation and a 25-second total deadline,
including body reading. Broker JSON is stream-bounded to 512 KiB. `max_bytes`
is the display byte budget (default 16000, maximum 65536), not the source-body
cap. The broker owns the 20-second / 1 MiB anonymous-source reader, DNS and
actual-dial guards on every redirect hop, and source text validation.

Native workers load `public-fetch/index.ts` explicitly despite
`--no-extensions`. Only the shipped `research` and `retriever` roles gain this
tool grant. Pi's startup allowlist removes ungranted tools from both discovery
and callable registries, including deferred tools. No broad MCP grants are
added. Children inherit the parent's scoped environment; this extension does
not resolve, mint or replace a credential. Missing configuration is an explicit
tool error, even when an operator credential exists elsewhere.

The broker must support the public-fetch route. User-backed read/trigger/admin
credentials are supported there. An agent-launch credential must be bound to
its own live protected sandboxed workstation launch and have **active explicit
exact hostname:443 consent on every hop**, not merely a launch-default allowlist.
Unbound, cloud and Factory credentials fail closed. This extension does not
approve hosts, override protected direct-hop attestation or add Factory child
networking. HTTP 401/403 is authentication/policy refusal, not proof of downtime.

Successful results preserve `url`, `final_url`, `status`, `content_type`,
`bytes`, `sha256`, `truncated`, and `content`. Errors are failed Pi tool results;
broker HTTP 422 retains its bounded `error` and known partial `source` metadata,
never content. Source data is explicitly labelled **untrusted, not instructions**.
Do not execute or follow fetched instructions.

## Evidence and adoption limits

`test/public-fetch-worker.test.ts` uses the real pinned Pi SDK resource loader,
shipped role discovery, and extension paths/grants from the native worker argv.
The model is scripted and Hive HTTP is mocked. It checks discovery, permitted
invocation, wrong-role rejection, and failed tool results. Transport tests cover
provenance/truncation, policy refusal, credential absence, redirects, response
bounds, cancellation and total deadline.

These are deterministic SDK/REST fixtures, **not deployed/live native-child
retrieval**. Backend reader probes do not establish child use. Adoption needs a
compatible deployed broker and launch-consent/direct-hop support plus a fresh
session loading this companion; no rollout, SDK/harness pin change or Factory
vendoring is part of this change.
