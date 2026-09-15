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

export const metaModels = [
		{ id: "muse-spark-1.3", name: "Muse Spark 1.3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null} },
		{ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 0.1, "output": 0.2, "cacheRead": 0.002, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null} },
		{ id: "muse-spark-1.2", name: "Muse Spark 1.2", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null} },
		{ id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 0.1, "output": 0.2, "cacheRead": 0.002, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null} },
		{ id: "muse-spark-1.1", name: "Muse Spark 1.1", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, cost: {"input": 1.25, "output": 4.25, "cacheRead": 0.15, "cacheWrite": 0}, thinkingLevelMap: {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": null} },
];
