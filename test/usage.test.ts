import { describe, expect, it } from "vitest";
import usageExtension, { type UsageDeps } from "../extensions/usage/index.ts";
import {
	codexSegment,
	formatReset,
	openRouterSegment,
	overlayLines,
	parseOpenRouterKey,
	statusLine,
	windowLabel,
	type CodexReading,
	type OpenRouterReading,
} from "../extensions/usage/format.ts";
import { createFakePi } from "./fake-pi.ts";

const NOW = 1_000_000;

const CODEX: CodexReading = {
	primary: { used_percent: 12, window_minutes: 300 },
	secondary: { used_percent: 34, window_minutes: 10_080, reset_after_seconds: 200_000 },
	planType: "pro",
	fetchedAtMs: NOW,
};

const OPENROUTER: OpenRouterReading = { usageUsd: 12.345, limitUsd: 100, remainingUsd: 87.65, fetchedAtMs: NOW };

describe("format — pure folds", () => {
	it("labels windows the way a human names them", () => {
		expect(windowLabel(300)).toBe("5h");
		expect(windowLabel(10_080)).toBe("7d");
		expect(windowLabel(90)).toBe("90m");
	});

	it("renders both codex windows in one segment", () => {
		expect(codexSegment(CODEX)).toBe("codex 5h 12% · 7d 34%");
		expect(codexSegment(null)).toBeUndefined();
		expect(codexSegment({ fetchedAtMs: NOW })).toBeUndefined();
	});

	it("shows remaining credit on capped keys, lifetime spend only on uncapped ones", () => {
		// Lifetime `usage` and the current credit block are different scales —
		// "spent of $30" with $160 lifetime is the bug this pins against.
		expect(openRouterSegment(OPENROUTER)).toBe("or $87.65 left");
		expect(openRouterSegment({ usageUsd: 3.5, limitUsd: null, remainingUsd: null, fetchedAtMs: NOW })).toBe(
			"or $3.50 spent",
		);
	});

	it("the active provider's segment leads; the other is a fallback", () => {
		expect(statusLine("openai-codex", CODEX, OPENROUTER)).toContain("codex");
		expect(statusLine("openrouter", CODEX, OPENROUTER)).toContain("or $");
		expect(statusLine("openrouter", CODEX, null)).toContain("codex");
		expect(statusLine("anthropic", null, OPENROUTER)).toContain("or $");
		expect(statusLine(undefined, null, null)).toBeUndefined();
	});

	it("parseOpenRouterKey refuses a payload without a finite usage — no reading must never render as $0", () => {
		expect(parseOpenRouterKey({ data: { usage: "a lot" } }, NOW)).toBeNull();
		expect(parseOpenRouterKey({}, NOW)).toBeNull();
		expect(parseOpenRouterKey({ data: { usage: 5.5, limit: 10, limit_remaining: 4.5 } }, NOW)).toEqual({
			usageUsd: 5.5,
			limitUsd: 10,
			remainingUsd: 4.5,
			fetchedAtMs: NOW,
		});
	});

	it("overlay shows plan, resets, and an honest empty state", () => {
		const body = overlayLines(CODEX, OPENROUTER, NOW + 5_000).join("\n");
		expect(body).toContain("Codex (pro):");
		expect(body).toContain("7d window: 34% used · resets in 2d");
		expect(body).toContain("$12.35 lifetime spend");
		expect(body).toContain("$87.65 of $100.00 credit remaining");
		expect(body).toContain("read 5s ago");

		const empty = overlayLines(null, null, NOW).join("\n");
		expect(empty).toContain("No quota readings yet");
	});

	it("formatReset rounds to the unit a human reads", () => {
		expect(formatReset(120)).toBe("resets in 2m");
		expect(formatReset(7_200)).toBe("resets in 2h");
		expect(formatReset(undefined)).toBeUndefined();
	});
});

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("usage extension behavior", () => {
	it("fetches on session_start (detached) and writes the usage status key", async () => {
		const fake = createFakePi();
		const deps: UsageDeps = {
			fetchCodex: async () => CODEX,
			fetchOpenRouter: async () => OPENROUTER,
		};
		usageExtension(fake.api, deps);
		await fake.emit({ type: "session_start", reason: "new" });
		await flush();

		const status = [...fake.statuses].reverse().find((entry) => entry.key === "usage");
		expect(status?.text).toContain("codex 5h 12%");
	});

	it("keeps the last good reading when a later fetch fails", async () => {
		const fake = createFakePi();
		let fail = false;
		const deps: UsageDeps = {
			fetchCodex: async () => (fail ? null : CODEX),
			fetchOpenRouter: async () => null,
		};
		usageExtension(fake.api, deps);
		await fake.emit({ type: "session_start", reason: "new" });
		await flush();

		fail = true;
		await fake.emit({ type: "model_select" });
		await flush();

		const status = [...fake.statuses].reverse().find((entry) => entry.key === "usage");
		expect(status?.text).toContain("codex 5h 12%");
	});

	it("/usage degrades to a notification outside the TUI", async () => {
		const fake = createFakePi();
		const deps: UsageDeps = { fetchCodex: async () => null, fetchOpenRouter: async () => OPENROUTER };
		usageExtension(fake.api, deps);
		await fake.runCommand("usage", "", { mode: "rpc" });
		expect(fake.notifications.some((note) => note.message.includes("$12.35 lifetime spend"))).toBe(true);
	});
});
