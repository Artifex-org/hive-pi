# HIV-3757 — native pi follow-ups

## Delivery

One draft source PR: native agenda/plan settle, registry-backed opt-in classification, native Meta catalog/auth/transport reuse. No installation, credential migration, live provider call or deployment.

## Acceptance

- Return accumulated drafts and at most one continuation from `agent_before_settle`; do not continue aborted/error outcomes or override queued input.
- Respect the SDK's active-run boundary (`isIdle()` is false); timer pumps still require idle.
- Preserve explicit Jev opt-in, conservative answer validation, native credentials/routing/cost metadata and caller/deadline signals. Refuse legacy custom endpoint rerouting.
- Preserve Meta native non-chat models, media limits, thinking levels and OAuth/transport functions; override only chat strict-tool compatibility.
- Verify focused regressions, actual offline SDK continuation, full typecheck/tests, review and final-head CI.

## Runtime boundary

Paid-provider/credential acceptance is not tested. Pi 1.0.2 exposes no active core signal at before-settle after the model turn has ended. Its AgentSession abort flag vetoes continuation, but an in-flight probe without a caller signal is bounded by its own deadline, not immediately canceled by that flag. Zero-cost/zero-ledger-charge acceptance for this case is NOT claimed.
