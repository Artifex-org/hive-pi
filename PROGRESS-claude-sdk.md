# Claude SDK compatibility checkpoint

Branch: `feat/claude-sdk-offline-prototype`.
Scope: the approved plan's first, non-serving offline slice only.

- Research and a bounded three-item read-only audit wave plus final reconciliation completed.
- Exact SDK 0.3.289 and MCP 1.32.0 development dependencies installed; both lockfiles synchronized.
- Typed isolated options/access-only shape and an in-memory parked MCP-call prototype added outside extension discovery.
- Initial typecheck found the new SDK permission callback's required requestId and nullable return; tests now use the actual public contract.
- Baseline check reported 5,623 passed / 20 skipped; dependency installation overlapped the end of that run, so final serialized verification is still required.
- Focused prototype tests: 32 passed, including transport disconnection.
- Final full gate: 5,655 passed / 20 existing skips; typecheck passed. Clean npm install and frozen pnpm lockfile validation passed.
- Code review found request-specific MCP cancellation leakage; fixed with cancellation/timeout regressions. Follow-up review reported no findings.
- Generic quality_gate could not discover this public repository's gate; ran its actual .github/workflows/check.yml npm gate directly.
- Delivery is intentionally draft-only; serving implementation and rollout remain blocked at the feasibility gate.
- No real credential reads, SDK queries, live inference, production admission, provider registration or rollout.

Blocked next gate: separately authorized named-account scope/live-turn budget,
unchanged Hive/Pi prompt/tool-shape subscription billing with Extra Usage disabled,
and eligibility for the intended assignment scope. See
[the compatibility record](docs/claude-sdk-compatibility.md).
