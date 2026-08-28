/**
 * The MCP config, read the way `pi-mcp-adapter` reads it — in one place.
 *
 * TWO CONSUMERS, and they must agree or both are wrong: `readiness/` reports
 * per-server lifecycle to the operator, and `subagent/worker.ts` has to
 * NEUTRALISE that lifecycle for delegated workers. A second, drifting copy of
 * "where is the config and what does it say" would let the report describe one
 * file while the workers read another.
 *
 * ## Why a worker needs a different config at all (HIV-1969)
 *
 * `worker.ts` restores `pi-mcp-adapter` into every worker (HIV-1581), and its
 * header states the condition that makes that affordable:
 *
 *   > connections are LAZY — `startLoadTimeInitialization` returns immediately
 *   > unless a server declares `lifecycle: eager|keep-alive`, and none do.
 *   > If a server is ever given an eager lifecycle, revisit this: it would
 *   > spawn that server on EVERY delegation.
 *
 * Making `hive` and `linear` eager is exactly that change, and it is worth
 * making for the interactive session: a prewarmed connection removes a
 * mid-task stall the human waits through. A worker is the opposite case — it
 * lives for one bounded task, is often one of eight spawned at once, and
 * `linear` spawns an `npx` subprocess per connection. Eight workers × two eager
 * servers is sixteen connections nobody asked for.
 *
 * So the lifecycle is a property of the SESSION KIND, not of the server, and
 * `lazyVariant` is how the two kinds read the same file differently.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpServerDef {
	lifecycle?: string;
	[key: string]: unknown;
}

export interface McpConfigDoc {
	mcpServers?: Record<string, McpServerDef>;
	[key: string]: unknown;
}

/** Lifecycles that make the adapter connect without being asked. */
export const PREWARMING_LIFECYCLES: readonly string[] = ["eager", "keep-alive"];

/**
 * Where the adapter looks, mirrored exactly: `--mcp-config <path>` on the
 * command line, else the agent dir. `PI_MCP_CONFIG` is OURS — a test and
 * escape seam, checked last so it can never mask what the adapter would use.
 */
export function mcpConfigPath(
	env: Record<string, string | undefined> = process.env,
	argv: readonly string[] = process.argv,
	home: string = os.homedir(),
): string {
	const idx = argv.indexOf("--mcp-config");
	if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
	if (env.PI_MCP_CONFIG) return env.PI_MCP_CONFIG;
	return path.join(home, ".pi", "agent", "mcp.json");
}

/**
 * The adapter's own tool-list cache — a server's tools, with no connection.
 *
 * `PI_MCP_CACHE` is OURS, exactly as `PI_MCP_CONFIG` is above: a test and
 * escape seam, checked before the default because there is no adapter flag it
 * could mask.
 */
export function mcpCachePath(
	home: string = os.homedir(),
	env: Record<string, string | undefined> = process.env,
): string {
	if (env.PI_MCP_CACHE) return env.PI_MCP_CACHE;
	return path.join(home, ".pi", "agent", "mcp-cache.json");
}

/**
 * The adapter's cache TTL (`metadata-cache.ts`, `CACHE_MAX_AGE_MS`).
 *
 * Duplicated rather than imported: `pi-mcp-adapter` exports only `.` and
 * `./types`, so `metadata-cache.ts` is unreachable by subpath even though it
 * ships. A constant hand-synced to someone else's pin drifts, so treat a
 * mismatch as this file's bug and re-check it on an adapter bump — the failure
 * mode is a row that is merely less accurate, never a crash.
 *
 * It lives HERE, with `mcpCachePath`, because two consumers now need it —
 * `readiness/probes.ts` reports it to the operator and `mcp-common/search.ts`
 * tells the agent why a search found nothing — and a third hand-copied 7d
 * would be the drift this comment is warning about.
 */
export const MCP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Why a cached tool list can be present and still unusable.
 *
 * TOOLS KNOWN ≠ TOOLS USABLE, and the gap is the whole point of this function.
 * `init.ts:244` seeds `state.toolMetadata` from the cache only when
 * `isServerCacheValid(entry, definition)` passes, which checks two things: the
 * entry is younger than the TTL, and `computeServerHash(definition)` still
 * matches the stored `configHash`. Fail either and the adapter behaves as if it
 * had never heard of the server — `mcp({ server: "sentry" })` answers
 * `Server "sentry" is configured but not connected` (`proxy-modes.ts:610`), a
 * search answers `No tools matching …`, and the agent has to
 * `mcp({ connect: … })` by hand before it can even list.
 *
 * Measured on session `a78c92ef` (2026-08-17): `sentry`'s entry had been
 * invalidated the day before, when pinning `@sentry/mcp-server@0.37.0` changed
 * `args` and therefore the identity hash. The readiness probe reported "9 tools
 * known · lazy-keep-alive: first call pays the connect", the agent believed it,
 * and then spent three turns and 39 s on bounce → connect → four `describe`
 * calls before its first real Sentry query. The row was not wrong about the
 * file; it was wrong about what the adapter would do with it, which is the only
 * thing the reader cares about.
 *
 * We can see the TTL exactly. We cannot recompute the identity hash without
 * reimplementing `computeServerHash` (env interpolation, path resolution,
 * stable key order) — which would be precisely the drift this file must not
 * take on — so the hash case is approximated by "`mcp.json` was written after
 * this entry was cached". That over-reports: editing one server's entry flags
 * every server cached before the edit. Over-reporting is the right direction
 * here, because the cost of the false alarm is one extra sentence, and the cost
 * of the miss is what session `a78c92ef` paid.
 */
export function mcpCacheStaleness(
	cachedAt: number | undefined,
	configMtimeMs: number | null,
	now: number,
): string | null {
	if (typeof cachedAt !== "number") return "no cache timestamp";
	if (now - cachedAt > MCP_CACHE_MAX_AGE_MS) {
		return `cached ${Math.floor((now - cachedAt) / (24 * 60 * 60 * 1_000))}d ago, past the adapter's 7d TTL`;
	}
	if (configMtimeMs !== null && configMtimeMs > cachedAt) return "mcp.json changed after it was cached";
	return null;
}

/**
 * The same config with every prewarming lifecycle removed.
 *
 * Removed rather than rewritten to `"lazy"`: `lazy` IS the adapter's default
 * (`init.ts:231`), so an absent key and an explicit `"lazy"` mean the same
 * thing, and absence cannot drift if that default is ever renamed.
 *
 * Pure, and it copies rather than mutates — the caller usually holds the
 * parsed config for its own reporting.
 */
export function lazyVariant(config: McpConfigDoc): { config: McpConfigDoc; changed: string[] } {
	const servers = config.mcpServers;
	if (!servers) return { config, changed: [] };
	const changed: string[] = [];
	const nextServers: Record<string, McpServerDef> = {};
	for (const [name, def] of Object.entries(servers)) {
		if (def && typeof def === "object" && typeof def.lifecycle === "string" && PREWARMING_LIFECYCLES.includes(def.lifecycle)) {
			const { lifecycle: _dropped, ...rest } = def;
			nextServers[name] = rest;
			changed.push(name);
			continue;
		}
		nextServers[name] = def;
	}
	if (changed.length === 0) return { config, changed: [] };
	return { config: { ...config, mcpServers: nextServers }, changed };
}

export function readMcpConfig(file: string): McpConfigDoc | null {
	try {
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf8")) as McpConfigDoc;
	} catch {
		// A malformed config is the adapter's problem to report, not ours to
		// crash a delegation over.
		return null;
	}
}

/**
 * Materialise the worker's config, once per process, and return its path.
 *
 * Returns null when there is nothing to change — no config, or no server
 * prewarming — because passing no flag is strictly better than passing a
 * redundant copy: the worker then reads exactly what the adapter would have.
 *
 * Written once and reused by every worker of this session. A file per
 * delegation would be litter proportional to fan-out, and the content is
 * identical by construction.
 */
export function ensureWorkerMcpConfig(
	sourcePath: string = mcpConfigPath(),
	dir: string = os.tmpdir(),
	pid: number = process.pid,
): string | null {
	const source = readMcpConfig(sourcePath);
	if (!source) return null;
	const { config, changed } = lazyVariant(source);
	if (changed.length === 0) return null;
	const target = path.join(dir, `pi-worker-mcp-${pid}.json`);
	try {
		if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(config, null, 2));
		return target;
	} catch {
		// Falling back to the parent's config costs a worker one eager connect;
		// failing the delegation would cost the whole task.
		return null;
	}
}

/** Remove this process's derived worker config, if it wrote one. */
export function cleanupWorkerMcpConfig(dir: string = os.tmpdir(), pid: number = process.pid): void {
	try {
		fs.rmSync(path.join(dir, `pi-worker-mcp-${pid}.json`), { force: true });
	} catch {
		/* best effort; it is one small file in tmp */
	}
}
