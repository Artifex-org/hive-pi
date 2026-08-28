/**
 * `mcp({search})` says "No tools matching" for tools that exist — and the two
 * reasons it says that need opposite answers.
 *
 * The adapter's scorer is pinned third-party code we cannot edit, so what is
 * under test here is the harness's own repair: rank the SAME corpus with OR
 * semantics, and put the candidates — or the reason the server was never in
 * the corpus — into the failing tool result.
 *
 * Every fixture description below is verbatim from the real
 * `~/.pi/agent/mcp-cache.json` (2026-08-28), because the defect is about how
 * real descriptions tokenize. Invented prose would rank differently and prove
 * nothing about the queries that actually failed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	corpusTool,
	loadToolCorpus,
	MCP_CACHE_MAX_AGE_MS,
	rankByAnyToken,
} from "../extensions/mcp-common/search.ts";
import { HINTS, matchHint, mcpMissAmendment, renderHint } from "../extensions/toolhints/hints.ts";
import toolhintsExtension from "../extensions/toolhints/index.ts";
import { createFakePi } from "./fake-pi.ts";

const HIVE_TOOLS = [
	{
		name: "get_scheduler_settings",
		description:
			"Read the DB-backed scheduler tuning overrides: run_wip (per-project started-run caps), run_wip_spill (+margin), run_sla_secs (run-latency target feeding hive_run_sla_breach_total) and adaptive_ordering. null/absent fields mean NO override — the server's env config applies (precedence: these settings > env > compiled default).",
	},
	{
		name: "set_scheduler_settings",
		description:
			"Update the DB-backed scheduler tuning overrides (admin scope). PARTIAL update: only the fields you pass change; list a field in `clear` to drop its override back to the server's env config.",
	},
	{
		name: "find_related_work",
		description:
			"Advisory-only hybrid retrieval over explicitly named knowledge collections, capped at five hits. Use `{tenant-slug}-{team-key}-linear` (for example `artifex-hiv-linear`) to find related synced tickets after naming that collection, or memory collections for prior lessons. Results can inform coordination but can never claim, refuse, dispatch, or suppress work; exact work-unit ownership remains authoritative.",
	},
	{
		name: "get_run",
		description:
			"Get one run with its task DAG (states, deps, errors). Use this to inspect progress or the shape of a run. Accepts the run's UUID or its run NUMBER (the #N shown in the UI and in failure notifications); add project/pipeline if a number is ambiguous.",
	},
	{
		name: "list_agent_sessions",
		description:
			"Your workstation coding-agent sessions, newest first: live state, turns, cost, repo, and — the field worth scanning — whether each one ATTACHED a conversation. A session that never attached reports counters but has no transcript and cannot be steered.",
	},
	{
		name: "get_queue_wait",
		description:
			"Per-cluster ready→dispatch queue-wait percentiles bucketed over time (mirrors GET /stats/queue-wait). High queue-wait = capacity pressure.",
	},
	{ name: "get_metering_usage", description: "Metered usage rollups, including booster-pack consumption." },
];

const ASFAM_TOOLS = [
	{
		name: "asfam_qis_vpm_resync",
		description:
			"OPERATIONAL ESCAPE HATCH (admin-only): force-resync QIS virtual positions for a strategy to match exchange actuals. Calls both QIS pods (SG + DE) and aggregates results.",
	},
	{ name: "asfam_qis_status", description: "QIS Meta Trader pod health: mode, uptime, DB connection status" },
];

const FIXTURE = [
	...HIVE_TOOLS.map((t) => corpusTool({ server: "hive", ...t })),
	...ASFAM_TOOLS.map((t) => corpusTool({ server: "asfam", ...t })),
];

const names = (query: string, limit?: number) =>
	rankByAnyToken(FIXTURE, query, limit).map((r) => r.tool.qualifiedName);

describe("rankByAnyToken — the adapter's ranking without its coverage gate", () => {
	// THE DEFECT, in one assertion. The live adapter returns ZERO rows for both
	// of these against the real 589-tool corpus: "factory settings" is a
	// two-token query, so its gate demands coverage 1 and no tool's text carries
	// "factory"; the long one lands under 0.6. Neither is a missing tool.
	it("ranks a description-only match above nothing", () => {
		expect(names("factory settings")).toContain("hive_get_scheduler_settings");
		expect(names("find related work canceled task empty log failed run")[0]).toBe("hive_find_related_work");
	});

	it("reads DESCRIPTIONS, not just names — the fact the old hint denied", () => {
		// `get_metering_usage` has "booster" only in its description. The adapter
		// finds it too; the hint that said otherwise was simply wrong.
		expect(names("booster")).toContain("hive_get_metering_usage");
	});

	it("still puts the best-covered tool first — OR is not a flat list", () => {
		const ranked = rankByAnyToken(FIXTURE, "scheduler settings");
		expect(ranked[0].tool.name).toMatch(/scheduler_settings$/);
		expect(ranked[0].coverage).toBe(1);
		expect(ranked[0].score).toBeGreaterThan(ranked[ranked.length - 1].score);
	});

	it("counts DISTINCT query tokens, so a repeated word can still reach full coverage", () => {
		// The adapter divides a Set of matched tokens by `queryTokens.length`,
		// which counts duplicates — coverage 1 is unreachable for a query that
		// says the same word twice, for a reason nothing in the query explains.
		const [top] = rankByAnyToken(FIXTURE, "run run run");
		expect(top.coverage).toBe(1);
	});

	it("names the tool the way the proxy resolves it, prefix included", () => {
		// `findToolByName` matches the REGISTERED name. Printing the bare name
		// would hand the agent a call that fails — the same class of defect as
		// the hint this replaces.
		expect(names("vpm resync")[0]).toBe("asfam_asfam_qis_vpm_resync");
	});

	it("is silent rather than noisy: no query tokens, no candidates", () => {
		expect(rankByAnyToken(FIXTURE, "   ")).toEqual([]);
		expect(rankByAnyToken([], "anything")).toEqual([]);
		expect(names("zzzqqq")).toEqual([]);
	});

	it("honours the limit — a hint is a shortlist, not a catalogue", () => {
		expect(names("run", 3).length).toBeLessThanOrEqual(3);
	});
});

describe("loadToolCorpus", () => {
	const dirs: string[] = [];
	function tmp(contents: string | null): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corpus-"));
		dirs.push(dir);
		const file = path.join(dir, "mcp-cache.json");
		if (contents !== null) fs.writeFileSync(file, contents);
		return file;
	}
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reads the adapter's cache, keeping each server's cachedAt", () => {
		const cachePath = tmp(
			JSON.stringify({
				version: 1,
				servers: { hive: { cachedAt: 1234, tools: [{ name: "get_run", description: "one run" }] } },
			}),
		);
		const corpus = loadToolCorpus({ cachePath, configPath: path.join(path.dirname(cachePath), "nope.json") });
		expect(corpus.tools.map((t) => t.qualifiedName)).toEqual(["hive_get_run"]);
		expect(corpus.servers.hive.cachedAt).toBe(1234);
		expect(corpus.configMtimeMs).toBeNull();
	});

	// DELIBERATE: the TTL is exactly why the adapter cannot see these tools, so
	// honouring it here would remove the only copy of the answer.
	it("keeps a server the adapter has expired — that is the point", () => {
		const cachePath = tmp(
			JSON.stringify({
				servers: {
					asfam: { cachedAt: Date.now() - MCP_CACHE_MAX_AGE_MS - 1, tools: [{ name: "asfam_qis_status" }] },
				},
			}),
		);
		expect(loadToolCorpus({ cachePath }).tools).toHaveLength(1);
	});

	it("never throws — a missing or malformed cache is an empty corpus", () => {
		expect(loadToolCorpus({ cachePath: "/nonexistent/mcp-cache.json" }).tools).toEqual([]);
		expect(loadToolCorpus({ cachePath: tmp("{ not json") }).tools).toEqual([]);
		expect(loadToolCorpus({ cachePath: tmp(JSON.stringify({ servers: { x: { tools: "nope" } } })) }).tools).toEqual([]);
	});
});

describe("the hint a miss now carries", () => {
	const ctx = (now = Date.now()) => ({
		corpus: { tools: FIXTURE, servers: { hive: { cachedAt: now }, asfam: { cachedAt: now } }, configMtimeMs: null },
		now,
	});

	it("matches the SERVERLESS miss form, which most searches produce", () => {
		// `proxy-modes.ts:528` emits the ` in "<server>"` suffix only for a scoped
		// search. The first pattern required it, so an unscoped miss — the common
		// case — got no hint at all.
		expect(matchHint("mcp", 'No tools matching "factory settings"')?.id).toBe("mcp-proxy-no-match");
		expect(matchHint("mcp", 'No tools matching "factory settings" in "hive"')?.id).toBe("mcp-proxy-no-match");
	});

	it("names the candidates instead of telling the agent to guess again", () => {
		const text = mcpMissAmendment('No tools matching "factory settings" in "hive"', ctx());
		expect(text).toContain("hive_get_scheduler_settings");
		expect(text).toContain('mcp({tool:');
	});

	it("scopes candidates to the server the search named", () => {
		const text = mcpMissAmendment('No tools matching "status" in "asfam"', ctx());
		expect(text).toContain("asfam_asfam_qis_status");
		expect(text).not.toContain("hive_");
	});

	it("reports a stale server as stale, not as no-such-tool", () => {
		const now = Date.now();
		const stale = {
			corpus: {
				tools: FIXTURE,
				servers: { hive: { cachedAt: now }, asfam: { cachedAt: now - 8 * 24 * 60 * 60 * 1_000 } },
				configMtimeMs: null,
			},
			now,
		};
		const text = mcpMissAmendment('No tools matching "vpm_resync" in "asfam"', stale);
		expect(text).toContain("TTL");
		expect(text).toContain('mcp({connect:"asfam"})');
		// And it must STILL name the tool: the cache holds it, the adapter just
		// stopped reading the entry.
		expect(text).toContain("asfam_qis_vpm_resync");
	});

	it("says nothing extra when there is nothing to add", () => {
		expect(mcpMissAmendment("some other failure", ctx())).toBeNull();
		expect(mcpMissAmendment('No tools matching "x"', { corpus: null })).toBeNull();
	});
});

describe("the extension end to end", () => {
	const dirs: string[] = [];
	const saved = { cache: process.env.PI_MCP_CACHE, config: process.env.PI_MCP_CONFIG };

	function writeCache(servers: Record<string, unknown>): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolhints-"));
		dirs.push(dir);
		const file = path.join(dir, "mcp-cache.json");
		fs.writeFileSync(file, JSON.stringify({ version: 1, servers }));
		return file;
	}

	async function run(cachePath: string, missText: string) {
		process.env.PI_MCP_CACHE = cachePath;
		// A path that does not exist: the mtime seam must not reach the real
		// machine's mcp.json, or the assertion would depend on this box.
		process.env.PI_MCP_CONFIG = path.join(os.tmpdir(), "pi-toolhints-absent.json");
		const pi = createFakePi();
		toolhintsExtension(pi.api);
		await pi.emit({ type: "session_start" });
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "mcp",
			isError: false,
			content: [{ type: "text", text: missText }],
		})) as ({ content?: { text: string }[] } | undefined)[];
		return patch?.content?.[0].text ?? "";
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
		if (saved.cache === undefined) delete process.env.PI_MCP_CACHE;
		else process.env.PI_MCP_CACHE = saved.cache;
		if (saved.config === undefined) delete process.env.PI_MCP_CONFIG;
		else process.env.PI_MCP_CONFIG = saved.config;
	});

	it("a search miss comes back naming the tools the search should have found", async () => {
		const cache = writeCache({ hive: { cachedAt: Date.now(), tools: HIVE_TOOLS } });
		const text = await run(cache, 'No tools matching "factory settings" in "hive"');
		expect(text).toContain('No tools matching "factory settings" in "hive"');
		expect(text).toContain("hive_get_scheduler_settings");
	});

	it("a miss on a server past the TTL says connect, and still names the tool", async () => {
		const cache = writeCache({
			asfam: { cachedAt: Date.now() - 9 * 24 * 60 * 60 * 1_000, tools: ASFAM_TOOLS },
		});
		const text = await run(cache, 'No tools matching "vpm_resync" in "asfam"');
		expect(text).toContain("TTL");
		expect(text).toContain('mcp({connect:"asfam"})');
		expect(text).toContain("asfam_qis_vpm_resync");
	});

	// NEGATIVE CONTROL. With no cache to read there is nothing to add, and the
	// handler must degrade to exactly today's behaviour rather than throw inside
	// the agent loop. (The STATIC hint is still appended — that is the whole
	// point of the table — so the claim under test is "original text preserved,
	// no invented candidates, no throw", not "byte-identical output".)
	it("survives a cache that is not there, with no candidates and no throw", async () => {
		const missing = path.join(os.tmpdir(), "pi-toolhints-no-such-cache.json");
		const text = await run(missing, 'No tools matching "factory settings" in "hive"');
		expect(text.startsWith('No tools matching "factory settings" in "hive"')).toBe(true);
		expect(text).toContain("mcp-proxy-no-match");
		expect(text).not.toContain("Closest in the harness's copy");
	});

	it("reads the corpus at session start, never inside the tool_result handler", async () => {
		// The handler runs inside the agent loop; the header of index.ts promises
		// no fs there. Deleting the cache AFTER session_start must not change the
		// hint — if it did, the read had moved into the loop.
		const cache = writeCache({ hive: { cachedAt: Date.now(), tools: HIVE_TOOLS } });
		process.env.PI_MCP_CACHE = cache;
		process.env.PI_MCP_CONFIG = path.join(os.tmpdir(), "pi-toolhints-absent.json");
		const pi = createFakePi();
		toolhintsExtension(pi.api);
		await pi.emit({ type: "session_start" });
		fs.rmSync(cache);
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "mcp",
			isError: false,
			content: [{ type: "text", text: 'No tools matching "factory settings" in "hive"' }],
		})) as ({ content?: { text: string }[] } | undefined)[];
		expect(patch?.content?.[0].text).toContain("hive_get_scheduler_settings");
	});
});

describe("the replaced hint", () => {
	const hint = HINTS.find((h) => h.id === "mcp-proxy-no-match")!;

	// P0175 and P0556 both record an agent noticing that this sentence
	// contradicted the adapter's own tool description, and spending turns on it.
	it("no longer claims the search ignores descriptions", () => {
		expect(renderHint(hint)).not.toMatch(/not a description/);
		expect(hint.hint).toMatch(/names AND descriptions/);
	});

	it("still names the direct tools, which remove the search entirely", () => {
		expect(hint.hint).toContain("hive_wait_for_run");
	});
});
