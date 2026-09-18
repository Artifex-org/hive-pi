/**
 * typesafe-common — configuration.
 *
 * The shape is `compaction`'s, on purpose, because the property that matters is
 * the same one: this feature sends data off the machine, so it is `=== true`
 * and never `!== false`. The difference is not pedantry — `!== false` makes
 * ABSENT mean ON, and absent is the state of every machine that has never heard
 * of this file. `compaction/index.ts:50-60` is the precedent; `hive-telemetry`
 * and `hive-remote` are the other two.
 *
 * ABSENT CONFIG IS A SUPPORTED STATE, not a degraded one. Everything below has
 * a default, `configFrom(null)` is a valid call, and the tests drive
 * `configFrom` rather than the developer's own `~/.pi` — testing the loader
 * against real machine state is a test that passes for the wrong reason
 * (`compaction/index.ts:wireCompaction` says the same thing at more length).
 */

import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";

export interface TypesafeConfig {
	/** `=== true`, never `!== false`. Nothing reaches the network without it. */
	enabled: boolean;
	/**
	 * Per-call ceiling. The measured numbers: cold including TLS 1.4–2.1s, warm
	 * on a kept-alive connection a 299ms median (270–405ms). 3s is "a cold call
	 * on a bad day still lands"; it is NOT a budget for a call inside the agent
	 * loop, which is why nothing in this package registers a handler.
	 */
	timeoutMs: number;
	/** The model alias sent in the request body. */
	model: string;
	/** Endpoint, overridable so a test or a proxy never has to patch the code. */
	endpoint: string;
}

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

/** The pure half: a parsed config object in, a fully-defaulted config out. */
export function configFrom(raw: unknown): TypesafeConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Partial<TypesafeConfig>;
	return {
		enabled: cfg.enabled === true,
		timeoutMs: numberOr(cfg.timeoutMs, 3_000, 250, 30_000),
		model: typeof cfg.model === "string" && cfg.model.length > 0 ? cfg.model : DEFAULT_MODEL,
		endpoint:
			typeof cfg.endpoint === "string" && cfg.endpoint.startsWith("https://") ? cfg.endpoint : DEFAULT_ENDPOINT,
	};
}

/** The I/O half. Blocking read — never from an event handler. */
export function loadConfig(): TypesafeConfig {
	return configFrom(readJSON<unknown>(configPathFor("typesafe")));
}
