/**
 * A ranked, any-token search over the session's MCP tools.
 *
 * ## Why this still exists with native MCP
 *
 * pi's built-in MCP has its own search (`tool_search`, codemode's
 * `searchTools()`, BM25). The model should use those, and the toolhints point
 * it there. This ranker serves the HARNESS: toolhints names likely tools when
 * a call fails on an unknown name, and `typesafe-common/router.ts` needs a
 * deterministic lexical floor to compare its classifier against. Neither can
 * call into pi's ranker, which is internal to the codemode extension.
 *
 * The corpus used to be pi-mcp-adapter's `mcp-cache.json`, read at session
 * start. Native MCP writes no such file; it registers every server tool with
 * pi as `mcp__<server>__<tool>`, with the server as the tool's namespace. So
 * the corpus is now read from `pi.getAllTools()` — the live registry, which
 * cannot go stale the way the cache did (HIV-3745).
 *
 * ## The ranking
 *
 * `normalizeSearchText`, `tokenize`, the field weights and the score increments
 * are the adapter's, kept because the router's replay fixtures were labelled
 * against them. The differences from the adapter are deliberate: no coverage
 * gate (one matched token makes a candidate; coverage still raises the score),
 * and the coverage denominator counts DISTINCT query tokens.
 */

import { nativeMcpServer, nativeMcpToolName } from "./names.ts";

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
	/** Every server with at least one registered tool. */
	servers: Record<string, Record<string, never>>;
}

export const EMPTY_CORPUS: McpToolCorpus = { tools: [], servers: {} };

/**
 * The name a model calls a server tool by. `native` (the default) is pi's
 * built-in MCP form; `server` is pi-mcp-adapter's promoted form, kept for the
 * router replay fixtures, which were labelled under the adapter.
 */
export function qualifyToolName(name: string, server: string, prefix = "native"): string {
	if (prefix === "native") return nativeMcpToolName(server, name);
	const sanitized = name.replace(/\./g, "_");
	if (prefix === "none") return sanitized;
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
	const qualifiedName = qualifyToolName(input.name, input.server, input.prefix ?? "native");
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

/** The slice of pi's `ToolInfo` the corpus reads. */
export interface RegistryTool {
	name: string;
	description?: string;
	namespace?: { name?: string } | undefined;
}

/**
 * The session's MCP tools as a searchable corpus, from pi's own registry.
 *
 * A tool is an MCP tool when its name has the `mcp__<server>__<tool>` shape;
 * the namespace pi assigns (`mcp__<server>`) agrees by construction. Pure and
 * cheap enough to rebuild on demand — servers connect in the background, so a
 * corpus taken at session start would miss every server that was still
 * connecting.
 */
export function corpusFromRegistry(tools: readonly RegistryTool[]): McpToolCorpus {
	const rows: CorpusTool[] = [];
	const servers: Record<string, Record<string, never>> = {};
	for (const tool of tools) {
		const server = nativeMcpServer(tool.name);
		if (!server) continue;
		const bare = tool.name.slice(`mcp__${server}__`.length);
		servers[server] = {};
		rows.push(corpusTool({ server, name: bare, description: tool.description ?? "" }));
	}
	return { tools: rows, servers };
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
