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
 * Persistence is `pi.appendEntry("plan", snapshot)` — the idiom `tasks/state.ts`
 * and `agenda/goal-state.ts` already use, for the same verified reasons: custom
 * entries are structurally invisible to the LLM, survive compaction, and are
 * copied into a fork. The model sees the plan through TOOL RESULTS, never
 * through a `context` handler (a prompt-cache hazard this repo bans and tests).
 */

export const PLAN_ENTRY_TYPE = "plan";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

/**
 * Phases of the plan itself, NOT of the work.
 *
 * Progress through the work lives in step status, exactly once. A phase that
 * tried to also mean "half the steps are done" would be a second copy of
 * something already recorded, and the two would disagree.
 */
export type PlanPhase = "drafting" | "ready" | "approved" | "abandoned";

export type StepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

const VALID_PHASES: readonly PlanPhase[] = ["drafting", "ready", "approved", "abandoned"];
const VALID_STEP_STATUSES: readonly StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

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
	| "artifact";

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

export interface PlanStep {
	id: string;
	title: string;
	detail?: string;
	status: StepStatus;
	/** Files this step is expected to touch. Advisory; nothing enforces it. */
	files?: string[];
	/** Ids of steps this one waits on. Advisory — see `applyOps`. */
	blockedBy?: string[];
	/** The `tasks` extension id this step materialized into once approved. */
	taskId?: string;
	linearKey?: string;
	/** Worker id, when a step is delegated. */
	owner?: string;
	/**
	 * What ACTUALLY happened, when it diverged from what was planned.
	 *
	 * The single cheapest anti-drift device in the design: a plan that records
	 * where reality went differently stays honest, where one that silently
	 * absorbs the change reads as though it predicted it.
	 */
	note?: string;
}

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

export interface StepsBlock extends BlockBase {
	type: "steps";
	steps: PlanStep[];
}

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
	| ArtifactBlock;

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
		phase: "drafting",
		revision: 0,
		blocks: [],
		nextId: 1,
		createdAt: now,
		updatedAt: now,
	};
}

export function isEmpty(doc: PlanDoc): boolean {
	return doc.blocks.length === 0 && doc.title === "" && doc.goal === "";
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
	/** Step id. Blocks are searched for it; the containing block need not be named. */
	id: string;
	status?: StepStatus;
	note?: string;
	owner?: string | null;
	taskId?: string | null;
	linearKey?: string | null;
}

export type PlanOp = HeaderOp | UpsertOp | RemoveOp | MoveOp | SetStepOp;

/** A block as the model supplies it: no ids, no timestamps. */
export type BlockInput =
	| { type: "text"; title?: string; markdown: string }
	| { type: "steps"; title?: string; steps: StepInput[] }
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
	| { type: "artifact"; title?: string; html: string; height?: number; caption?: string };

export interface StepInput {
	/** Preserved when re-stating an existing step, so status and links survive. */
	id?: string;
	title: string;
	detail?: string;
	status?: StepStatus;
	files?: string[];
	blockedBy?: string[];
}

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

/** Ops that change what the plan MEANS, as opposed to how far along it is. */
function isIntentOp(op: PlanOp): boolean {
	if (op.op === "set_step") return false;
	if (op.op === "header") return op.title !== undefined || op.goal !== undefined;
	return true;
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
	let next: PlanDoc = { ...doc, blocks: [...doc.blocks] };
	const created: string[] = [];
	const updated: string[] = [];
	const removed: string[] = [];
	const problems: string[] = [];
	let intentChanged = false;

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
			default:
				problems.push(`${label}: unknown op "${String((op as { op?: unknown }).op)}"`);
		}

		// Only a op that actually applied counts toward the revision.
		if (problems.length === before && isIntentOp(op)) intentChanged = true;
	});

	next = {
		...next,
		revision: intentChanged ? next.revision + 1 : next.revision,
		updatedAt: created.length + updated.length + removed.length > 0 || intentChanged ? now : next.updatedAt,
	};

	return { doc: next, created, updated, removed, problems };
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
}

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
			taskId: step.taskId ?? prior.taskId,
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
	if (op.status !== undefined && !VALID_STEP_STATUSES.includes(op.status)) {
		problems.push(`${label}: unknown step status "${String(op.status)}"`);
		return;
	}

	for (const block of doc.blocks) {
		if (block.type !== "steps") continue;
		const at = block.steps.findIndex((step) => step.id === id);
		if (at === -1) continue;

		const current = block.steps[at];
		let owner = current.owner;
		if (op.owner === null) owner = undefined;
		else if (typeof op.owner === "string") owner = cleanString(op.owner);

		let taskId = current.taskId;
		if (op.taskId === null) taskId = undefined;
		else if (typeof op.taskId === "string") taskId = cleanString(op.taskId);

		let linearKey = current.linearKey;
		if (op.linearKey === null) linearKey = undefined;
		else if (typeof op.linearKey === "string") linearKey = cleanString(op.linearKey);

		block.steps[at] = {
			...current,
			status: op.status ?? current.status,
			note: op.note === undefined ? current.note : cleanString(op.note),
			owner,
			taskId,
			linearKey,
		};
		block.updatedAt = now;
		updated.push(block.id);
		return;
	}

	problems.push(`${label}: no steps block contains step "${id}"`);
}

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
				const status = (entry as { status?: unknown }).status;
				if (status !== undefined && !VALID_STEP_STATUSES.includes(status as StepStatus)) {
					problems.push(`${label}: step #${i + 1} has unknown status "${String(status)}"`);
					return;
				}
				steps.push({
					// Step ids are LOCAL and author-supplied, unlike block ids. A model
					// re-stating a list keeps them stable, which is what lets `mergeSteps`
					// carry status across a reword.
					id: cleanString((entry as { id?: unknown }).id) ?? String(i + 1),
					title: stepTitle,
					detail: cleanString((entry as { detail?: unknown }).detail),
					status: (status as StepStatus | undefined) ?? "pending",
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

export function stepCounts(doc: PlanDoc): Record<StepStatus, number> & { total: number } {
	const counts = { pending: 0, in_progress: 0, done: 0, skipped: 0, blocked: 0, total: 0 };
	for (const step of allSteps(doc)) {
		counts[step.status] += 1;
		counts.total += 1;
	}
	return counts;
}

/** `blockedBy` edges naming a step that no longer exists. Advisory; never repaired. */
export function danglingBlockers(doc: PlanDoc): { id: string; missing: string[] }[] {
	const live = new Set(allSteps(doc).map((step) => step.id));
	const dangling: { id: string; missing: string[] }[] = [];
	for (const step of allSteps(doc)) {
		const missing = (step.blockedBy ?? []).filter((blocker) => !live.has(blocker));
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

export function validateSnapshot(data: unknown): PlanDoc | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "plan") return null;
	// A newer writer's shape is not ours to guess at: an unknown version
	// rehydrates as "no plan" rather than as a partially-understood one.
	if (record.schemaVersion !== SCHEMA_VERSION) return null;

	const doc = record.doc as Partial<PlanDoc> | undefined;
	if (typeof doc !== "object" || doc === null || !Array.isArray(doc.blocks)) return null;

	const blocks = doc.blocks.filter((block): block is PlanBlock => {
		if (typeof block !== "object" || block === null) return false;
		const candidate = block as Partial<PlanBlock>;
		return typeof candidate.id === "string" && VALID_BLOCK_TYPES.includes(candidate.type as BlockType);
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
		phase: VALID_PHASES.includes(doc.phase as PlanPhase) ? (doc.phase as PlanPhase) : "drafting",
		revision: typeof doc.revision === "number" && Number.isSafeInteger(doc.revision) ? doc.revision : 0,
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
		const doc = validateSnapshot(entry.data);
		if (doc) return doc;
	}
	return null;
}
