import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import asciichart from "asciichart";
import { exposureFor } from "./loadout/policy.ts";
import { createChartTool } from "./inline-charts/tool.ts";
import { formatValue, type ChartDetails } from "./inline-charts/core.ts";
export { chartParameters } from "./inline-charts/tool.ts";
const MAX_POINTS_PER_SERIES = 100;
const MIN_CHART_WIDTH = 24;
const CHART_HEIGHT = 10;
const BLOCK = "█";

export type { ChartDetails, Point, Series } from "./inline-charts/core.ts";

function downsample(values: number[], width: number): number[] {
	if (values.length <= width) return values;
	const step = values.length / width;
	return Array.from({ length: width }, (_, index) => {
		const start = Math.floor(index * step);
		const end = Math.max(start + 1, Math.floor((index + 1) * step));
		const bucket = values.slice(start, end);
		return bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
	});
}

export { formatValue };

function chartWidth(width: number): number {
	return Math.max(1, Math.min(MAX_POINTS_PER_SERIES, width - 14));
}

function renderLineChart(details: ChartDetails, width: number): string[] {
	if (width < MIN_CHART_WIDTH) return [`Need ${MIN_CHART_WIDTH}+ columns.`];
	const values = details.series.map((item) => downsample(item.points.map((point) => point.y), chartWidth(width)));
	const plot = asciichart.plot(values.length === 1 ? values[0]! : values, {
		height: CHART_HEIGHT,
		format: (value: number) => formatValue(value, details.unit).padStart(9),
	});
	const labels = details.series[0]!.points;
	const labelLine = `${labels[0]!.x} → ${labels[labels.length - 1]!.x}`;
	return [...plot.split("\n"), labelLine];
}

function renderBarChart(details: ChartDetails, width: number): string[] {
	if (width < MIN_CHART_WIDTH) return [`Need ${MIN_CHART_WIDTH}+ columns.`];
	const items = details.series.flatMap((series) =>
		series.points.map((point) => ({
			label: details.series.length === 1 ? point.x : `${series.name} · ${point.x}`,
			value: point.y,
		})),
	);
	const visibleItems = items.slice(0, Math.min(items.length, 24));
	const maxLabel = Math.min(18, Math.max(...visibleItems.map((item) => item.label.length)));
	const maxValue = Math.max(...visibleItems.map((item) => Math.abs(item.value)), 1);
	const valueWidth = Math.max(...visibleItems.map((item) => formatValue(item.value, details.unit).length));
	const barWidth = Math.max(1, width - maxLabel - valueWidth - 7);
	const lines = visibleItems.map((item) => {
		const label = item.label.length > maxLabel ? `${item.label.slice(0, maxLabel - 1)}…` : item.label;
		const bar = BLOCK.repeat(Math.round((Math.abs(item.value) / maxValue) * barWidth));
		const sign = item.value < 0 ? "−" : " ";
		return `${label.padEnd(maxLabel)} ${sign}${bar} ${formatValue(item.value, details.unit)}`;
	});
	if (items.length > visibleItems.length) lines.push(`Showing ${visibleItems.length} of ${items.length} values.`);
	return lines;
}

export function renderChartLines(details: ChartDetails, width: number, expanded: boolean): string[] {
	const chart = details.type === "line" ? renderLineChart(details, width) : renderBarChart(details, width);
	const legend = details.series.map((item) => item.name).join(" · ");
	const summary = `range ${formatValue(details.min, details.unit)} to ${formatValue(details.max, details.unit)}`;
	const lines = [details.title, ...(details.subtitle ? [details.subtitle] : []), legend, ...chart, summary];
	if (expanded) {
		lines.push("Latest values:", ...details.lastValues.map((item) => `${item.name}: ${formatValue(item.value, details.unit)}`));
	}
	return lines.map((line) => truncateToWidth(line, width));
}

function chartComponent(details: ChartDetails, expanded: boolean, theme: { fg(color: string, text: string): string; bold(text: string): string }) {
	return {
		render(width: number): string[] {
			const lines = renderChartLines(details, width, expanded);
			const headerLines = details.subtitle ? 2 : 1;
			return lines.map((line, index) => {
				if (index === 0) return theme.fg("toolTitle", theme.bold(line));
				if (index <= headerLines) return theme.fg("muted", line);
				if (line.startsWith("range ") || line === "Latest values:") return theme.fg("dim", line);
				return theme.fg("toolOutput", line);
			});
		},
		invalidate() {},
	};
}

export default function inlineCharts(pi: ExtensionAPI) {
	pi.registerTool({
		...createChartTool(),
		exposure: exposureFor("render_chart"),
		renderCall(args, theme) {
			return new Text(`${theme.fg("accent", "▥ render chart")} ${theme.fg("toolTitle", args.title)}${theme.fg("dim", ` · ${args.type}`)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as ChartDetails | undefined;
			if (!details) return new Text(theme.fg(isPartial ? "warning" : "error", isPartial ? "rendering chart…" : "Chart data unavailable"), 0, 0);
			return chartComponent(details, expanded, theme);
		},
	});
}
