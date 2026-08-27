import { describe, expect, it } from "vitest";
import {
	CONTEXT_TOKEN_EPSILON,
	changed,
	chooseQuotaWindow,
	isOfficialCodexOrigin,
	isThinkingLevel,
	parseCodexUsage,
	parseUsageWindow,
	splitModelSpec,
	type StatusPayload,
} from "../extensions/hive-remote/status.ts";

// The quota parser reads someone else's undocumented payload, so it is pure and
// tested against the shape the Codex backend actually returns. Its refusals
// matter more than its successes: a quota we cannot read must render as
// UNKNOWN, never as fine.
//
// The FIRST version of this read `x-codex-*` response headers. It shipped,
// deployed, and reported nothing — those headers are not on the responses pi
// surfaces. These tests exist against the endpoint that actually answers.

const NOW = 1_760_000_000_000; // fixed, so reset_at arithmetic is not a clock race

describe("parseUsageWindow", () => {
	it("reads a window", () => {
		expect(
			parseUsageWindow(
				{ used_percent: 48, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 3_600 },
				NOW,
			),
		).toEqual({ used_percent: 48, window_minutes: 10_080, reset_after_seconds: 3_600 });
	});

	// The backend sends an ABSOLUTE epoch and the wire carries an offset. Doing
	// the arithmetic here means only one clock is involved rather than three.
	it("converts an absolute reset into an offset, and drops one in the past", () => {
		const past = parseUsageWindow({ used_percent: 10, reset_at: NOW / 1000 - 60 }, NOW);
		expect(past?.reset_after_seconds).toBeUndefined();
	});

	it("is undefined when there is no window to read", () => {
		expect(parseUsageWindow(undefined, NOW)).toBeUndefined();
		expect(parseUsageWindow(null, NOW)).toBeUndefined();
		expect(parseUsageWindow({}, NOW)).toBeUndefined();
	});

	// Out of range is contract drift, not a measurement.
	it("refuses a percentage outside 0-100", () => {
		expect(parseUsageWindow({ used_percent: 101 }, NOW)).toBeUndefined();
		expect(parseUsageWindow({ used_percent: -1 }, NOW)).toBeUndefined();
		expect(parseUsageWindow({ used_percent: "48" }, NOW)).toBeUndefined();
	});

	it("accepts a genuinely empty window", () => {
		expect(parseUsageWindow({ used_percent: 0, limit_window_seconds: 604_800 }, NOW)).toEqual({
			used_percent: 0,
			window_minutes: 10_080,
		});
	});
});

describe("parseCodexUsage", () => {
	const payload = {
		plan_type: "pro",
		rate_limit: {
			primary_window: { used_percent: 90, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 48, limit_window_seconds: 604_800 },
		},
		// Per-feature buckets. Folding these in would make one percentage on the
		// bar mean different things on different days.
		additional_rate_limits: [
			{ limit_name: "some-tool", rate_limit: { primary_window: { used_percent: 99 } } },
		],
	};

	it("takes the longer window and the plan type, and ignores per-feature buckets", () => {
		expect(parseCodexUsage(payload, NOW)).toEqual({
			quota: { used_percent: 48, window_minutes: 10_080 },
			plan_type: "pro",
		});
	});

	it("is empty for a payload it does not understand", () => {
		expect(parseCodexUsage(null, NOW)).toEqual({});
		expect(parseCodexUsage({ nope: 1 }, NOW)).toEqual({});
	});
});

describe("isOfficialCodexOrigin", () => {
	// The one way this feature could leak a credential: a custom baseUrl means
	// the token belongs to a proxy, and posting it to chatgpt.com would hand a
	// third party's token to OpenAI.
	it("refuses a proxy base URL", () => {
		expect(isOfficialCodexOrigin("https://my-proxy.internal/v1")).toBe(false);
		expect(isOfficialCodexOrigin("not a url")).toBe(false);
	});

	it("accepts the official origin and an unset one", () => {
		expect(isOfficialCodexOrigin(undefined)).toBe(true);
		expect(isOfficialCodexOrigin("https://chatgpt.com/backend-api")).toBe(true);
	});
});

describe("chooseQuotaWindow", () => {
	const fiveHour = { used_percent: 90, window_minutes: 300 };
	const weekly = { used_percent: 48, window_minutes: 10080 };

	// The LONGER window, not the fuller one. A 5-hour window at 90% refills this
	// afternoon; the weekly one decides whether there is work left this week.
	it("prefers the longer window even when the shorter one is fuller", () => {
		expect(chooseQuotaWindow(fiveHour, weekly)).toBe(weekly);
		expect(chooseQuotaWindow(weekly, fiveHour)).toBe(weekly);
	});

	it("takes whichever exists when only one does", () => {
		expect(chooseQuotaWindow(fiveHour, undefined)).toBe(fiveHour);
		expect(chooseQuotaWindow(undefined, weekly)).toBe(weekly);
		expect(chooseQuotaWindow(undefined, undefined)).toBeUndefined();
	});
});

describe("changed", () => {
	const base: StatusPayload = { context_tokens: 100_000, context_window: 200_000, model: "openai-codex/gpt-5.6-luna" };

	it("always sends the first reading", () => {
		expect(changed(null, base)).toBe(true);
	});

	// An idle session produces an identical reading every tick. Sending it anyway
	// means a workstation left at a prompt overnight POSTs forever to say nothing.
	it("suppresses an unchanged reading", () => {
		expect(changed(base, { ...base })).toBe(false);
	});

	it("ignores context drift too small to move the gauge", () => {
		expect(changed(base, { ...base, context_tokens: 100_000 + CONTEXT_TOKEN_EPSILON - 1 })).toBe(false);
		expect(changed(base, { ...base, context_tokens: 100_000 + CONTEXT_TOKEN_EPSILON })).toBe(true);
	});

	it("sends on a model, thinking, window or quota change", () => {
		expect(changed(base, { ...base, model: "openai-codex/gpt-5.6-sol" })).toBe(true);
		expect(changed(base, { ...base, thinking: "xhigh" })).toBe(true);
		expect(changed(base, { ...base, context_window: 400_000 })).toBe(true);
		expect(changed(base, { ...base, quota: { used_percent: 49, window_minutes: 10080 } })).toBe(true);
	});

	// Losing the reading entirely is news — the gauge has to stop claiming a
	// number it can no longer see.
	it("sends when a value disappears", () => {
		expect(changed(base, { ...base, context_tokens: undefined })).toBe(true);
	});
});

describe("splitModelSpec", () => {
	it("splits on the FIRST slash, so a provider-qualified id keeps its own", () => {
		expect(splitModelSpec("openrouter/z-ai/glm-5.2")).toEqual({ provider: "openrouter", id: "z-ai/glm-5.2" });
		expect(splitModelSpec("openai-codex/gpt-5.6-sol")).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
	});

	it("rejects anything that is not provider/id", () => {
		expect(splitModelSpec("gpt-5.6-sol")).toBeNull();
		expect(splitModelSpec("/gpt-5.6-sol")).toBeNull();
		expect(splitModelSpec("openai-codex/")).toBeNull();
		expect(splitModelSpec("")).toBeNull();
	});
});

describe("isThinkingLevel", () => {
	it("accepts pi's levels", () => {
		expect(isThinkingLevel("xhigh")).toBe(true);
		expect(isThinkingLevel("off")).toBe(true);
	});

	// A server naming a level this client does not know must not block the model
	// switch — the level is skipped, the model still changes.
	it("rejects anything else, including absent", () => {
		expect(isThinkingLevel("ludicrous")).toBe(false);
		expect(isThinkingLevel(undefined)).toBe(false);
	});
});
