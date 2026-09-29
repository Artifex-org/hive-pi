/**
 * fast, for delegated workers — subagents and briefers, which load only
 * subagent/worker.ts's WORKER_EXTENSIONS.
 *
 * The whole extension (index.ts) is not loaded there: its command, flag,
 * status marker and workspace control channel serve a person at an
 * interactive session, and a worker has none. This module does the one thing
 * a worker needs — wrap the OpenAI providers — and decides by
 * `PI_SUBAGENT_FAST=1` alone (resolveFastConfig's worker rule), so a Hive
 * launch can run its helpers fast without its main session, or the reverse.
 *
 * It registers exactly one hook, session_start, because that is the first
 * point the model registry is reachable; test/subagent-worker.test.ts pins
 * that and nothing more.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPathFor, readJSON } from "../hive-common/identity.ts";
import { resolveFastConfig } from "./policy.ts";
import { providerWrapper } from "./wrap.ts";

export default function fastWorker(pi: ExtensionAPI): void {
	const config = resolveFastConfig(readJSON(configPathFor("fast")), process.env);
	if (!config.enabled) return;
	const wrap = providerWrapper(pi, () => config);
	pi.on("session_start", (_event, ctx) => wrap(ctx));
}
