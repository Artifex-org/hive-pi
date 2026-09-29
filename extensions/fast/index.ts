/**
 * fast — OpenAI Fast mode (the priority service tier) for pi.
 *
 *   /fast               toggle
 *   /fast on|off        set, and remember it
 *   /fast status        what the current model would get
 *   pi --fast           on for this process
 *   HIVE_PI_FAST=1      on for this process (how a Hive launch asks for it)
 *
 * Off by default: priority costs 2–2.5× the credits or dollars. Applies only to
 * the allowlisted models in policy.ts, extendable with `models` in
 * ~/.pi/agent/hive-telemetry/fast.config.json.
 *
 * HOW. pi composes a provider's stream per provider id, and an extension that
 * registers `streamSimple` for a built-in provider id replaces the stream for
 * that provider's models on that api, keeping its models and login
 * (provider-composer.js). So this registers `openai-codex` and `openai` with a
 * stream that delegates to pi's own implementation, and only adds the tier
 * when fast mode applies. Off, the request is exactly what pi would send.
 */

// `/compat`, not the package root: pi aliases both to ITS OWN pi-ai for
// extensions (core/extensions/loader.js), but only the compat entry exports the
// per-api stream factories. A different copy would mean a second OpenAI client.
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPathFor, readJSON } from "../hive-common/identity.ts";
import {
	type FastConfig,
	type PayloadHook,
	fastApplies,
	modelKey,
	parseFastCommand,
	resolveFastConfig,
	withPriorityTier,
} from "./policy.ts";

const STATUS_KEY = "fast";
const CONFIG = "fast";

export default function fast(pi: ExtensionAPI): void {
	// Read once at load, never in a handler: pi awaits handlers serially, so
	// file I/O there is agent-loop latency. Commands re-read, they are allowed to.
	let config: FastConfig = resolveFastConfig(readJSON(configPathFor(CONFIG)), process.env);

	const decorate =
		(api: ProviderStreams): ProviderStreams["streamSimple"] =>
		(model, context, options) => {
			if (!fastApplies(model, config)) return api.streamSimple(model, context, options);
			return api.streamSimple(model, context, {
				...options,
				onPayload: withPriorityTier(options?.onPayload as PayloadHook | undefined),
			});
		};

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: decorate(openAICodexResponsesApi()),
	});
	pi.registerProvider("openai", {
		api: "openai-responses",
		streamSimple: decorate(openAIResponsesApi()),
	});

	pi.registerFlag("fast", {
		description: "Use OpenAI Fast mode (priority tier) on supported models for this session",
		type: "boolean",
		default: false,
	});

	const showStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, fastApplies(ctx.model, config) ? "⚡ fast" : undefined);
	};

	const describe = (ctx: ExtensionContext): string => {
		const model = modelKey(ctx.model);
		if (!config.enabled) return `Fast mode is off (current model ${model}).`;
		if (fastApplies(ctx.model, config)) {
			return `Fast mode is on: ${model} requests the priority tier (about 1.5× faster, 2–2.5× the cost). OpenAI may still serve the default tier under load.`;
		}
		return `Fast mode is on, but ${model} is not on the allowlist, so it runs at the default tier. Allowed: ${config.models.join(", ")}.`;
	};

	const persist = (enabled: boolean) => {
		const path = configPathFor(CONFIG);
		const raw = readJSON<Record<string, unknown>>(path) ?? {};
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ ...raw, enabled }, null, "\t")}\n`, { mode: 0o600 });
		config = resolveFastConfig({ ...raw, enabled }, { ...process.env, HIVE_PI_FAST: undefined });
	};

	pi.registerCommand("fast", {
		description: "OpenAI Fast mode (priority tier): /fast [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status"].filter((v) => v.startsWith(prefix.trim().toLowerCase()));
			return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const command = parseFastCommand(args);
			if (!command) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			if (command !== "status") persist(command === "toggle" ? !config.enabled : command === "on");
			showStatus(ctx);
			ctx.ui.notify(describe(ctx), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag("fast") === true) config = { ...config, enabled: true };
		showStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => showStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
}
