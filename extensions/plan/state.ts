/**
 * The plan document — a flat, id-addressed list of typed blocks.
 *
 * WHY NOT A DOCUMENT. The obvious representations for a plan are Markdown or
 * HTML, and both fail the same requirement: the agent has to update the plan
 * WHILE it works. A prose document can only be updated by rewriting it, which
 * costs a full re-emission to tick one checkbox, loses one worker's edit when
 * two land together, and leaves nothing addressable — a viewer cannot say
 * "step 3 of 7, in progress" about a string. That rewrite-only shape is the
 * documented generator of the stale-plan problem: the agent patches code, the
 * plan quietly keeps describing a reality that no longer holds, and on resume
 * the stale plan becomes the source of truth again.
 *
 * WHY BLOCKS. Both live standards for agent-authored UI converged on the same
 * answer from opposite directions. Google's A2UI has the agent emit a flat list
 * of components with id references — flat *specifically* because it is easy for
 * an LLM to generate incrementally and can render before generation finishes.
 * MCP Apps does serve HTML, but the HTML is authored by the SERVER and rendered
 * in a sandboxed iframe; the model supplies data, never markup. Notion gives
 * every block a uuid and patches one block at a time. We take that shape and
 * not the dependency — A2UI is explicitly unstable before its Q4 2026 v1.0.
 *
 * WHY A CLOSED CATALOG. `BlockType` is a fixed vocabulary this repo renders,
 * not an escape hatch for model-authored markup. Three things follow, and they
 * are the whole reason the design works:
 *
 *   - nothing the model writes is ever interpreted as markup by a browser
 *   - a `chart` carries DATA, so it re-renders, re-themes, animates and exports;
 *     a chart baked into HTML is a picture of a chart
 *   - every block is independently patchable, which is the requirement above
 *
 * WHAT A LANE IS, since HIV-2902. A `steps` block carrying a `kind` is a LANE,
 * and its items are WORK ITEMS — which is what a todo, a plan step and a
 * workflow step each were before the three stores were merged into this one.
 * The rules that keep lanes navigable (the `parentId` tree, the `dependsOn`
 * DAG, rank placement, which kinds Hive resolves) live in `lanes.ts`; this file
 * owns the shape and the mutation.
 *
 * TWO CLOCKS, ONE DOCUMENT. `revision` counts INTENT and `progress` counts
 * TICKS. That split is not new — `isIntentOp` below has kept status changes out
 * of `revision` since the beginning, which is precisely why the workflow could
 * be folded in here without a checkbox re-arming the approval timer. What is
 * new is that a tick now increments something, so a reader can tell "nothing
 * has happened" from "nothing has been re-planned".
 *
 * Persistence is `pi.appendEntry("plan", snapshot)` — the idiom `tasks/state.ts`
 * and `agenda/goal-state.ts` already use, for the same verified reasons: custom
 * entries are structurally invisible to the LLM, survive compaction, and are
 * copied into a fork. The model sees the plan through TOOL RESULTS, never
 * through a `context` handler (a prompt-cache hazard this repo bans and tests).
 */

import {
	dependsWouldCycle,
	descendants,
	isObservedKind,
	laneAnchor,
	lanesOf,
	MAX_DEPTH,
	parentWouldCycle,
	targetLane,
	depthOf,
} from "./lanes.ts";
import { LANE_TEMPLATES, templateLaneOps } from "./templates.ts";

export const PLAN_ENTRY_TYPE = "plan";

/**
 * The TICK entry: what moved, without re-emitting the document.
 *
 * A separate custom type rather than a flag on the snapshot, because the two
 * are read differently — `rehydratePlan` scans backwards for the newest
 * SNAPSHOT and then folds the ticks that follow it, and a reader that had to
 * inspect every entry to learn which kind it was would lose the bounded-by-
 * recency property that makes the scan cheap on a long session.
 */
export const PLAN_TICK_ENTRY_TYPE = "plan.tick";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

/**
 * Phases of the plan itself, NOT of the work.
 *
 * Progress through the work lives in step status, exactly once. A phase that
 * tried to also mean "half the steps are done" would be a second copy of
 * something already recorded, and the two would disagree.
 */
export type PlanPhase = "none" | "drafting" | "ready" | "approved" | "abandoned";

/**
 * The one status vocabulary, replacing three.
 *
 * `TaskItem` had `pending | in_progress | completed`, `PlanStep` had
 * `pending | in_progress | done | skipped | blocked`, and `WorkflowStep` had
 * those plus `failed` and spelled in-progress `running`. This is their union
 * with the two synonyms collapsed: `completed` and `running` are accepted on
 * the way in (see `normalizeStatus`) and stored as `done` and `in_progress`.
 *
 * `failed` is kept from the workflow vocabulary because a step genuinely can
 * fail — a gate that went red, a repro that did not reproduce — and reporting
 * that as `blocked` loses the difference between "waiting on something" and
 * "tried it and it did not work".
 */
export type WorkItemStatus = "pending" | "in_progress" | "done" | "failed" | "skipped" | "blocked";

/** @deprecated The pre-merge name. Kept so existing imports keep compiling. */
export type StepStatus = WorkItemStatus;

export const VALID_PHASES: readonly PlanPhase[] = ["none", "drafting", "ready", "approved", "abandoned"];

/**
 * The phases a MODEL may write through `plan_write`. Deliberately NOT
 * `VALID_PHASES` — `approved` is absent, and its absence is the feature.
 *
 * `approved` is the one phase that means an OPERATOR accepted the plan, and it
 * is the only one anything downstream trusts. Hive's revision history stores
 * the phase straight off the document (`COALESCE($3::jsonb #>> '{doc,phase}'`),
 * its retention keeps the newest approved row, and the browser's
 * "diff since approved" picks its comparison anchor with
 * `history.find((r) => r.phase === "approved")`. A model that could stamp
 * `approved` on its own revision would make that diff compare the plan against
 * itself and show an operator nothing changed — the exact opposite of what the
 * feature exists to show.
 *
 * Every legitimate producer of `approved` is an INTERNAL `persistOps` call in
 * the approval handlers, and those go straight to `applyOps`, which validates
 * against `VALID_PHASES` above and never sees this tool schema. So narrowing
 * the tool surface closes the model's door and leaves all three real approval
 * paths working.
 *
 * Do not "fix" the asymmetry by re-aligning these two lists. It is load-bearing,
 * and `plan-approve-flow.test.ts` asserts the difference is exactly `approved`.
 *
 * Known residual, not closed here: a launched agent holding a session token can
 * still PUT a document with `phase: "approved"` straight at Hive, which cannot
 * tell that from a pi-side operator approval because both arrive as a document
 * phase. Closing that needs Hive to own the approved transition — HIV-2937.
 */
export const MODEL_WRITABLE_PHASES = ["none", "drafting", "ready", "abandoned"] as const;

/**
 * `none` is the phase of a document that has LANES and no plan.
 *
 * It is the initial phase since the merge, and it exists so that the common
 * case — a short task that writes three todos and never enters plan mode — does
 * not present itself to an operator as an unapproved plan awaiting their
 * approval. Measured before the merge: 98% of sessions kept a todo list and
 * only 71% kept a plan, so "lanes but no plan" is the majority state, not an
 * edge case.
 *
 * Every consumer that reacts to a plan must treat `none` as NO PLAN: the
 * approval gate, the handsfree sweep, the conductor's phase signal, the
 * sidebar's phase chip, `plan_ready`, and the deck's plan section.
 */
export function hasPlan(doc: PlanDoc): boolean {
	return doc.phase !== "none";
}
const VALID_STEP_STATUSES: readonly WorkItemStatus[] = [
	"pending",
	"in_progress",
	"done",
	"failed",
	"skipped",
	"blocked",
];

/**
 * Accept the two synonyms the merged vocabularies brought with them.
 *
 * A façade caller that still says `completed` (the todo word) or `running` (the
 * workflow word) is not making a mistake — it is speaking the vocabulary its
 * tool has always had, and those tools keep their schemas. Translating on the
 * way in is what lets `TodoWrite` and `workflow_write` stay unchanged.
 */
export function normalizeStatus(value: unknown): WorkItemStatus | undefined {
	if (typeof value !== "string") return undefined;
	if (value === "completed") return "done";
	if (value === "running") return "in_progress";
	return (VALID_STEP_STATUSES as readonly string[]).includes(value) ? (value as WorkItemStatus) : undefined;
}

export type BlockType =
	| "text"
	| "steps"
	| "chart"
	| "diagram"
	| "refs"
	| "table"
	| "metrics"
	| "callout"
	| "code"
	| "artifact"
	| "checklist"
	| "ticket"
	| "milestone"
	| "decision"
	| "log";

/**
 * The catalog, at runtime.
 *
 * Exported so the PROMPT can be checked against it: the model only ever learns
 * a block type from the vocabulary table in prompt.ts, so a type added here and
 * forgotten there is a block nothing will ever emit — invisible to every other
 * test, because the renderer, the normalizer and the schema would all be right.
 */
export const VALID_BLOCK_TYPES: readonly BlockType[] = [
	"text",
	"steps",
	"chart",
	"diagram",
	"refs",
	"table",
	"metrics",
	"callout",
	"code",
	"artifact",
	"checklist",
	"ticket",
	"milestone",
	"decision",
	"log",
];

/**
 * The largest `artifact` document accepted, in characters.
 *
 * An artifact is the one block whose payload has no natural ceiling — every
 * other type is a list of short fields — and it is stored in the plan snapshot,
 * re-emitted on every read and shipped to a browser. 128 KiB is roughly ten
 * times the largest useful hand-written prototype and still small enough that a
 * plan with several of them stays a document rather than a payload.
 */
export const MAX_ARTIFACT_CHARS = 128 * 1024;

/**
 * One piece of work — what a todo, a plan step and a workflow step each were.
 *
 * The three carried nine overlapping fields between them and were kept in step
 * by `taskId` and `planStepId` links that something had to write and something
 * else had to trust. Both links are gone: an item is in a lane, and that IS the
 * relationship the links were expressing.
 *
 * `taskId` in particular is not merely redundant now — it never worked. It is
 * documented as "the tasks extension id this step materialized into once
 * approved", and `scripts/plan-shape.mjs` finds **0 producers across 594
 * sessions**. Nothing ever wrote it.
 */
export interface WorkItem {
	id: string;
	title: string;
	/**
	 * Present-continuous form, shown while the item is in progress.
	 *
	 * From the todo list, where it is the dual-text trick that lets a live view
	 * read "Running the migration" while the list reads "Run the migration".
	 */
	activeForm?: string;
	detail?: string;
	/**
	 * What KIND of work this is, and therefore WHOSE claim its status is.
	 *
	 * `task` (the default, and anything unrecognised) is the agent's own work
	 * and its status is read as written. A kind Hive can observe — `push`,
	 * `pr.open`, `ci.green`, `merged` … — has its status resolved from Hive's
	 * own run and pull rows on read, and `applyOps` REFUSES to set one here
	 * rather than accepting a value that would be discarded. See lanes.ts.
	 */
	kind?: string;
	status: WorkItemStatus;
	/** Files this item is expected to touch. Advisory; nothing enforces it. */
	files?: string[];
	/**
	 * Ids this item waits on. ENFORCED to be acyclic (lanes.ts), not enforced
	 * as a gate: nothing here refuses to start an item whose dependency is
	 * unfinished. A harness that enforces its own edges turns a bad edge into a
	 * deadlock the model cannot argue its way out of.
	 *
	 * Used by 96% of measured sessions — the most-adopted structural field in
	 * the whole document.
	 */
	dependsOn?: string[];
	/**
	 * The item this one decomposes — nesting, within the same lane.
	 *
	 * Absent for a root item. Depth is capped and a parent that would close a
	 * loop is refused (lanes.ts). Kept through the merge on measurement rather
	 * than on the stale note that said nothing used it: 14% of sessions do, and
	 * the rate is rising.
	 */
	parentId?: string;
	/** @deprecated The pre-merge name for `dependsOn`, still read on the way in. */
	blockedBy?: string[];
	linearKey?: string;
	/** Worker id, when the item is delegated. */
	owner?: string;
	/** ms epoch — also what attaches a delegation to this item in the diagram. */
	startedAt?: number;
	endedAt?: number;
	/**
	 * What ACTUALLY happened, when it diverged from what was planned.
	 *
	 * The single cheapest anti-drift device in the design: a plan that records
	 * where reality went differently stays honest, where one that silently
	 * absorbs the change reads as though it predicted it. 87% of measured
	 * sessions wrote at least one.
	 */
	note?: string;
}

/** @deprecated The pre-merge name. Kept so existing imports keep compiling. */
export type PlanStep = WorkItem;

interface BlockBase {
	id: string;
	/** Optional heading rendered above the block. */
	title?: string;
	createdAt: number;
	updatedAt: number;
}

export interface TextBlock extends BlockBase {
	type: "text";
	/** Markdown. Rendered as markdown in the TUI and as sanitized markdown in the web view. */
	markdown: string;
}

/**
 * A LANE: a list of work items that knows which phase of the work it holds.
 *
 * It is still a `steps` block on the wire — no reader has to learn a new block
 * type, and a lane written by a new client renders in an old one as the step
 * list it has always been. Everything the merge added is optional.
 */
export interface LaneBlock extends BlockBase {
	type: "steps";
	/**
	 * `frame` | `research` | `plan` | `execute` | `verify` | `deliver` |
	 * `consolidate`, or anything the model invents.
	 *
	 * OPEN on purpose. A closed set would make the model's own vocabulary —
	 * "Triage", "Fix", "Verification" — unrepresentable, and the measured
	 * consequence of forcing it into a closed set was a fourth box restating
	 * the first three. Known kinds get RANKED placement (lanes.ts); unknown
	 * kinds are placed where the model put them.
	 */
	kind?: string;
	/**
	 * Set while this lane exists only because a MACHINE made it — the conductor
	 * walking into a stage, or the todo façade needing somewhere to write — and
	 * cleared the moment the model writes to it.
	 *
	 * It exists to settle one race, which was the single most damaging defect
	 * in the pre-merge corpus: the todo mirror wrote its lane on turn one, with
	 * items in it, long before the model declared its own; 13 of 15 measured
	 * sessions ended with two "Execute" lanes. A lane a machine made is
	 * CLAIMABLE, so the model's declaration lands in the lane that already
	 * holds the todos instead of beside it.
	 */
	origin?: "conductor" | "mirror";
	/**
	 * One optional iteration annotation; never a dependency edge.
	 *
	 * HIV-2155's contract, carried across the merge verbatim. An orchestrator's
	 * watch → collect → dispatch is a loop, and a DAG cannot say so: `dependsOn`
	 * stays acyclic and the back-edge is decoration. Without it a lead running
	 * waves for hours reads as "almost done" rather than "iterating".
	 */
	loop?: LaneLoop;
	steps: WorkItem[];
}

export interface LaneLoop {
	/** Item ids WITHIN this lane forming the loop body, in body order. */
	steps: string[];
	/** Human-readable exit condition. */
	until?: string;
	/** 1-based wave counter. */
	iteration?: number;
	/** False once the loop has exited; absent means active. */
	active?: boolean;
}

/** @deprecated The pre-merge name. Kept so existing imports keep compiling. */
export type StepsBlock = LaneBlock;

/**
 * A chart as DATA plus a spec, never as an image or as markup.
 *
 * `series` is deliberately a plain array of `{label, value}` rather than
 * anything richer: it covers bar/line/pie, it survives a markdown render as a
 * table, and it is a shape a model gets right on the first attempt.
 */
export interface ChartBlock extends BlockBase {
	type: "chart";
	chart: "bar" | "line" | "pie" | "progress";
	series: { label: string; value: number }[];
	unit?: string;
	caption?: string;
}

export interface DiagramBlock extends BlockBase {
	type: "diagram";
	/** Mermaid source. Rendered natively by the web view; fenced in markdown. */
	mermaid: string;
	caption?: string;
}

export interface RefsBlock extends BlockBase {
	type: "refs";
	refs: { label: string; url?: string; kind?: "linear" | "pr" | "file" | "doc" | "url"; note?: string }[];
}

export interface TableBlock extends BlockBase {
	type: "table";
	columns: string[];
	rows: string[][];
}

export interface MetricsBlock extends BlockBase {
	type: "metrics";
	metrics: { label: string; value: string; delta?: string }[];
}

export interface CalloutBlock extends BlockBase {
	type: "callout";
	tone: "info" | "warn" | "risk" | "success";
	markdown: string;
}

/**
 * Source, shown as source.
 *
 * Distinct from a fenced block inside `text` because the fence is markdown that
 * has to survive a markdown renderer, and because this is addressable: a
 * proposed function signature is a thing the agent revises as the plan changes,
 * and `upsert` on its own id is how it does that without rewriting the prose
 * around it.
 */
export interface CodeBlock extends BlockBase {
	type: "code";
	/** Fence tag, file extension or path. Omit to let the renderer detect it. */
	language?: string;
	code: string;
	caption?: string;
}

/**
 * A self-contained HTML document, rendered in a sandboxed frame.
 *
 * THIS IS THE ONE EXCEPTION to the closed catalog, and it is deliberately
 * shaped so that the catalog's guarantee survives it. Everywhere else the rule
 * is "nothing the model writes is interpreted as markup"; here the model writes
 * markup, and the guarantee is moved rather than dropped: the document is never
 * parsed into the host page. It is handed to a frame with an OPAQUE ORIGIN
 * (`sandbox="allow-scripts"` and deliberately NOT `allow-same-origin`), so it
 * has no access to the host DOM, its cookies, its storage or its session, and a
 * CSP inside the document itself denies every network destination. See the web
 * renderer for the exact contract and for the one residual channel it can only
 * detect rather than prevent.
 *
 * WHY IT EXISTS. The typed blocks describe a plan; they cannot SHOW a proposed
 * interface. An agent proposing a redesign could previously only write "a card
 * with the status chip moved to the right", and a sentence is a poor way to
 * agree on a layout. This is the block that lets it build the thing.
 *
 * WHY IT IS THE LAST RESORT. An artifact is opaque to the terminal renderer, to
 * theming, and to anything that reads the plan as data — a chart block still
 * exports as numbers, an artifact exports as a blob of HTML nobody can query.
 * The prompt says this plainly, because the failure mode is an agent answering
 * every question with an HTML blob and the plan regressing into a screenshot.
 */
export interface ArtifactBlock extends BlockBase {
	type: "artifact";
	/** A complete, self-contained HTML document. No external references. */
	html: string;
	/** Requested frame height in CSS pixels; the renderer clamps it. */
	height?: number;
	caption?: string;
}

export interface ChecklistBlock extends BlockBase {
	type: "checklist";
	items: { id: string; text: string; checked: boolean; evidence?: string }[];
}

/** Ticket metadata is data; the browser may hydrate a bare key without treating it as markup. */
export interface TicketBlock extends BlockBase {
	type: "ticket";
	key: string;
	url?: string;
	role?: "primary" | "related";
}

/** A milestone is the plan-side projection of a goal link owned by the launch integration. */
export interface MilestoneBlock extends BlockBase {
	type: "milestone";
	goalId: string;
	stepId?: string;
}

export interface DecisionBlock extends BlockBase {
	type: "decision";
	question: string;
	options: string[];
	chosen: string;
	rationale: string;
	source: "plan_ask" | "grill" | "comment";
	at: number;
}

export interface LogBlock extends BlockBase {
	type: "log";
	entries: { at: number; kind: "stage" | "gate" | "approval" | "note"; text: string }[];
}

export type PlanBlock =
	| TextBlock
	| StepsBlock
	| ChartBlock
	| DiagramBlock
	| RefsBlock
	| TableBlock
	| MetricsBlock
	| CalloutBlock
	| CodeBlock
	| ArtifactBlock
	| ChecklistBlock
	| TicketBlock
	| MilestoneBlock
	| DecisionBlock
	| LogBlock;

export interface PlanDoc {
	title: string;
	goal: string;
	phase: PlanPhase;
	/**
	 * Bumped when INTENT changes — a block added, removed, moved, or its content
	 * edited — and NOT when a step ticks over.
	 *
	 * That distinction is what makes the number worth reading. If status changes
	 * bumped it too, "revision 40" would describe a plan that executed smoothly
	 * and one that was rewritten forty times identically.
	 */
	revision: number;
	/**
	 * The TICK clock — bumped by an item's status, note or timestamps, by a loop
	 * tick, and by a stage advance. Never by an edit to what the plan means.
	 *
	 * It exists so that merging execution into this document costs the approval
	 * machinery nothing. `revision` drives approval, the handsfree timer and the
	 * stored revision history; `progress` drives the live view and nothing else.
	 * A viewer refetches when EITHER moves; an approval re-arms only when
	 * `revision` does.
	 */
	progress: number;
	/**
	 * Which phase of the work the session is in — the conductor's answer, not
	 * the model's, and a single value rather than a lane.
	 *
	 * Carried here rather than derived from the lanes because it is the glance
	 * an operator wants and because it is an ORCHESTRATION fact: Hive reports it
	 * from `diagnose_agent_session`, `recap_session` and every roster row. A
	 * session that never declared one has none, which is the truth about it.
	 */
	stage?: string;
	/**
	 * Linear tickets this session serves. The model writes a key; the browser
	 * hydrates the rest through the broker.
	 *
	 * Before this, ticket chips in the workspace were DERIVED — from a `refs`
	 * block, an item's `linearKey`, or, failing both, a guess at the branch
	 * name. Measured: 0 of 581 task lists carried a `linearKey` and only 6% of
	 * plans named a ticket in `refs`, so in practice the chips were the branch
	 * guess almost every time.
	 */
	tickets?: { key: string; url?: string; role?: "primary" | "related" }[];
	/** The project milestone this session contributes to, when one is linked. */
	milestone?: { goalId: string; stepId?: string };
	blocks: PlanBlock[];
	/**
	 * Monotonic id source, persisted rather than derived.
	 *
	 * Deriving it from `blocks.length` or the live maximum reuses a removed
	 * block's id, and a reused id silently re-points every `blockedBy` edge and
	 * every stored reference that still names it.
	 */
	nextId: number;
	createdAt: number;
	updatedAt: number;
}

export function emptyPlan(now: number): PlanDoc {
	return {
		title: "",
		goal: "",
		// Lanes before a plan: a session that only ever writes todos must not
		// present itself as a plan waiting to be approved. See `hasPlan`.
		phase: "none",
		revision: 0,
		progress: 0,
		blocks: [],
		nextId: 1,
		createdAt: now,
		updatedAt: now,
	};
}

export function isEmpty(doc: PlanDoc): boolean {
	return doc.blocks.length === 0 && doc.title === "" && doc.goal === "";
}

/**
 * Whether everything in this document was written by a MACHINE — work that
 * accumulated, rather than a plan anybody authored.
 *
 * The distinction `plan_ready` needs, and the first version of it was wrong in
 * an instructive way: "every block is a lane" also describes a perfectly good
 * plan whose author wrote one `steps` block and nothing else, which is what
 * most of this repo's own plan tests build. The discriminator is not the block
 * TYPE, it is `origin` — the mark a lane carries while only the todo façade or
 * the conductor has touched it, and which is cleared the moment the model
 * writes to that lane itself.
 *
 * So: a document of mirrored todos is not a plan; the same document once the
 * model has claimed the lane or added a single block of its own is.
 */
export function isLanesOnly(doc: PlanDoc): boolean {
	return (
		doc.blocks.length > 0 &&
		doc.blocks.every((block) => block.type === "steps" && (block as LaneBlock).origin !== undefined)
	);
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

/** Header fields. Every one optional: a header write touches only what it names. */
export interface HeaderOp {
	op: "header";
	title?: string;
	goal?: string;
	phase?: PlanPhase;
	/** The lifecycle stage. A tick, not an intent change — see `isIntentOp`. */
	stage?: string;
	/** A label for THIS revision, shown in the version picker (HIV-2906). */
	label?: string;
	tickets?: { key: string; url?: string; role?: "primary" | "related" }[];
	milestone?: { goalId: string; stepId?: string } | null;
}

/**
 * Create or replace one block. Genuinely an upsert, in all three cases:
 *
 *   - `id` names an existing block  → replace its content, keep its position
 *   - `id` names nothing yet        → create it WITH that id
 *   - `id` omitted                  → create with a generated numeric id
 *
 * The middle case is the one that matters, and the first live run is what
 * taught it: asked to create a plan, the model supplied `id:"smoke-steps"` —
 * a readable id of its own choosing — and an earlier version rejected it as
 * unknown, so the header applied and the steps silently did not. An op called
 * `upsert` that cannot insert is a trap, and the model was right.
 *
 * Author-chosen ids are better anyway. They survive being read back out of the
 * rendered markdown, they let a model patch `risks` without first learning that
 * `risks` is block 4, and they match how step ids already work here.
 *
 * The cost is that a typo creates a block instead of correcting one. That is
 * visible in the very next render, where a silently-dropped block is not.
 */
export interface UpsertOp {
	op: "upsert";
	/** Short, stable, meaningful — `approach`, `steps`, `risks`. */
	id?: string;
	/** Insert after this block id. Ignored when replacing. Omit to append. */
	after?: string;
	block: BlockInput;
}

export interface RemoveOp {
	op: "remove";
	id: string;
}

export interface MoveOp {
	op: "move";
	id: string;
	/** Move after this block id, or to the front when omitted. */
	after?: string;
}

/**
 * Update ONE step inside a steps block, addressed by step id.
 *
 * Separate from `upsert` because this is the hot path — it is what an executing
 * agent calls to tick a box — and routing it through a whole-block replacement
 * would mean re-sending every sibling step to change one field, which is the
 * rewrite problem this design exists to avoid, merely at a smaller scale.
 */
export interface SetStepOp {
	op: "set_step";
	/** Item id. Lanes are searched for it; the containing lane need not be named. */
	id: string;
	status?: WorkItemStatus | "completed" | "running";
	note?: string;
	owner?: string | null;
	linearKey?: string | null;
	startedAt?: number;
	endedAt?: number;
}

/**
 * Create or update a LANE, addressed by id or by kind.
 *
 * By KIND is the half that matters, and it is what ended the duplicate-lane
 * defect: a caller that says "the execute lane" gets the execute lane whether
 * the conductor made it, the todo façade made it, or it does not exist yet. A
 * lane a machine made is CLAIMED by this op — its `origin` is cleared — so the
 * model's declaration lands in the lane that already holds the mirrored todos
 * rather than in a second lane beside it.
 *
 * Placement is by RANK when the caller expresses no position, because the
 * documented `before` argument that preceded it was used zero times in 213 ops
 * while 11 of 11 sessions put their research lane in the wrong place.
 */
export interface LaneOp {
	op: "lane";
	/** Lane block id. Omit to address by kind. */
	id?: string;
	/** Lifecycle kind. Creates the lane when neither id nor kind matches one. */
	kind?: string;
	title?: string;
	/** Insert before this lane. Omit to place by rank. */
	before?: string;
	/** Marks the lane machine-made. Only the conductor and the façade set it. */
	origin?: "conductor" | "mirror";
	/** Items to create or update in the lane, applied in order. */
	items?: ItemInput[];
}

/**
 * Create or update ONE work item, addressed by id.
 *
 * `lane` names where a NEW item goes (by lane id or kind); it is ignored when
 * the id already exists, because moving an item between lanes is `move_item`
 * and doing it silently here would relocate work a caller only meant to tick.
 */
export interface ItemOp {
	op: "item";
	id?: string;
	/** Lane id or kind for a new item. Defaults to the target lane (lanes.ts). */
	lane?: string;
	/**
	 * Set ONLY by a machine writing on the agent's behalf, and only when this op
	 * has to create the lane. It marks that lane claimable; a lane the model
	 * caused is the model's.
	 */
	origin?: "conductor" | "mirror";
	item: ItemInput;
}

/**
 * Remove one work item, and everything decomposed under it.
 *
 * Children travel with the parent rather than being promoted to roots: an item
 * that only existed as part of something deleted is not suddenly independent
 * work, and every reader here treats an orphan as a root, so leaving them would
 * silently reshape the lane.
 */
export interface RemoveItemOp {
	op: "remove_item";
	id: string;
}

/** Move one item to another lane, or under another parent. */
export interface MoveItemOp {
	op: "move_item";
	id: string;
	lane?: string;
	/** New parent within the destination lane; null detaches to the root. */
	parentId?: string | null;
}

/** Declare or update a lane's loop annotation (HIV-2155). */
export interface LoopOp {
	op: "loop";
	lane: string;
	steps?: string[];
	until?: string;
	active?: boolean;
}

/** Advance a lane's wave counter. Body item statuses are the model's to reset. */
export interface LoopTickOp {
	op: "loop_tick";
	lane: string;
}

/**
 * Ask for one of the recognisable lane shapes.
 *
 * Seeding is not coming back — it assumed every session ships code, and an
 * orchestration run, an infra audit and a research sweep each got a delivery
 * lane they would never walk, then reported themselves blocked on a merge that
 * was never going to happen. What was worth keeping is narrower: for a handful
 * of shapes the lane is the same every time and is the least interesting thing
 * for a model to author. So the shapes are asked for, never given.
 */
export interface TemplateOp {
	op: "template";
	name: string;
	title?: string;
}

/** Verification can only tick a criterion with evidence a reader can inspect. */
export interface ChecklistTickOp {
	op: "checklist_tick";
	id: string;
	itemId: string;
	evidence: string;
}

/** Log entries are appended by the harness; callers never replace history. */
export interface LogOp {
	op: "log";
	id?: string;
	entries: { at?: number; kind: "stage" | "gate" | "approval" | "note"; text: string }[];
}

export type PlanOp =
	| HeaderOp
	| UpsertOp
	| RemoveOp
	| MoveOp
	| SetStepOp
	| LaneOp
	| ItemOp
	| MoveItemOp
	| RemoveItemOp
	| LoopOp
	| LoopTickOp
	| TemplateOp
	| ChecklistTickOp
	| LogOp;

/** A block as the model supplies it: no ids, no timestamps. */
export type BlockInput =
	| { type: "text"; title?: string; markdown: string }
	| { type: "steps"; title?: string; steps: ItemInput[] }
	| {
			type: "chart";
			title?: string;
			chart: ChartBlock["chart"];
			series: { label: string; value: number }[];
			unit?: string;
			caption?: string;
	  }
	| { type: "diagram"; title?: string; mermaid: string; caption?: string }
	| { type: "refs"; title?: string; refs: RefsBlock["refs"] }
	| { type: "table"; title?: string; columns: string[]; rows: string[][] }
	| { type: "metrics"; title?: string; metrics: MetricsBlock["metrics"] }
	| { type: "callout"; title?: string; tone: CalloutBlock["tone"]; markdown: string }
	| { type: "code"; title?: string; language?: string; code: string; caption?: string }
	| { type: "artifact"; title?: string; html: string; height?: number; caption?: string }
	| { type: "checklist"; title?: string; items: { id: string; text: string; checked?: boolean; evidence?: string }[] }
	| { type: "ticket"; title?: string; key: string; url?: string; role?: "primary" | "related" }
	| { type: "milestone"; title?: string; goalId: string; stepId?: string }
	| { type: "decision"; title?: string; question: string; options: string[]; chosen: string; rationale: string; source: "plan_ask" | "grill" | "comment"; at: number }
	| { type: "log"; title?: string; entries: { at: number; kind: "stage" | "gate" | "approval" | "note"; text: string }[] };

export interface ItemInput {
	/** Preserved when re-stating an existing item, so status and links survive. */
	id?: string;
	/**
	 * Required when CREATING, optional when patching.
	 *
	 * Optional in the type because `{id, status}` is the natural shape of a
	 * tick and a caller should not have to restate a title to change a status —
	 * restating one is how a reword silently lands in a patch nobody reviewed.
	 * A create without one is refused in `writeItem`, where the difference is
	 * actually knowable.
	 */
	title?: string;
	activeForm?: string;
	detail?: string;
	kind?: string;
	status?: WorkItemStatus | "completed" | "running";
	files?: string[];
	dependsOn?: string[];
	parentId?: string;
	linearKey?: string;
	owner?: string;
	note?: string;
	/** @deprecated Read as `dependsOn` on the way in. */
	blockedBy?: string[];
}

/** @deprecated The pre-merge name. Kept so existing imports keep compiling. */
export type StepInput = ItemInput;

export interface OpResult {
	doc: PlanDoc;
	created: string[];
	updated: string[];
	removed: string[];
	/**
	 * Everything the caller got wrong, reported rather than thrown.
	 *
	 * A rejected batch teaches nothing: the model retries the whole thing and
	 * usually reproduces the mistake. A partial apply plus a precise complaint
	 * lets it fix only what failed.
	 */
	problems: string[];
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((v) => cleanString(v)).filter((v): v is string => v !== undefined);
}

/**
 * Ops that change what the plan MEANS, as opposed to how far along it is.
 *
 * This function is the whole reason the workflow document could be folded into
 * this one. It has always kept a ticked checkbox out of `revision`; the merge
 * only had to add the ops that tick, and give them somewhere to count.
 *
 * The two judgement calls in here:
 *
 *   `header` is intent only when it names the title, the goal, the tickets or
 *   the milestone. A `stage` advance is the conductor reporting where it got
 *   to — it happens several times in a session that never re-planned once, and
 *   counting it would re-arm the approval timer on a machine's beat.
 *
 *   `lane` IS intent. Declaring a lane is declaring the shape of the work, and
 *   an operator who approved a three-lane plan should see a fourth lane as a
 *   change to what they approved. Ticking the items inside it is not.
 */
function isIntentOp(op: PlanOp): boolean {
	switch (op.op) {
		case "set_step":
		case "loop_tick":
		case "move_item":
		case "checklist_tick":
			return false;
		case "remove_item":
			// Deleting work changes what the plan says will be done.
			return true;
		case "item": {
			// MIRRORS `set_step`, deliberately and by construction. The same
			// update reaching this document through two ops must move the same
			// clock: `TodoWrite` becomes a façade over `item`, so a predicate
			// that called a status change "intent" here would bump `revision` on
			// every todo tick — re-arming the approval timer and writing a full
			// snapshot for the most common writer in the harness, which is the
			// entire failure the two clocks exist to prevent.
			//
			// A tick is: an item that already exists, touched only in the fields
			// a tick may touch.
			if (op.item.id === undefined) return true; // creating work is intent
			const TICK_FIELDS = new Set(["id", "status", "note", "activeForm", "startedAt", "endedAt"]);
			return Object.keys(op.item).some((key) => !TICK_FIELDS.has(key));
		}
		case "header":
			return (
				op.title !== undefined ||
				op.goal !== undefined ||
				op.tickets !== undefined ||
				op.milestone !== undefined
			);
		default:
			return true;
	}
}

/** Ops that move the PROGRESS clock: something happened, nothing was re-planned. */
function isTickOp(op: PlanOp): boolean {
	switch (op.op) {
		case "set_step":
		case "loop_tick":
		case "move_item":
		case "item":
		case "checklist_tick":
			return true;
		case "header":
			return op.stage !== undefined || op.phase !== undefined;
		default:
			return false;
	}
}

/**
 * Apply a batch of ops.
 *
 * Batch rather than one-op-per-call because a re-plan arriving in six pieces is
 * six chances to be interrupted halfway into an inconsistent document.
 *
 * `blockedBy` is recorded but NOT enforced: nothing here refuses to move a
 * blocked step to `in_progress`. A harness that enforces its own dependency
 * edges turns a bad edge into a deadlock the model cannot argue its way out of.
 */
export function applyOps(doc: PlanDoc, ops: readonly PlanOp[], now: number): OpResult {
	// COPY-ON-ENTRY, one level deeper than it looks like it needs.
	//
	// `{...doc, blocks: [...doc.blocks]}` copies the array and SHARES every block
	// object in it, and the handlers below write through that share:
	// `applySetStep` assigns `block.steps[at]`, `applyLane` pushes onto
	// `lane.steps`. The result is that applying an op MUTATES THE DOCUMENT THAT
	// WAS PASSED IN — a caller holding the previous version finds its checkboxes
	// already ticked.
	//
	// That was harmless while every caller discarded the old document. It stops
	// being harmless the moment anything keeps one: the tick/snapshot split
	// compares a document against its predecessor to decide what to write, and
	// the stored revision history (HIV-2906) keeps every approved version to
	// diff against. Found by a test asserting that a stale tick could not revive
	// a status a re-plan had reset — it could, because the "re-planned" document
	// and the ticked one were the same object.
	//
	// Copying each block and its own item array is enough: the handlers replace
	// item objects (`{...current, ...}`) rather than writing into their fields.
	let next: PlanDoc = {
		...doc,
		blocks: doc.blocks.map((block) => (block.type === "steps" ? { ...block, steps: [...block.steps] } : { ...block })),
	};
	const created: string[] = [];
	const updated: string[] = [];
	const removed: string[] = [];
	const problems: string[] = [];
	let intentChanged = false;
	let ticked = false;

	ops.forEach((op, index) => {
		const label = `op #${index + 1}`;
		const before = problems.length;

		switch (op.op) {
			case "header":
				applyHeader(next, op, problems, label);
				break;
			case "upsert":
				applyUpsert(next, op, now, created, updated, problems, label);
				break;
			case "remove":
				applyRemove(next, op, removed, problems, label);
				break;
			case "move":
				applyMove(next, op, updated, problems, label);
				break;
			case "set_step":
				applySetStep(next, op, now, updated, problems, label);
				break;
			case "lane":
				applyLane(next, op, now, created, updated, problems, label);
				break;
			case "item":
				applyItem(next, op, now, created, updated, problems, label);
				break;
			case "move_item":
				applyMoveItem(next, op, now, updated, problems, label);
				break;
			case "remove_item":
				applyRemoveItem(next, op, now, removed, problems, label);
				break;
			case "loop":
				applyLoop(next, op, now, updated, problems, label);
				break;
			case "loop_tick":
				applyLoopTick(next, op, now, updated, problems, label);
				break;
			case "template":
				applyTemplate(next, op, now, created, updated, problems, label);
				break;
			case "checklist_tick":
				applyChecklistTick(next, op, now, updated, problems, label);
				break;
			case "log":
				applyLog(next, op, now, created, updated, problems, label);
				break;
			default:
				problems.push(`${label}: unknown op "${String((op as { op?: unknown }).op)}"`);
		}

		// Only an op that actually applied counts toward either clock.
		if (problems.length === before) {
			if (isIntentOp(op)) intentChanged = true;
			if (isTickOp(op)) ticked = true;
		}
	});

	next = {
		...next,
		revision: intentChanged ? next.revision + 1 : next.revision,
		// One increment per BATCH, not per op: a façade that writes six status
		// changes in one call did one thing, and a counter that made it look
		// like six would make "how much has happened" unreadable at a glance.
		progress: ticked ? next.progress + 1 : next.progress,
		updatedAt:
			created.length + updated.length + removed.length > 0 || intentChanged || ticked ? now : next.updatedAt,
	};

	return { doc: next, created, updated, removed, problems };
}

function applyChecklistTick(
	doc: PlanDoc,
	op: ChecklistTickOp,
	now: number,
	updated: string[],
	problems: string[],
	label: string,
): void {
	const evidence = cleanString(op.evidence);
	if (!evidence || !/(?:\brun\s+[\w-]+\b|\b[^\s:]+:\d+\b)/i.test(evidence)) {
		problems.push(`${label}: checklist evidence must name a run id or file:line`);
		return;
	}
	const block = doc.blocks.find((candidate): candidate is ChecklistBlock => candidate.id === cleanString(op.id) && candidate.type === "checklist");
	if (!block) {
		problems.push(`${label}: unknown checklist block "${String(op.id)}"`);
		return;
	}
	const at = block.items.findIndex((item) => item.id === cleanString(op.itemId));
	if (at === -1) {
		problems.push(`${label}: unknown checklist item "${String(op.itemId)}"`);
		return;
	}
	if (block.items[at].checked && block.items[at].evidence === evidence) return;
	block.items[at] = { ...block.items[at], checked: true, evidence };
	block.updatedAt = now;
	updated.push(block.id);
}

function applyLog(
	doc: PlanDoc,
	op: LogOp,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const entries = (Array.isArray(op.entries) ? op.entries : []).flatMap((entry) => {
		const text = cleanString(entry?.text);
		const kind = entry?.kind;
		if (!text || !["stage", "gate", "approval", "note"].includes(kind)) {
			problems.push(`${label}: log entries need a kind and text`);
			return [];
		}
		return [{ at: typeof entry.at === "number" && Number.isFinite(entry.at) ? Math.round(entry.at) : now, kind, text } as LogBlock["entries"][number]];
	});
	if (entries.length === 0) return;
	const id = cleanString(op.id) ?? "log";
	const existing = doc.blocks.find((block): block is LogBlock => block.id === id && block.type === "log");
	if (existing) {
		existing.entries.push(...entries);
		existing.updatedAt = now;
		updated.push(id);
		return;
	}
	if (doc.blocks.some((block) => block.id === id)) {
		problems.push(`${label}: block "${id}" is not a log`);
		return;
	}
	doc.blocks.push({ id, type: "log", entries, createdAt: now, updatedAt: now });
	created.push(id);
}

function applyHeader(doc: PlanDoc, op: HeaderOp, problems: string[], label: string): void {
	if (op.phase !== undefined) {
		if (!VALID_PHASES.includes(op.phase)) {
			problems.push(`${label}: unknown phase "${String(op.phase)}"`);
		} else {
			doc.phase = op.phase;
		}
	}
	const title = cleanString(op.title);
	const goal = cleanString(op.goal);
	if (title !== undefined) doc.title = title;
	if (goal !== undefined) doc.goal = goal;

	const stage = cleanString(op.stage);
	if (stage !== undefined) doc.stage = stage;

	if (op.tickets !== undefined) {
		const tickets = (Array.isArray(op.tickets) ? op.tickets : [])
			.map((ticket) => {
				const key = cleanString(ticket?.key)?.toUpperCase();
				if (key === undefined) return undefined;
				return {
					key,
					url: cleanString(ticket?.url),
					role: ticket?.role === "primary" ? ("primary" as const) : ("related" as const),
				};
			})
			.filter((ticket): ticket is NonNullable<typeof ticket> => ticket !== undefined)
			.slice(0, MAX_TICKETS);
		doc.tickets = tickets.length > 0 ? tickets : undefined;
	}

	if (op.milestone !== undefined) {
		const goalId = op.milestone === null ? undefined : cleanString(op.milestone.goalId);
		doc.milestone = goalId === undefined ? undefined : { goalId, stepId: cleanString(op.milestone?.stepId) };
	}
}

/** A plan naming a dozen tickets is not naming any of them. */
const MAX_TICKETS = 12;

function applyUpsert(
	doc: PlanDoc,
	op: UpsertOp,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const body = normalizeBlock(op.block, problems, label);
	if (!body) return;

	const id = cleanString(op.id);
	if (id !== undefined) {
		const at = doc.blocks.findIndex((block) => block.id === id);
		if (at === -1) {
			insertBlock(doc, { ...(body as PlanBlock), id, createdAt: now, updatedAt: now } as PlanBlock, op.after, problems, label);
			created.push(id);
			return;
		}
		const current = doc.blocks[at];
		doc.blocks[at] = {
			...(body as PlanBlock),
			id: current.id,
			createdAt: current.createdAt,
			updatedAt: now,
		} as PlanBlock;
		// Re-stating a steps block must not discard progress recorded since.
		if (body.type === "steps" && current.type === "steps") {
			(doc.blocks[at] as StepsBlock).steps = mergeSteps(current.steps, (body as StepsBlock).steps);
		}
		updated.push(id);
		return;
	}

	// Generated ids skip anything an author already claimed, so a plan mixing
	// `risks` with `1`, `2` can never collide.
	let newId = String(doc.nextId++);
	while (doc.blocks.some((block) => block.id === newId)) newId = String(doc.nextId++);

	insertBlock(doc, { ...(body as PlanBlock), id: newId, createdAt: now, updatedAt: now } as PlanBlock, op.after, problems, label);
	created.push(newId);
}

/** Place a new block after `after`, or append when it is absent or unknown. */
function insertBlock(
	doc: PlanDoc,
	block: PlanBlock,
	after: string | undefined,
	problems: string[],
	label: string,
): void {
	const target = cleanString(after);
	if (target === undefined) {
		doc.blocks.push(block);
		return;
	}
	const at = doc.blocks.findIndex((candidate) => candidate.id === target);
	if (at === -1) {
		// Appending rather than refusing: the block itself is fine, and losing it
		// over a bad position is a worse trade than putting it in the wrong place
		// and saying so.
		problems.push(`${label}: "after" names unknown block "${target}"; appended instead`);
		doc.blocks.push(block);
		return;
	}
	doc.blocks.splice(at + 1, 0, block);
}

/**
 * Carry status and links across a re-stated steps block.
 *
 * A model re-stating a step list to reword it would otherwise reset every step
 * to `pending` and orphan every `taskId` — the plan would report that finished
 * work had not started. Matching is by step id when the model supplies one and
 * by exact title otherwise, which is what a reword-in-place actually looks like.
 */
function mergeSteps(previous: readonly PlanStep[], incoming: readonly PlanStep[]): PlanStep[] {
	const byId = new Map(previous.map((step) => [step.id, step]));
	const byTitle = new Map(previous.map((step) => [step.title, step]));
	return incoming.map((step) => {
		const prior = byId.get(step.id) ?? byTitle.get(step.title);
		if (!prior) return step;
		return {
			...step,
			status: step.status === "pending" ? prior.status : step.status,
			linearKey: step.linearKey ?? prior.linearKey,
			owner: step.owner ?? prior.owner,
			note: step.note ?? prior.note,
		};
	});
}

function applyRemove(doc: PlanDoc, op: RemoveOp, removed: string[], problems: string[], label: string): void {
	const id = cleanString(op.id);
	if (id === undefined) {
		problems.push(`${label}: remove needs an id`);
		return;
	}
	const at = doc.blocks.findIndex((block) => block.id === id);
	if (at === -1) {
		problems.push(`${label}: unknown block id "${id}"`);
		return;
	}
	doc.blocks.splice(at, 1);
	removed.push(id);
}

function applyMove(doc: PlanDoc, op: MoveOp, updated: string[], problems: string[], label: string): void {
	const id = cleanString(op.id);
	if (id === undefined) {
		problems.push(`${label}: move needs an id`);
		return;
	}
	const at = doc.blocks.findIndex((block) => block.id === id);
	if (at === -1) {
		problems.push(`${label}: unknown block id "${id}"`);
		return;
	}
	const [block] = doc.blocks.splice(at, 1);
	const after = cleanString(op.after);
	if (after === undefined) {
		doc.blocks.unshift(block);
		updated.push(id);
		return;
	}
	if (after === id) {
		problems.push(`${label}: block "${id}" cannot be moved after itself`);
		doc.blocks.splice(at, 0, block);
		return;
	}
	const target = doc.blocks.findIndex((candidate) => candidate.id === after);
	if (target === -1) {
		problems.push(`${label}: "after" names unknown block "${after}"`);
		doc.blocks.splice(at, 0, block);
		return;
	}
	doc.blocks.splice(target + 1, 0, block);
	updated.push(id);
}

function applySetStep(
	doc: PlanDoc,
	op: SetStepOp,
	now: number,
	updated: string[],
	problems: string[],
	label: string,
): void {
	const id = cleanString(op.id);
	if (id === undefined) {
		problems.push(`${label}: set_step needs a step id`);
		return;
	}
	const status = op.status === undefined ? undefined : normalizeStatus(op.status);
	if (op.status !== undefined && status === undefined) {
		problems.push(`${label}: unknown item status "${String(op.status)}"`);
		return;
	}

	for (const block of doc.blocks) {
		if (block.type !== "steps") continue;
		const at = block.steps.findIndex((step) => step.id === id);
		if (at === -1) continue;

		const current = block.steps[at];

		// An agent cannot mark its own gate green. For a kind whose truth lives
		// in Hive's own run and pull rows, a status written here is DISCARDED on
		// read — so the tool refuses it and says why, rather than accepting a
		// value that quietly goes nowhere. A tool that ignores half its argument
		// teaches the model nothing.
		if (status !== undefined && isObservedKind(current.kind)) {
			problems.push(
				`${label}: "${id}" is a ${current.kind} item, whose status Hive resolves from its own runs and pull requests; ` +
					`leave it alone and let the observation speak`,
			);
			return;
		}

		let owner = current.owner;
		if (op.owner === null) owner = undefined;
		else if (typeof op.owner === "string") owner = cleanString(op.owner);

		let linearKey = current.linearKey;
		if (op.linearKey === null) linearKey = undefined;
		else if (typeof op.linearKey === "string") linearKey = cleanString(op.linearKey);

		// Timestamps are stamped from the transition rather than asked for: an
		// item that just started is starting now, and a caller that had to
		// supply the clock would supply a wrong one half the time. They are what
		// attaches a delegation to the right item in the diagram.
		const started = status === "in_progress" && current.status !== "in_progress";
		const ended = status !== undefined && status !== "in_progress" && status !== "pending";

		block.steps[at] = {
			...current,
			status: status ?? current.status,
			note: op.note === undefined ? current.note : cleanString(op.note),
			owner,
			linearKey,
			startedAt: op.startedAt ?? (started ? now : current.startedAt),
			endedAt: op.endedAt ?? (ended ? now : current.endedAt),
		};
		block.updatedAt = now;
		updated.push(block.id);
		return;
	}

	problems.push(`${label}: no lane contains item "${id}"`);
}

/* -------------------------------------------------------------------------- */
/* Lanes and work items                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Find the lane an op is addressing.
 *
 * By id first, then by kind. Addressing by KIND is what ended the duplicate
 * lane: the todo façade, the conductor and the model all say "execute" and all
 * three reach the same block, whichever of them created it.
 */
function findLane(doc: PlanDoc, ref: string | undefined): LaneBlock | undefined {
	const key = cleanString(ref);
	if (key === undefined) return undefined;
	const lanes = lanesOf(doc);
	return lanes.find((lane) => lane.id === key) ?? lanes.find((lane) => lane.kind === key);
}

/** A work item as the model supplies it, bounded and with synonyms resolved. */
/**
 * One item's input as a PATCH — every field absent unless the caller supplied it.
 *
 * `title` is optional here, and that is the whole point. It used to default to
 * the id, which was invisible on the create path (a titleless new item is
 * refused before this runs) and destructive on the patch path: `writeItem`
 * preserves a field by dropping it when it is `undefined`, so a title that
 * always had a value overwrote the real one with the id on every write.
 *
 * The effect reached readers. Measured over 77 sessions, 27% of plans carried
 * purely numeric step titles — "2", "3", "4" — which are `String(doc.nextId++)`,
 * the ids this function substituted. Any op that ticked a status without
 * restating the title renamed the item to its own id, so the plans most worked
 * on were the ones that lost the most: a finished step is a ticked step.
 */
function normalizeItem(input: ItemInput, id: string): Omit<WorkItem, "title"> & { title?: string } {
	const deps = cleanStringList(input.dependsOn) ?? cleanStringList(input.blockedBy);
	return {
		id,
		title: cleanString(input.title),
		activeForm: cleanString(input.activeForm),
		detail: cleanString(input.detail),
		kind: cleanString(input.kind),
		status: normalizeStatus(input.status) ?? "pending",
		files: cleanStringList(input.files),
		dependsOn: deps && deps.length > 0 ? deps : undefined,
		parentId: cleanString(input.parentId),
		linearKey: cleanString(input.linearKey),
		owner: cleanString(input.owner),
		note: cleanString(input.note),
	};
}

/**
 * Write one item into a lane, creating or patching by id.
 *
 * The two structural edges are checked HERE rather than trusted, because both
 * are load-bearing for the diagram: a `parentId` that would close a loop or
 * exceed the depth cap is dropped with a complaint, and a `dependsOn` that would
 * close a cycle is dropped with a complaint. Neither refuses the ITEM — losing a
 * piece of work over a bad edge is a worse trade than keeping it and saying the
 * edge was wrong.
 */
function writeItem(
	doc: PlanDoc,
	lane: LaneBlock,
	input: ItemInput,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const supplied = cleanString(input.id);
	const at = supplied === undefined ? -1 : lane.steps.findIndex((item) => item.id === supplied);

	// THE GATE-GREEN REFUSAL LIVES HERE, on the shared write path, not on one op.
	//
	// It was originally only in `applySetStep`, which was enough while that was
	// the only way to change a status. It is not: `item` reaches the same field,
	// and `workflow_write`'s own `set_step` maps onto `item` — so the rule that
	// an agent cannot mark its own gate green was bypassable by spelling the
	// call differently. A rule about the DOCUMENT has to sit where every writer
	// passes, or it is a rule about one vocabulary.
	if (at !== -1 && input.status !== undefined) {
		const existing = lane.steps[at];
		if (isObservedKind(existing.kind)) {
			problems.push(
				`${label}: "${existing.id}" is a ${existing.kind} item, whose status Hive resolves from its own runs and ` +
					`pull requests; leave it alone and let the observation speak`,
			);
			return;
		}
	}

	if (at === -1 && cleanString(input.title) === undefined) {
		problems.push(`${label}: a new item needs a title${supplied === undefined ? "" : ` (nothing here has id "${supplied}")`}`);
		return;
	}
	const id = supplied ?? String(doc.nextId++);
	const item = normalizeItem(input, id);

	// The same claim, made on the way in: declaring `{kind:"ci.green", status:"done"}`
	// asserts a gate result exactly as setting it afterwards would. The item is
	// kept — the delivery lane is supposed to exist — and only the status is
	// refused, so it lands pending and waits for the observation.
	if (at === -1 && isObservedKind(item.kind) && normalizeStatus(input.status) !== undefined) {
		problems.push(
			`${label}: "${id}" is a ${item.kind} item, whose status Hive resolves from its own runs and pull ` +
				`requests; it was created pending`,
		);
		item.status = "pending";
	}

	if (item.dependsOn && dependsWouldCycle(doc, id, item.dependsOn)) {
		problems.push(`${label}: dependsOn on "${id}" would close a cycle; the edge was dropped, the item was kept`);
		item.dependsOn = undefined;
	}
	if (item.parentId !== undefined) {
		if (parentWouldCycle(lane, id, item.parentId)) {
			problems.push(`${label}: parentId on "${id}" would close a loop; the item was kept at the root`);
			item.parentId = undefined;
		} else if (depthOf(lane, item.parentId) >= MAX_DEPTH) {
			problems.push(
				`${label}: "${id}" would nest deeper than ${MAX_DEPTH}; the item was kept at its parent's level`,
			);
			item.parentId = lane.steps.find((s) => s.id === item.parentId)?.parentId;
		}
	}

	if (at === -1) {
		// `?? id` cannot fire: the guard above refuses a new item with no title.
		// It is here to satisfy the type without restating that proof, NOT as a
		// fallback — reintroducing one on the patch path is the bug this shape
		// exists to prevent.
		lane.steps.push({ ...item, title: item.title ?? id });
		lane.updatedAt = now;
		created.push(id);
		return;
	}

	const current = lane.steps[at];
	// A re-stated item keeps what it has earned. Without this, a model rewording
	// its own list resets every status to pending and the document reports that
	// finished work had not started.
	lane.steps[at] = {
		...current,
		...Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)),
		status: input.status === undefined ? current.status : item.status,
	} as WorkItem;
	lane.updatedAt = now;
	updated.push(id);
}

/**
 * Create or claim a lane, then write its items.
 *
 * CLAIMING is the load-bearing half. A lane a machine made carries `origin`, and
 * any op that names it from the model clears that mark — so the model's declared
 * "Implement" lane merges into the lane that already holds the mirrored todos
 * instead of appearing beside it. 13 of 15 sessions carried two Execute lanes
 * before this rule existed, and four rounds of adoption logic in the old
 * workflow document failed to fix it because each round keyed on something the
 * race made untrue.
 */
function applyLane(
	doc: PlanDoc,
	op: LaneOp,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const kind = cleanString(op.kind);
	let lane = findLane(doc, op.id) ?? findLane(doc, kind);

	if (!lane) {
		const id = cleanString(op.id) ?? String(doc.nextId++);
		lane = {
			type: "steps",
			id,
			title: cleanString(op.title) ?? cleanString(op.kind),
			kind,
			origin: op.origin,
			steps: [],
			createdAt: now,
			updatedAt: now,
		};
		// Placement by RANK when the caller expressed none. A documented `before`
		// that models never reached for is not a mechanism; a rule that fires
		// without being remembered is.
		const before = cleanString(op.before) ?? laneAnchor(doc, kind);
		const at = before === undefined ? -1 : doc.blocks.findIndex((block) => block.id === before);
		if (at === -1) doc.blocks.push(lane);
		else doc.blocks.splice(at, 0, lane);
		created.push(id);
	} else {
		const title = cleanString(op.title);
		if (title !== undefined) lane.title = title;
		if (kind !== undefined) lane.kind = kind;
		// The claim. `origin` is only ever SET by the machine that made the lane,
		// and only ever cleared here.
		if (op.origin === undefined) lane.origin = undefined;
		lane.updatedAt = now;
		updated.push(lane.id);
	}

	for (const item of op.items ?? []) {
		writeItem(doc, lane, item, now, created, updated, problems, label);
	}
}

/** Create or update ONE item, in the named lane or in the one the session is in. */
function applyItem(
	doc: PlanDoc,
	op: ItemOp,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const id = cleanString(op.item.id);
	// An existing id is patched WHERE IT IS. Relocating an item because a caller
	// named a lane while ticking it is `move_item`'s job, and doing it here
	// would move work somebody only meant to update.
	const holding = id === undefined ? undefined : lanesOf(doc).find((lane) => lane.steps.some((i) => i.id === id));
	const lane = holding ?? findLane(doc, op.lane) ?? targetLane(doc);

	if (!lane) {
		// No lane at all: make one. `origin` is NOT assumed — a lane created
		// because the MODEL wrote an item is the model's lane, and marking it
		// machine-made would leave it claimable by the next writer, which is how
		// a second lane appears. Only a caller that knows it is a machine says so.
		applyLane(
			doc,
			{ op: "lane", kind: "execute", title: "Execute", origin: op.origin, items: [op.item] },
			now,
			created,
			updated,
			problems,
			label,
		);
		return;
	}
	writeItem(doc, lane, op.item, now, created, updated, problems, label);
}

/** Move an item to another lane, or under another parent. */
function applyMoveItem(
	doc: PlanDoc,
	op: MoveItemOp,
	now: number,
	updated: string[],
	problems: string[],
	label: string,
): void {
	const id = cleanString(op.id);
	if (id === undefined) {
		problems.push(`${label}: move_item needs an item id`);
		return;
	}
	const from = lanesOf(doc).find((lane) => lane.steps.some((item) => item.id === id));
	if (!from) {
		problems.push(`${label}: no lane contains item "${id}"`);
		return;
	}
	const to = findLane(doc, op.lane) ?? from;

	if (op.parentId !== undefined) {
		const parentId = op.parentId === null ? undefined : cleanString(op.parentId);
		if (parentId !== undefined && parentWouldCycle(to, id, parentId)) {
			problems.push(`${label}: parentId on "${id}" would close a loop; left where it was`);
			return;
		}
		const at = from.steps.findIndex((item) => item.id === id);
		from.steps[at] = { ...from.steps[at], parentId };
	}

	if (to !== from) {
		// The subtree travels with its root: a child left behind in the old lane
		// would be an orphan whose parent is elsewhere, which every reader here
		// promotes to a root — silently reshaping work nobody moved.
		const moving = [id, ...descendants(from, id).map((item) => item.id)];
		const taken = from.steps.filter((item) => moving.includes(item.id));
		from.steps = from.steps.filter((item) => !moving.includes(item.id));
		to.steps.push(...taken);
		from.updatedAt = now;
		updated.push(from.id);
	}
	to.updatedAt = now;
	updated.push(to.id);
}

/** Remove an item and its subtree. */
function applyRemoveItem(
	doc: PlanDoc,
	op: RemoveItemOp,
	now: number,
	removed: string[],
	problems: string[],
	label: string,
): void {
	const id = cleanString(op.id);
	if (id === undefined) {
		problems.push(`${label}: remove_item needs an item id`);
		return;
	}
	const lane = lanesOf(doc).find((candidate) => candidate.steps.some((item) => item.id === id));
	if (!lane) {
		problems.push(`${label}: no lane contains item "${id}"`);
		return;
	}
	const doomed = new Set([id, ...descendants(lane, id).map((item) => item.id)]);
	lane.steps = lane.steps.filter((item) => !doomed.has(item.id));
	lane.updatedAt = now;
	for (const gone of doomed) removed.push(gone);
}

/** Declare or update a lane's loop annotation. At most one per lane. */
function applyLoop(doc: PlanDoc, op: LoopOp, now: number, updated: string[], problems: string[], label: string): void {
	const lane = findLane(doc, op.lane);
	if (!lane) {
		problems.push(`${label}: unknown lane "${String(op.lane)}"`);
		return;
	}
	// Ids that are not in this lane are DROPPED rather than refused: a loop body
	// naming a step that was renamed is still a loop, and refusing the whole
	// annotation over one stale id loses the wave counter an operator reads.
	const present = new Set(lane.steps.map((item) => item.id));
	const steps = (cleanStringList(op.steps) ?? []).filter((id) => present.has(id));
	const until = cleanString(op.until);
	lane.loop = {
		steps,
		...(until !== undefined ? { until: until.slice(0, MAX_LOOP_UNTIL) } : {}),
		iteration: lane.loop?.iteration ?? 1,
		...(op.active === false ? { active: false } : {}),
	};
	lane.updatedAt = now;
	updated.push(lane.id);
}

/**
 * Advance a lane's wave counter.
 *
 * The body items' statuses are deliberately NOT reset: a tick that silently
 * reopened them would erase what the last wave actually did. The model reopens
 * what it is genuinely redoing.
 */
function applyLoopTick(
	doc: PlanDoc,
	op: LoopTickOp,
	now: number,
	updated: string[],
	problems: string[],
	label: string,
): void {
	const lane = findLane(doc, op.lane);
	if (!lane?.loop) {
		problems.push(`${label}: lane "${String(op.lane)}" has no loop to tick`);
		return;
	}
	lane.loop = { ...lane.loop, iteration: (lane.loop.iteration ?? 1) + 1 };
	lane.updatedAt = now;
	updated.push(lane.id);
}

/** Expand one of the recognisable lane shapes, in a single apply. */
function applyTemplate(
	doc: PlanDoc,
	op: TemplateOp,
	now: number,
	created: string[],
	updated: string[],
	problems: string[],
	label: string,
): void {
	const name = cleanString(op.name);
	if (name === undefined || !(name in LANE_TEMPLATES)) {
		problems.push(`${label}: unknown template "${String(op.name)}". Available: ${Object.keys(LANE_TEMPLATES).join(", ")}`);
		return;
	}
	const ops = templateLaneOps(doc, name, cleanString(op.title));
	if (ops.length === 0) return; // already there — asking twice is a no-op
	for (const inner of ops) {
		if (inner.op === "lane") applyLane(doc, inner, now, created, updated, problems, label);
		else if (inner.op === "loop") applyLoop(doc, inner, now, updated, problems, label);
	}
}

/** A loop's exit condition is a label, not an essay. */
const MAX_LOOP_UNTIL = 120;

/* -------------------------------------------------------------------------- */
/* Block normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Distributive, because `PlanBlock` is a union: a plain `Omit` over a union
 * collapses to the keys COMMON to every member, which here is just `type` and
 * `title` — so every block body would fail to typecheck.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type NormalizedBlock = DistributiveOmit<PlanBlock, "id" | "createdAt" | "updatedAt">;

/**
 * Validate and clean one model-supplied block.
 *
 * Returns `undefined` and records a problem rather than throwing, and rejects
 * an unknown `type` outright — the closed catalog is the security property, so
 * "pass it through and let the renderer cope" is exactly the hole it exists to
 * close.
 */
function normalizeBlock(input: BlockInput | undefined, problems: string[], label: string): NormalizedBlock | undefined {
	if (typeof input !== "object" || input === null) {
		problems.push(`${label}: block must be an object`);
		return undefined;
	}
	const type = (input as { type?: unknown }).type;
	if (typeof type !== "string" || !VALID_BLOCK_TYPES.includes(type as BlockType)) {
		problems.push(`${label}: unknown block type "${String(type)}". Available: ${VALID_BLOCK_TYPES.join(", ")}`);
		return undefined;
	}
	const title = cleanString((input as { title?: unknown }).title);

	switch (type as BlockType) {
		case "text": {
			const markdown = cleanString((input as { markdown?: unknown }).markdown);
			if (markdown === undefined) {
				problems.push(`${label}: a text block needs markdown`);
				return undefined;
			}
			return { type: "text", title, markdown };
		}
		case "callout": {
			const markdown = cleanString((input as { markdown?: unknown }).markdown);
			const tone = (input as { tone?: unknown }).tone;
			if (markdown === undefined) {
				problems.push(`${label}: a callout block needs markdown`);
				return undefined;
			}
			const tones = ["info", "warn", "risk", "success"];
			if (typeof tone !== "string" || !tones.includes(tone)) {
				problems.push(`${label}: callout tone must be one of ${tones.join(", ")}`);
				return undefined;
			}
			return { type: "callout", title, tone: tone as CalloutBlock["tone"], markdown };
		}
		case "diagram": {
			const mermaid = cleanString((input as { mermaid?: unknown }).mermaid);
			if (mermaid === undefined) {
				problems.push(`${label}: a diagram block needs mermaid source`);
				return undefined;
			}
			return { type: "diagram", title, mermaid, caption: cleanString((input as { caption?: unknown }).caption) };
		}
		case "steps": {
			const raw = (input as { steps?: unknown }).steps;
			if (!Array.isArray(raw) || raw.length === 0) {
				problems.push(`${label}: a steps block needs at least one step`);
				return undefined;
			}
			const steps: PlanStep[] = [];
			raw.forEach((entry, i) => {
				const stepTitle = cleanString((entry as { title?: unknown })?.title);
				if (stepTitle === undefined) {
					problems.push(`${label}: step #${i + 1} needs a title`);
					return;
				}
				// THE STATUS IS READ THROUGH `normalizeStatus`, NOT AGAINST THE RAW LIST.
				//
				// This path used to test membership of `VALID_STEP_STATUSES` and then
				// RETURN, which skipped the `steps.push` below — so an unreadable status
				// cost the whole STEP, not the field. That mattered because the schema
				// this block is validated against ADVERTISES two words the raw list does
				// not have: `StepStatusSchema` accepts `completed` and `running` as
				// synonyms, and says so in its own description. Measured: a steps block
				// carrying completed/running/done stored ONE of its three steps, and the
				// two it dropped were the ones reporting progress. The same statuses via
				// `op:"lane"` stored fine, because that path goes through `normalizeItem`
				// → `normalizeStatus`. Same tool, same schema, two handlers.
				//
				// So the synonyms resolve HERE the way they resolve for an item, rather
				// than being appended to `VALID_STEP_STATUSES` — that list is the set of
				// statuses a step may HOLD, the synonyms are spellings a caller may SEND,
				// and collapsing the two would put `completed` into the stored vocabulary
				// every renderer and counter switches on.
				//
				// A word nothing can map still keeps its step, at `pending`, with the
				// field refused out loud — the rule `applyItem` already follows above.
				// `pending` is `mergeSteps`'s "no opinion" marker, so a re-stated step
				// that had earned `done` keeps it: refusing the field costs no progress.
				const status = (entry as { status?: unknown }).status;
				const resolved = normalizeStatus(status);
				if (status !== undefined && resolved === undefined) {
					problems.push(
						`${label}: step #${i + 1} has unknown status "${String(status)}"; the step was kept at pending`,
					);
				}
				steps.push({
					// Step ids are LOCAL and author-supplied, unlike block ids. A model
					// re-stating a list keeps them stable, which is what lets `mergeSteps`
					// carry status across a reword.
					id: cleanString((entry as { id?: unknown }).id) ?? String(i + 1),
					title: stepTitle,
					detail: cleanString((entry as { detail?: unknown }).detail),
					status: resolved ?? "pending",
					files: cleanStringList((entry as { files?: unknown }).files),
					blockedBy: cleanStringList((entry as { blockedBy?: unknown }).blockedBy),
				});
			});
			if (steps.length === 0) return undefined;
			return { type: "steps", title, steps };
		}
		case "chart": {
			const chart = (input as { chart?: unknown }).chart;
			const kinds = ["bar", "line", "pie", "progress"];
			if (typeof chart !== "string" || !kinds.includes(chart)) {
				problems.push(`${label}: chart must be one of ${kinds.join(", ")}`);
				return undefined;
			}
			const raw = (input as { series?: unknown }).series;
			if (!Array.isArray(raw) || raw.length === 0) {
				problems.push(`${label}: a chart block needs a non-empty series`);
				return undefined;
			}
			const series: { label: string; value: number }[] = [];
			raw.forEach((entry, i) => {
				const seriesLabel = cleanString((entry as { label?: unknown })?.label);
				const value = (entry as { value?: unknown })?.value;
				if (seriesLabel === undefined || typeof value !== "number" || !Number.isFinite(value)) {
					problems.push(`${label}: chart point #${i + 1} needs a label and a finite numeric value`);
					return;
				}
				series.push({ label: seriesLabel, value });
			});
			if (series.length === 0) return undefined;
			return {
				type: "chart",
				title,
				chart: chart as ChartBlock["chart"],
				series,
				unit: cleanString((input as { unit?: unknown }).unit),
				caption: cleanString((input as { caption?: unknown }).caption),
			};
		}
		case "refs": {
			const raw = (input as { refs?: unknown }).refs;
			if (!Array.isArray(raw) || raw.length === 0) {
				problems.push(`${label}: a refs block needs at least one reference`);
				return undefined;
			}
			const kinds = ["linear", "pr", "file", "doc", "url"];
			const refs: RefsBlock["refs"] = [];
			raw.forEach((entry, i) => {
				const refLabel = cleanString((entry as { label?: unknown })?.label);
				if (refLabel === undefined) {
					problems.push(`${label}: reference #${i + 1} needs a label`);
					return;
				}
				const kind = (entry as { kind?: unknown }).kind;
				refs.push({
					label: refLabel,
					url: cleanString((entry as { url?: unknown }).url),
					kind: typeof kind === "string" && kinds.includes(kind) ? (kind as RefsBlock["refs"][number]["kind"]) : undefined,
					note: cleanString((entry as { note?: unknown }).note),
				});
			});
			if (refs.length === 0) return undefined;
			return { type: "refs", title, refs };
		}
		case "table": {
			const columns = cleanStringList((input as { columns?: unknown }).columns);
			const rawRows = (input as { rows?: unknown }).rows;
			if (columns === undefined || columns.length === 0) {
				problems.push(`${label}: a table block needs columns`);
				return undefined;
			}
			if (!Array.isArray(rawRows) || rawRows.length === 0) {
				problems.push(`${label}: a table block needs rows`);
				return undefined;
			}
			const rows: string[][] = [];
			rawRows.forEach((row, i) => {
				if (!Array.isArray(row)) {
					problems.push(`${label}: table row #${i + 1} must be an array`);
					return;
				}
				// Pad and truncate rather than reject: a ragged row is a formatting
				// slip, and failing the whole block over one is a bad trade.
				const cells = row.map((cell) => (typeof cell === "string" ? cell : String(cell ?? "")));
				while (cells.length < columns.length) cells.push("");
				rows.push(cells.slice(0, columns.length));
			});
			if (rows.length === 0) return undefined;
			return { type: "table", title, columns, rows };
		}
		case "code": {
			// NOT cleanString: leading whitespace is the indentation, and trailing
			// blank lines are harmless. Only an entirely blank body is a mistake.
			const raw = (input as { code?: unknown }).code;
			if (typeof raw !== "string" || raw.trim().length === 0) {
				problems.push(`${label}: a code block needs a non-empty code string`);
				return undefined;
			}
			return {
				type: "code",
				title,
				language: cleanString((input as { language?: unknown }).language),
				code: raw,
				caption: cleanString((input as { caption?: unknown }).caption),
			};
		}
		case "artifact": {
			const raw = (input as { html?: unknown }).html;
			if (typeof raw !== "string" || raw.trim().length === 0) {
				problems.push(`${label}: an artifact block needs a non-empty html document`);
				return undefined;
			}
			// Refused, not truncated. Half an HTML document renders as garbage and
			// looks like the model's mistake rather than the cap's, so the model is
			// told the real reason and can decide what to cut.
			if (raw.length > MAX_ARTIFACT_CHARS) {
				problems.push(
					`${label}: artifact html is ${raw.length} characters, over the ${MAX_ARTIFACT_CHARS} limit — ` +
						`build it smaller, or describe it in text and link the real thing with refs`,
				);
				return undefined;
			}
			const height = (input as { height?: unknown }).height;
			return {
				type: "artifact",
				title,
				html: raw,
				// The renderer clamps to what it can actually give the frame; this only
				// declines a value that is not a number at all.
				height: typeof height === "number" && Number.isFinite(height) ? Math.round(height) : undefined,
				caption: cleanString((input as { caption?: unknown }).caption),
			};
		}
		case "checklist": {
			const raw = (input as { items?: unknown }).items;
			if (!Array.isArray(raw) || raw.length === 0) {
				problems.push(`${label}: a checklist block needs at least one item`);
				return undefined;
			}
			const items: ChecklistBlock["items"] = [];
			raw.forEach((entry, index) => {
				const id = cleanString((entry as { id?: unknown })?.id);
				const text = cleanString((entry as { text?: unknown })?.text);
				if (!id || !text) problems.push(`${label}: checklist item #${index + 1} needs an id and text`);
				else items.push({ id, text, checked: (entry as { checked?: unknown }).checked === true, evidence: cleanString((entry as { evidence?: unknown }).evidence) });
			});
			return items.length > 0 ? { type: "checklist", title, items } : undefined;
		}
		case "ticket": {
			const key = cleanString((input as { key?: unknown }).key)?.toUpperCase();
			if (!key) { problems.push(`${label}: a ticket block needs a key`); return undefined; }
			const role = (input as { role?: unknown }).role;
			return { type: "ticket", title, key, url: cleanString((input as { url?: unknown }).url), role: role === "primary" || role === "related" ? role : undefined };
		}
		case "milestone": {
			const goalId = cleanString((input as { goalId?: unknown }).goalId);
			if (!goalId) { problems.push(`${label}: a milestone block needs a goalId`); return undefined; }
			return { type: "milestone", title, goalId, stepId: cleanString((input as { stepId?: unknown }).stepId) };
		}
		case "decision": {
			const question = cleanString((input as { question?: unknown }).question);
			const chosen = cleanString((input as { chosen?: unknown }).chosen);
			const rationale = cleanString((input as { rationale?: unknown }).rationale);
			const options = cleanStringList((input as { options?: unknown }).options);
			const source = (input as { source?: unknown }).source;
			const at = (input as { at?: unknown }).at;
			if (!question || !chosen || !rationale || options === undefined || typeof source !== "string" || !["plan_ask", "grill", "comment"].includes(source) || typeof at !== "number" || !Number.isFinite(at)) {
				problems.push(`${label}: a decision needs question, options, chosen, rationale, source and at`);
				return undefined;
			}
			return { type: "decision", title, question, options, chosen, rationale, source: source as DecisionBlock["source"], at: Math.round(at) };
		}
		case "log": {
			const raw = (input as { entries?: unknown }).entries;
			if (!Array.isArray(raw) || raw.length === 0) { problems.push(`${label}: a log block needs entries`); return undefined; }
			const entries: LogBlock["entries"] = [];
			raw.forEach((entry, index) => {
				const text = cleanString((entry as { text?: unknown })?.text);
				const kind = (entry as { kind?: unknown })?.kind;
				const at = (entry as { at?: unknown })?.at;
				if (!text || typeof kind !== "string" || !["stage", "gate", "approval", "note"].includes(kind) || typeof at !== "number" || !Number.isFinite(at)) problems.push(`${label}: log entry #${index + 1} needs at, kind and text`);
				else entries.push({ at: Math.round(at), kind: kind as LogBlock["entries"][number]["kind"], text });
			});
			return entries.length > 0 ? { type: "log", title, entries } : undefined;
		}
		case "metrics": {
			const raw = (input as { metrics?: unknown }).metrics;
			if (!Array.isArray(raw) || raw.length === 0) {
				problems.push(`${label}: a metrics block needs at least one metric`);
				return undefined;
			}
			const metrics: MetricsBlock["metrics"] = [];
			raw.forEach((entry, i) => {
				const metricLabel = cleanString((entry as { label?: unknown })?.label);
				const value = (entry as { value?: unknown })?.value;
				if (metricLabel === undefined || value === undefined || value === null) {
					problems.push(`${label}: metric #${i + 1} needs a label and a value`);
					return;
				}
				metrics.push({
					label: metricLabel,
					value: typeof value === "string" ? value : String(value),
					delta: cleanString((entry as { delta?: unknown }).delta),
				});
			});
			if (metrics.length === 0) return undefined;
			return { type: "metrics", title, metrics };
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export function allSteps(doc: PlanDoc): PlanStep[] {
	return doc.blocks.flatMap((block) => (block.type === "steps" ? block.steps : []));
}

/**
 * Item counts across every lane.
 *
 * Items whose kind Hive resolves are EXCLUDED, for the same reason the tool
 * refuses to set their status: the number here is not a fact about them. A
 * delivery lane's five steps are not five things the agent has left to do —
 * they are five observations nobody has made yet — and counting them reports a
 * finished session as 40% done forever.
 */
export function stepCounts(doc: PlanDoc): Record<WorkItemStatus, number> & { total: number } {
	const counts: Record<WorkItemStatus, number> & { total: number } = {
		pending: 0,
		in_progress: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		blocked: 0,
		total: 0,
	};
	for (const item of allSteps(doc)) {
		if (isObservedKind(item.kind)) continue;
		counts[item.status] += 1;
		counts.total += 1;
	}
	return counts;
}

/** Dependency edges naming an item that no longer exists. Advisory; never repaired. */
export function danglingBlockers(doc: PlanDoc): { id: string; missing: string[] }[] {
	const live = new Set(allSteps(doc).map((step) => step.id));
	const dangling: { id: string; missing: string[] }[] = [];
	for (const step of allSteps(doc)) {
		const missing = [...(step.dependsOn ?? []), ...(step.blockedBy ?? [])].filter((blocker) => !live.has(blocker));
		if (missing.length > 0) dangling.push({ id: step.id, missing });
	}
	return dangling;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/** The persisted shape. Whole-snapshot, because "current" must be readable from one entry. */
export function toEntry(doc: PlanDoc): Record<string, unknown> {
	return { kind: "plan", schemaVersion: SCHEMA_VERSION, doc };
}

/**
 * A tick: the counters, the stage, and the items that moved.
 *
 * Deliberately NOT a diff of the whole document. Ticks carry exactly what the
 * tick ops can change, so folding one is a bounded, total function rather than
 * a patch application that can fail halfway — and a tick that cannot be
 * understood is skipped, leaving the snapshot beneath it intact.
 */
export function tickEntry(doc: PlanDoc): Record<string, unknown> {
	return {
		kind: "plan.tick",
		schemaVersion: SCHEMA_VERSION,
		revision: doc.revision,
		progress: doc.progress,
		stage: doc.stage,
		phase: doc.phase,
		updatedAt: doc.updatedAt,
		items: allSteps(doc).map((item) => ({
			id: item.id,
			status: item.status,
			note: item.note,
			startedAt: item.startedAt,
			endedAt: item.endedAt,
		})),
		loops: doc.blocks
			.filter((block): block is LaneBlock => block.type === "steps" && block.loop !== undefined)
			.map((lane) => ({ id: lane.id, iteration: lane.loop?.iteration, active: lane.loop?.active })),
		checklists: doc.blocks
			.filter((block): block is ChecklistBlock => block.type === "checklist")
			.map((block) => ({ id: block.id, items: block.items.map((item) => ({ id: item.id, checked: item.checked, evidence: item.evidence })) })),
	};
}

/**
 * Fold one tick over a document.
 *
 * Skips a tick whose revision does not match: a tick belongs to the snapshot it
 * was written against, and applying a stale one over a newer document would
 * revive statuses the re-plan deliberately reset. Unknown item ids are ignored
 * for the same reason a dangling edge is — the document is the authority on
 * what exists.
 */
export function applyTick(doc: PlanDoc, data: unknown): PlanDoc {
	if (typeof data !== "object" || data === null) return doc;
	const tick = data as Record<string, unknown>;
	if (tick.kind !== "plan.tick" || tick.schemaVersion !== SCHEMA_VERSION) return doc;
	if (typeof tick.revision !== "number" || tick.revision !== doc.revision) return doc;

	const statuses = new Map<string, Record<string, unknown>>();
	for (const raw of Array.isArray(tick.items) ? tick.items : []) {
		const item = raw as Record<string, unknown>;
		if (typeof item?.id === "string") statuses.set(item.id, item);
	}
	const loops = new Map<string, Record<string, unknown>>();
	for (const raw of Array.isArray(tick.loops) ? tick.loops : []) {
		const loop = raw as Record<string, unknown>;
		if (typeof loop?.id === "string") loops.set(loop.id, loop);
	}
	const checklists = new Map<string, Map<string, Record<string, unknown>>>();
	for (const raw of Array.isArray(tick.checklists) ? tick.checklists : []) {
		const checklist = raw as Record<string, unknown>;
		if (typeof checklist?.id !== "string") continue;
		const items = new Map<string, Record<string, unknown>>();
		for (const item of Array.isArray(checklist.items) ? checklist.items : []) {
			if (typeof (item as { id?: unknown })?.id === "string") items.set((item as { id: string }).id, item as Record<string, unknown>);
		}
		checklists.set(checklist.id, items);
	}

	return {
		...doc,
		progress: typeof tick.progress === "number" ? tick.progress : doc.progress,
		stage: typeof tick.stage === "string" ? tick.stage : doc.stage,
		phase: VALID_PHASES.includes(tick.phase as PlanPhase) ? (tick.phase as PlanPhase) : doc.phase,
		updatedAt: typeof tick.updatedAt === "number" ? tick.updatedAt : doc.updatedAt,
		blocks: doc.blocks.map((block) => {
			if (block.type === "checklist") {
				const items = checklists.get(block.id);
				return !items ? block : { ...block, items: block.items.map((item) => {
					const ticked = items.get(item.id);
					return ticked ? { ...item, checked: ticked.checked === true, evidence: typeof ticked.evidence === "string" ? ticked.evidence : item.evidence } : item;
				}) };
			}
			if (block.type !== "steps") return block;
			const loop = loops.get(block.id);
			return {
				...block,
				...(block.loop && loop
					? {
							loop: {
								...block.loop,
								iteration: typeof loop.iteration === "number" ? loop.iteration : block.loop.iteration,
								...(loop.active === false ? { active: false } : {}),
							},
						}
					: {}),
				steps: block.steps.map((item) => {
					const moved = statuses.get(item.id);
					if (!moved) return item;
					const status = normalizeStatus(moved.status);
					return {
						...item,
						status: status ?? item.status,
						note: typeof moved.note === "string" ? moved.note : item.note,
						startedAt: typeof moved.startedAt === "number" ? moved.startedAt : item.startedAt,
						endedAt: typeof moved.endedAt === "number" ? moved.endedAt : item.endedAt,
					};
				}),
			};
		}),
	};
}

export function validateSnapshot(data: unknown): PlanDoc | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "plan") return null;
	// A newer writer's shape is not ours to guess at: an unknown version
	// rehydrates as "no plan" rather than as a partially-understood one.
	if (record.schemaVersion !== SCHEMA_VERSION) return null;

	const doc = record.doc as Partial<PlanDoc> | undefined;
	if (typeof doc !== "object" || doc === null || !Array.isArray(doc.blocks)) return null;

	const blocks = doc.blocks
		.filter((block): block is PlanBlock => {
			if (typeof block !== "object" || block === null) return false;
			const candidate = block as Partial<PlanBlock>;
			return typeof candidate.id === "string" && VALID_BLOCK_TYPES.includes(candidate.type as BlockType);
		})
		// ITEMS ARE FILTERED TOO, which the block filter alone did not do.
		//
		// A lane is the one block whose contents come from several writers, and a
		// malformed item — `null`, or an object with no id — used to pass straight
		// through into the counts, the renderer and the deck. The todo store this
		// replaced dropped such rows on rehydrate; keeping that property here is
		// what stops a truncated or hand-edited transcript from putting an
		// untitled ghost in somebody's task list.
		.map((block) => {
			if (block.type !== "steps") return block;
			const steps = (Array.isArray(block.steps) ? block.steps : []).filter((item): item is WorkItem => {
				if (typeof item !== "object" || item === null) return false;
				const candidate = item as Partial<WorkItem>;
				return typeof candidate.id === "string" && typeof candidate.title === "string";
			});
			return steps.length === block.steps?.length ? block : { ...block, steps };
		});

	// Repair rather than trust: a persisted `nextId` behind the live maximum
	// would hand the next block an id that already exists.
	const highest = blocks.reduce((max, block) => {
		const numeric = Number(block.id);
		return Number.isSafeInteger(numeric) && numeric > max ? numeric : max;
	}, 0);
	const stored = typeof doc.nextId === "number" && Number.isSafeInteger(doc.nextId) ? doc.nextId : 1;

	return {
		title: typeof doc.title === "string" ? doc.title : "",
		goal: typeof doc.goal === "string" ? doc.goal : "",
		// A snapshot written before the merge has no `phase: "none"` and never
		// will: it defaults to `drafting`, which is what it meant. Only a NEW
		// document starts at `none`, so an old session's plan keeps presenting
		// itself exactly as it did.
		phase: VALID_PHASES.includes(doc.phase as PlanPhase) ? (doc.phase as PlanPhase) : "drafting",
		revision: typeof doc.revision === "number" && Number.isSafeInteger(doc.revision) ? doc.revision : 0,
		// Absent in every pre-merge snapshot. Zero is right: nothing had ticked
		// under a counter that did not exist, and the first tick after a resume
		// moves it to 1 rather than inventing history.
		progress: typeof doc.progress === "number" && Number.isSafeInteger(doc.progress) ? doc.progress : 0,
		stage: typeof doc.stage === "string" && doc.stage.trim() !== "" ? doc.stage.trim() : undefined,
		tickets: Array.isArray(doc.tickets)
			? (doc.tickets as PlanDoc["tickets"])
			: undefined,
		milestone:
			typeof doc.milestone === "object" && doc.milestone !== null && typeof (doc.milestone as { goalId?: unknown }).goalId === "string"
				? (doc.milestone as PlanDoc["milestone"])
				: undefined,
		blocks,
		nextId: Math.max(stored, highest + 1),
		createdAt: typeof doc.createdAt === "number" ? doc.createdAt : 0,
		updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : 0,
	};
}

/**
 * Newest snapshot wins. Scans backwards and stops at the first valid one, so
 * the cost is bounded by recency rather than by session length.
 */
export function rehydratePlan(entries: readonly unknown[]): PlanDoc | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== PLAN_ENTRY_TYPE) continue;
		const snapshot = validateSnapshot(entry.data);
		// Ticks written after this snapshot carry the progress it does not have.
		// Folding forward from `i` keeps the scan bounded by recency: the work is
		// proportional to what has happened since the last re-plan, not to the
		// length of the session.
		if (snapshot) {
			let folded = snapshot;
			for (let j = i + 1; j < entries.length; j++) {
				const later = entries[j] as { customType?: string; data?: unknown } | undefined;
				if (later?.customType === PLAN_TICK_ENTRY_TYPE) folded = applyTick(folded, later.data);
			}
			return folded;
		}
		const doc = snapshot;
		if (doc) return doc;
	}
	return null;
}
