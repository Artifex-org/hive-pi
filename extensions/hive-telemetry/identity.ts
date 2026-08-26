/**
 * hive-telemetry — config resolution.
 *
 * The credential, project and filesystem primitives moved to ../hive-common so
 * hive-remote shares ONE credential store and ONE /hive-login. What stays here
 * is only what is telemetry-specific: this extension's own config shape.
 *
 * The re-exports below keep index.ts's imports unchanged, which is what makes
 * the move reviewable — the diff is a move, not a rewrite.
 *
 * Everything here does blocking I/O, so NONE of it may be called from an event
 * handler: pi awaits handlers serially, so a 15ms file read inside one is 15ms
 * of stalled agent loop.
 */

import {
	atomicWrite,
	configPathFor,
	numberOr,
	readJSON,
	resolveAuth as resolveAuthCommon,
	spoolDirFor,
} from "../hive-common/identity.ts";
import type { ResolvedAuth, ResolvedConfig } from "./types.ts";

export {
	atomicWrite,
	clearCredentials,
	credentialsPath,
	normalizeRemote,
	readStoredCredential,
	resolveProject,
	saveCredentials,
	stateDir,
} from "../hive-common/identity.ts";

export function configPath(): string {
	return configPathFor("hive-telemetry");
}

export function spoolDir(): string {
	return spoolDirFor("hive-telemetry");
}

const DEFAULTS: ResolvedConfig = {
	enabled: false,
	url: "",
	flushIntervalMs: 120_000,
	eventThreshold: 25,
	spoolEveryFlush: false,
	projectOverride: null,
};

/**
 * loadConfig resolves non-secret settings. Absent config means DISABLED: a fresh
 * machine that installs this package gets an extension that does nothing at all
 * until someone runs /hive-login.
 */
export function loadConfig(): ResolvedConfig {
	const raw = readJSON<Partial<ResolvedConfig>>(configPath()) ?? {};
	return {
		enabled: raw.enabled === true,
		url: typeof raw.url === "string" ? raw.url : "",
		flushIntervalMs: numberOr(raw.flushIntervalMs, DEFAULTS.flushIntervalMs, 15_000, 3_600_000),
		eventThreshold: numberOr(raw.eventThreshold, DEFAULTS.eventThreshold, 1, 1000),
		spoolEveryFlush: raw.spoolEveryFlush === true,
		projectOverride: typeof raw.projectOverride === "string" ? raw.projectOverride : null,
	};
}

export function writeConfig(patch: Partial<ResolvedConfig>): void {
	const current = readJSON<Partial<ResolvedConfig>>(configPath()) ?? {};
	atomicWrite(configPath(), JSON.stringify({ ...current, ...patch }, null, 2));
}

/** resolveAuth, with this extension's configured URL as the last fallback. */
export function resolveAuth(cfg: ResolvedConfig): ResolvedAuth | null {
	return resolveAuthCommon(cfg.url);
}
