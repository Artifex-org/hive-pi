/**
 * The tool corpus the adapter searches, read from the same file the adapter
 * caches it in — and ranked with OR semantics instead of the adapter's AND.
 *
 * ## Why this exists (the papercut it answers)
 *
 * `mcp({search})` answers `No tools matching "…"` for tools that plainly
 * exist, and it does so for TWO unrelated reasons that print the same
 * sentence:
 *
 * 1. **A coverage gate, not a name-only corpus.** `pi-mcp-adapter`'s
 *    `search-ranking.ts` scores names AND descriptions (`FIELD_WEIGHTS`
 *    includes `description: 5`), but then throws the row away unless the query
 *    is nearly all covered: `coverage !== 1` for a one- or two-token query, and
 *    `< 0.6` for anything longer (`search-ranking.ts:82`). A capability phrase
 *    — "factory settings", "find related work canceled task empty log failed
 *    run" — mixes words no single tool's text carries, so EVERY row returns
 *    null and the search reports zero. Measured against the real 589-tool
 *    cache: nine natural-language queries, nine empty results; with the gate
 *    replaced by any-token OR and the same weights, the intended tool is rank 1
 *    in seven of them.
 * 2. **A server that is not in the corpus at all.** `init.ts:243` seeds
 *    `state.toolMetadata` from the cache only while `isServerCacheValid`
 *    passes — younger than the 7d TTL and the config hash unchanged. Fail
 *    either and the adapter behaves as if the server had never been heard of,
 *    and says so with the same sentence. See `mcpCacheStaleness`.
 *
 * We cannot fix either one: the scorer is third-party and pinned
 * (`npm:pi-mcp-adapter@2.20.1`). We can stop the agent being misled, because
 * this harness ALREADY reads the same cache file (`readiness/probes.ts`) and
 * already knows where it is (`mcp-common/config.ts`). So: read the corpus once
 * at session start, rank it ourselves with the adapter's own weights minus the
 * gate, and name the candidates in the failing tool result.
 *
 * ## The ranker is the adapter's, minus one line
 *
 * `normalizeSearchText`, `tokenize`, the field weights and every score
 * increment below are mirrored from `search-ranking.ts` on purpose: two
 * rankers that disagree about what "matches" means would be worse than one
 * that is occasionally strict. The deliberate differences are exactly two:
 *
 *  - **No coverage gate.** One matched token is enough to be a candidate. The
 *    score still rewards coverage, so a full-coverage row outranks a
 *    one-word brush — the difference is that the brush is now VISIBLE.
 *  - **The coverage denominator counts DISTINCT query tokens.** The adapter
 *    divides a `Set` of matched tokens by `queryTokens.length`, which counts
 *    duplicates, so a query repeating a word can never reach coverage 1 and is
 *    gated out for a reason nothing in it explains.
 *
 * If the upstream gate is ever turned into an OR fallback, retire this
 * deliberately rather than leaving two rankers to disagree.
 */

import fs from "node:fs";

import { mcpCachePath, mcpConfigPath, readMcpConfig } from "./config.ts";

export { MCP_CACHE_MAX_AGE_MS, mcpCacheStaleness } from "./config.ts";
import { mcpCacheStaleness } from "./config.ts";

/**
 * Shortest field token allowed to stem-match a longer query token — mirrored
 * from `search-ranking.ts`, and for the reason stated there: possessives
 * tokenize into single letters, which would otherwise match everything.
 */
const MIN_STEM_LENGTH = 4;

/** `search-ranking.ts` FIELD_WEIGHTS, in the adapter's own order. */
const FIELD_WEIGHTS = { name: 12, originalName: 10, server: 8, description: 5 } as const;

/**
 * A cache that big is not our cache. The measured file is ~750 KB for 589
 * tools across four servers; the cap exists so a corrupt or runaway file
 * cannot turn session start into a multi-second read.
 */
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;

/** How many candidates a miss is worth naming. More is a wall of text. */
export const DEFAULT_CANDIDATE_LIMIT = 8;

export function normalizeSearchText(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_./:-]+/g, " ")
		.toLowerCase();
}

export function tokenize(value: string): string[] {
	return normalizeSearchText(value)
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** One scored field, normalised and tokenised ONCE at load. */
interface ScoredField {
	weight: number;
	value: string;
	tokens: string[];
}

export interface CorpusTool {
	server: string;
	/** The name the server advertises, and what `describe` calls it. */
	name: string;
	/**
	 * The name the adapter REGISTERS, which is what `mcp({tool})` resolves
	 * (`tool-metadata.ts:findToolByName` matches the prefixed name and nothing
	 * else). Printing the bare name would hand the agent a call that fails.
	 */
	qualifiedName: string;
	description: string;
	/** When this server's entry was written, from the cache. */
	cachedAt?: number;
	/**
	 * Precomputed because the consumer is a `tool_result` handler, which pi
	 * awaits INSIDE the agent loop: re-normalising 589 descriptions per miss
	 * would put real work on a path whose contract is "nothing that can hang a
	 * turn".
	 */
	fields: ScoredField[];
}

export interface McpToolCorpus {
	tools: CorpusTool[];
	/** Per-server cache metadata, kept even for servers with no tools. */
	servers: Record<string, { cachedAt?: number }>;
	/**
	 * `mcp.json`'s mtime when the corpus was read, or null. The adapter also
	 * invalidates an entry whose config HASH changed; we cannot recompute that
	 * hash without reimplementing it, so "the config was written after this
	 * entry was cached" stands in for it — the same approximation, and the same
	 * justification, as `readiness/probes.ts`.
	 */
	configMtimeMs: number | null;
}

export const EMPTY_CORPUS: McpToolCorpus = { tools: [], servers: {}, configMtimeMs: null };

/**
 * The adapter's `formatToolName` under prefix mode `server` and friends.
 *
 * Mirrored rather than imported: `pi-mcp-adapter` exports only `.` and
 * `./types`, so `types.ts` is unreachable by subpath even though it ships.
 */
export function qualifyToolName(name: string, server: string, prefix = "server"): string {
	const sanitized = name.replace(/\./g, "_");
	if (prefix === "none") return sanitized;
	if (prefix === "mcp") return `mcp__${server.replace(/-/g, "_")}_${sanitized}`;
	if (prefix === "short") {
		const short = server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
		return `${short}_${sanitized}`;
	}
	return `${server.replace(/-/g, "_")}_${sanitized}`;
}

/** Build one corpus row, with its fields normalised and tokenised. */
export function corpusTool(input: {
	server: string;
	name: string;
	description?: string;
	cachedAt?: number;
	prefix?: string;
}): CorpusTool {
	const description = input.description ?? "";
	const qualifiedName = qualifyToolName(input.name, input.server, input.prefix ?? "server");
	const field = (weight: number, raw: string): ScoredField => {
		const value = normalizeSearchText(raw);
		return { weight, value, tokens: tokenize(value) };
	};
	return {
		server: input.server,
		name: input.name,
		qualifiedName,
		description,
		...(input.cachedAt === undefined ? {} : { cachedAt: input.cachedAt }),
		// Order matters: fields[0] is the name field, and the adapter's
		// "first query token appears in the name" bonus reads exactly that one.
		fields: [
			field(FIELD_WEIGHTS.name, qualifiedName),
			field(FIELD_WEIGHTS.originalName, input.name),
			field(FIELD_WEIGHTS.server, input.server),
			field(FIELD_WEIGHTS.description, description),
		],
	};
}

interface CachedTool {
	name?: unknown;
	description?: unknown;
}

interface CachedServer {
	tools?: unknown;
	cachedAt?: unknown;
}

interface CacheDoc {
	servers?: Record<string, CachedServer | undefined>;
}

/**
 * Read `~/.pi/agent/mcp-cache.json` into a ranked-searchable corpus.
 *
 * DELIBERATELY IGNORES THE TTL. An expired entry still holds its `tools`
 * array; the adapter drops it from `state.toolMetadata`, which is precisely
 * why the agent is standing here reading "no tools matching". Naming the tools
 * a stale server has is the whole value — paired with `mcpCacheStaleness` so
 * the agent is told to `connect` rather than told the tool does not exist.
 *
 * Never throws. A missing, oversized, or malformed cache is an empty corpus
 * and a hint with no candidate list, which is exactly today's behaviour.
 */
export function loadToolCorpus(
	options: { cachePath?: string; configPath?: string } = {},
): McpToolCorpus {
	const cachePath = options.cachePath ?? mcpCachePath();
	const configPath = options.configPath ?? mcpConfigPath();
	let doc: CacheDoc;
	try {
		const stat = fs.statSync(cachePath);
		if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return EMPTY_CORPUS;
		doc = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheDoc;
	} catch {
		return EMPTY_CORPUS;
	}

	let configMtimeMs: number | null = null;
	try {
		configMtimeMs = fs.statSync(configPath).mtimeMs;
	} catch {
		configMtimeMs = null;
	}

	// The prefix decides the name we print, and printing an unresolvable name
	// would be the same class of defect this file exists to remove.
	const config = readMcpConfig(configPath);
	const globalPrefix = typeof (config?.settings as { toolPrefix?: unknown } | undefined)?.toolPrefix === "string"
		? ((config?.settings as { toolPrefix: string }).toolPrefix)
		: "server";

	const tools: CorpusTool[] = [];
	const servers: Record<string, { cachedAt?: number }> = {};
	for (const [server, entry] of Object.entries(doc?.servers ?? {})) {
		const cachedAt = typeof entry?.cachedAt === "number" ? entry.cachedAt : undefined;
		servers[server] = cachedAt === undefined ? {} : { cachedAt };
		const definition = config?.mcpServers?.[server] as { toolPrefix?: unknown } | undefined;
		const prefix = typeof definition?.toolPrefix === "string" ? definition.toolPrefix : globalPrefix;
		if (!Array.isArray(entry?.tools)) continue;
		for (const raw of entry.tools as CachedTool[]) {
			if (!raw || typeof raw.name !== "string" || raw.name.length === 0) continue;
			tools.push(
				corpusTool({
					server,
					name: raw.name,
					description: typeof raw.description === "string" ? raw.description : "",
					...(cachedAt === undefined ? {} : { cachedAt }),
					prefix,
				}),
			);
		}
	}
	return { tools, servers, configMtimeMs };
}

/** Why the adapter is ignoring this server's cached tools, if it is. */
export function corpusStaleness(corpus: McpToolCorpus, server: string, now: number): string | null {
	const entry = corpus.servers[server];
	if (!entry) return null;
	return mcpCacheStaleness(entry.cachedAt, corpus.configMtimeMs, now);
}

export interface RankedTool {
	tool: CorpusTool;
	score: number;
	/** Share of DISTINCT query tokens this tool matched, 0–1. */
	coverage: number;
}

/**
 * The adapter's ranking with OR semantics: any tool matching at least one
 * query token is a candidate, best first.
 *
 * Pure and allocation-light — it runs inside the agent loop.
 */
export function rankByAnyToken(
	tools: readonly CorpusTool[],
	query: string,
	limit: number = DEFAULT_CANDIDATE_LIMIT,
): RankedTool[] {
	const normalizedQuery = normalizeSearchText(query).trim();
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	const distinct = [...new Set(queryTokens)];

	const ranked: RankedTool[] = [];
	for (const tool of tools) {
		let score = 0;
		let phraseMatched = false;
		let wholeFieldExact = false;
		const matched = new Set<string>();

		for (const { weight, value, tokens } of tool.fields) {
			if (value === normalizedQuery) {
				score += weight * 14;
				phraseMatched = true;
				wholeFieldExact = true;
			} else if (value.startsWith(normalizedQuery)) {
				score += weight * 9;
				phraseMatched = true;
			} else if (value.includes(normalizedQuery)) {
				score += weight * 6;
				phraseMatched = true;
			}
			for (const token of distinct) {
				if (tokens.includes(token)) {
					score += weight * 4;
					matched.add(token);
				} else if (
					tokens.some((ft) => ft.startsWith(token) || (ft.length >= MIN_STEM_LENGTH && token.startsWith(ft)))
				) {
					score += weight * 2;
					matched.add(token);
				} else if (value.includes(token)) {
					score += weight;
					matched.add(token);
				}
			}
		}

		// THE WHOLE FIX: the adapter returns null here unless coverage is 1
		// (short query) or ≥ 0.6. One token is enough to be worth naming.
		if (!phraseMatched && matched.size === 0) continue;

		const coverage = matched.size / distinct.length;
		score += coverage === 1 ? 25 : Math.round(coverage * 10);
		const firstToken = queryTokens[0];
		if (firstToken !== undefined && tool.fields[0].tokens.includes(firstToken)) score += 8;
		if (wholeFieldExact) score += 20;
		ranked.push({ tool, score, coverage });
	}

	ranked.sort(
		(a, b) =>
			b.score - a.score ||
			b.coverage - a.coverage ||
			a.tool.qualifiedName.localeCompare(b.tool.qualifiedName),
	);
	return ranked.slice(0, Math.max(1, limit));
}
