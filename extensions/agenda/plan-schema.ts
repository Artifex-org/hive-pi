/**
 * The plan representation — a declarative DAG the model authors as tool params.
 *
 * Claude Code's dynamic workflows have the model write a JavaScript
 * orchestration script. That buys arbitrary computation and costs a sandbox, a
 * determinism story (its `Date.now()`/`Math.random()` bans exist so replay
 * works), and a resume that replays by call order.
 *
 * A declarative DAG gives up computation and gets back three things worth more
 * here: the scheduler becomes a pure fold that tests with zero child processes;
 * resume falls out of content-derived node ids rather than being built; and
 * there is nothing to eval, because `Ref` is the whole expression language.
 *
 * The escape hatch, stated now so it is not discovered as a surprise: if more
 * than two real workflows need a transform this whitelist cannot express,
 * build the JS backend.
 */

import { Type, type Static } from "typebox";

import { rejectUnsupportedSchema } from "../harness/structured.ts";

export const MAX_FANOUT_ITEMS = 200;
export const MAX_NODES = 200;
export const DEFAULT_MAX_CONCURRENT = 4;
export const CEILING_MAX_CONCURRENT = 8;
export const DEFAULT_MAX_AGENTS = 40;
export const CEILING_MAX_AGENTS = 200;

/**
 * `"<nodeId>.<field>"`, or a bare `"<nodeId>"` for the whole result.
 *
 * Deliberately not an expression language. Anything richer needs an evaluator,
 * and an evaluator over model-authored input is the thing this design exists to
 * avoid.
 */
export const RefSchema = Type.String({
	pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$",
	description: 'Reference to another node\'s output: "<nodeId>" or "<nodeId>.<field>".',
});

const TransformOpSchema = Type.Union([
	Type.Object({ op: Type.Literal("dedupeBy"), keys: Type.Array(Type.String(), { minItems: 1 }) }),
	Type.Object({
		op: Type.Literal("filterBy"),
		path: Type.String(),
		test: Type.Union([
			Type.Literal("eq"),
			Type.Literal("neq"),
			Type.Literal("gt"),
			Type.Literal("gte"),
			Type.Literal("lt"),
			Type.Literal("lte"),
			Type.Literal("truthy"),
			Type.Literal("contains"),
		]),
		value: Type.Optional(Type.Unknown()),
	}),
	Type.Object({
		op: Type.Literal("topN"),
		n: Type.Integer({ minimum: 1 }),
		by: Type.Optional(Type.String()),
		dir: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
	}),
	Type.Object({ op: Type.Literal("groupBy"), key: Type.String() }),
	Type.Object({ op: Type.Literal("flatten") }),
	Type.Object({ op: Type.Literal("pluck"), path: Type.String() }),
	Type.Object({ op: Type.Literal("count") }),
]);

const AgentSpecSchema = Type.Object({
	role: Type.String({ description: "A subagent role name from agents/." }),
	prompt: Type.String({ minLength: 1 }),
	model: Type.Optional(Type.String()),
	retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
	outputSchema: Type.Optional(Type.Unknown({ description: "JSON Schema the worker's result must satisfy." })),
	// "worktree" is REJECTED by `validatePlan` — no spawner reads this field, so
	// declaring it buys nothing and promises everything. Kept in the schema so an
	// author's intent is still expressible the day a spawner honours it.
	isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
});

/** Every node carries an author-chosen id; the CONTENT hash is derived separately. */
const Base = { id: Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), needs: Type.Optional(Type.Array(RefSchema)) };

export const NodeSchema = Type.Union([
	Type.Object({ ...Base, kind: Type.Literal("agent"), ...AgentSpecSchema.properties }),
	Type.Object({
		...Base,
		kind: Type.Literal("fanout"),
		over: RefSchema,
		...AgentSpecSchema.properties,
		prompt: Type.String({ minLength: 1, description: "Use {item} for the current element." }),
	}),
	Type.Object({
		...Base,
		kind: Type.Literal("pipeline"),
		over: RefSchema,
		stages: Type.Array(AgentSpecSchema, { minItems: 1 }),
	}),
	Type.Object({ ...Base, kind: Type.Literal("barrier"), needs: Type.Array(RefSchema, { minItems: 1 }) }),
	Type.Object({ ...Base, kind: Type.Literal("transform"), over: RefSchema, op: TransformOpSchema }),
	// REJECTED by `validatePlan` until `nextBatch` grows a branch for it: the
	// scheduler cannot instantiate a round, so a repeat node — and everything
	// downstream of it — was silently dropped from an otherwise successful run.
	Type.Object({
		...Base,
		kind: Type.Literal("repeat"),
		body: Type.Array(Type.Unknown(), { minItems: 1 }),
		// REQUIRED, not optional. An unbounded repeat is the one shape in this
		// language that can burn a budget without any node being wrong.
		maxRounds: Type.Integer({ minimum: 1, maximum: 20 }),
		until: Type.Union([
			Type.Object({ kind: Type.Literal("empty"), of: RefSchema }),
			Type.Object({ kind: Type.Literal("count"), of: RefSchema, atLeast: Type.Integer({ minimum: 1 }) }),
			Type.Object({ kind: Type.Literal("budget"), remainingTokensBelow: Type.Integer({ minimum: 1 }) }),
		]),
	}),
]);

export const CapsSchema = Type.Object({
	maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: CEILING_MAX_CONCURRENT })),
	maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: CEILING_MAX_AGENTS })),
	budgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	/**
	 * Run workers as durable RPC sessions in a background plan. The tool returns
	 * a run id immediately; workers stay addressable through `worker_send`, and
	 * completion is pushed once plus retained behind `orchestrate_result`.
	 *
	 * Keep it opt-in for short pure-function nodes. Turn it on whenever scope may
	 * change while the fleet works, or when the parent should continue useful
	 * synthesis instead of blocking on the whole wave.
	 */
	durable: Type.Optional(Type.Boolean()),
});

export const PlanSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	description: Type.String({ minLength: 1 }),
	nodes: Type.Array(NodeSchema, { minItems: 1 }),
	caps: Type.Optional(CapsSchema),
});

export type Plan = Static<typeof PlanSchema>;
export type PlanNode = Static<typeof NodeSchema>;
export type TransformOp = Static<typeof TransformOpSchema>;
export type Caps = Static<typeof CapsSchema>;

export interface ResolvedCaps {
	maxConcurrent: number;
	maxAgents: number;
	budgetTokens?: number;
	durable: boolean;
}

export function resolveCaps(caps: Caps | undefined): ResolvedCaps {
	return {
		maxConcurrent: Math.min(caps?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, CEILING_MAX_CONCURRENT),
		maxAgents: Math.min(caps?.maxAgents ?? DEFAULT_MAX_AGENTS, CEILING_MAX_AGENTS),
		budgetTokens: caps?.budgetTokens,
		durable: caps?.durable === true,
	};
}

export interface ValidationIssue {
	nodeId?: string;
	message: string;
}

/** Nodes that spawn workers; the rest are bookkeeping and cost nothing. */
export function isAgentBearing(node: PlanNode): boolean {
	return node.kind === "agent" || node.kind === "fanout" || node.kind === "pipeline";
}

/**
 * Semantic validation, on top of the typebox shape check.
 *
 * Everything here is a rejection the SCHEMA cannot express: unknown roles,
 * dangling refs, duplicate ids, cycles. The error messages name the offending
 * node and, for a bad role, enumerate the real ones — a model that guessed
 * "researcher" needs to see "research" rather than "unknown agent".
 *
 * It is also where DECLARED-BUT-UNIMPLEMENTED shapes are refused — `repeat`
 * nodes and `isolation:"worktree"`. Both type-check, and the runtime then drops
 * the first silently and ignores the second dangerously. A validator is the one
 * place that can say so before a worker is paid for.
 *
 * NOTE, and this reverses the written plan: a node's `outputSchema` setting
 * `additionalProperties:false` is NOT rejected. That instruction was imported
 * from Claude Code's `Workflow agent({schema})` validator, which has the
 * OPPOSITE requirement to pi's. pi sends the schema to the provider unmodified
 * and `constrainedSampling` strict mode *requires* `additionalProperties:false`
 * plus every key in `required` — so the borrowed rule would have 400'd every
 * node at the provider.
 */
export function validatePlan(plan: Plan, knownRoles: readonly string[]): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const ids = new Set<string>();

	if (plan.nodes.length > MAX_NODES) {
		issues.push({ message: `plan has ${plan.nodes.length} nodes; the limit is ${MAX_NODES}` });
	}

	for (const node of plan.nodes) {
		if (ids.has(node.id)) issues.push({ nodeId: node.id, message: `duplicate node id "${node.id}"` });
		ids.add(node.id);
	}

	const roleList = knownRoles.join(", ");
	const checkRole = (nodeId: string, role: string) => {
		if (!knownRoles.includes(role)) {
			issues.push({ nodeId, message: `unknown role "${role}". Available: ${roleList}` });
		}
	};

	// An `outputSchema` the validator cannot use would otherwise be discovered
	// only after the node ran, by failing it — the author pays for a worker to
	// learn about a typo in their own schema.
	const checkSchema = (nodeId: string, schema: unknown, where: string) => {
		if (schema === undefined) return;
		const problem = rejectUnsupportedSchema(schema);
		if (problem) issues.push({ nodeId, message: `${where} outputSchema is unusable: ${problem}` });
	};

	// `isolation: "worktree"` is declared here, carried all the way onto the
	// emitted `Dispatch`, and read by NOBODY: both spawners hand every worker the
	// controller's own `cwd`. A plan that asked for it therefore ran — and
	// COMMITTED — in the controller's checkout, which is the one outcome the
	// setting exists to prevent. Until a spawner honours it, saying no is the
	// only answer that does not quietly do the dangerous thing.
	const checkIsolation = (nodeId: string, isolation: string | undefined, where: string) => {
		if (isolation !== "worktree") return;
		issues.push({
			nodeId,
			message:
				`${where}worktree isolation is not implemented; this worker would run in the controller's checkout. ` +
				'Drop it (or set isolation:"none") and give the worker a cwd-safe task.',
		});
	};

	for (const node of plan.nodes) {
		if (node.kind === "agent" || node.kind === "fanout") {
			checkRole(node.id, node.role);
			checkSchema(node.id, node.outputSchema, "");
			checkIsolation(node.id, node.isolation, "");
		}
		if (node.kind === "pipeline") {
			for (const [index, stage] of node.stages.entries()) {
				checkRole(node.id, stage.role);
				checkSchema(node.id, stage.outputSchema, `stage ${index + 1}`);
				checkIsolation(node.id, stage.isolation, `stage ${index + 1} `);
			}
		}
		if (node.kind === "repeat") {
			// The scheduler has no branch for `repeat`. A plan containing one
			// validated clean, ran its other nodes, and finished `halted:
			// undefined, failures: []` — the repeat AND everything downstream of it
			// were never instantiated, never marked skipped, never mentioned. A
			// rejection the author can read beats a success that silently omitted
			// a third of their plan. Implementing it is a real piece of work
			// (rounds, per-round node identity, `until` evaluation against a
			// budget) and belongs in a ticket, not in a validator.
			issues.push({
				nodeId: node.id,
				message:
					"`repeat` is declared in the schema but not implemented by the scheduler; unroll it into explicit nodes " +
					`(up to ${node.maxRounds} copies) or drive the rounds from successive orchestrate calls.`,
			});
		}
		if (node.kind === "fanout" && !node.prompt.includes("{item}")) {
			// A fanout whose prompt ignores the item runs N identical agents —
			// always a mistake, and an expensive one.
			issues.push({ nodeId: node.id, message: "a fanout prompt must reference {item}" });
		}
	}

	// Refs must point at declared nodes.
	for (const node of plan.nodes) {
		const refs: string[] = [...(node.needs ?? [])];
		if (node.kind === "fanout" || node.kind === "pipeline" || node.kind === "transform") refs.push(node.over);
		for (const ref of refs) {
			const target = ref.split(".")[0];
			if (!ids.has(target)) {
				issues.push({ nodeId: node.id, message: `reference "${ref}" points at unknown node "${target}"` });
			}
			if (target === node.id) {
				issues.push({ nodeId: node.id, message: `node "${node.id}" references itself` });
			}
		}
	}

	issues.push(...detectCycles(plan));
	return issues;
}

/** Dependency edges into a node: explicit `needs` plus the implicit `over`. */
export function dependenciesOf(node: PlanNode): string[] {
	const refs: string[] = [...(node.needs ?? [])];
	if (node.kind === "fanout" || node.kind === "pipeline" || node.kind === "transform") refs.push(node.over);
	return refs.map((ref) => ref.split(".")[0]);
}

function detectCycles(plan: Plan): ValidationIssue[] {
	const byId = new Map(plan.nodes.map((node) => [node.id, node]));
	const state = new Map<string, "visiting" | "done">();
	const issues: ValidationIssue[] = [];

	const visit = (id: string, stack: string[]): void => {
		const current = state.get(id);
		if (current === "done") return;
		if (current === "visiting") {
			const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
			issues.push({ nodeId: id, message: `dependency cycle: ${cycle}` });
			return;
		}
		const node = byId.get(id);
		if (!node) return; // already reported as a dangling ref
		state.set(id, "visiting");
		for (const dep of dependenciesOf(node)) visit(dep, [...stack, id]);
		state.set(id, "done");
	};

	for (const node of plan.nodes) visit(node.id, []);
	return issues;
}
