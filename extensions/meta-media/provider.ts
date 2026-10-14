/**
 * pi 1.0 owns Meta's catalog, transport, API-key/OAuth auth and image limits.
 * Hive retains only the directly verified strict JSON-schema tool capability.
 * Meta rejects tool_search; no tool-search/grammar capabilities are added.
 */
// Pi 1.0.2's extension loader aliases providers/all explicitly, but rewrites
// other pi-ai subpaths under compat.js. Use the public built-in registry so
// native worker startup loads the SAME Meta provider without a loader shim.
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const native = builtinProviders().find(provider => provider.id === "meta");
if (!native) throw new Error("Pi's built-in provider registry is missing Meta.");
export const META_BASE_URL = native.baseUrl;
export const metaModels = native.getModels().map(model => ({
	...model,
	compat: { ...model.compat, supportsStrictMode: true },
}));

/** Both the main session and --no-extensions workers register this provider. */
export const hiveMetaProvider = {
	...native,
	getModels: () => metaModels,
	getAllModels: () => (native.getAllModels?.() ?? native.getModels()).map(model => {
		if (model.type === "image" || model.type === "classifier") return model;
		return { ...model, compat: { ...model.compat, supportsStrictMode: true } };
	}),
};
