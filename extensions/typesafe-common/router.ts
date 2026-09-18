/**
 * typesafe-common — the two-stage tool router, as pure functions.
 *
 * Stage 1 picks a capability CATEGORY, stage 2 picks a tool inside it. Nothing
 * here calls the network or registers anything; `scripts/typesafe-route-replay.ts`
 * drives it offline against the real MCP corpus so the idea can be measured
 * before any of it is wired to a consumer.
 *
 * ## THE STRUCTURAL FLOOR — read this before changing `stageTwoOptions`
 *
 * Stage 2's option set is ALWAYS the chosen category's members UNION
 * `rankByAnyToken`'s top 8 over the WHOLE corpus. That union is not a safety
 * net bolted on afterwards; it is the reason this design is allowed to exist at
 * all, because it makes the router structurally incapable of scoring below the
 * lexical shortlist it would replace.
 *
 * It is not a hypothetical. In a measured pilot the plain hierarchy MISSED BOTH
 * of this repo's own recorded benchmark queries — the two that
 * `test/mcp-search-fallback.test.ts:89-90` pins:
 *
 *   - "factory settings" -> `hive_get_scheduler_settings`. The tool's category
 *     was not one stage 1 would pick, so stage 2 could never reach it. No
 *     amount of stage-2 quality helps: the answer was not on the ballot.
 *   - "find related work canceled task empty log failed run" ->
 *     `hive_find_related_work`. Stage 1 picked a defensible but wrong category
 *     and there was no recovery path.
 *
 * The lexical ranker had them at rank 2 and rank 1 respectively. The union
 * repairs both, and it repairs them by construction rather than by tuning.
 *
 * ## "Unassigned" must be impossible
 *
 * Categories are keyed STRUCTURALLY as `<server>/<group>`, derived from the
 * corpus, and every server gets a mandatory `<server>/other` catch-all. A tool
 * that fell out of every category would be a tool stage 2 could never reach and
 * stage 1 could never route to — invisible, with no error. So the catch-all is
 * created whether or not anything lands in it, `categorise` is total by
 * construction, and `test/typesafe-router.test.ts` asserts the membership sum
 * equals the corpus size: an uncategorised tool is a TEST FAILURE, not a silent
 * exclusion.
 *
 * ## What Jev is not asked to do
 *
 * No arithmetic, no counting, no dates, no generation. Both stages are `choice`
 * questions over supplied options and nothing else. State is the query string
 * alone — "large irrelevant state degrades answers badly", measured.
 */

import { rankByAnyToken, tokenize, type CorpusTool } from "../mcp-common/search.ts";
import { MAX_CHOICE_OPTIONS, MAX_CRITERIA_TOKENS, estimateTokens } from "./client.ts";

/**
 * Leading tokens stripped before a tool's group is read off its name.
 *
 * These are ACTIONS, and a category of actions is useless for routing: `get`
 * would gather `get_run`, `get_ticket` and `get_greeks` into one bucket that
 * shares nothing a query could select on. What routes is the NOUN.
 */
const VERB_PREFIXES = new Set([
	"add", "allocate", "apply", "approve", "assign", "call", "cancel", "check", "claim", "clear", "compare",
	"complete", "confirm", "create", "delete", "describe", "disable", "draft", "duplicate", "enable", "encounter",
	"end", "evaluate", "explain", "export", "extract", "find", "force", "generate", "get", "instantiate", "join",
	"launch", "link", "list", "mark", "merge", "move", "my", "offload", "patch", "ping", "pin", "post", "prepare",
	"print", "prioritize", "promote", "propose", "read", "recap", "record", "register", "remove", "rename", "reorder",
	"replace", "reply", "report", "request", "reset", "resolve", "restart", "restore", "retire", "retry", "revoke",
	"rollback", "run", "save", "search", "send", "set", "share", "show", "spawn", "start", "steer", "stop", "submit",
	"transfer", "trigger", "unassign", "unshare", "update", "upload", "wait", "watch", "write",
]);

/** The catch-all suffix. Structural, so no tool can be unassigned. */
export const OTHER_GROUP = "other";

/**
 * Smallest raw group that earns its own category; anything smaller collapses
 * into `<server>/other`.
 *
 * Measured on this workstation's 635-tool corpus (2026-09-18): with no floor
 * the derivation yields 203 groups of which 108 are singletons, and a
 * 203-option stage-1 choice is both near the 255 server cap and past the
 * ~3000-token criteria ceiling. At 3 it yields 70 categories and ~2289 tokens
 * of stage-1 criteria — which fits, with room. The replay re-measures and
 * prints both numbers rather than trusting this comment on someone else's
 * corpus; `--min-members` is there to re-tune it when a corpus outgrows this.
 */
export const DEFAULT_MIN_MEMBERS = 3;

function singular(token: string): string {
	return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/**
 * The raw group for one tool: strip the server prefix the name repeats, strip
 * leading verbs, singularise what is left.
 *
 * TOTAL BY CONSTRUCTION. A name that is entirely the server name, entirely
 * verbs, or tokenises to nothing at all returns `other` rather than undefined —
 * there is no code path that produces a tool without a group.
 */
export function rawGroupFor(tool: Pick<CorpusTool, "server" | "name">): string {
	let tokens = tokenize(tool.name);
	if (tokens[0] === tool.server) tokens = tokens.slice(1);
	if (tokens.length === 0) return OTHER_GROUP;
	// A name that is ONE word is a group only if that word is not itself an
	// action: `whoami` is a group, a hypothetical bare `get` is not.
	if (tokens.length === 1) return VERB_PREFIXES.has(tokens[0]) ? OTHER_GROUP : singular(tokens[0]);

	// POSITION decides, not vocabulary, once a verb has been stripped. The first
	// draft re-tested the survivor against the verb list and `get_run` fell into
	// `other` while `list_runs` became `run` — the same concept in two groups,
	// one of them the catch-all, with nothing to show for it. Several words are
	// both ("run", "report", "record", "link", "post"), so a noun test built out
	// of the verb list splits exactly the tools that most deserve a group.
	while (tokens.length > 1 && VERB_PREFIXES.has(tokens[0])) tokens = tokens.slice(1);
	return singular(tokens[0]);
}

export interface Category {
	/** `<server>/<group>`. The stage-1 choice key. */
	key: string;
	server: string;
	group: string;
	members: CorpusTool[];
}

export interface Categorisation {
	categories: Category[];
	/** qualifiedName -> category key. Every corpus tool has an entry. */
	assignment: Map<string, string>;
}

export function categoryKey(server: string, group: string): string {
	return `${server}/${group}`;
}

/**
 * Bucket the corpus.
 *
 * Two passes, because collapsing a small group needs its final size and that is
 * not known while the first tool is being read.
 */
export function categorise(
	tools: readonly CorpusTool[],
	options: { minMembers?: number } = {},
): Categorisation {
	const minMembers = options.minMembers ?? DEFAULT_MIN_MEMBERS;

	const raw = new Map<string, CorpusTool[]>();
	const servers = new Set<string>();
	for (const tool of tools) {
		servers.add(tool.server);
		const key = categoryKey(tool.server, rawGroupFor(tool));
		const bucket = raw.get(key);
		if (bucket) bucket.push(tool);
		else raw.set(key, [tool]);
	}

	const byKey = new Map<string, Category>();
	// The catch-alls FIRST, and unconditionally. An empty `<server>/other` is
	// not waste: it is the guarantee that stage 1 always has somewhere to put a
	// query it cannot place, and that a later corpus change cannot create the
	// first uncategorisable tool.
	for (const server of servers) {
		byKey.set(categoryKey(server, OTHER_GROUP), {
			key: categoryKey(server, OTHER_GROUP),
			server,
			group: OTHER_GROUP,
			members: [],
		});
	}

	const assignment = new Map<string, string>();
	for (const [key, members] of raw) {
		const server = members[0].server;
		const group = key.slice(server.length + 1);
		const target =
			group === OTHER_GROUP || members.length >= minMembers
				? key
				: categoryKey(server, OTHER_GROUP);
		let category = byKey.get(target);
		if (!category) {
			category = { key: target, server, group, members: [] };
			byKey.set(target, category);
		}
		for (const tool of members) {
			category.members.push(tool);
			assignment.set(tool.qualifiedName, target);
		}
	}

	return { categories: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), assignment };
}

/** How many candidate names a category description is worth listing. */
const EXAMPLES_PER_CATEGORY = 6;

/**
 * Stage-1 criteria: one line per category, built from the member NAMES.
 *
 * Names, not descriptions: the descriptions are paragraphs (asfam's especially)
 * and 70 of them would blow the criteria budget many times over. A category is
 * being chosen on what its tools are CALLED, which is also what the lexical
 * ranker weights highest.
 */
export function categoryCriteria(categories: readonly Category[]): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const category of categories) {
		const examples = category.members.slice(0, EXAMPLES_PER_CATEGORY).map((t) => t.name);
		criteria[category.key] =
			examples.length === 0
				? `${category.server}: anything on this server that fits no other group here`
				: `${category.server} · ${category.group}: ${examples.join(", ")}` +
					(category.members.length > examples.length ? `, +${category.members.length - examples.length} more` : "");
	}
	return criteria;
}

/**
 * How many whole-corpus lexical candidates form the floor.
 *
 * THE FRAGILE NUMBER IN THIS FILE. It is 8 because
 * `mcp-common/search.ts:DEFAULT_CANDIDATE_LIMIT` is 8 — the floor has to be the
 * shortlist we are claiming never to do worse than, and a floor of 5 would be a
 * different, weaker claim. Measured on the 635-tool corpus (2026-09-18):
 * "factory settings" -> `hive_get_scheduler_settings` sits at lexical rank
 * SEVEN, one slot inside the floor. (The pilot's 589-tool corpus had it at rank
 * 2; four more `hive_get_factory_*` tools have shipped since.) One more
 * plausible `factory` tool and this benchmark falls off the floor, so the
 * replay prints each query's lexical rank on every run — the day one of them
 * reads 8 is the day to raise this, not the day after.
 */
export const FLOOR_SIZE = 8;

export interface StageTwoOptions {
	/** The option set, floor first, in the order the criteria are built. */
	tools: CorpusTool[];
	/** The floor's qualified names, so a caller can prove the union happened. */
	floor: string[];
	/** True when the budget stopped us adding more category members. */
	truncated: boolean;
}

/**
 * Build stage 2's option set: the floor, then the chosen category's members.
 *
 * ORDER IS LOAD-BEARING. The floor is added FIRST and is never evicted, so when
 * the token budget bites it takes category members and never the lexical
 * shortlist. That is what makes "cannot score below the lexical ranker" a
 * structural property rather than a hope: in the worst case — stage 1 picked
 * the wrong category, or returned nothing at all — stage 2 is still choosing
 * from exactly the eight tools the shipped ranker would have offered.
 *
 * `chosenKey` may be null. A stage 1 that timed out, was rate limited or
 * answered something malformed still gets a stage 2, over the floor alone. The
 * caller records the stage-1 outcome kind separately (`liveness.ts`) so a run
 * that silently degraded to floor-only is visible rather than merely correct.
 */
export function stageTwoOptions(
	corpus: readonly CorpusTool[],
	categorisation: Categorisation,
	chosenKey: string | null,
	query: string,
	options: { floorSize?: number; maxOptions?: number; maxCriteriaTokens?: number } = {},
): StageTwoOptions {
	const floorSize = options.floorSize ?? FLOOR_SIZE;
	const maxOptions = Math.min(options.maxOptions ?? MAX_CHOICE_OPTIONS, MAX_CHOICE_OPTIONS);
	const budget = options.maxCriteriaTokens ?? MAX_CRITERIA_TOKENS;

	const floorTools = rankByAnyToken(corpus, query, floorSize).map((r) => r.tool);
	const chosen = chosenKey === null ? undefined : categorisation.categories.find((c) => c.key === chosenKey);

	// Members ranked against the query so that, when the budget truncates a
	// 90-tool category, what survives is the part of it the query is about.
	const members = chosen ? chosen.members : [];
	const rankedMembers = rankByAnyToken(members, query, members.length).map((r) => r.tool);
	const rankedNames = new Set(rankedMembers.map((t) => t.qualifiedName));
	// rankByAnyToken DROPS zero-match rows. Appending the remainder in stable
	// order keeps the option set a superset of the category, which is the
	// promise stage 1 was answering.
	const ordered = [...rankedMembers, ...members.filter((t) => !rankedNames.has(t.qualifiedName))];

	const tools: CorpusTool[] = [];
	const seen = new Set<string>();
	let truncated = false;
	const push = (tool: CorpusTool, evictable: boolean): boolean => {
		if (seen.has(tool.qualifiedName)) return true;
		const next = [...tools, tool];
		if (evictable && (next.length > maxOptions || estimateTokens(toolCriteria(next)) > budget)) {
			truncated = true;
			return false;
		}
		seen.add(tool.qualifiedName);
		tools.push(tool);
		return true;
	};

	// The floor is pushed non-evictably. If the floor alone exceeded the budget
	// the right answer would be a smaller floor, not a silently dropped one.
	for (const tool of floorTools) push(tool, false);
	for (const tool of ordered) {
		if (!push(tool, true)) break;
	}

	return { tools, floor: floorTools.map((t) => t.qualifiedName), truncated };
}

/** How long a tool description is allowed to be in stage-2 criteria. */
const MAX_DESCRIPTION_CHARS = 160;

/**
 * Stage-2 criteria: qualifiedName -> a one-line description.
 *
 * The key is the QUALIFIED name because that is what `mcp({tool})` resolves —
 * `mcp-common/search.ts` records the same decision and the same reason: naming
 * a tool the way the proxy cannot resolve it hands the agent a call that fails.
 */
export function toolCriteria(tools: readonly CorpusTool[]): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const tool of tools) {
		const text = tool.description.replace(/\s+/g, " ").trim();
		criteria[tool.qualifiedName] =
			text.length === 0
				? tool.name
				: text.length > MAX_DESCRIPTION_CHARS
					? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
					: text;
	}
	return criteria;
}

/** The lexical baseline this router has to beat: `rankByAnyToken`'s top hit. */
export function lexicalTop1(corpus: readonly CorpusTool[], query: string): string | null {
	const [best] = rankByAnyToken(corpus, query, 1);
	return best ? best.tool.qualifiedName : null;
}
