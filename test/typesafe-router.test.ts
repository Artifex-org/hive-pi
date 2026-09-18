/**
 * typesafe-common/router — categorisation and the structural floor.
 *
 * Two properties are under test and neither is a preference:
 *
 *  1. **No tool is uncategorised.** A tool that fell out of every category is a
 *     tool stage 1 can never route to and stage 2 can never offer — invisible,
 *     with no error anywhere. So "unassigned" is a TEST FAILURE here, asserted
 *     by summing membership against the corpus size rather than by spot checks.
 *  2. **The floor unions the lexical top 8.** This is what makes the router
 *     structurally incapable of scoring below the shortlist it replaces. In a
 *     measured pilot the plain hierarchy missed BOTH of this repo's recorded
 *     benchmark queries (`test/mcp-search-fallback.test.ts:89-90`); the strong
 *     form of the test below — expected ∈ options(c) for EVERY category c —
 *     fails for both of them if the union is removed.
 *
 * The corpus is a fixture, deliberately. Running these against
 * `~/.pi/agent/mcp-cache.json` would pass vacuously on any machine that has no
 * MCP cache — a test that passes for the wrong reason, which is the exact trap
 * `compaction/index.ts:wireCompaction` documents.
 */

import { describe, expect, it } from "vitest";

import { corpusTool, rankByAnyToken, type CorpusTool, type McpToolCorpus } from "../extensions/mcp-common/search.ts";
import { MAX_CHOICE_OPTIONS } from "../extensions/typesafe-common/client.ts";
import {
	FLOOR_SIZE,
	OTHER_GROUP,
	categorise,
	categoryCriteria,
	rawGroupFor,
	stageTwoOptions,
	toolCriteria,
} from "../extensions/typesafe-common/router.ts";
import { floorCoverage, parseLabels, resolveLabels, summarise } from "../extensions/typesafe-common/replay.ts";

/**
 * Verbatim descriptions from the real cache, via `test/mcp-search-fallback.test.ts`.
 * Invented prose tokenizes differently and would prove nothing about the
 * queries that actually failed — the same reason that file gives.
 */
const HIVE = [
	{
		name: "get_scheduler_settings",
		description:
			"Read the DB-backed scheduler tuning overrides: run_wip (per-project started-run caps), run_wip_spill (+margin), run_sla_secs (run-latency target feeding hive_run_sla_breach_total) and adaptive_ordering.",
	},
	{
		name: "set_scheduler_settings",
		description: "Update the DB-backed scheduler tuning overrides (admin scope). PARTIAL update.",
	},
	{
		name: "find_related_work",
		description:
			"Advisory-only hybrid retrieval over explicitly named knowledge collections, capped at five hits. Results can inform coordination but can never claim, refuse, dispatch, or suppress work.",
	},
	{ name: "get_run", description: "Get one run with its task DAG (states, deps, errors)." },
	{ name: "list_runs", description: "List runs, filtered by project, status, pipeline, branch, sha, pr or author." },
	{ name: "retry_run", description: "Retry a failed run from its first failing task." },
	{ name: "cancel_run", description: "Cancel a queued or running run." },
	{ name: "get_factory_evals", description: "Factory eval scores per model tier." },
	{ name: "get_factory_experiments", description: "Factory experiments and their arms." },
	{ name: "get_factory_spend", description: "Factory spend rollups by project and tier." },
	{ name: "get_metering_usage", description: "Metered usage rollups, including booster-pack consumption." },
	{ name: "whoami", description: "The identity this token carries." },
];

const ASFAM = [
	{
		name: "asfam_qis_vpm_resync",
		description: "OPERATIONAL ESCAPE HATCH (admin-only): force-resync QIS virtual positions for a strategy.",
	},
	{ name: "asfam_qis_status", description: "QIS Meta Trader pod health: mode, uptime, DB connection status" },
	{ name: "asfam_qis_netting", description: "QIS netting across strategies." },
	{ name: "asfam_qis_slippage", description: "QIS slippage by venue." },
	{ name: "asfam_bbg_price", description: "Bloomberg last price for a security." },
];

function corpus(): McpToolCorpus {
	const tools = [
		...HIVE.map((t) => corpusTool({ server: "hive", ...t })),
		...ASFAM.map((t) => corpusTool({ server: "asfam", ...t })),
	];
	return { tools, servers: { hive: {}, asfam: {} }, configMtimeMs: null };
}

describe("categorisation — an unassigned tool is a build error", () => {
	const c = corpus();

	it("assigns EVERY corpus tool; membership sums to the corpus size", () => {
		// The only formulation that catches a silent exclusion. A spot check
		// cannot: the tool that fell out is by definition the one nobody
		// thought to look for.
		const cat = categorise(c.tools, { minMembers: 2 });
		const members = cat.categories.reduce((sum, category) => sum + category.members.length, 0);
		expect(members).toBe(c.tools.length);
		expect(cat.assignment.size).toBe(c.tools.length);
		for (const tool of c.tools) {
			const key = cat.assignment.get(tool.qualifiedName);
			expect(key, `${tool.qualifiedName} is unassigned`).toBeTruthy();
			expect(cat.categories.some((category) => category.key === key)).toBe(true);
		}
	});

	it("keys every category structurally as <server>/<group>", () => {
		const cat = categorise(c.tools, { minMembers: 2 });
		for (const category of cat.categories) {
			expect(category.key).toBe(`${category.server}/${category.group}`);
			expect(category.key.split("/")).toHaveLength(2);
		}
	});

	it("creates <server>/other for EVERY server, even when nothing lands in it", () => {
		// Unconditional, because it is the guarantee that stage 1 always has
		// somewhere to put a query — not an artefact of this corpus.
		const cat = categorise(c.tools, { minMembers: 1 });
		for (const server of ["hive", "asfam"]) {
			const other = cat.categories.find((category) => category.key === `${server}/${OTHER_GROUP}`);
			expect(other, `${server}/${OTHER_GROUP} is missing`).toBeDefined();
		}
	});

	it("collapses a group smaller than minMembers into the catch-all rather than dropping it", () => {
		const cat = categorise(c.tools, { minMembers: 3 });
		// `asfam_bbg_price` is the only bbg tool; it must still be reachable.
		const key = cat.assignment.get("asfam_asfam_bbg_price");
		expect(key).toBe(`asfam/${OTHER_GROUP}`);
		const other = cat.categories.find((category) => category.key === key);
		expect(other?.members.map((t) => t.name)).toContain("asfam_bbg_price");
	});

	it("is total on pathological names — verbs only, server-only, punctuation only", () => {
		// Each of these is a name that a "take the noun" rule could plausibly
		// return undefined for. None may.
		const weird = [
			corpusTool({ server: "hive", name: "get" }),
			corpusTool({ server: "hive", name: "hive" }),
			corpusTool({ server: "hive", name: "___" }),
			corpusTool({ server: "hive", name: "list_get_set" }),
		];
		for (const tool of weird) expect(rawGroupFor(tool)).toBeTruthy();
		const cat = categorise(weird, { minMembers: 2 });
		expect(cat.assignment.size).toBe(weird.length);
		for (const tool of weird) expect(cat.assignment.get(tool.qualifiedName)).toBe(`hive/${OTHER_GROUP}`);
	});

	it("strips leading verbs so the group is the NOUN a query can select on", () => {
		expect(rawGroupFor({ server: "hive", name: "get_scheduler_settings" })).toBe("scheduler");
		expect(rawGroupFor({ server: "hive", name: "list_runs" })).toBe("run");
		expect(rawGroupFor({ server: "hive", name: "get_run" })).toBe("run");
		// REGRESSION: "run" is both a verb and a noun. A first draft re-tested
		// the survivor against the verb list, so `get_run` landed in the
		// catch-all while `list_runs` became `run` — one concept, two groups,
		// one of them `other`. Position decides once a verb has been stripped.
		expect(rawGroupFor({ server: "hive", name: "get_run" })).toBe(
			rawGroupFor({ server: "hive", name: "list_runs" }),
		);
		expect(rawGroupFor({ server: "hive", name: "get_report" })).toBe("report");
		// The server prefix a tool repeats in its own name is not a group.
		expect(rawGroupFor({ server: "asfam", name: "asfam_qis_status" })).toBe("qis");
		// A single word that is not an action IS a group.
		expect(rawGroupFor({ server: "hive", name: "whoami" })).toBe("whoami");
	});

	it("stage-1 criteria stay inside the choice cap", () => {
		const cat = categorise(c.tools, { minMembers: 2 });
		expect(Object.keys(categoryCriteria(cat.categories)).length).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS);
	});
});

describe("the structural floor", () => {
	const c = corpus();
	const cat = categorise(c.tools, { minMembers: 2 });

	it("unions the lexical top 8 into stage 2 — the option set contains tools NOT in the chosen category", () => {
		// The literal claim, asserted directly: pick a category the query is not
		// about, and the lexical shortlist must still be on the ballot.
		const query = "factory settings";
		const chosen = "asfam/qis";
		const options = stageTwoOptions(c.tools, cat, chosen, query);
		const outsiders = options.tools.filter((t) => cat.assignment.get(t.qualifiedName) !== chosen);
		expect(outsiders.length).toBeGreaterThan(0);
		// And specifically the lexical top 8, not merely "some outsider".
		const lexical = rankByAnyToken(c.tools, query, FLOOR_SIZE).map((r) => r.tool.qualifiedName);
		expect(lexical.length).toBeGreaterThan(0);
		for (const name of lexical) {
			expect(options.tools.map((t) => t.qualifiedName)).toContain(name);
		}
		expect(options.floor).toEqual(lexical);
	});

	it("puts BOTH recorded benchmark answers on the ballot for EVERY category", () => {
		// This is the measured pilot failure, turned into a guard. Remove the
		// union from stageTwoOptions and this dies for both queries.
		const benchmarks: [string, string][] = [
			["factory settings", "hive_get_scheduler_settings"],
			["find related work canceled task empty log failed run", "hive_find_related_work"],
		];
		for (const [query, expected] of benchmarks) {
			for (const category of cat.categories) {
				const options = stageTwoOptions(c.tools, cat, category.key, query);
				expect(
					options.tools.map((t) => t.qualifiedName),
					`"${query}" is not on the ballot when stage 1 picks ${category.key}`,
				).toContain(expected);
			}
		}
	});

	it("survives stage 1 answering nothing: a null category is the floor alone", () => {
		const options = stageTwoOptions(c.tools, cat, null, "factory settings");
		expect(options.tools.map((t) => t.qualifiedName)).toEqual(options.floor);
		expect(options.tools).toContain(
			c.tools.find((t) => t.qualifiedName === "hive_get_scheduler_settings"),
		);
	});

	it("survives stage 1 naming a category that does not exist", () => {
		// A choice outside the criteria is malformed at the client, but the
		// router must not crash if one ever reaches here.
		const options = stageTwoOptions(c.tools, cat, "hive/does-not-exist", "factory settings");
		expect(options.tools.map((t) => t.qualifiedName)).toEqual(options.floor);
	});

	it("never evicts the floor to make room for category members", () => {
		// ORDER IS LOAD-BEARING. Under a budget too small for the category, what
		// is dropped must be members and never the lexical shortlist — otherwise
		// "cannot score below the ranker" stops being structural.
		const many: CorpusTool[] = [];
		for (let i = 0; i < 120; i++) {
			many.push(corpusTool({ server: "bulk", name: `bulk_widget_${i}`, description: "a widget ".repeat(30) }));
		}
		const wide = [...c.tools, ...many];
		const wideCat = categorise(wide, { minMembers: 2 });
		const options = stageTwoOptions(wide, wideCat, "bulk/widget", "factory settings", {
			maxCriteriaTokens: 400,
		});
		expect(options.truncated).toBe(true);
		for (const name of options.floor) expect(options.tools.map((t) => t.qualifiedName)).toContain(name);
		expect(options.tools.length).toBeLessThan(wideCat.categories.find((x) => x.key === "bulk/widget")!.members.length);
	});

	it("respects the 255-option cap even for a category larger than it", () => {
		const many: CorpusTool[] = [];
		for (let i = 0; i < 400; i++) many.push(corpusTool({ server: "bulk", name: `bulk_widget_${i}`, description: "w" }));
		const wide = [...c.tools, ...many];
		const wideCat = categorise(wide, { minMembers: 2 });
		const options = stageTwoOptions(wide, wideCat, "bulk/widget", "widget", { maxCriteriaTokens: 1_000_000 });
		expect(options.tools.length).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS);
		expect(options.truncated).toBe(true);
	});

	it("keys stage-2 criteria by the QUALIFIED name the proxy resolves", () => {
		// Printing the bare name hands the agent a call that fails —
		// `mcp-common/search.ts` records the same decision for the same reason.
		const options = stageTwoOptions(c.tools, cat, "hive/run", "cancel a run");
		expect(Object.keys(toolCriteria(options.tools))).toContain("hive_cancel_run");
	});
});

describe("replay helpers", () => {
	const c = corpus();

	it("refuses a label with no source — an unpointable benchmark moves when it is inconvenient", () => {
		expect(() => parseLabels({ queries: [{ query: "x", expect: { server: "hive", name: "get_run" } }] })).toThrow(
			/no source/,
		);
		expect(() => parseLabels({})).toThrow(/no `queries`/);
		expect(() => parseLabels({ queries: [{ query: "x", expect: { server: "hive" }, source: "t:1" }] })).toThrow(
			/\{server, name\}/,
		);
	});

	it("resolves labels to THIS corpus's qualified names, and reports the ones it cannot", () => {
		const { resolved, unresolved } = resolveLabels(c, [
			{ query: "a", expect: { server: "hive", name: "get_run" }, source: "t:1" },
			{ query: "b", expect: { server: "hive", name: "not_a_tool" }, source: "t:2" },
		]);
		expect(resolved.map((r) => r.expectedQualifiedName)).toEqual(["hive_get_run"]);
		// Dropped silently, a missing label would quietly shrink the benchmark.
		expect(unresolved.map((r) => r.query)).toEqual(["b"]);
	});

	it("floorCoverage reports zero missing ballots for the benchmark queries", () => {
		const cat = categorise(c.tools, { minMembers: 2 });
		const coverage = floorCoverage(c, cat, {
			query: "factory settings",
			expect: { server: "hive", name: "get_scheduler_settings" },
			source: "test/mcp-search-fallback.test.ts:89",
			expectedQualifiedName: "hive_get_scheduler_settings",
		});
		expect(coverage.categoriesMissingExpected).toEqual([]);
		// +1 for the "stage 1 gave nothing" ballot, which must also be checked.
		expect(coverage.categoriesChecked).toBe(cat.categories.length + 1);
		expect(coverage.lexicalRank).toBeGreaterThan(0);
	});

	it("summarise counts BOTH stages' outcomes, so a dead stage 1 cannot hide", () => {
		const report = summarise("t", [
			{
				query: "q",
				top1: "hive_get_run",
				correct: true,
				latencyMs: 300,
				inputTokens: 900,
				stage1: "timeout",
				stage2: "ok",
				chosenCategory: null,
				floorOnly: true,
				certainty: 0.9,
			},
		]);
		expect(report.top1Accuracy).toBe(1);
		// A report that showed only "ok" would say the router works while stage
		// 1 has been dead all along — the HIV-712 shape.
		expect(report.outcomes.timeout).toBe(1);
		expect(report.outcomes.ok).toBe(1);
		expect(report.medianInputTokens).toBe(900);
	});
});
