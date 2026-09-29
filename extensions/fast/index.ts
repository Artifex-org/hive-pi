/**
 * fast — OpenAI Fast mode (the priority service tier) for pi.
 *
 *   /fast               toggle
 *   /fast on|off        set, and remember it
 *   /fast status        what the current model would get
 *   pi --fast           on for this process
 *   HIVE_PI_FAST=1      on for this process (how a Hive launch asks for it)
 *   PI_SUBAGENT_FAST=1  on for delegated workers and one-shot helpers, which
 *                       ignore HIVE_PI_FAST and the stored setting (policy.ts)
 *
 * Off by default: priority costs 2–2.5× the credits or dollars. Applies only to
 * the allowlisted models in policy.ts, extendable with `models` in
 * ~/.pi/agent/hive-telemetry/fast.config.json.
 *
 * HOW. pi composes a provider's stream per provider id, and an extension that
 * registers `streamSimple` for a built-in provider id replaces the stream for
 * that provider's models on that api, keeping its models and login
 * (provider-composer.js). So this registers `openai-codex` and `openai` with a
 * stream that delegates to the provider pi had BEFORE the override, and only
 * adds the tier when fast mode applies. Off, the request is exactly what pi
 * would send.
 *
 * The delegate is captured from `ctx.modelRegistry.getProvider()` before
 * registering, which is why registration waits for the first session_start:
 * the registry is only reachable through a ctx. The captured object keeps the
 * composition it was built with, so calling it cannot re-enter this override.
 * The alternative — pi-ai's per-api stream factories — lives only in
 * `@earendil-works/pi-ai/compat`, which test/pi-api-surface.test.ts forbids:
 * upstream deletes that entry, and nothing would announce the breakage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FAST_CONTROL_CHANNEL, FAST_STATE_CHANNEL, type FastControlEvent, type FastStateEvent } from "../hive-common/channels.ts";
import { configPathFor, readJSON } from "../hive-common/identity.ts";
import { type FastConfig, fastApplies, isWorkerEnv, modelKey, parseFastCommand, resolveFastConfig } from "./policy.ts";
import { providerWrapper } from "./wrap.ts";

const STATUS_KEY = "fast";
const CONFIG = "fast";

export default function fast(pi: ExtensionAPI): void {
	// Read once at load, never in a handler: pi awaits handlers serially, so
	// file I/O there is agent-loop latency. Commands re-read, they are allowed to.
	let config: FastConfig = resolveFastConfig(readJSON(configPathFor(CONFIG)), process.env);

	const wrapProviders = providerWrapper(pi, () => config);
	// A delegated worker decides by PI_SUBAGENT_FAST alone (policy.ts); a
	// `--fast` it was never meant to receive must not override that.
	const worker = isWorkerEnv(process.env);

	pi.registerFlag("fast", {
		description: "Use OpenAI Fast mode (priority tier) on supported models for this session",
		type: "boolean",
		default: false,
	});

	// The ctx of the newest lifecycle event, for the control channel, which
	// carries none. It goes stale on session replacement, so every use of it is
	// guarded and a stale one costs the marker, never the switch.
	let latestCtx: ExtensionContext | undefined;

	/** Tell hive-remote what is in force, so the workspace toggle can show it. */
	const announce = (ctx: ExtensionContext | undefined) => {
		let applies = false;
		try {
			applies = fastApplies(ctx?.model, config);
		} catch {
			/* stale ctx: report the switch; applies re-derives on the next event */
		}
		try {
			pi.events.emit(FAST_STATE_CHANNEL, { enabled: config.enabled, applies } satisfies FastStateEvent);
		} catch {
			/* no bus, or nobody listening */
		}
	};

	const showStatus = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		try {
			ctx.ui.setStatus(STATUS_KEY, fastApplies(ctx.model, config) ? "⚡ fast" : undefined);
		} catch {
			/* no status bar (print mode, a helper process): the marker is cosmetic */
		}
		announce(ctx);
	};

	// A browser toggle from the Hive workspace, relayed by hive-remote. THIS
	// SESSION only — no file is written, both because a browser click must not
	// change what every future session on this machine starts with (the effort
	// slider beside it does not either) and because this runs inside the agent
	// loop, where blocking I/O is stalled turns.
	pi.events.on(FAST_CONTROL_CHANNEL, (data: unknown) => {
		const enabled = (data as FastControlEvent | undefined)?.enabled;
		if (typeof enabled !== "boolean") return;
		config = { ...config, enabled };
		try {
			if (latestCtx) {
				showStatus(latestCtx);
				return;
			}
		} catch {
			/* stale ctx: fall through and still announce the switch */
		}
		announce(undefined);
	});

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
		wrapProviders(ctx);
		if (!worker && pi.getFlag("fast") === true) config = { ...config, enabled: true };
		showStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => showStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* no status bar to clear */
		}
	});
}
