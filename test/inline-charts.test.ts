/**
 * Ported from a dotfiles repo `pi/tests/inline-charts.test.ts` (node:test + tsx +
 * its own tsconfig.test.json + a setup script). The assertions are unchanged;
 * only the runner is, because this repo already has vitest and a second test
 * toolchain would need its own CI wiring to be worth anything.
 */

import { describe, expect, it } from "vitest";
import inlineCharts, { type ChartDetails, formatValue, renderChartLines } from "../extensions/inline-charts.ts";

const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const widthOf = (line: string) => [...line.replace(ansi, "")].length;

const lineChart: ChartDetails = {
	type: "line",
	title: "NAV trend",
	unit: "USD",
	series: [
		{
			name: "NAV",
			points: [
				{ x: "2026-01-01", y: 100 },
				{ x: "2026-01-02", y: 120 },
				{ x: "2026-01-03", y: 90 },
				{ x: "2026-01-04", y: 135 },
			],
		},
	],
	min: 90,
	max: 135,
	lastValues: [{ name: "NAV", value: 135 }],
};

describe("formatValue", () => {
	it("formats compact values with their unit", () => {
		expect(formatValue(1_250_000, "USD")).toBe("1.25M USD");
		expect(formatValue(-12.5, "%")).toBe("-12.50 %");
	});
});

describe("renderChartLines", () => {
	it("renders a line chart within the terminal width", () => {
		const lines = renderChartLines(lineChart, 64, false);
		expect(lines).toContain("NAV trend");
		expect(lines.some((line) => line.includes("2026-01-01 → 2026-01-04"))).toBe(true);
		expect(lines.every((line) => widthOf(line) <= 64)).toBe(true);
	});

	it("renders negative bars and exposes latest values when expanded", () => {
		const details: ChartDetails = {
			...lineChart,
			type: "bar",
			title: "Monthly P&L",
			series: [{ name: "P&L", points: [{ x: "Jan", y: -20 }, { x: "Feb", y: 40 }] }],
			min: -20,
			max: 40,
			lastValues: [{ name: "P&L", value: 40 }],
		};
		const lines = renderChartLines(details, 48, true);
		expect(lines.some((line) => line.includes("−"))).toBe(true);
		expect(lines).toContain("Latest values:");
		expect(lines.every((line) => widthOf(line) <= 48)).toBe(true);
	});

	it("falls back cleanly on narrow terminals", () => {
		const lines = renderChartLines(lineChart, 20, false);
		expect(lines.some((line) => line.startsWith("Need 24+ columns."))).toBe(true);
		expect(lines.every((line) => widthOf(line) <= 20)).toBe(true);
	});

	it("reports when a bar chart is limited to its visible rows", () => {
		const details: ChartDetails = {
			...lineChart,
			type: "bar",
			series: [
				{
					name: "Values",
					points: Array.from({ length: 25 }, (_, index) => ({ x: `Item ${index + 1}`, y: index + 1 })),
				},
			],
			min: 1,
			max: 25,
			lastValues: [{ name: "Values", value: 25 }],
		};
		expect(renderChartLines(details, 80, false)).toContain("Showing 24 of 25 values.");
	});
});

describe("the registered tool", () => {
	it("rejects unaligned multi-series line data", async () => {
		let tool: { execute: (...args: never[]) => Promise<unknown> } | undefined;
		inlineCharts({ registerTool: (definition: typeof tool) => { tool = definition; } } as never);
		expect(tool).toBeDefined();

		await expect(
			(tool as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("test", {
				type: "line",
				title: "Misaligned",
				series: [
					{ name: "A", points: [{ x: "Jan", y: 1 }, { x: "Feb", y: 2 }] },
					{ name: "B", points: [{ x: "Jan", y: 2 }, { x: "Mar", y: 3 }] },
				],
			}),
		).rejects.toThrow(/different x label/);
	});
});
