import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import asciichart from "asciichart";
import { Type } from "typebox";

const MAX_SERIES = 8;
const MAX_POINTS_PER_SERIES = 100;
const MAX_TEXT_LENGTH = 80;
const MIN_CHART_WIDTH = 24;
const CHART_HEIGHT = 10;
const BLOCK = "█";

type ChartType = "line" | "bar";

export interface Point {
	x: string;
	y: number;
}

export interface Series {
	name: string;
	points: Point[];
}

export interface ChartDetails {
	type: ChartType;
	title: string;
	subtitle?: string;
	unit?: string;
	series: Series[];
	min: number;
	max: number;
	lastValues: Array<{ name: string; value: number }>;
}

const pointSchema = Type.Object({
	x: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
	y: Type.Number(),
});

const seriesSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
	points: Type.Array(pointSchema, { minItems: 1, maxItems: MAX_POINTS_PER_SERIES }),
});

export const chartParameters = Type.Object({
	type: StringEnum(["line", "bar"] as const, { description: "Line for trends over ordered observations; bar for category comparisons." }),
	title: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
	subtitle: Type.Optional(Type.String({ maxLength: MAX_TEXT_LENGTH })),
	unit: Type.Optional(Type.String({ maxLength: 24, description: "Optional unit shown beside summary values, for example %, USD, or ms." })),
	series: Type.Array(seriesSchema, { minItems: 1, maxItems: MAX_SERIES }),
});

function fail(message: string): never {
	throw new Error(`render_chart: ${message}`);
}

function assertFiniteData(series: Series[]): void {
	for (const item of series) {
		for (const point of item.points) {
			if (!Number.isFinite(point.y)) fail(`non-finite value in series ${JSON.stringify(item.name)}`);
		}
	}
}

function assertAlignedLineSeries(series: Series[]): void {
	if (series.length < 2) return;
	const reference = series[0]!.points;
	for (const item of series.slice(1)) {
		if (item.points.length !== reference.length) {
			fail(`line series ${JSON.stringify(item.name)} must have ${reference.length} points to align with ${JSON.stringify(series[0]!.name)}`);
		}
		for (let index = 0; index < reference.length; index++) {
			if (item.points[index]!.x !== reference[index]!.x) {
				fail(`line series ${JSON.stringify(item.name)} has a different x label at point ${index + 1}`);
			}
		}
	}
}

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

export function formatValue(value: number, unit?: string): string {
	const absolute = Math.abs(value);
	let text: string;
	if (absolute >= 1_000_000_000) text = `${(value / 1_000_000_000).toFixed(2)}B`;
	else if (absolute >= 1_000_000) text = `${(value / 1_000_000).toFixed(2)}M`;
	else if (absolute >= 1_000) text = `${(value / 1_000).toFixed(2)}K`;
	else if (Number.isInteger(value)) text = String(value);
	else text = value.toFixed(2);
	return unit ? `${text} ${unit}` : text;
}

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
		name: "render_chart",
		label: "Render chart",
		description: "Render validated numeric data as an inline terminal line or bar chart. This is display-only: obtain data with another tool first.",
		promptSnippet: "Render inline terminal line or bar charts from small, already-available numeric datasets",
		promptGuidelines: [
			"Use render_chart only when a line or bar chart makes a trend or comparison clearer than a compact table; obtain data before calling it.",
			"Use render_chart with finite numeric values, no more than 8 series and 100 points per series; use a table when exact values are the primary need.",
		],
		parameters: chartParameters,
		async execute(_toolCallId, params) {
			const series = params.series as Series[];
			assertFiniteData(series);
			if (params.type === "line") assertAlignedLineSeries(series);
			const values = series.flatMap((item) => item.points.map((point) => point.y));
			const details: ChartDetails = {
				type: params.type as ChartType,
				title: params.title,
				subtitle: params.subtitle,
				unit: params.unit,
				series,
				min: Math.min(...values),
				max: Math.max(...values),
				lastValues: series.map((item) => ({ name: item.name, value: item.points[item.points.length - 1]!.y })),
			};
			return {
				content: [{ type: "text", text: `Rendered ${details.type} chart: ${details.title} (${details.series.length} series; ${formatValue(details.min, details.unit)} to ${formatValue(details.max, details.unit)}).` }],
				details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("accent", "▥ render chart")} ${theme.fg("toolTitle", args.title)}${theme.fg("dim", ` · ${args.type}`)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "rendering chart…"), 0, 0);
			const details = result.details as ChartDetails | undefined;
			if (!details) return new Text(theme.fg("error", "Chart data unavailable"), 0, 0);
			return chartComponent(details, expanded, theme);
		},
	});
}
