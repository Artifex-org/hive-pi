/**
 * context-tree — the pure half: session transcript in, one row per agent out.
 *
 * ## The invariant this file exists to hold
 *
 * Every row's token figure is that agent's OWN spend, with descendants
 * EXCLUDED, so `sum(ownTokens over all rows) === grand total`. A tree that
 * puts subtree sums in the rows double-counts every ancestor, and the column
 * then answers no question at all: you cannot read "which agent was
 * expensive" off it, because the root always wins.
 *
 * Exclusivity is nearly free here, and it is worth knowing why rather than
 * trusting it. Each agent is a SEPARATE `pi` process (subagent spawns one per
 * task; the orchestrate executor spawns one per node), and a process bills
 * only the LLM calls it makes itself. A child's spend therefore appears
 * nowhere in the parent's own numbers — it is reachable only through the
 * child's `details`. So the failure mode to guard is not double-counting, it
 * is silently MISSING a level: fail to recurse into a subagent's transcript
 * and its own subagents vanish from the total. Hence `childrenOf` recurses
 * through `result.messages`.
 *
 * ## What "tokens" means in this column
 *
 * input + output, matching `harness/usage.ts:budgetTokens` — which is what
 * the orchestrate executor already journals per node
 * (`rpc-protocol.ts:184`, `spawn.ts:156`). Cache reads/writes are excluded.
 * Mixing definitions across rows would be worse than either choice: the
 * orchestrate rows arrive pre-summed by that definition and cannot be
 * recomputed from here, so everything else adopts it.
 *
 * ## Why cost is a scope, not a number
 *
 * pi bills dollars per LLM response, but not every producer forwards them
 * per-agent. Three genuinely different cases, and collapsing them to `0.00`
 * is the "wrong in the flattering direction" failure `harness/usage.ts` was
 * written about:
 *
 *   "row"       — this agent's own dollars, measured.
 *   "aggregate" — one figure covering this row AND its descendants. The
 *                 orchestrate executor sums `spentCost` for the whole run and
 *                 never breaks it down, so it sits on the group row. The
 *                 column still sums exactly, because the aggregate is on
 *                 exactly ONE row. A run that reports NO dollars is not an
 *                 aggregate of zero — it is "unknown", below.
 *   "covered"   — an ancestor's aggregate already accounts for this row. Also
 *                 renders "—", but it is NOT a gap: conflating it with
 *                 "unknown" made the report claim four rows were unpriced
 *                 when only one was.
 *   "unknown"   — tokens were spent, here or below this row, and the dollar
 *                 figure is absent (an unpriced model reports cost 0).
 *                 Rendered "—", never $0.00, and counted in `unpricedRows` so
 *                 the report can say the total is a floor.
 *
 * Nothing here touches pi, the clock, or the filesystem: it takes plain data
 * and returns plain data, which is what makes the invariant testable.
 */

import { formatTokens } from "../status-footer/render.ts";

export type AgentKind = "session" | "subagent" | "orchestrate" | "worker";

/** See the header. Only `unknown` is a genuine hole in the accounting. */
export type CostScope = "row" | "aggregate" | "covered" | "unknown";

export interface AgentNode {
	id: string;
	label: string;
	kind: AgentKind;
	/** input + output for THIS agent alone. Descendants excluded. */
	ownTokens: number;
	/** Dollars for this row, under `costScope`. 0 when `costScope` is "unknown". */
	ownCostUsd: number;
	costScope: CostScope;
	/** Live context-window fill, when the producer reports it. */
	contextTokens: number | null;
	/** The window those tokens are measured against. Only the session knows its own. */
	contextWindow: number | null;
	children: AgentNode[];
}

export interface RootFacts {
	label: string;
	contextTokens: number | null;
	contextWindow: number | null;
}

// --------------------------------------------------------------- narrowing

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Finite, or 0 — one NaN would poison every sum downstream of it. */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The message inside a transcript element.
 *
 * Two shapes reach this parser and both are legitimate: the live session is a
 * list of SessionEntry (`{ type: "message", message: {…} }`), while a
 * subagent's own transcript, carried in its result's `messages`, is a bare
 * `Message[]`. Accepting either is what lets one recursion walk the whole
 * tree instead of two near-identical ones.
 */
function messageOf(entry: unknown): Record<string, unknown> | null {
	const record = asRecord(entry);
	if (!record) return null;
	const inner = asRecord(record.message);
	if (inner && typeof inner.role === "string") return inner;
	return typeof record.role === "string" ? record : null;
}

// ------------------------------------------------------------------ parsing

/**
 * One agent's OWN spend: its assistant messages, nothing else.
 *
 * Deliberately ignores toolResult-level `usage` (the advisor sets it so pi
 * folds a consultation into the session totals). Counting it here would
 * attribute a child process's bill to its parent, which is exactly the
 * double-count this file is built to avoid. The consequence, worth stating:
 * `/context` reconciles with status-footer's session line, not with a
 * provider invoice.
 */
export function foldOwnUsage(messages: readonly unknown[]): { tokens: number; costUsd: number } {
	let tokens = 0;
	let costUsd = 0;
	for (const raw of messages) {
		const message = messageOf(raw);
		if (!message || message.role !== "assistant") continue;
		const usage = asRecord(message.usage);
		if (!usage) continue;
		tokens += num(usage.input) + num(usage.output);
		// `usage.cost` is an OBJECT — see harness/usage.ts. `Number(cost)` is NaN
		// and `cost ?? 0` is the object; `cost.total` is the only correct read.
		costUsd += num(asRecord(usage.cost)?.total);
	}
	return { tokens, costUsd };
}

/** `subagent`'s `details.results[]` — one node per task, recursing into each one's transcript. */
function subagentNodes(details: Record<string, unknown>, idBase: string): AgentNode[] {
	if (!Array.isArray(details.results)) return [];
	const nodes: AgentNode[] = [];
	details.results.forEach((raw, index) => {
		const result = asRecord(raw);
		// A `usage` object is the discriminator, not decoration: `details.results`
		// is a plausible enough shape that some future tool will emit it, and a
		// phantom zero-token "subagent" row is exactly the kind of wrong number
		// this readout must not invent.
		const usage = result && asRecord(result.usage);
		if (!result || !usage) return;
		const tokens = num(usage.input) + num(usage.output);
		const costUsd = num(usage.cost);
		// Cost 0 against real tokens is an unpriced model, not a free agent.
		const costScope: CostScope = tokens > 0 && costUsd <= 0 ? "unknown" : "row";
		nodes.push({
			id: `${idBase}#${index}`,
			label: text(result.agent) ?? "subagent",
			kind: "subagent",
			ownTokens: tokens,
			ownCostUsd: costUsd,
			costScope,
			contextTokens: positive(usage.contextTokens),
			// A worker's context window is not on the wire, and resolving another
			// process's model here would be wiring this module must not have. The
			// cell degrades to a bare token count instead of guessing a divisor.
			contextWindow: null,
			children: Array.isArray(result.messages) ? childrenOf(result.messages) : [],
		});
	});
	return nodes;
}

/**
 * `orchestrate`'s result — one group row with a worker beneath it per node.
 *
 * Per-worker tokens come from the `context-tree` hive_widget envelope the
 * orchestrate half of HIV-1243 already emits (agenda/index.ts), rather than
 * re-folding the journal: that envelope is the shape the workspace renders,
 * so reading it keeps both halves describing the same run the same way.
 *
 * The group's own tokens are the run total MINUS what the workers account
 * for — normally 0, since the executor bills every token to a node. Anything
 * left over is real spend that has no row of its own, and dropping it would
 * break the sum silently.
 */
function orchestrateNodes(details: Record<string, unknown>, idBase: string): AgentNode[] {
	const summary = asRecord(details.summary);
	// Same discriminator reasoning as above: a numeric `spentTokens` is what
	// makes this a run summary rather than any other object called "summary".
	if (!summary || typeof summary.spentTokens !== "number") return [];

	const widget = asRecord(details.hive_widget);
	const spec = widget && widget.type === "context-tree" ? asRecord(widget.spec) : null;
	const rows = spec && Array.isArray(spec.rows) ? spec.rows : [];

	const workers: AgentNode[] = [];
	rows.forEach((raw, index) => {
		const row = asRecord(raw);
		if (!row) return;
		workers.push({
			id: `${idBase}~${index}`,
			label: text(row.name) ?? `node ${index}`,
			kind: "worker",
			ownTokens: num(row.tokens),
			ownCostUsd: 0,
			// The executor sums dollars for the whole run only; the group row above
			// carries them. Accounted for, just not here — not a gap.
			costScope: "covered",
			contextTokens: null,
			contextWindow: null,
			children: [],
		});
	});

	const spent = num(summary.spentTokens);
	const spentCost = num(summary.spentCost);
	const attributed = workers.reduce((total, worker) => total + worker.ownTokens, 0);
	return [
		{
			id: idBase,
			label: `orchestrate (${workers.length} worker${workers.length === 1 ? "" : "s"})`,
			kind: "orchestrate",
			ownTokens: Math.max(0, spent - attributed),
			ownCostUsd: spentCost,
			// The run's dollars are an aggregate ONLY when there are dollars. The
			// executor sums `result.cost ?? 0` across its workers, so a fan-out of
			// unpriced models yields a run that really spent `spentTokens` and
			// reports $0 — and this row usually has no own tokens of its own to
			// betray that, because the workers hold them all. Calling it an
			// aggregate then prints a confident zero over a whole run's unknown
			// bill and marks its workers "covered" by something that is not there.
			costScope: spent > 0 && spentCost <= 0 ? "unknown" : "aggregate",
			contextTokens: null,
			contextWindow: null,
			children: workers,
		},
	];
}

/** Every agent spawned from one transcript, in the order it was spawned. */
function childrenOf(messages: readonly unknown[]): AgentNode[] {
	const nodes: AgentNode[] = [];
	let seq = 0;
	for (const raw of messages) {
		const message = messageOf(raw);
		if (!message || message.role !== "toolResult") continue;
		const details = asRecord(message.details);
		if (!details) continue;
		const id = text(message.toolCallId) ?? `call-${seq}`;
		seq += 1;
		// The two shapes are disjoint: `subagent` puts a `results` array at the
		// top level, `orchestrate` puts a `summary` object there. Checking both
		// costs nothing and means a future producer of either shape is picked up
		// without a tool-name allow-list to maintain.
		nodes.push(...subagentNodes(details, id), ...orchestrateNodes(details, id));
	}
	return nodes;
}

export function buildTree(branch: readonly unknown[], root: RootFacts): AgentNode {
	const own = foldOwnUsage(branch);
	return {
		id: "session",
		label: root.label,
		kind: "session",
		ownTokens: own.tokens,
		ownCostUsd: own.costUsd,
		costScope: own.tokens > 0 && own.costUsd <= 0 ? "unknown" : "row",
		contextTokens: root.contextTokens,
		contextWindow: root.contextWindow,
		children: childrenOf(branch),
	};
}

// -------------------------------------------------------------------- sums

export interface TreeRow {
	node: AgentNode;
	depth: number;
}

export function flatten(node: AgentNode, depth = 0): TreeRow[] {
	return [{ node, depth }, ...node.children.flatMap((child) => flatten(child, depth + 1))];
}

/** The check the whole feature rests on: rows in, one total out. */
export function subtreeTokens(node: AgentNode): number {
	return flatten(node).reduce((total, row) => total + row.node.ownTokens, 0);
}

export function subtreeCostUsd(node: AgentNode): number {
	return flatten(node).reduce((total, row) => total + row.node.ownCostUsd, 0);
}

export interface Totals {
	tokens: number;
	costUsd: number;
	agents: number;
	/**
	 * Rows that spent tokens and reported no dollars at all. The report says so.
	 *
	 * Measured over the row's SUBTREE, not its own tokens: an orchestrate group
	 * whose price is missing has 0 own tokens (the workers carry them) yet is
	 * the row where a whole run's bill went missing. For a leaf the two are the
	 * same number, so nothing else changes.
	 */
	unpricedRows: number;
	/**
	 * Rows carrying a FIGURE that also covers their descendants. A zero is not a
	 * figure: a plan of pure transforms spawns nothing and spends nothing, and
	 * counting its `$0` here fires the "* covers that row's workers too"
	 * footnote when no `*` is rendered anywhere to explain.
	 */
	aggregateRows: number;
}

export function totals(root: AgentNode): Totals {
	const rows = flatten(root);
	return {
		tokens: rows.reduce((total, row) => total + row.node.ownTokens, 0),
		costUsd: rows.reduce((total, row) => total + row.node.ownCostUsd, 0),
		agents: rows.length,
		unpricedRows: rows.filter((row) => row.node.costScope === "unknown" && subtreeTokens(row.node) > 0).length,
		aggregateRows: rows.filter((row) => row.node.costScope === "aggregate" && row.node.ownCostUsd > 0).length,
	};
}

// ---------------------------------------------------------------- the bar

export const BAR_WIDTH = 5;
/** Where a context gauge stops being informational and starts being a warning. */
export const WARN_PERCENT = 80;

export function contextPercent(node: AgentNode): number | null {
	if (node.contextTokens === null || node.contextWindow === null || node.contextWindow <= 0) return null;
	return Math.max(0, Math.min(100, (node.contextTokens / node.contextWindow) * 100));
}

/**
 * `▓▓▓░░`. Same clamp as status-footer's gauge — see the README for why that
 * one could not simply be imported — with one added rule it does not need.
 *
 * A FULL BAR MEANS FULL. At the footer's width of 10 a rounded fill is
 * harmless, but this bar is 5 cells wide (one per 20%) and there is a row of
 * them, so plain rounding saturates at 90% — and 90% and 100% are exactly the
 * two readings a warning bar exists to tell apart. The last cell is therefore
 * withheld until the window really is full.
 */
export function contextBar(percent: number, width = BAR_WIDTH): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled =
		clamped >= 100 ? width : Math.min(width - 1, Math.round((clamped / 100) * width));
	return `${"▓".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, width - filled))}`;
}

/**
 * The context cell. Three answers, and they are not the same answer:
 * a bar when the fill AND the window are known, a bare token count when only
 * the fill is (a subagent reports `contextTokens` with no window), and "—"
 * when the producer says nothing at all.
 */
export function contextCell(node: AgentNode): string {
	const percent = contextPercent(node);
	if (percent !== null) return `${contextBar(percent)} ${Math.round(percent)}%`;
	if (node.contextTokens !== null) return `ctx ${formatTokens(node.contextTokens)}`;
	return "—";
}

export function isContextWarning(node: AgentNode): boolean {
	const percent = contextPercent(node);
	return percent !== null && percent >= WARN_PERCENT;
}

// ------------------------------------------------------------- the report

export type LineTone = "head" | "row" | "warn" | "total" | "note";

export interface ReportLine {
	text: string;
	tone: LineTone;
}

/** Four decimals below a cent, two above — a sub-cent agent rounds to `$0.00`. */
export function formatUsd(value: number): string {
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Dollars for a row, honouring the scope. Never `$0.00` for a real spend. */
export function costCell(node: AgentNode): string {
	if (node.costScope === "unknown" || node.costScope === "covered") return "—";
	if (node.ownCostUsd <= 0) return node.ownTokens > 0 ? "—" : "$0";
	const formatted = formatUsd(node.ownCostUsd);
	return node.costScope === "aggregate" ? `${formatted}*` : formatted;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padStart(value: string, width: number): string {
	return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

const LABEL_MIN = 20;
const LABEL_MAX = 44;
const TOKEN_COL = 9;
const COST_COL = 10;

/**
 * The `/context` body, as plain text plus a tone per line. Colour is the
 * caller's job — keeping ANSI out of here is what lets a test assert on the
 * numbers rather than on escape sequences.
 */
export function renderReport(root: AgentNode): ReportLine[] {
	const rows = flatten(root);
	const labels = rows.map((row) => `${"  ".repeat(row.depth)}${row.node.label}`);
	const labelWidth = Math.min(
		LABEL_MAX,
		Math.max(LABEL_MIN, ...labels.map((label) => Math.min(label.length, LABEL_MAX))),
	);
	const clip = (label: string) => (label.length > labelWidth ? `${label.slice(0, labelWidth - 1)}…` : label);

	const lines: ReportLine[] = [
		{
			text: `${pad("agent", labelWidth)} ${padStart("own tok", TOKEN_COL)} ${padStart("own $", COST_COL)}  context`,
			tone: "head",
		},
	];

	rows.forEach((row, index) => {
		lines.push({
			text: `${pad(clip(labels[index]), labelWidth)} ${padStart(formatTokens(row.node.ownTokens), TOKEN_COL)} ${padStart(costCell(row.node), COST_COL)}  ${contextCell(row.node)}`,
			tone: isContextWarning(row.node) ? "warn" : "row",
		});
	});

	const sums = totals(root);
	lines.push({
		text: `${pad(`total (${sums.agents} agent${sums.agents === 1 ? "" : "s"})`, labelWidth)} ${padStart(formatTokens(sums.tokens), TOKEN_COL)} ${padStart(sums.costUsd > 0 ? formatUsd(sums.costUsd) : "—", COST_COL)}`,
		tone: "total",
	});

	// Say what the columns do NOT cover. A reader who assumes a complete
	// breakdown and gets a partial one is worse off than one who was told.
	if (sums.aggregateRows > 0) {
		lines.push({
			text: "* covers that row's workers too — the orchestrate executor bills dollars only for the whole run.",
			tone: "note",
		});
	}
	if (sums.unpricedRows > 0) {
		lines.push({
			text: `— in the cost column: ${sums.unpricedRows} row(s) spent tokens but reported no price, so the total is a floor, not the bill.`,
			tone: "note",
		});
	}
	if (rows.length === 1) {
		lines.push({ text: "No subagents or orchestrate runs in this session yet.", tone: "note" });
	}
	return lines;
}

/**
 * The `context-tree` hive_widget envelope.
 *
 * Shape is copied from the orchestrate half of HIV-1243
 * (`agenda/index.ts:contextTreeEnvelope`) on purpose — one widget type, one
 * spec, whichever side emitted it. `depth` there is 1 for every worker of a
 * flat run; here it is the real tree depth, which the same renderer already
 * indents by.
 */
export function contextTreeEnvelope(root: AgentNode): {
	hive_widget: { v: 1; type: "context-tree"; spec: Record<string, unknown> };
} {
	const sums = totals(root);
	return {
		hive_widget: {
			v: 1,
			type: "context-tree",
			spec: {
				rows: flatten(root).map((row) => ({
					name: row.node.label,
					depth: row.depth,
					tokens: row.node.ownTokens,
				})),
				totalTokens: sums.tokens,
				...(sums.costUsd > 0 ? { totalCostUsd: sums.costUsd } : {}),
			},
		},
	};
}
