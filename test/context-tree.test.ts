/**
 * The property the whole feature rests on: every row shows its OWN spend, so
 * the token column SUMS to the grand total. Get that wrong and the readout is
 * not merely imprecise, it is anti-informative — with subtree sums in the rows
 * the root always looks like the expensive one, which is the question nobody
 * asked.
 *
 * So the load-bearing test here is `sums exactly` over a THREE-level fixture
 * (session → subagent → subagent), because the level that actually goes
 * missing in this design is the grandchild: each agent is a separate `pi`
 * process, so a child's spend is reachable ONLY through its own `details`, and
 * failing to recurse loses it silently rather than double-counting it.
 *
 * The rest is the honesty surface: dollars that are aggregate must not render
 * as a confident per-row figure, and an unpriced model must not render as
 * $0.00.
 */

import { describe, expect, it } from "vitest";

import { createFakePi, type FakeCtxOptions } from "./fake-pi.ts";
import contextTreeExtension from "../extensions/context-tree/index.ts";
import {
	type AgentNode,
	buildTree,
	contextBar,
	contextCell,
	contextPercent,
	contextTreeEnvelope,
	costCell,
	flatten,
	foldOwnUsage,
	isContextWarning,
	renderReport,
	subtreeTokens,
	totals,
} from "../extensions/context-tree/tree.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures — the wire shapes, as the producers actually emit them             */
/* -------------------------------------------------------------------------- */

/** An assistant turn. `cost` is an OBJECT on the wire — see harness/usage.ts. */
const assistant = (input: number, output: number, costTotal = 0) => ({
	type: "message",
	message: {
		role: "assistant",
		content: [],
		usage: { input, output, cacheRead: 999, cacheWrite: 999, cost: { total: costTotal } },
	},
});

/** A `subagent` tool result. `messages` is the child's own transcript. */
const subagentResult = (
	toolCallId: string,
	results: Array<{
		agent: string;
		input: number;
		output: number;
		cost?: number;
		contextTokens?: number;
		messages?: unknown[];
	}>,
) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "subagent",
		details: {
			mode: "parallel",
			results: results.map((r) => ({
				agent: r.agent,
				task: "do a thing",
				exitCode: 0,
				messages: r.messages ?? [],
				usage: {
					input: r.input,
					output: r.output,
					cacheRead: 500,
					cacheWrite: 100,
					cost: r.cost ?? 0,
					contextTokens: r.contextTokens ?? 0,
					turns: 3,
				},
			})),
		},
	},
});

/** An `orchestrate` tool result, envelope and all (agenda/index.ts). */
const orchestrateResult = (
	toolCallId: string,
	workers: Array<{ name: string; tokens: number }>,
	spentCost: number,
) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "orchestrate",
		details: {
			summary: {
				state: "done",
				results: {},
				failures: [],
				agentsSpawned: workers.length,
				spentTokens: workers.reduce((total, worker) => total + worker.tokens, 0),
				spentCost,
			},
			events: [],
			hive_widget: {
				v: 1,
				type: "context-tree",
				spec: {
					rows: workers.map((worker) => ({ name: worker.name, depth: 1, tokens: worker.tokens })),
					totalTokens: workers.reduce((total, worker) => total + worker.tokens, 0),
					totalCostUsd: spentCost,
				},
			},
		},
	},
});

const ROOT = { label: "session", contextTokens: null, contextWindow: null };

/** The fake models only the fields its own consumers read; these fixtures carry
 *  `usage`/`details` too, which is the documented cast for fake contexts. */
const branchOf = (...entries: unknown[]) => entries as unknown as FakeCtxOptions["branch"];

/* -------------------------------------------------------------------------- */
/* The invariant                                                               */
/* -------------------------------------------------------------------------- */

describe("own-vs-subtree attribution", () => {
	/**
	 * session (300) → reviewer (150) → nested critic (40)
	 *               → writer   (60)
	 * plus an orchestrate group of two workers (500 + 700).
	 */
	const nestedBranch = [
		assistant(100, 200, 0.5),
		subagentResult("call-1", [
			{
				agent: "reviewer",
				input: 100,
				output: 50,
				cost: 0.25,
				messages: [
					// The grandchild lives HERE, in the child's own transcript, as a
					// bare Message (not a SessionEntry).
					{
						role: "toolResult",
						toolCallId: "call-1-inner",
						toolName: "subagent",
						details: {
							mode: "single",
							results: [
								{
									agent: "critic",
									messages: [],
									usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 1 },
								},
							],
						},
					},
				],
			},
			{ agent: "writer", input: 40, output: 20, cost: 0.15 },
		]),
		orchestrateResult("call-2", [{ name: "fan/0", tokens: 500 }, { name: "fan/1", tokens: 700 }], 2),
	];

	const tree = buildTree(nestedBranch, ROOT);

	it("finds every agent, including the grandchild", () => {
		expect(flatten(tree).map((row) => `${row.depth}:${row.node.label}`)).toEqual([
			"0:session",
			"1:reviewer",
			"2:critic",
			"1:writer",
			"1:orchestrate (2 workers)",
			"2:fan/0",
			"2:fan/1",
		]);
	});

	it("sums exactly — no row includes its descendants", () => {
		const rows = flatten(tree).map((row) => row.node.ownTokens);
		// 300 root + 150 reviewer + 40 critic + 60 writer + 0 group + 500 + 700
		expect(rows).toEqual([300, 150, 40, 60, 0, 500, 700]);
		expect(rows.reduce((a, b) => a + b, 0)).toBe(totals(tree).tokens);
		expect(totals(tree).tokens).toBe(1750);
		expect(subtreeTokens(tree)).toBe(1750);
	});

	it("cost sums exactly too, with the aggregate on exactly one row", () => {
		const rows = flatten(tree);
		// The orchestrate group carries the run's whole $2; its workers carry none.
		expect(rows.map((row) => row.node.ownCostUsd)).toEqual([0.5, 0.25, 0.1, 0.15, 2, 0, 0]);
		expect(totals(tree).costUsd).toBeCloseTo(3, 10);
		expect(totals(tree).aggregateRows).toBe(1);
		// The workers are ACCOUNTED FOR by that aggregate, so they must not be
		// reported as holes — conflating the two claimed four unpriced rows here
		// when the real answer is none.
		expect(totals(tree).unpricedRows).toBe(0);
	});

	it("cache tokens are excluded — the column is input+output, as the executor bills", () => {
		// Every fixture carries cacheRead/cacheWrite; none of it reaches a row.
		expect(totals(tree).tokens).toBe(1750);
	});

	it("the envelope matches the orchestrate half's shape", () => {
		const widget = contextTreeEnvelope(tree).hive_widget;
		expect(widget.v).toBe(1);
		expect(widget.type).toBe("context-tree");
		expect(widget.spec.totalTokens).toBe(1750);
		expect(widget.spec.totalCostUsd).toBeCloseTo(3, 10);
		expect((widget.spec.rows as Array<{ name: string; depth: number; tokens: number }>)[2]).toEqual({
			name: "critic",
			depth: 2,
			tokens: 40,
		});
	});
});

describe("matching the right tool results", () => {
	/**
	 * There is no tool-name allow-list — the shape is the discriminator, so a
	 * future producer of either shape is picked up for free. The cost of that
	 * is a false match inventing a phantom row, which these pin shut. No other
	 * extension currently emits either shape (checked by grep, 2026-08-15).
	 */
	it("ignores a details.results that is not subagent results", () => {
		const branch = [
			{
				type: "message",
				message: { role: "toolResult", toolName: "grep", details: { results: [{ file: "a.ts", line: 3 }] } },
			},
		];
		expect(buildTree(branch, ROOT).children).toEqual([]);
	});

	it("ignores a details.summary that is not a run summary", () => {
		const branch = [
			{ type: "message", message: { role: "toolResult", toolName: "ask", details: { summary: { text: "pending" } } } },
		];
		expect(buildTree(branch, ROOT).children).toEqual([]);
	});

	/** A plan of pure transforms spawns nothing, so agenda emits NO envelope —
	 *  `details` is `{summary, events}` alone. Real wire shape, not hypothetical. */
	it("keeps an orchestrate run that has no workers, and its tokens", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "orchestrate",
					details: { summary: { spentTokens: 40, spentCost: 0.02 }, events: [] },
				},
			},
		];
		const tree = buildTree(branch, ROOT);
		expect(tree.children).toHaveLength(1);
		expect(tree.children[0].label).toBe("orchestrate (0 workers)");
		expect(tree.children[0].ownTokens).toBe(40);
		expect(totals(tree).tokens).toBe(40);
	});
});

describe("foldOwnUsage", () => {
	it("counts assistant turns only, and reads cost.total rather than cost", () => {
		expect(foldOwnUsage([assistant(10, 5, 0.02), assistant(1, 1, 0.01)])).toEqual({ tokens: 17, costUsd: 0.03 });
	});

	it("ignores toolResult-level usage — that is a child process's bill", () => {
		const branch = [
			assistant(10, 5, 0.02),
			{ type: "message", message: { role: "toolResult", toolName: "advisor", usage: { input: 900, output: 900 } } },
		];
		expect(foldOwnUsage(branch).tokens).toBe(15);
	});

	it("survives malformed usage rather than poisoning the total with NaN", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: "lots", output: null, cost: 4 } } },
			assistant(10, 5),
		];
		expect(foldOwnUsage(branch)).toEqual({ tokens: 15, costUsd: 0 });
	});
});

/* -------------------------------------------------------------------------- */
/* Honesty about dollars                                                       */
/* -------------------------------------------------------------------------- */

describe("cost cells", () => {
	const node = (over: Partial<AgentNode>): AgentNode => ({
		id: "x",
		label: "x",
		kind: "subagent",
		ownTokens: 0,
		ownCostUsd: 0,
		costScope: "row",
		contextTokens: null,
		contextWindow: null,
		children: [],
		...over,
	});

	it("shows an em dash, never $0.00, for an unpriced model that spent tokens", () => {
		const tree = buildTree([subagentResult("c", [{ agent: "flash", input: 900, output: 100 }])], ROOT);
		const flash = tree.children[0];
		expect(flash.ownTokens).toBe(1000);
		expect(flash.costScope).toBe("unknown");
		expect(costCell(flash)).toBe("—");
	});

	it("marks an aggregate figure so it is not read as this row alone", () => {
		expect(costCell(node({ costScope: "aggregate", ownCostUsd: 1.5 }))).toBe("$1.50*");
		expect(costCell(node({ costScope: "row", ownCostUsd: 1.5 }))).toBe("$1.50");
		expect(costCell(node({ costScope: "row", ownCostUsd: 0.0004 }))).toBe("$0.0004");
		// "an ancestor has it" and "nobody has it" render alike but count apart.
		expect(costCell(node({ costScope: "covered", ownTokens: 900 }))).toBe("—");
	});

	/**
	 * The spec's named hazard, on the row most likely to hit it: the executor
	 * sums `spentCost` over its workers, so a fan-out of unpriced models
	 * produces a run that really spent tokens and reports $0. The group row
	 * normally has NO own tokens (the workers hold them all), so a scope that
	 * only looks at `ownTokens` reads that $0 as "this row spent nothing" and
	 * prints a confident zero over a whole run's unknown bill — while the
	 * workers below sit "covered" by an aggregate that does not exist, and the
	 * `*` footnote fires with no `*` anywhere to explain.
	 */
	it("never prints $0 for an orchestrate run whose dollars were not reported", () => {
		const tree = buildTree([orchestrateResult("c", [{ name: "w0", tokens: 600 }, { name: "w1", tokens: 400 }], 0)], ROOT);
		const group = tree.children[0];
		expect(group.ownTokens).toBe(0);
		expect(costCell(group)).toBe("—");
		// One hole, named once: the group. Its workers are not counted again.
		expect(totals(tree).unpricedRows).toBe(1);
		expect(totals(tree).aggregateRows).toBe(0);

		const lines = renderReport(tree);
		expect(lines.some((line) => line.text.includes("the total is a floor"))).toBe(true);
		// No aggregate exists, so the footnote explaining one must not appear.
		expect(lines.some((line) => line.text.includes("bills dollars only for the whole run"))).toBe(false);
	});

	/** The other end of the same class: a plan of pure transforms spawns nothing
	 *  and spends nothing, so its `$0` is truthful — but there is no aggregate to
	 *  footnote, and a `*` note with no `*` on any row explains nothing. */
	it("does not footnote an aggregate for a run that spent nothing", () => {
		const tree = buildTree(
			[
				{
					type: "message",
					message: { role: "toolResult", toolName: "orchestrate", details: { summary: { spentTokens: 0, spentCost: 0 } } },
				},
			],
			ROOT,
		);
		expect(costCell(tree.children[0])).toBe("$0");
		expect(totals(tree).aggregateRows).toBe(0);
		expect(totals(tree).unpricedRows).toBe(0);
		expect(renderReport(tree).some((line) => line.text.includes("bills dollars only for the whole run"))).toBe(false);
	});

	it("counts the unattributable rows so the report can say the total is a floor", () => {
		const tree = buildTree(
			[subagentResult("c", [{ agent: "a", input: 10, output: 0 }, { agent: "b", input: 20, output: 0, cost: 0.1 }])],
			ROOT,
		);
		expect(totals(tree).unpricedRows).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* The bar                                                                     */
/* -------------------------------------------------------------------------- */

describe("context bar", () => {
	it("fills proportionally and always spans its width", () => {
		expect(contextBar(0)).toBe("░░░░░");
		expect(contextBar(23)).toBe("▓░░░░");
		expect(contextBar(50)).toBe("▓▓▓░░");
		expect(contextBar(100)).toBe("▓▓▓▓▓");
	});

	it("clamps rather than overflowing on a bad reading", () => {
		expect(contextBar(-40)).toBe("░░░░░");
		expect(contextBar(400)).toBe("▓▓▓▓▓");
	});

	/**
	 * The whole point of the warning colour is telling "nearly out" from "out".
	 * Plain rounding at this width saturates at 90%, collapsing exactly that
	 * distinction.
	 */
	it("keeps the last cell until the window really is full", () => {
		expect(contextBar(90)).toBe("▓▓▓▓░");
		expect(contextBar(99.9)).toBe("▓▓▓▓░");
		expect(contextBar(100)).toBe("▓▓▓▓▓");
	});

	it("warns at 80% and not before", () => {
		const at = (tokens: number): AgentNode =>
			buildTree([], { label: "s", contextTokens: tokens, contextWindow: 100 });
		expect(isContextWarning(at(79))).toBe(false);
		expect(isContextWarning(at(80))).toBe(true);
		expect(contextCell(at(23))).toBe("▓░░░░ 23%");
	});

	it("degrades honestly when only part of the reading exists", () => {
		// Fill but no window (a subagent): a bar would need a divisor nobody sent.
		const tree = buildTree([subagentResult("c", [{ agent: "a", input: 1, output: 1, contextTokens: 12_000 }])], ROOT);
		expect(contextPercent(tree.children[0])).toBeNull();
		expect(contextCell(tree.children[0])).toBe("ctx 12k");
		// Nothing at all (an orchestrate worker).
		expect(contextCell(buildTree([], ROOT))).toBe("—");
	});
});

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

describe("renderReport", () => {
	it("carries a total line whose tokens equal the column", () => {
		const tree = buildTree(
			[assistant(100, 100, 0.4), subagentResult("c", [{ agent: "a", input: 50, output: 50, cost: 0.1 }])],
			ROOT,
		);
		const lines = renderReport(tree);
		const total = lines.find((line) => line.tone === "total");
		expect(total?.text).toContain("total (2 agents)");
		expect(total?.text).toContain("300");
	});

	it("explains the aggregate and the unpriced rows only when they exist", () => {
		const clean = renderReport(buildTree([assistant(10, 10, 0.1)], ROOT));
		expect(clean.some((line) => line.tone === "note" && line.text.startsWith("*"))).toBe(false);

		const messy = renderReport(
			buildTree(
				[orchestrateResult("c", [{ name: "w0", tokens: 10 }], 0.9), subagentResult("d", [{ agent: "u", input: 5, output: 0 }])],
				ROOT,
			),
		);
		expect(messy.some((line) => line.text.includes("bills dollars only for the whole run"))).toBe(true);
		expect(messy.some((line) => line.text.includes("the total is a floor"))).toBe(true);
	});

	it("says so when there is nothing to break down", () => {
		expect(renderReport(buildTree([assistant(10, 10)], ROOT)).some((line) => line.text.includes("No subagents"))).toBe(
			true,
		);
	});

	it("indents by depth and flags the over-80% row", () => {
		const tree = buildTree([subagentResult("c", [{ agent: "deep", input: 1, output: 1 }])], {
			label: "session",
			contextTokens: 90,
			contextWindow: 100,
		});
		const lines = renderReport(tree);
		expect(lines[1].tone).toBe("warn");
		expect(lines[1].text).toContain("▓▓▓▓░ 90%");
		expect(lines[2].text.startsWith("  deep")).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

describe("the extension", () => {
	it("registers /context and NO event handlers — the loop pays nothing until asked", () => {
		const pi = createFakePi();
		contextTreeExtension(pi.api);
		expect(pi.commands.has("context")).toBe(true);
		expect(pi.handlers.size).toBe(0);
		expect(pi.tools).toHaveLength(0);
	});

	it("reports through notify outside a TUI, and persists the envelope as a session entry", async () => {
		const pi = createFakePi();
		contextTreeExtension(pi.api);
		await pi.runCommand("context", "", {
			mode: "print",
			branch: branchOf(assistant(100, 100, 0.4), subagentResult("c", [{ agent: "reviewer", input: 20, output: 30, cost: 0.1 }])),
		});

		expect(pi.notifications).toHaveLength(1);
		expect(pi.notifications[0].message).toContain("reviewer");
		expect(pi.notifications[0].message).toContain("250");

		// appendEntry, not sendMessage: the readout must never enter model context.
		expect(pi.messages).toHaveLength(0);
		expect(pi.entries).toHaveLength(1);
		expect(pi.entries[0].customType).toBe("context-tree");
		const envelope = pi.entries[0].data as ReturnType<typeof contextTreeEnvelope>;
		expect(envelope.hive_widget.spec.totalTokens).toBe(250);
	});

	it("still answers when the session has nothing in it", async () => {
		const pi = createFakePi();
		contextTreeExtension(pi.api);
		await pi.runCommand("context", "", { mode: "print", branch: [] });
		expect(pi.notifications[0].message).toContain("No subagents");
	});
});
