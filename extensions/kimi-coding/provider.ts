/**
 * Kimi Code (subscription) models pi does not ship yet.
 *
 * Kimi K3.1 Pro (`k3.1-pro`, `k3.1-pro-highspeed`) was released 2026-10-23;
 * pi-ai 1.3.0 and 1.4.0 list only k3, k3-256k, kimi-for-coding and
 * kimi-for-coding-highspeed. An undeclared id still runs — pi builds a
 * "custom model id" from the provider default, kimi-for-coding — but inherits
 * its 32768 maxTokens, so long answers are cut short without an error.
 *
 * The declared ids live in models.json so Hive's catalog drift test can read
 * the same list this module registers. Each one is pi's own k3 entry (same
 * endpoint, compat and thinking map) with the fields models.json sets. k3's
 * map has `off: null`, so a requested `off` is clamped up to `low` before the
 * request leaves — K3.1 Pro rejects thinking-disabled requests with HTTP 400.
 *
 * The native provider is wrapped, not redeclared: pi's OAuth login and refresh
 * and its transport stay pi's. A shipped entry always wins over a declared
 * one with the same id, so a pi release that adds K3.1 makes this inert.
 */
import { readFileSync } from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

interface DeclaredModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface Declarations {
	provider: string;
	template: string;
	models: DeclaredModel[];
}

export const KIMI_PROVIDER = "kimi-coding";

export const declarations: Declarations = JSON.parse(
	readFileSync(new URL("./models.json", import.meta.url), "utf8"),
);
if (declarations.provider !== KIMI_PROVIDER) {
	throw new Error(`kimi-coding/models.json declares provider "${declarations.provider}"`);
}

const native = builtinProviders().find(provider => provider.id === KIMI_PROVIDER);
if (!native) throw new Error("Pi's built-in provider registry is missing kimi-coding.");

const shipped = native.getModels();
const template = shipped.find(model => model.id === declarations.template);
if (!template) throw new Error(`Pi's kimi-coding provider no longer ships template model "${declarations.template}".`);

const added = declarations.models
	.filter(declared => !shipped.some(model => model.id === declared.id))
	.map(declared => ({ ...template, ...declared }));

export const kimiModels = [...shipped, ...added];

/** Both the main session and --no-extensions workers register this provider. */
export const hiveKimiProvider = {
	...native,
	getModels: () => kimiModels,
	getAllModels: () => [...(native.getAllModels?.() ?? shipped), ...added],
};
