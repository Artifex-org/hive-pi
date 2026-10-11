// Dependency-light live tool shared by workstation and trusted cloud pi.
// Claude deliberately uses the static descriptor: its transport has no updates.
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { buildDetails, chartParameters as staticChartParameters, chartResult, chartToolDefinition } from "./core.ts";
import { watchChartSource } from "./source.ts";

export const chartParameters = Type.Object({
	...staticChartParameters.properties,
	source_file: Type.Optional(Type.String({ minLength: 1, description: "Existing regular JSONL feed produced by a separately guarded background job; resolved against execution cwd." })),
	timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })),
	series: Type.Optional(staticChartParameters.properties.series),
});

function fail(message: string): never { throw new Error(`render_chart: ${message}`); }

export function createChartTool() {
	const activeChartIds = new Set<string>();
	return {
		...chartToolDefinition,
		description: "Render validated numeric data as a line or bar chart. Optionally observe full JSONL snapshots in source_file from a separately owned background job; never executes commands.",
		parameters: chartParameters,
		async execute(_id: string, input: Static<typeof chartParameters>, signal: AbortSignal | undefined, onUpdate: ((value: ReturnType<typeof chartResult>) => void) | undefined, context: { cwd: string; sessionManager?: { getSessionId(): string } }) {
			if (input.type !== "line" && input.type !== "bar") fail("type must be line or bar");
			if (input.timeout_seconds !== undefined && (!Number.isFinite(input.timeout_seconds) || input.timeout_seconds < 1 || input.timeout_seconds > 300)) fail("timeout_seconds must be a finite number between 1 and 300");
			const claim = JSON.stringify([context?.sessionManager?.getSessionId() ?? "", input.chart_id]);
			if (input.chart_id && activeChartIds.has(claim)) fail(`chart_id ${JSON.stringify(input.chart_id)} already has an active source observer in this tool session`);
			if (!input.source_file) {
				if (!input.series) fail("series is required without source_file");
				return chartResult(buildDetails({ ...input, series: input.series }));
			}
			if (typeof input.chart_id !== "string" || input.chart_id.length < 1 || input.chart_id.length > 120 || input.chart_id !== input.chart_id.trim()) fail("chart_id must be 1 to 120 characters without surrounding whitespace with source_file");
			activeChartIds.add(claim);
			try {
				return chartResult(await watchChartSource(resolve(context.cwd, input.source_file), { ...input, chart_id: input.chart_id }, signal, onUpdate, chartResult, buildDetails));
			} finally {
				activeChartIds.delete(claim);
			}
		},
	};
}
