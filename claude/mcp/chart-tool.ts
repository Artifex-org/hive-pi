import { chartParameters, chartToolDefinition, executeChart } from "../../extensions/inline-charts/core.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

export const RENDER_CHART_TOOL: ToolDefinition = {
	name: "render_chart",
	description: `${chartToolDefinition.description} Provide series directly; live source feeds are available only in pi.`,
	inputSchema: chartParameters as unknown as Record<string, unknown>,
};

export async function renderChartTool(args: Record<string, unknown>): Promise<ToolResult> {
	const result = await executeChart(args);
	return { text: JSON.stringify({ content: result.content, details: result.details }) };
}
