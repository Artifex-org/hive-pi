import { Type } from "typebox";

const MAX_SERIES = 8;
const MAX_POINTS_PER_SERIES = 100;
const MAX_TEXT_LENGTH = 80;

type ChartType = "line" | "bar";

export interface Point { x: string; y: number }
export interface Series { name: string; points: Point[] }
export interface ChartDetails {
	type: ChartType;
	title: string;
	subtitle?: string;
	unit?: string;
	series: Series[];
	min: number;
	max: number;
	lastValues: Array<{ name: string; value: number }>;
	chart_id?: string;
}

const pointSchema = Type.Object({ x: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }), y: Type.Number() });
const seriesSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
	points: Type.Array(pointSchema, { minItems: 1, maxItems: MAX_POINTS_PER_SERIES }),
});

/** Static data-only schema, also exposed by the Claude MCP adapter. */
export const chartParameters = Type.Object({
	type: Type.Union([Type.Literal("line"), Type.Literal("bar")], { description: "Line for trends over ordered observations; bar for category comparisons." }),
	title: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
	subtitle: Type.Optional(Type.String({ maxLength: MAX_TEXT_LENGTH })),
	unit: Type.Optional(Type.String({ maxLength: 24, description: "Optional unit shown beside summary values, for example %, USD, or ms." })),
	chart_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	series: Type.Array(seriesSchema, { minItems: 1, maxItems: MAX_SERIES }),
});

function fail(message: string): never { throw new Error(`render_chart: ${message}`); }

type ChartInput = { type: ChartType; title: string; subtitle?: string; unit?: string; chart_id?: string; series: Series[] };

export function buildDetails(input: ChartInput): ChartDetails {
	if (input.type !== "line" && input.type !== "bar") fail("type must be line or bar");
	if (typeof input.title !== "string" || input.title.length < 1 || input.title.length > MAX_TEXT_LENGTH) fail("title must be 1 to 80 characters");
	if (input.subtitle !== undefined && (typeof input.subtitle !== "string" || input.subtitle.length > MAX_TEXT_LENGTH)) fail("subtitle must be at most 80 characters");
	if (input.unit !== undefined && (typeof input.unit !== "string" || input.unit.length > 24)) fail("unit must be at most 24 characters");
	if (input.chart_id !== undefined && (typeof input.chart_id !== "string" || input.chart_id.length < 1 || input.chart_id.length > 120 || input.chart_id !== input.chart_id.trim())) fail("chart_id must be 1 to 120 characters without surrounding whitespace");
	const series = input.series;
	if (!Array.isArray(series) || series.length < 1 || series.length > MAX_SERIES) fail(`series must contain 1 to ${MAX_SERIES} series`);
	for (const item of series) {
		if (!item || typeof item.name !== "string" || !item.name || item.name.length > MAX_TEXT_LENGTH || !Array.isArray(item.points) || item.points.length < 1 || item.points.length > MAX_POINTS_PER_SERIES) fail("malformed series (limit is 8 series x 100 points)");
		const labels = new Set<string>();
		for (const point of item.points) {
			if (!point || typeof point.x !== "string" || !point.x.trim() || point.x.length > MAX_TEXT_LENGTH || typeof point.y !== "number" || !Number.isFinite(point.y)) fail("malformed point or non-finite value");
			const label = point.x.trim();
			if (labels.has(label)) fail("x labels must be unique within a series (after trimming); aggregate repeated observations");
			labels.add(label);
		}
	}
	if (input.type === "line" && series.length > 1) {
		const reference = series[0]!.points;
		for (const item of series.slice(1)) {
			if (item.points.length !== reference.length) fail(`line series ${JSON.stringify(item.name)} must have ${reference.length} points to align with ${JSON.stringify(series[0]!.name)}`);
			for (let index = 0; index < reference.length; index++) if (item.points[index]!.x !== reference[index]!.x) fail(`line series ${JSON.stringify(item.name)} has a different x label at point ${index + 1}`);
		}
	}
	const values = series.flatMap((item) => item.points.map((point) => point.y));
	return { type: input.type, title: input.title, subtitle: input.subtitle, unit: input.unit, chart_id: input.chart_id, series, min: Math.min(...values), max: Math.max(...values), lastValues: series.map((item) => ({ name: item.name, value: item.points[item.points.length - 1]!.y })) };
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

export async function executeChart(params: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: ChartDetails }> {
	if (!params || typeof params !== "object" || Array.isArray(params)) fail("parameters must be an object");
	const input = params as Record<string, unknown>;
	if ("source_file" in input || "timeout_seconds" in input) fail("source_file and timeout_seconds are unavailable; provide static series");
	if (!Array.isArray(input.series)) fail("series is required");
	const details = buildDetails(input as unknown as ChartInput);
	return chartResult(details);
}

export function chartResult(details: ChartDetails) {
	return { content: [{ type: "text" as const, text: `Rendered ${details.type} chart: ${details.title} (${details.series.length} series; ${formatValue(details.min, details.unit)} to ${formatValue(details.max, details.unit)}).` }], details };
}

export const chartToolDefinition = {
	name: "render_chart",
	label: "Render chart",
	description: "Render validated numeric data as an inline terminal line or bar chart. This is display-only: obtain data with another tool first.",
	promptSnippet: "Render inline terminal line or bar charts from small, already-available numeric datasets",
	promptGuidelines: [
		"Use render_chart only when a line or bar chart makes a trend or comparison clearer than a compact table; obtain data before calling it.",
		"Use render_chart with finite numeric values, no more than 8 series and 100 points per series; use a table when exact values are the primary need.",
	],
	parameters: chartParameters,
	execute: executeChart,
};
