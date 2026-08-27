import type { PlanDoc } from "./state.ts";

export interface PlanLintIssue {
	kind: "diagram" | "table" | "metrics" | "checklist" | "ticket" | "milestone";
	message: string;
}

const prose = (doc: PlanDoc) =>
	doc.blocks
		.filter((block): block is Extract<typeof block, { type: "text" | "callout" }> => block.type === "text" || block.type === "callout")
		.map((block) => block.markdown)
		.join("\n");

/**
 * Advisory only: these patterns point authors toward a representation that
 * readers can inspect faster. They never reject a plan because prose remains a
 * valid choice when it is genuinely clearer.
 */
export function lintPlanComposition(doc: PlanDoc): PlanLintIssue[] {
	const text = prose(doc);
	const types = new Set(doc.blocks.map((block) => block.type));
	const issues: PlanLintIssue[] = [];
	if (!types.has("diagram") && /\b(stage|flow|call(?:s)?|state)\b|→/i.test(text)) issues.push({ kind: "diagram", message: "This plan describes a flow or states in prose; consider a diagram block." });
	if (!types.has("table") && /\b(option|alternative|compare|versus|vs\.)\b/i.test(text)) issues.push({ kind: "table", message: "This plan compares options in prose; consider a table block." });
	if (!types.has("metrics") && !types.has("chart") && /\b\d+(?:\.\d+)?\b/.test(text)) issues.push({ kind: "metrics", message: "This plan cites numbers in prose; consider metrics or a chart." });
	if (!types.has("checklist") && /\bverify|verification|test(?:ing)?\b/i.test(text)) issues.push({ kind: "checklist", message: "This plan names verification without a checklist block." });
	if (!types.has("ticket") && !types.has("refs") && /\b[A-Z][A-Z0-9]+-\d+\b/.test(text)) issues.push({ kind: "ticket", message: "This plan names a ticket key without a ticket or refs block." });
	if (!types.has("milestone") && /\b(milestone|session start|active project)\b/i.test(text)) issues.push({ kind: "milestone", message: "This plan mentions a project milestone without a milestone block." });
	return issues;
}
