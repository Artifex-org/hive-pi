import type { PlanDoc } from "./state.ts";

export interface PlanLintIssue {
	kind: "diagram" | "table" | "metrics" | "checklist" | "ticket" | "explain" | "evidence";
	message: string;
}

/**
 * Blocks that make a claim INSPECTABLE rather than merely asserted.
 *
 * `text` and `callout` are deliberately absent: they are prose, and prose is the
 * thing the rest of this file exists to point away from when something better
 * exists. `steps` is absent for the same reason it is not evidence — it says
 * what will be done, never what was found.
 */
const EVIDENCE_BLOCKS = ["diagram", "chart", "table", "metrics", "checklist", "code", "refs", "ticket", "milestone", "decision"] as const;

/**
 * Work items across every lane — the plan's SIZE, in the only unit that means
 * anything to a reader. Block count would not do: a plan is one `steps` block
 * whether it holds two items or twenty.
 */
const workItemCount = (doc: PlanDoc) =>
	doc.blocks.reduce((total, block) => total + (block.type === "steps" ? block.steps.length : 0), 0);

/**
 * The threshold below which a plan owes nobody an explanation.
 *
 * Measured over 668 sessions: task lists average 4.4 items. A two- or
 * three-item plan is usually a genuinely small piece of work whose steps ARE
 * the explanation, and firing on it would teach authors that this lint does not
 * know what it is talking about — the failure mode that costs a linter its
 * readers. Four is where "a list of steps with no reasoning attached" starts
 * being a real omission rather than an appropriately terse plan.
 */
const OWES_AN_EXPLANATION = 4;

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
 *
 * TWO KINDS OF RULE LIVE HERE, and the second exists because the first was
 * measured to be insufficient.
 *
 * The MISMATCH rules below key on prose that already exists: the plan says
 * "stages", so offer a diagram. They were shipped 2026-08-28 and the block mix
 * did not move — 44% of 487 plans were still prose-and-checklist only, against
 * a 43% baseline before them, at an average of 3.0 blocks per plan. Chart and
 * artifact stayed at 0%, diagram and metrics at 1%.
 *
 * The reason is structural rather than a tuning problem: **a rule that reads
 * prose cannot ask for prose that is not there.** The typical plan is one
 * `steps` block and a `callout`, which offers almost nothing to match, so the
 * lint was silent on precisely the plans that needed it most and voluble on the
 * few that were already rich.
 *
 * The ABSENCE rules fix that by keying on the plan's SHAPE instead. They are the
 * only two that can fire on an empty-prose plan, and they are deliberately the
 * gentlest possible version — one asks for a reason, the other for a single
 * piece of evidence, and both stay quiet under `OWES_AN_EXPLANATION`.
 */
export function lintPlanComposition(doc: PlanDoc): PlanLintIssue[] {
	const text = prose(doc);
	const types = new Set(doc.blocks.map((block) => block.type));
	const issues: PlanLintIssue[] = [];
	const items = workItemCount(doc);

	// ABSENCE RULES — see the note above. Ordered first because a plan missing
	// its reasoning has a bigger problem than a plan whose flow wants a diagram.
	if (items >= OWES_AN_EXPLANATION && !types.has("text")) {
		issues.push({
			kind: "explain",
			message: `This plan lists ${items} steps and never says why. Add a text block: what you found, what you considered, and why this approach — a reader who was not here cannot reconstruct it from the steps.`,
		});
	}
	if (items >= OWES_AN_EXPLANATION && !EVIDENCE_BLOCKS.some((type) => types.has(type))) {
		issues.push({
			kind: "evidence",
			message: "This plan is prose and a checklist. Whatever convinced you — the shape you traced, the options you weighed, the numbers you measured, the files you read — belongs in a diagram, table, chart, metrics, code or refs block, where the reader can check it instead of taking it on trust.",
		});
	}

	if (!types.has("diagram") && DESCRIBES_A_SHAPE.test(text)) issues.push({ kind: "diagram", message: "This plan describes a flow or states in prose; consider a diagram block." });
	if (!types.has("table") && /\b(option|alternative|compare|versus|vs\.)\b/i.test(text)) issues.push({ kind: "table", message: "This plan compares options in prose; consider a table block." });
	if (!types.has("metrics") && !types.has("chart") && ASSERTED_QUANTITY.test(text)) issues.push({ kind: "metrics", message: "This plan cites an asserted quantity in prose; consider metrics or a chart." });
	if (!types.has("checklist") && NAMES_VERIFICATION.test(text)) issues.push({ kind: "checklist", message: "This plan names verification without a checklist block." });
	const ticket = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
	if (!types.has("ticket") && !types.has("refs") && [...text.matchAll(ticket)].some((match) => !NOT_A_TEAM.has(match[1]))) issues.push({ kind: "ticket", message: "This plan names a ticket key without a ticket or refs block." });
	return issues;
}
