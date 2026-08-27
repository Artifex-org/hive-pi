import type { PlanDoc } from "./state.ts";

export interface PlanLintIssue {
	kind: "diagram" | "table" | "metrics" | "checklist" | "ticket";
	message: string;
}

// Keep this aligned with hive web/src/lib/agentTickets.ts: a wrong ticket nudge
// trains readers to dismiss all lint, while a missed suggestion is cheap.
const NOT_A_TEAM = new Set(["UTF", "HTTP", "IPV", "TLS", "SHA", "RFC", "ISO", "GO", "JS", "TS", "NODE", "REACT", "VITE"]);
/**
 * Prose that describes a SHAPE — something with parts and an order.
 *
 * Two corrections after measuring this rule against real sentences:
 *
 * `stage`/`flow`/`state` were matched WITHOUT their plurals, so the most
 * natural phrasing a plan actually uses — "the pipeline has five stages", "the
 * request flows through the cache" — was the case it missed. A rule that fires
 * on the singular and not the plural is a rule that fires on the rarer half.
 *
 * `call` came out, because it does not mean what it meant in the spec. There it
 * stood for "what calls what"; in a plan the word is almost always "call sites"
 * or "a call to the helper", and matching it told an author asserting a QUANTITY
 * to go and draw a diagram. Wrong advice is worse than silence — it is how a
 * reader learns the lint has nothing to say. `→` already carries the
 * "A calls B" case, and carries it unambiguously.
 */
const DESCRIBES_A_SHAPE = /\b(?:stages?|flows?|states?|state machines?|pipelines?|lifecycles?)\b|→/i;

/**
 * Prose that names verification.
 *
 * The leading `\b` is the whole point: `test(?:ing)?\b` with no left anchor
 * matches the tail of ordinary words, so "The **latest** run was green" and
 * "the pro**test**" both asked for a verification checklist. Two of the most
 * common words in a status sentence, firing a nudge about something else.
 */
const NAMES_VERIFICATION = /\b(?:verif(?:y|ies|ication)|tests?|testing)\b/i;

const ASSERTED_QUANTITY = /\b(?:about|around|approximately)?\s*\d+(?:\.\d+)?\s*(?:%|percent\b|stages?\b|steps?\b|callers?\b|files?\b|tests?\b|shards?\b|sessions?\b|items?\b|rows?\b|ms\b|seconds?\b|minutes?\b|hours?\b)/i;

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
	if (!types.has("diagram") && DESCRIBES_A_SHAPE.test(text)) issues.push({ kind: "diagram", message: "This plan describes a flow or states in prose; consider a diagram block." });
	if (!types.has("table") && /\b(option|alternative|compare|versus|vs\.)\b/i.test(text)) issues.push({ kind: "table", message: "This plan compares options in prose; consider a table block." });
	if (!types.has("metrics") && !types.has("chart") && ASSERTED_QUANTITY.test(text)) issues.push({ kind: "metrics", message: "This plan cites an asserted quantity in prose; consider metrics or a chart." });
	if (!types.has("checklist") && NAMES_VERIFICATION.test(text)) issues.push({ kind: "checklist", message: "This plan names verification without a checklist block." });
	const ticket = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
	if (!types.has("ticket") && !types.has("refs") && [...text.matchAll(ticket)].some((match) => !NOT_A_TEAM.has(match[1]))) issues.push({ kind: "ticket", message: "This plan names a ticket key without a ticket or refs block." });
	return issues;
}
