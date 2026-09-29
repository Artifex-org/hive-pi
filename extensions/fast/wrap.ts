/**
 * The provider wrapping shared by the session extension (index.ts) and the
 * worker module (worker.ts). No hooks here: the caller decides when to wrap,
 * which has to be at a session_start, the first point a ctx — and so the model
 * registry — is reachable.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FastConfig, type PayloadHook, fastApplies, isCacheWarm, withPriorityTier } from "./policy.ts";

/** The providers whose API accepts a service tier, with the api each streams. */
const FAST_PROVIDERS = [
	["openai-codex", "openai-codex-responses"],
	["openai", "openai-responses"],
] as const;

/**
 * Returns a function that, on its first call, re-registers the OpenAI
 * providers with a stream that delegates to pi's own and adds the priority
 * tier when `config()` says fast mode applies to the request's model.
 *
 * Once per process: a later session_start would find THIS override in the
 * registry, and wrapping it would call itself.
 */
export function providerWrapper(pi: ExtensionAPI, config: () => FastConfig): (ctx: ExtensionContext) => void {
	const decorate =
		(base: Provider): NonNullable<Provider["streamSimple"]> =>
		(model, context, options) => {
			if (isCacheWarm(options) || !fastApplies(model, config())) return base.streamSimple(model, context, options);
			return base.streamSimple(model, context, {
				...options,
				onPayload: withPriorityTier(options?.onPayload as PayloadHook | undefined),
			});
		};
	let wrapped = false;
	return (ctx) => {
		if (wrapped) return;
		wrapped = true;
		for (const [id, api] of FAST_PROVIDERS) {
			let base: Provider | undefined;
			try {
				base = ctx.modelRegistry?.getProvider?.(id);
			} catch {
				base = undefined;
			}
			// No provider to wrap (a build without it, or a registry this version
			// cannot read): leave pi's stream alone rather than guess one.
			if (!base) continue;
			pi.registerProvider(id, { api, streamSimple: decorate(base) });
		}
	};
}
