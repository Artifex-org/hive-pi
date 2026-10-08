/**
 * `subagent` — hive-pi's delegation tool, served to a Claude session.
 *
 * The modes, worker spawn, model choice, writer lock, worktree guard, retries,
 * sampled verifier and result rendering are `extensions/subagent/delegate.ts`
 * — the code the pi tool runs. This file is the host: role discovery through
 * the pinned pi's parser, the catalog ladder narrowed to leased providers,
 * the accounting, and background jobs that report through the aux spool.
 *
 * Two deliberate differences from the pi tool, both because a Claude session
 * lacks the pi surface they need:
 *   - project-local roles are refused (pi gates them behind its project-trust
 *     confirmation, which does not exist here);
 *   - `schema` is not offered (its validator needs typebox, which does not
 *     resolve where the adapter runs).
 */

import { randomUUID } from "node:crypto";
import { MAX_CONCURRENT } from "../../extensions/background/jobs.ts";
import { discoverAgentsWith, projectAgentsAmong, resolveAgent, selectableAgents, type AgentConfig, type AgentScope, type RolesRuntime } from "../../extensions/harness/roles-core.ts";
import type { Usage } from "../../extensions/harness/usage.ts";
import { backgroundRefusal } from "../../extensions/subagent/background.ts";
import {
	backgroundCompletion,
	describeAgentForRecovery,
	requestedAgentNames,
	runAgentWithSchema,
	runChainDelegation,
	runParallelDelegation,
	runSingleDelegation,
	subagentUsageByModel,
	type DelegationHost,
	type DelegationOutcome,
	type DelegationTask,
	type SingleResult,
	type SubagentDetails,
} from "../../extensions/subagent/delegate.ts";
import type { CatalogMode, WorkerModelEnv } from "../../extensions/subagent/model.ts";
import { isWriterCapable } from "../../extensions/harness/writer.ts";
import type { OpMode } from "../../extensions/opmode/modes.ts";
import type { Spool } from "../spool.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

const taskItem = {
	type: "object",
	properties: {
		agent: { type: "string", description: "Name of the agent to invoke" },
		task: { type: "string", description: "Task to delegate to the agent" },
		cwd: { type: "string", description: "Working directory for the agent process" },
		model: {
			type: "string",
			description: "Model to run this worker on, as provider/id. Omit to use the role's pin or the delegation default.",
		},
	},
	required: ["agent", "task"],
	additionalProperties: false,
};

export function subagentToolDefinition(roles: readonly AgentConfig[]): ToolDefinition {
	const names = roles.map((role) => (role.aliases?.length ? `${role.name} (aka ${role.aliases.join(", ")})` : role.name));
	return {
		name: "subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context, running on cheaper non-Anthropic models from the Hive catalog.",
			"Modes: single (agent + task), parallel (tasks array, up to 8, 4 at a time), chain (sequential with {previous} placeholder).",
			names.length > 0 ? `Available agents: ${names.join(", ")}.` : "",
			"Use it for read-heavy exploration, routine fixes, tests, documentation and first-pass review; parallelize only read-only roles in one worktree.",
			"Verify subagent results before relying on them — a confident summary is not evidence.",
		]
			.filter(Boolean)
			.join(" "),
		inputSchema: {
			type: "object",
			properties: {
				agent: { type: "string", description: "Name of the agent to invoke (for single mode)" },
				task: { type: "string", description: "Task to delegate (for single mode)" },
				tasks: { type: "array", items: taskItem, description: "Array of {agent, task} for parallel execution" },
				chain: { type: "array", items: { ...taskItem, properties: { ...taskItem.properties, task: { type: "string", description: "Task with optional {previous} placeholder for prior output" } } }, description: "Array of {agent, task} for sequential execution" },
				agentScope: { type: "string", enum: ["user", "project", "both"], description: 'Which agent directories to use. Default: "user". Project-local roles are not available in a Claude session.' },
				cwd: { type: "string", description: "Working directory for the agent process (single mode)" },
				model: { type: "string", description: "Model for this worker, as provider/id (single mode). Omit for the role's pin or the delegation default." },
				background: {
					type: "boolean",
					description: "Run this delegation in the background and return immediately; you are notified when it finishes. Single mode only; requires `what`.",
				},
				what: { type: "string", description: "Required when background is true: a short human-readable description of what the subagent is doing." },
				verify: { type: "string", enum: ["sample", "off"], description: '"sample" (default) runs one read-only verifier over a writer\'s claim; "off" skips it.' },
			},
			additionalProperties: false,
		},
	};
}

interface SubagentParams {
	agent?: string;
	task?: string;
	tasks?: DelegationTask[];
	chain?: DelegationTask[];
	agentScope?: AgentScope;
	cwd?: string;
	model?: string;
	background?: boolean;
	what?: string;
	verify?: "sample" | "off";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function taskList(value: unknown, field: string): DelegationTask[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value.map((item, i) => {
		const t = item as Record<string, unknown>;
		if (!t || typeof t.agent !== "string" || typeof t.task !== "string") throw new Error(`${field}[${i}] needs string agent and task`);
		return { agent: t.agent, task: t.task, ...(str(t.cwd) ? { cwd: str(t.cwd) } : {}), ...(str(t.model) ? { model: str(t.model) } : {}) };
	});
}

export function parseSubagentParams(args: Record<string, unknown>): SubagentParams {
	const scope = args.agentScope;
	if (scope !== undefined && scope !== "user" && scope !== "project" && scope !== "both") throw new Error(`agentScope must be user, project or both`);
	const verify = args.verify;
	if (verify !== undefined && verify !== "sample" && verify !== "off") throw new Error(`verify must be sample or off`);
	return {
		agent: str(args.agent),
		task: str(args.task),
		tasks: taskList(args.tasks, "tasks"),
		chain: taskList(args.chain, "chain"),
		agentScope: scope,
		cwd: str(args.cwd),
		model: str(args.model),
		background: args.background === true,
		what: str(args.what),
		verify,
	};
}

/**
 * What the session's operating mode lets a delegation run. Claude's PreToolUse
 * hook never sees a pi worker's tool calls, so the posture is enforced HERE,
 * on the roles, before anything spawns:
 *   - discuss / plan / orchestrate are read-only postures: writer-capable
 *     roles are refused (read-only roles, and the read-only verifier, run);
 *   - bugfix withholds edits until a root cause is recorded. A worker cannot
 *     record one for this session, so a writer role runs only if it carries
 *     the bugfix posture ITSELF (`op_mode: bugfix`, e.g. the `bugfix` role):
 *     its own opmode extension then enforces "no fix before a root cause"
 *     inside the worker. Other writers are refused.
 */
export function opModeRefusal(mode: OpMode, roles: readonly AgentConfig[]): string | null {
	if (mode === "build") return null;
	const writers = roles.filter((role) => isWriterCapable(role.tools) && !(mode === "bugfix" && role.opMode === "bugfix"));
	if (writers.length === 0) return null;
	const names = writers.map((role) => `"${role.name}"`).join(", ");
	return mode === "bugfix"
		? `Bugfix mode: no fix before a root cause, so writer roles that do not enforce that themselves are refused: ${names}. ` +
				'Delegate investigation to a read-only role, or the fix to the "bugfix" role, which runs the reproduce → root-cause protocol itself.'
		: `${mode[0].toUpperCase()}${mode.slice(1)} mode is read-only, so writer-capable roles are refused: ${names}. ` +
				"Delegate to a read-only role, or ask the user to switch the session to build mode.";
}

export interface SubagentHost {
	/** The session's operating mode (control.json), read per call. */
	opMode(): OpMode;
	cwd: string;
	roles: RolesRuntime;
	modelEnv: WorkerModelEnv;
	spool: Spool;
	jobs: BackgroundJobs;
	/** True when the driver can deliver a completion (the aux spool is set). */
	canWake: boolean;
}

/** Background delegations of this MCP server; all are aborted when it exits. */
export class BackgroundJobs {
	private seq = 0;
	private readonly log: (line: string) => void;
	private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

	constructor(log: (line: string) => void) {
		this.log = log;
	}

	get size(): number {
		return this.running.size;
	}

	start(run: (signal: AbortSignal, id: string) => Promise<void>): string {
		this.seq += 1;
		// Unique beyond this process: an MCP server restarted mid-session starts
		// counting again, and the driver matches a wake to the call that
		// announced it by this id alone.
		const id = `sub-${this.seq}-${randomUUID().slice(0, 8)}`;
		const controller = new AbortController();
		// A job that throws past its own handling is reported, never left as an
		// unhandled rejection — that would take the whole MCP server, and every
		// other job with it, down.
		const done = run(controller.signal, id)
			.catch((error: unknown) => this.log(`hive-pi mcp: background job ${id} failed: ${error instanceof Error ? error.message : String(error)}`))
			.finally(() => this.running.delete(id));
		this.running.set(id, { controller, done });
		return id;
	}

	/** Abort every job and wait for each worker to unwind (writer locks released, children reaped). */
	async stopAll(): Promise<void> {
		const entries = [...this.running.values()];
		for (const entry of entries) entry.controller.abort();
		await Promise.allSettled(entries.map((entry) => entry.done));
	}
}

/**
 * One usage record per worker per model it ran on — the worker's whole run,
 * retries on another account and its sampled verifier included. The buckets
 * are pi's own telemetry accounting (`subagentUsageByModel`), which reads every
 * attempt's assistant messages; `SingleResult.usage` holds only the last
 * attempt's. A worker's wall time is split across its models by turns.
 */
function spoolResults(spool: Spool, results: readonly SingleResult[]): void {
	for (const result of results) {
		const buckets = subagentUsageByModel([result], () => "unknown");
		const turns = buckets.reduce((sum, b) => sum + b.turns, 0);
		const ms = Math.max(0, (result.lastActivityAtMs ?? Date.now()) - (result.startedAtMs ?? Date.now()));
		for (const b of buckets) {
			const usage: Usage = { input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite, cost: b.cost };
			spool.usage(`subagent:${result.agent}`, `${b.provider}/${b.model}`, usage, turns > 0 ? (ms * b.turns) / turns : ms, Math.max(1, b.turns));
		}
	}
}

export async function runSubagentTool(args: Record<string, unknown>, host: SubagentHost, signal: AbortSignal): Promise<ToolResult> {
	const params = parseSubagentParams(args);
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgentsWith(host.cwd, agentScope, host.roles);
	// No project trust exists here, so project roles are withheld from the pool
	// (pi's untrusted path), and a call that names one is told why.
	const agents = selectableAgents(discovery.agents, false);
	const refused = projectAgentsAmong(discovery.agents, requestedAgentNames(params));
	if (refused.length > 0 || (agents.length === 0 && discovery.agents.length > 0)) {
		const names = refused.length > 0 ? refused.map((a) => `"${a.name}"`).join(", ") : "every role in scope";
		return {
			text:
				`Refusing project-local agents: ${names}. A Claude session has no project-trust confirmation, so repo-supplied roles ` +
				`(${discovery.projectAgentsDir ?? "(unknown)"}) cannot run. Name a user or package agent instead.`,
			isError: true,
		};
	}

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return { text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`, isError: true };
	}

	const requested = requestedAgentNames(params)
		.map((name) => resolveAgent(agents, name))
		.filter((role): role is AgentConfig => role !== undefined);
	const postureRefusal = opModeRefusal(host.opMode(), requested);
	if (postureRefusal) return { text: postureRefusal, isError: true };

	const makeDetails = (mode: DelegationOutcome["mode"]) => (results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	});

	if (params.background) {
		// Deliverable only through the driver: it turns the spool's wake record
		// into a follow-up. pi's refusal speaks in pi's session modes; "rpc" is
		// the one whose notifications land, "print" the one whose do not.
		const refusal = backgroundRefusal(params, host.canWake ? "rpc" : "print");
		if (refusal) return { text: refusal, isError: true };
		if (host.jobs.size >= MAX_CONCURRENT) {
			return { text: `Already running ${host.jobs.size} background delegations (the limit). Wait for one to finish.`, isError: true };
		}
		const agentName = params.agent as string;
		if (!resolveAgent(agents, agentName)) {
			const available = agents.length > 0 ? agents.map(describeAgentForRecovery).join("\n") : "  (none)";
			return { text: `Unknown agent: "${agentName}" — nothing was started. Retry with one of:\n${available}`, isError: true };
		}
		const what = (params.what ?? "").trim();
		const id = host.jobs.start(async (jobSignal, jobId) => {
			let text: string;
			try {
				const result = await runAgentWithSchema(host.cwd, agents, agentName, params.task as string, params.cwd, undefined, jobSignal, undefined, makeDetails("single"), undefined, params.model, host.modelEnv);
				spoolResults(host.spool, [result]);
				const completion = backgroundCompletion(result, jobSignal.aborted);
				text = [`Background delegation \`${jobId}\` (${agentName} — ${what}) ${completion.status}${completion.exitCode !== undefined ? ` (exit ${completion.exitCode})` : ""}.`, completion.summary].filter(Boolean).join("\n\n");
			} catch (error) {
				text = `Background delegation \`${jobId}\` (${agentName} — ${what}) failed: the delegation threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			// A job cancelled because the server is exiting has nobody to wake.
			if (!jobSignal.aborted) host.spool.wake(jobId, text);
		});
		return {
			// The `hive-pi-job:` line is the driver's handshake: it delivers a wake
			// only for a job id it saw announced in this tool's result.
			text:
				`Started background delegation \`${id}\`: ${agentName} — ${what}\n` +
				`hive-pi-job: ${id}\n\n` +
				"It is running now and you will be told when it finishes. Do NOT poll for it: carry on with something else, and deal with the result when it arrives.",
		};
	}

	const delegation: DelegationHost = { cwd: host.cwd, agents, modelEnv: host.modelEnv, signal, makeDetails };
	const outcome = hasChain
		? await runChainDelegation(params.chain as DelegationTask[], delegation)
		: hasTasks
			? await runParallelDelegation(params.tasks as DelegationTask[], params.verify, delegation)
			: await runSingleDelegation({ agent: params.agent as string, task: params.task as string, cwd: params.cwd, model: params.model }, params.verify, delegation);
	spoolResults(host.spool, outcome.results);
	return { text: outcome.text, ...(outcome.isError ? { isError: true } : {}) };
}

/**
 * The delegation model env on a leased store: configured = leased. Build one
 * PER CALL — the catalog read is memoised for the call (a parallel wave asks
 * once), never for the server's life, so a catalog that was unreachable at
 * the first call is read again at the next.
 */
export function leasedModelEnv(isConfigured: (spec: string) => boolean, catalog: () => Promise<readonly CatalogMode[]>): WorkerModelEnv {
	let pending: Promise<readonly CatalogMode[]> | undefined;
	return {
		isConfigured: (spec) => (spec.includes("/") ? isConfigured(spec) : null),
		// No session model: a Claude session's own model is not a pi model, and
		// a delegation must never be promoted onto it.
		sessionModel: undefined,
		catalog: () => (pending ??= catalog()),
		requireExplicitModel: true,
	};
}
