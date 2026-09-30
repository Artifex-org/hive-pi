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
	/**
	 * The `typesafe` route's endpoint. The field name predates the second route
	 * and is kept so an existing `typesafe.config.json` means what it meant.
	 * Overridable so a test or a proxy never has to patch the code.
	 */
	endpoint: string;
	/** The `openrouter` route's endpoint: the same System One API, billed by OpenRouter. */
	openrouterEndpoint: string;
	/**
	 * Which routes to try, in order. A route with no key is skipped, so the
	 * default order is also the right one on a machine that holds only one key.
	 * Cutover to OpenRouter only is `["openrouter"]` — config, not code.
	 */
	routes: readonly JevRoute[];
	/**
	 * Why `routes` could not be read, or null. A bad route list FAILS CLOSED:
	 * the client reports `disabled` rather than guessing which of an operator's
	 * typos they meant, because a guess could send data somewhere unintended.
	 */
	routeError: string | null;
}

/** The two places Jev is served. Nothing else is a route. */
export type JevRoute = "typesafe" | "openrouter";
export const JEV_ROUTES: readonly JevRoute[] = ["typesafe", "openrouter"];

/** Env override for the route order, a comma list: `JEV_ROUTES=openrouter`. */
export const JEV_ROUTES_ENV = "JEV_ROUTES";

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_ROUTES: readonly JevRoute[] = JEV_ROUTES;

/** Only https: every route carries a bearer token. Anything else falls back to the default. */
function httpsOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.startsWith("https://") ? value : fallback;
}

/**
 * A route list from the config file (array or comma string) or the env (comma
 * string). Absent is the default order; present-but-wrong is an error, never
 * a silent default — an operator who wrote `JEV_ROUTES=openruoter` asked for
 * OpenRouter only and must not quietly get typesafe too.
 */
export function parseRoutes(raw: unknown): { routes: readonly JevRoute[]; error: string | null } {
	if (raw === undefined || raw === null) return { routes: DEFAULT_ROUTES, error: null };
	const items =
		typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : null;
	if (items === null) return { routes: [], error: "routes must be a list or a comma-separated string" };
	const routes: JevRoute[] = [];
	for (const item of items) {
		const name = typeof item === "string" ? item.trim().toLowerCase() : item;
		if (name === "") continue;
		if (!JEV_ROUTES.includes(name as JevRoute)) return { routes: [], error: `unknown route ${JSON.stringify(item)}` };
		if (routes.includes(name as JevRoute)) return { routes: [], error: `route "${String(name)}" is listed twice` };
		routes.push(name as JevRoute);
	}
	if (routes.length === 0) return { routes: [], error: "routes is empty" };
	return { routes, error: null };
}

/**
 * The pure half: a parsed config object in, a fully-defaulted config out.
 *
 * `env` is only consulted for `JEV_ROUTES`, which outranks the file's
 * `routes` so a launched agent can be cut over without editing a file. It
 * defaults to empty so a test drives exactly what it hands in.
 */
export function configFrom(raw: unknown, env: Record<string, string | undefined> = {}): TypesafeConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof TypesafeConfig, unknown>>;
	const fromEnv = env[JEV_ROUTES_ENV];
	const { routes, error } = parseRoutes(fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : cfg.routes);
	return {
		enabled: cfg.enabled === true,
		timeoutMs: numberOr(cfg.timeoutMs, 3_000, 250, 30_000),
		model: typeof cfg.model === "string" && cfg.model.length > 0 ? cfg.model : DEFAULT_MODEL,
		endpoint: httpsOr(cfg.endpoint, DEFAULT_ENDPOINT),
		openrouterEndpoint: httpsOr(cfg.openrouterEndpoint, DEFAULT_OPENROUTER_ENDPOINT),
		routes,
		routeError: error,
	};
}

/** The I/O half. Blocking read — never from an event handler. */
export function loadConfig(env: Record<string, string | undefined> = process.env): TypesafeConfig {
	return configFrom(readJSON<unknown>(configPathFor("typesafe")), env);
}
