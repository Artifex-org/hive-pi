import { describe, expect, it } from "vitest";

import { parseUsage } from "./usage.ts";
import { contextWindowFor, isCursorOwnModel, splitEffort, toPiModels } from "./models.ts";

describe("subscription allowance", () => {
	// The exact payload a live account returned, so the arithmetic is pinned to
	// something real rather than to a fixture that shares my assumptions.
	const live = {
		billingCycleStart: "1785895907000",
		billingCycleEnd: "1788574307000",
		planUsage: {
			totalSpend: 1245,
			includedSpend: 1245,
			remaining: 755,
			limit: 2000,
			totalPercentUsed: 3.6086956521739126,
		},
		displayMessage: "You've used 62% of your included usage",
	};

	it("derives the percentage from cents, not from totalPercentUsed", () => {
		const usage = parseUsage(live);
		expect(usage.remainingCents).toBe(755);
		expect(usage.limitCents).toBe(2000);
		// 755/2000 = 38% remaining, which reconciles with "used 62%".
		// `totalPercentUsed` said 3.6 — a blended figure across pools that would
		// have reported a nearly-full account as nearly-empty had we trusted it.
		expect(usage.remainingPercent).toBe(38);
	});

	it("keeps Cursor's own sentence for operator display", () => {
		expect(parseUsage(live).message).toBe("You've used 62% of your included usage");
	});

	it("reads the billing cycle end as a date", () => {
		expect(parseUsage(live).billingCycleEnd?.toISOString().slice(0, 4)).toBe("2026");
	});

	// The dangerous direction. hive's orderByQuota demotes an account on positive
	// evidence of emptiness; a missing limit reported as 100% would instead be
	// positive evidence of HEALTH, and would route the fleet onto an account
	// nobody could measure.
	it("reports 0% when the allowance cannot be measured, never 100%", () => {
		expect(parseUsage({}).remainingPercent).toBe(0);
		expect(parseUsage({ planUsage: { remaining: 500 } }).remainingPercent).toBe(0);
		expect(parseUsage({ planUsage: { limit: 0, remaining: 0 } }).remainingPercent).toBe(0);
	});

	it("clamps a nonsensical reading into range", () => {
		expect(parseUsage({ planUsage: { remaining: 5000, limit: 2000 } }).remainingPercent).toBe(100);
		expect(parseUsage({ planUsage: { remaining: -50, limit: 2000 } }).remainingPercent).toBe(0);
	});
});

describe("model catalogue mapping", () => {
	it("parses the longest effort suffix first", () => {
		// `extra-high` must beat `high`, or the family is silently wrong.
		expect(splitEffort("gpt-5.5-extra-high")).toEqual({ family: "gpt-5.5", effort: "extra-high" });
		expect(splitEffort("claude-opus-5-thinking-xhigh")).toEqual({
			family: "claude-opus-5-thinking",
			effort: "xhigh",
		});
		expect(splitEffort("composer-2.5")).toEqual({ family: "composer-2.5", effort: null });
	});

	it("declares a conservative window for an unknown model", () => {
		// Under-declaring costs an early compaction; over-declaring costs a
		// request the server refuses outright, so unknown means small.
		expect(contextWindowFor("something-new-9")).toBe(128_000);
		// Measured from a live turn's tokenDetails.maxTokens.
		expect(contextWindowFor("composer-2.5")).toBe(200_000);
		expect(contextWindowFor("cursor-grok-4.6-high")).toBe(256_000);
		// A third-party passthrough now falls to the conservative default rather
		// than carrying its real 1M window — deliberate, and harmless, because
		// isCursorOwnModel means it is never registered in the first place. The
		// table only describes models we actually expose.
		expect(contextWindowFor("claude-opus-5-thinking-high")).toBe(128_000);
	});

	// THE BILLING BOUNDARY. Cursor bills against two pools: its own models draw
	// on a large included allowance, third-party passthroughs come out of a much
	// smaller one "charged at the model's API price". Registering a passthrough
	// would spend metered credit at list price while hive saw a zero-cost model —
	// the models are declared free precisely because the first pool is flat-rate.
	it("registers only Cursor's own models, never the third-party passthroughs", () => {
		const catalogue = [
			{ modelId: "composer-2.5" },
			{ modelId: "composer-2.5-fast" },
			{ modelId: "cursor-grok-4.6-high" },
			{ modelId: "cursor-grok-4.5-low-fast" },
			// Everything below is a passthrough billed at API prices.
			{ modelId: "claude-opus-5-thinking-high" },
			{ modelId: "claude-sonnet-5-thinking-high" },
			{ modelId: "gpt-5.6-sol-medium" },
			{ modelId: "gpt-5.3-codex" },
			{ modelId: "gemini-3.7-flash-high" },
		];
		const ids = toPiModels(catalogue).map((m) => m.id);
		expect(ids).toEqual([
			"composer-2.5",
			"composer-2.5-fast",
			"cursor-grok-4.6-high",
			"cursor-grok-4.5-low-fast",
		]);
		// Asserted as an exact list rather than "contains no claude": a future
		// vendor prefix we have never seen would slip past a deny-check, and the
		// safe default for a billing boundary is to exclude what we do not know.
		expect(isCursorOwnModel("some-new-vendor-model-1")).toBe(false);
	});

	it("drops `default`, which is Cursor choosing for us", () => {
		// A score recorded against `cursor/default` is unattributable: the model
		// behind it changes without notice.
		const models = toPiModels([{ modelId: "default" }, { modelId: "composer-2.5" }]);
		expect(models.map((m) => m.id)).toEqual(["composer-2.5"]);
	});

	it("prices subscription tokens at zero", () => {
		// Not a placeholder: these tokens are covered by a flat rate, and any
		// invented per-token price would make cost-ranking consumers treat
		// subscription work as metered spend.
		const [model] = toPiModels([{ modelId: "composer-2.5", displayName: "Composer 2.5" }]);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.name).toBe("Composer 2.5");
	});
});
