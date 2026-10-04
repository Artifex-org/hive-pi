/**
 * The harness's own MCP tool search, over pi's live registry (HIV-3745).
 *
 * Native MCP registers `mcp__<server>__<tool>`; a call by any other name fails
 * with pi's "Tool X not found". toolhints answers that failure with the
 * closest registered tools, ranked by `rankByAnyToken` over a corpus built
 * from `pi.getAllTools()` at the moment the hint fires.
 *
 * Every fixture description below is verbatim from the real hive server.
 */

import { describe, expect, it } from "vitest";

import { corpusFromRegistry, corpusTool, rankByAnyToken } from "../extensions/mcp-common/search.ts";
import { matchHint, unknownMcpToolAmendment } from "../extensions/toolhints/hints.ts";
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
		expect(names("factory settings")).toContain("mcp__hive__get_scheduler_settings");
		expect(names("find related work canceled task empty log failed run")[0]).toBe("mcp__hive__find_related_work");
	});

	it("reads DESCRIPTIONS, not just names — the fact the old hint denied", () => {
		// `get_metering_usage` has "booster" only in its description. The adapter
		// finds it too; the hint that said otherwise was simply wrong.
		expect(names("booster")).toContain("mcp__hive__get_metering_usage");
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

	it("names the tool the way pi registers it, server included", () => {
		// Printing the bare name would hand the agent a call that fails.
		expect(names("vpm resync")[0]).toBe("mcp__asfam__asfam_qis_vpm_resync");
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

describe("corpusFromRegistry", () => {
	it("keeps only MCP tools and splits server from tool", () => {
		const corpus = corpusFromRegistry([
			{ name: "read" },
			{ name: "codemode" },
			{ name: "mcp__hive__get_run", description: "Get one run" },
			{ name: "mcp__asfam__asfam_qis_status" },
		]);
		expect(corpus.tools.map((t) => [t.server, t.name, t.qualifiedName])).toEqual([
			["hive", "get_run", "mcp__hive__get_run"],
			["asfam", "asfam_qis_status", "mcp__asfam__asfam_qis_status"],
		]);
		expect(Object.keys(corpus.servers)).toEqual(["hive", "asfam"]);
	});
});

describe("the unknown-MCP-tool hint", () => {
	const ctx = { corpus: { tools: FIXTURE, servers: { hive: {}, asfam: {} } } };

	it("fires for a native name and for the adapter's old form", () => {
		expect(matchHint("mcp__hive__get_runs", "Tool mcp__hive__get_runs not found")?.id).toBe("mcp-unknown-tool");
		expect(matchHint("hive_get_run", "Tool hive_get_run not found")?.id).toBe("mcp-unknown-tool");
		expect(matchHint("bash", "Tool bash not found")).toBeNull();
	});

	it("names the closest registered tools, scoped to the server the guess named", () => {
		const text = unknownMcpToolAmendment("Tool mcp__hive__scheduler_settings not found", ctx);
		expect(text).toContain("mcp__hive__get_scheduler_settings");
		expect(text).not.toContain("mcp__asfam__");
	});

	it("maps an adapter-form guess onto native candidates", () => {
		expect(unknownMcpToolAmendment("Tool hive_get_run not found", ctx)).toContain("mcp__hive__get_run");
	});

	it("says nothing extra when there is nothing to add", () => {
		expect(unknownMcpToolAmendment("some other failure", ctx)).toBeNull();
		expect(unknownMcpToolAmendment("Tool mcp__x__y not found", { corpus: null })).toBeNull();
	});
});

describe("the extension end to end", () => {
	it("reads the live registry when a call misses, so a late-connecting server is included", async () => {
		const pi = createFakePi();
		toolhintsExtension(pi.api);
		await pi.emit({ type: "session_start" });
		// Registered AFTER session_start, the way a background MCP connect lands.
		pi.api.registerTool({ name: "mcp__hive__get_scheduler_settings" } as never);
		const [patch] = (await pi.emit({
			type: "tool_result",
			toolName: "mcp__hive__scheduler_settings",
			isError: true,
			content: [{ type: "text", text: "Tool mcp__hive__scheduler_settings not found" }],
		})) as ({ content?: { text: string }[] } | undefined)[];
		const text = patch?.content?.[0].text ?? "";
		expect(text.startsWith("Tool mcp__hive__scheduler_settings not found")).toBe(true);
		expect(text).toContain("mcp__hive__get_scheduler_settings");
	});

	it("leaves a successful result alone", async () => {
		const pi = createFakePi();
		toolhintsExtension(pi.api);
		const [patch] = await pi.emit({
			type: "tool_result",
			toolName: "mcp__hive__get_run",
			isError: false,
			content: [{ type: "text", text: "Tool x not found" }],
		});
		expect(patch).toBeUndefined();
	});
});
