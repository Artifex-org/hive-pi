/**
 * The Meta Muse Code provider, declared in the hive-pi BASE so it ships
 * everywhere pi runs — workstation launches AND the Code Factory image —
 * rather than only where the artifex-pi workstation overlay is linked
 * (HIV-3563). It used to live in that overlay's models.json, which is why a
 * factory run that demoted onto a meta rung died with `Model "meta/…" not
 * found`: the factory image carries the base, not the overlay.
 *
 * Models only — no `streamSimple`. Muse Spark speaks the OpenAI Responses API,
 * so pi's built-in transport serves it; wrapping the transport would need the
 * banned `@earendil-works/pi-ai/compat` import, and nothing here needs to. The
 * key is $META_API_KEY, injected by Hive's credential lease.
 *
 * These entries are the overlay's, verbatim minus the `provider` field the
 * models.json schema carried. Keep them in sync with hive's
 * internal/modelcatalog (the tenant launch catalogue + modality table).
 */
export const META_BASE_URL = "https://api.meta.ai/v1";

/**
 * `compat.supportsStrictMode` turns on strict JSON-schema constrained tool
 * inputs — the "structured output" capability Meta advertises for Muse. It is
 * scoped and safe: the transport applies it only to tools that opt in with a
 * `json_schema` constrainedSampling config, and a schema that cannot be made
 * strict falls back PER-TOOL to non-strict (resolveJsonSchemaStrictSampling)
 * rather than failing the request — the same reason openai-codex carries it on
 * every model with no ill effect.
 *
 * Verified against api.meta.ai directly (2026-09-16): a `/v1/responses` call
 * with a `strict:true` function tool returned HTTP 200 and a correct
 * schema-shaped call. The two OTHER Muse-lacking flags are deliberately NOT set:
 * `supportsToolSearch` makes api.meta.ai return HTTP 500 on the `tool_search`
 * wire item, and `supportsOpenAIGrammarTools` is inert here (no hive tool ships
 * an `openai_lark` grammar variant).
 */
export const metaModels = [
		{ id: "muse-spark-1.3", name: "Muse Spark 1.3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null}, compat: { supportsStrictMode: true } },
		{ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 0.1, "output": 0.2, "cacheRead": 0.002, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null}, compat: { supportsStrictMode: true } },
		{ id: "muse-spark-1.2", name: "Muse Spark 1.2", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null}, compat: { supportsStrictMode: true } },
		{ id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 0.1, "output": 0.2, "cacheRead": 0.002, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null}, compat: { supportsStrictMode: true } },
		{ id: "muse-spark-1.1", name: "Muse Spark 1.1", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null}, compat: { supportsStrictMode: true } },
];
