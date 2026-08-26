/**
 * claude-oauth — use a Claude Pro/Max subscription from Pi (HIV-2211).
 *
 * Pi owns the OAuth login/refresh store and the complete Anthropic provider.
 * This extension replaces that provider with a wrapper which changes only
 * subscription-token requests into the currently validated Claude Code wire
 * shape. Anthropic API-key traffic passes through by object identity.
 */

import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

import { isSupportedPiVersion, supportedPiVersions } from "./compatibility.ts";
import { wrapAnthropicProvider } from "./provider.ts";
import { discoverClaudeCodeIdentity } from "./protocol.ts";

export default function claudeOAuth(pi: ExtensionAPI): void {
	// An unvalidated pi disables THIS EXTENSION, and nothing else.
	//
	// This used to throw. A throw at extension load does not decline the
	// wrapper — it refuses to start pi at all, taking every other extension with
	// it, including hive-remote and hive-telemetry. That is how a PATCH bump
	// became a fleet outage on 2026-08-26: a workstation resolved pi from mise
	// `latest` (0.84.3) while this contract admitted 0.84.2, pi would not
	// launch, and 18 of 33 agent launches that day started, failed to attach a
	// session, and died — each after provisioning a full worktree first.
	//
	// Declining is a real degradation and is logged as one: subscription traffic
	// falls back to pi's own Anthropic provider, which does not emit the
	// validated Claude Code wire shape. That is worth saying loudly. It is not
	// worth taking the harness down for.
	if (!isSupportedPiVersion(VERSION)) {
		const admitted = supportedPiVersions();
		console.warn(
			`claude-oauth: DISABLED — this build is validated against Pi ${
				admitted.length ? admitted.join(", ") : "(no pin resolvable)"
			}, and Pi ${VERSION} is running. Claude Pro/Max subscription requests will use Pi's ` +
				`built-in Anthropic provider instead of the validated Claude Code wire shape. ` +
				`Every other extension is unaffected. Fix by running the pinned Pi, or by ` +
				`revalidating ${VERSION} and adding it to EXTRA_VALIDATED_PI_VERSIONS.`,
		);
		return;
	}
	let registered = false;
	pi.on("session_start", async (_event, ctx) => {
		if (registered) return;
		const anthropic = ctx.modelRegistry.getProvider("anthropic");
		if (!anthropic) {
			throw new Error("claude-oauth could not load Pi's built-in Anthropic provider");
		}
		// Read the provider from the public runtime registry rather than a private
		// package subpath. This also wraps the provider Pi actually composed for
		// this process, including any earlier supported override.
		pi.registerProvider(wrapAnthropicProvider(anthropic, discoverClaudeCodeIdentity()));
		registered = true;
	});
}
