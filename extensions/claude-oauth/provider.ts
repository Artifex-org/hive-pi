import type {
	Api,
	ApiStreamOptions,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
	type ClaudeCodeIdentity,
	discoverClaudeCodeIdentity,
	isAnthropicOAuthToken,
	mergeClaudeCodeOptions,
} from "./protocol.ts";

/**
 * Wrap Pi's own Anthropic provider rather than reimplementing it. Pi remains
 * responsible for models, tools, retries, streaming, usage and OAuth refresh;
 * this layer changes only the request shape subscription tokens require.
 */
export function wrapAnthropicProvider(
	provider: Provider,
	identity:
		| ClaudeCodeIdentity
		| undefined
		| Promise<ClaudeCodeIdentity | undefined> = discoverClaudeCodeIdentity(),
): Provider {
	if (provider.id !== "anthropic") {
		throw new Error(`claude-oauth cannot wrap provider "${provider.id}"`);
	}

	return {
		...provider,
		stream<T extends Api>(
			model: Model<T>,
			context: Context,
			options?: ApiStreamOptions<T>,
		) {
			if (!options || !isAnthropicOAuthToken(options.apiKey)) {
				return provider.stream(model, context, options);
			}
			return provider.stream(model, context, mergeClaudeCodeOptions(options, context, identity));
		},
		streamSimple(
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) {
			if (!options || !isAnthropicOAuthToken(options.apiKey)) {
				return provider.streamSimple(model, context, options);
			}
			return provider.streamSimple(
				model,
				context,
				mergeClaudeCodeOptions(options, context, identity),
			);
		},
	};
}

