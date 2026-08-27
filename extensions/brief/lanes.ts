import { collectionsFor } from "../profile-common/profile.ts";
/**
 * brief — the retrieval lanes, and how their drafts become one (HIV-1804).
 *
 * HIV-1798 shipped ONE worker doing repo grep, then knowledge search, then a
 * Linear read, in that order, against a 120s wall. Two real passes measured
 * 72.5s and 49.5s — and because the automatic path blocks the session's first
 * turn by design, that number is not a background cost, it is the operator
 * waiting. A sequential pass pays for every source it consults even though the
 * sources have nothing to say to each other.
 *
 * So they run concurrently and their drafts merge here. Three consequences, all
 * of them the point:
 *
 *  1. Wall-clock is the SLOWEST lane, not the sum.
 *  2. A lane that dies takes only its own findings with it. The old shape had
 *     no partial credit: a Linear timeout at the end cost the repo facts that
 *     had already been established.
 *  3. Each lane gets the whole budget of attention for one source, and a
 *     narrower tool set, which is what a cheap model is actually good at.
 *
 * WHY MERGING IS ITS OWN FILE. Interleaving is the part that decides what the
 * expensive model reads, and getting it wrong is invisible: concatenating lanes
 * would let a chatty knowledge lane fill `facts` to the cap before the repo
 * lane's `file:line` evidence is ever considered, and the brief would still
 * look complete. Pure functions, tested directly.
 */

import type { AgentConfig } from "../harness/roles.ts";
import { MAX_FACTS, MAX_MOVES, MAX_REFS, MAX_START_HERE, MAX_UNKNOWNS, type BriefDraft, type BriefRef } from "./compile.ts";

export const LANES = ["repo", "knowledge", "ticket"] as const;
export type BriefLane = (typeof LANES)[number];

/** Knowledge-brain tools, by the prefix the Hive MCP gives all of them. */
const KNOWLEDGE_PREFIX = "knowledge_";

/**
 * Which knowledge collections a checkout's task should be searched against.
 *
 * The lane used to search everything the credential can see, which is not a
 * neutral default — it is a bias toward whichever corpus is largest. A task in
 * one product's checkout would surface another product's documents, and the
 * operator's complaint that started HIV-2530 was exactly that: "the brief is
 * preparing things that are not actually required for the project we started
 * the agent in".
 *
 * The mapping is the house profile's (`profile-common/profile.ts`). Its default
 * collections are in every list on purpose — that is where infrastructure,
 * workstation and CI knowledge lives, and it is relevant to work in any
 * repository. What the mapping removes is the OTHER project's corpus, which
 * never is.
 *
 * An unmapped checkout falls back to the defaults alone rather than to
 * "everything": a repo nobody has classified is far more likely to be helped by
 * general infrastructure notes than by another product's documentation.
 *
 * With NO profile this returns an empty list, and the caller searches without a
 * collection filter — the pre-HIV-2530 behaviour, which is correct for a
 * machine whose corpus nobody has described.
 */
export function knowledgeCollections(cwd: string): string[] {
	return collectionsFor(cwd);
}

/**
 * Which lanes are worth spawning for this task.
 *
 * `repo` and `knowledge` always run: both are cheap, and "there was nothing in
 * the repo about this" is itself worth knowing. `ticket` runs only when the
 * prompt names a key — the same condition that already gated the `mcp` grant,
 * because an adapter that will not be called is pure startup latency.
 */
export function planLanes(ticketKeys: string[]): BriefLane[] {
	const lanes: BriefLane[] = ["repo", "knowledge"];
	if (ticketKeys.length > 0) lanes.push("ticket");
	return lanes;
}

/**
 * The tools one lane may use.
 *
 * Derived by PARTITIONING the role's own declared set rather than hardcoding
 * tool names here, so `agents/briefer.md` stays the one place the briefer's
 * capabilities are stated. A lane whose partition is empty is not spawned —
 * see `laneIsRunnable`.
 */
export function laneTools(role: AgentConfig, lane: BriefLane): string[] {
	const declared = role.tools ?? [];
	switch (lane) {
		case "repo":
			return declared.filter((t) => !t.startsWith(KNOWLEDGE_PREFIX) && t !== "mcp");
		case "knowledge":
			return declared.filter((t) => t.startsWith(KNOWLEDGE_PREFIX));
		case "ticket":
			// `mcp` is granted to this lane and this lane only. It is the one tool
			// that reaches off the machine, and confining it to the lane whose
			// entire job is a ticket read keeps that reach auditable.
			return ["mcp"];
	}
}

/** A lane with no tools cannot retrieve anything — spawning it burns a model call for nothing. */
export function laneIsRunnable(role: AgentConfig, lane: BriefLane): boolean {
	return laneTools(role, lane).length > 0;
}

/**
 * What each lane is told it is.
 *
 * Stated as a boundary rather than a preference ("do not", not "prefer not")
 * because a cheap model handed a broad instruction will reach for whatever tool
 * it has, and two lanes doing the same grep is the failure that makes the
 * fan-out cost more than the sequential pass it replaced.
 */
export function laneInstruction(lane: BriefLane, ticketKeys: string[], cwd = ""): string {
	switch (lane) {
		case "repo":
			return [
				"You are the REPO lane. Work ONLY from the working tree: grep, find and read.",
				"Do not search the knowledge base and do not fetch tickets — other lanes are doing that",
				"concurrently, and duplicated findings are discarded.",
				"",
				"You are also the lane that owns `goal`. The other lanes leave it empty.",
			].join("\n");
		case "knowledge": {
			// No configured collections → no scoping paragraph. `Pass collections: []`
			// would be a literal instruction to search nothing, which is worse than
			// the unscoped search this scoping exists to narrow.
			const collections = knowledgeCollections(cwd);
			const scope = collections.length
				? [
						`Pass collections: ${JSON.stringify(collections)} on every search. These are`,
						"the collections for THIS checkout. Searching unscoped pulls in other projects' corpora,",
						"which is slower and returns documents that cannot apply to this task.",
						"",
					]
				: [];
			return [
				"You are the KNOWLEDGE lane. Work ONLY through the `knowledge_*` tools over the",
				"knowledge base. Do not grep the repository — the repo lane is doing that concurrently.",
				"",
				...scope,
				"Use FEW terms per search: the index is AND-semantics, so a long query returns nothing.",
				"Put what you find under `refs` (document path + what it covers) and, where a document",
				"states something specific and checkable, under `facts`. Leave `goal` empty.",
			].join("\n");
		}
		case "ticket":
			return [
				`You are the TICKET lane. Fetch each of ${ticketKeys.join(", ")} with the \`mcp\` tool`,
				"(`mcp__linear__get_issue`) and nothing else.",
				"",
				"Fold the title, the state and the parts of the description that CONSTRAIN the work into",
				"`facts`, each referenced by its ticket key. Do not restate the whole ticket, and do not",
				"turn its wish-list into requirements. Leave `goal` empty.",
			].join("\n");
	}
}

export interface LaneDraft {
	lane: BriefLane;
	draft: BriefDraft;
}

/**
 * Lane precedence per section — which lane's entries are offered first when the
 * cap binds.
 *
 * Not one global order, because "most trustworthy" differs by section. A repo
 * `file:line` outranks a KB summary as a FACT; the KB outranks everything under
 * `refs`, where its whole job is external pointers. The ticket lane sits above
 * knowledge for facts because a ticket states a constraint the code cannot.
 */
const PRECEDENCE: Record<keyof MergedSections, BriefLane[]> = {
	facts: ["repo", "ticket", "knowledge"],
	startHere: ["repo", "knowledge", "ticket"],
	refs: ["knowledge", "ticket", "repo"],
	unknowns: ["ticket", "repo", "knowledge"],
	nextMoves: ["repo", "knowledge", "ticket"],
};

interface MergedSections {
	facts: unknown;
	startHere: unknown;
	refs: unknown;
	unknowns: unknown;
	nextMoves: unknown;
}

/**
 * Fold every lane's draft into one.
 *
 * ROUND-ROBIN, not concatenation. Taking one entry from each lane in turn means
 * a lane that returned twelve findings cannot crowd out a lane that returned
 * two — the cap falls on the tail of the chatty lane instead of on the whole of
 * the quiet one. Ordering within a lane is preserved, because the role prompt
 * asks for most-useful-first and that is information.
 */
export function mergeDrafts(lanes: LaneDraft[]): BriefDraft {
	const byLane = new Map<BriefLane, BriefDraft>();
	for (const entry of lanes) byLane.set(entry.lane, entry.draft);

	const pick = <T>(section: keyof MergedSections, read: (d: BriefDraft) => T[]): T[][] =>
		PRECEDENCE[section].map((lane) => {
			const draft = byLane.get(lane);
			return draft ? read(draft) : [];
		});

	return {
		// The repo lane owns the goal and the others are told to leave it empty;
		// falling back to any lane that filled it anyway is deliberate, because an
		// empty goal costs the brief its only restatement of intent.
		goal: byLane.get("repo")?.goal?.trim() || lanes.map((l) => l.draft.goal.trim()).find(Boolean) || "",
		facts: interleaveRefs(pick("facts", (d) => d.facts), MAX_FACTS),
		startHere: interleaveBy(
			pick("startHere", (d) => d.startHere),
			(c) => normalizeRef(c.ref),
			MAX_START_HERE,
		),
		refs: interleaveRefs(pick("refs", (d) => d.refs), MAX_REFS),
		unknowns: interleaveBy(pick("unknowns", (d) => d.unknowns), normalizeText, MAX_UNKNOWNS),
		nextMoves: interleaveBy(pick("nextMoves", (d) => d.nextMoves), normalizeText, MAX_MOVES),
		// Never a lane's to fill: history is measured locally from git, and a
		// model asked for it would produce plausible commit hashes.
		history: [],
	};
}

function interleaveRefs(lists: BriefRef[][], max: number): BriefRef[] {
	return interleaveBy(lists, (r) => normalizeRef(r.ref), max);
}

/**
 * One entry from each list in turn, first-seen winning any duplicate.
 *
 * First-seen matters: the lists arrive in precedence order, so the surviving
 * copy of a duplicated ref is the one from the lane whose account of it we
 * trust most — a repo `file.ts:88` beats a KB document mentioning `file.ts`.
 */
export function interleaveBy<T>(lists: T[][], key: (item: T) => string, max: number): T[] {
	const out: T[] = [];
	const seen = new Set<string>();
	const depth = Math.max(0, ...lists.map((l) => l.length));
	for (let i = 0; i < depth; i++) {
		for (const list of lists) {
			const item = list[i];
			if (item === undefined) continue;
			const k = key(item);
			if (!k || seen.has(k)) continue;
			seen.add(k);
			out.push(item);
			if (out.length >= max) return out;
		}
	}
	return out;
}

/**
 * `internal/place.go:88` and `./internal/place.go:88` are the same file, and two
 * lanes will spell it both ways. Line numbers are kept: the same file at two
 * lines is two facts.
 */
export function normalizeRef(ref: string): string {
	// Backticks come off FIRST. A model that quotes its refs writes
	// `` `./place.go` ``, and stripping the prefix before the quote leaves the
	// `./` in place — so the two spellings of one file stay two entries and the
	// dedupe silently does nothing. Caught by its own test, which is the only
	// way this class of bug is ever caught.
	return ref.trim().replace(/^`+|`+$/g, "").replace(/^\.\//, "").trim().toLowerCase();
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}
