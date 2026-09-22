/**
 * The `meta` provider declaration alone — no tools, no hooks — so a delegated
 * worker can load it.
 *
 * `meta` exists ONLY through `pi.registerProvider` (it left models.json on
 * 2026-09-15, see provider.ts). A subagent worker spawns with
 * `--no-extensions`, so without this module it has no `meta` provider, and pi
 * resolves `--model meta/muse-spark-1.3-contributor` by bare id instead: the
 * OpenRouter catalogue carries that exact id, so the worker ran on OpenRouter
 * and died on `404 … Paid model training violation` — 22 papercuts in three
 * days, every one after the fleet's `low` mode (the PI_SUBAGENT_MODEL a Hive
 * launch stamps) became a meta rung. The session itself was fine: it loads
 * meta-media/index.ts, which is why readiness reported the lane ready.
 *
 * index.ts calls this too, so the session and the worker cannot declare two
 * different providers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { META_BASE_URL, metaModels } from "./provider.ts";

export default function registerMetaProvider(pi: ExtensionAPI) {
	// Models only: Muse Spark speaks OpenAI Responses, so pi's built-in
	// transport serves it and no /compat transport wrap is needed.
	pi.registerProvider("meta", {
		name: "Meta (Muse Spark)",
		baseUrl: META_BASE_URL,
		apiKey: "$META_API_KEY",
		api: "openai-responses",
		models: metaModels as never,
	});
}
