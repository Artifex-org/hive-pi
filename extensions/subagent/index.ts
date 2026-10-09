/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Derived from the MIT-licensed examples/extensions/subagent/ of
 * @earendil-works/pi-coding-agent (© 2025 Mario Zechner). Extended here with
 * per-role models, role discovery across package/user/project scopes, parallel
 * and chain modes, per-task output caps and one-writer-per-worktree
 * enforcement. See LICENSE.
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type Theme,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { lastSubagentId } from "../background/journal.ts";
import {
	DECK_SECTION_CHANNEL,
	DECK_SYNC_CHANNEL,
	type DeckAgentRow,
	type DeckSectionEvent,
} from "../deck/protocol.ts";
import {
	type AgentScope,
	discoverAgents,
	projectAgentsAmong,
	resolveAgent,
	selectableAgents,
	unknownTools,
} from "../harness/roles.ts";
import { cleanupWorkerAgentDir } from "../mcp-common/config.ts";
import { backgroundRefusal, backgroundStartedMessage } from "./background.ts";
import { MAX_CONCURRENT } from "../background/jobs.ts";
import {
	BACKGROUND_CANCEL_CHANNEL,
	BACKGROUND_JOB_CHANNEL,
	type BackgroundJobEvent,
} from "../background/channel.ts";
import * as structuredSupport from "../harness/structured.ts";
import { rejectUnsupportedSchema } from "../harness/structured.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { resolveAuth } from "../hive-common/identity.ts";
import { fetchAgentModeCatalog } from "../advisor/modes.ts";
import { HIVE_METRIC_CHANNEL, type HiveMetricEvent } from "../hive-telemetry/types.ts";
import type { WorkerModelEnv } from "./model.ts";
import {
	backgroundCompletion,
	describeAgentForRecovery,
	getFinalOutput,
	isFailedResult,
	requestedAgentNames,
	runAgentWithSchema,
	runChainDelegation,
	runParallelDelegation,
	runSingleDelegation,
	subagentUsageByModel,
	type DelegationHost,
	type DelegationOutcome,
	type DelegationTask,
	type StructuredRequest,
	type ModelAuthResolver,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentUsageByModel,
	type UsageStats,
} from "./delegate.ts";

// The lifted surface, re-exported for the callers and tests that import it from here.
export {
	describeAgentForRecovery,
	getSubagentDefaultModel,
	providerLimitGuidance,
	requestedAgentNames,
	resultNotes,
	retryNote,
	structuredSection,
	subagentUsageByModel,
	type SingleResult,
	type SubagentUsageByModel,
} from "./delegate.ts";

import { DELIVERY_REVIEW_GUIDANCE, registerDeliveryReview } from "./delivery.ts";

const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/**
 * Makes Pi's required tool-level Usage from the same narrow per-model metrics
 * contract telemetry consumes. Per-category dollar prices are unavailable on a
 * child result, so only the authoritative total is reported.
 */
export function subagentToolUsage(models: readonly SubagentUsageByModel[]): Usage | undefined {
	if (models.length === 0) return undefined;
	const total = models.reduce(
		(sum, model) => ({
			input: sum.input + model.input,
			output: sum.output + model.output,
			cacheRead: sum.cacheRead + model.cacheRead,
			cacheWrite: sum.cacheWrite + model.cacheWrite,
			reasoning: sum.reasoning + (model.reasoning ?? 0),
			cost: sum.cost + model.cost,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
	);
	return {
		input: total.input,
		output: total.output,
		cacheRead: total.cacheRead,
		cacheWrite: total.cacheWrite,
		reasoning: total.reasoning,
		totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost },
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function formatLiveUsage(usage: UsageStats, model?: string): string {
	const parts = [
		`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
		`↑${formatTokens(usage.input)}`,
		`↓${formatTokens(usage.output)}`,
	];
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" · ");
}

/** Deck rows carry plain text; the deck applies theme colors (HIV-1219). */
const PLAIN_FG = (_color: unknown, text: string) => text;

function toDeckAgentRows(details: SubagentDetails, nowMs: number): DeckAgentRow[] {
	return details.results.map((result) => {
		const failed = isFailedResult(result);
		const finished = result.stopReason === "end";
		const latest = [...getDisplayItems(result.messages)].reverse().find((item) => item.type === "toolCall");
		const activity =
			result.activity ??
			(latest && latest.type === "toolCall"
				? formatToolCall(latest.name, latest.args, PLAIN_FG)
				: finished
					? "complete"
					: "starting…");
		const startedAtMs = result.startedAtMs ?? nowMs;
		return {
			agent: result.agent,
			state: failed ? ("failed" as const) : finished ? ("done" as const) : ("running" as const),
			activity,
			startedAtMs,
			lastActivityAtMs: result.lastActivityAtMs ?? startedAtMs,
			usage: formatLiveUsage(result.usage, result.model),
		};
	});
}

/**
 * Live `subagent` tool calls, keyed by toolCallId — plural because parallel
 * invocations are legal, and under the old one-widget-per-call scheme the
 * last caller silently overwrote everyone else's roster. The deck shows the
 * merged rows. Elapsed-time ticking is the deck's job now (it computes from
 * `startedAtMs` on its own 1 s timer), so this side emits only on real
 * progress events instead of every second.
 */
const ACTIVE_SUBAGENT_RUNS = new Map<string, SubagentDetails | null>();

function publishSubagents(pi: ExtensionAPI): void {
	try {
		const active = [...ACTIVE_SUBAGENT_RUNS.values()].filter((details): details is SubagentDetails => details !== null);
		if (active.length === 0) {
			pi.events.emit(DECK_SECTION_CHANNEL, { section: "subagents", state: null } satisfies DeckSectionEvent);
			return;
		}
		const nowMs = Date.now();
		pi.events.emit(DECK_SECTION_CHANNEL, {
			section: "subagents",
			state: {
				kind: "subagents",
				mode: active.length > 1 ? "multiple runs" : active[0].mode,
				rows: active.flatMap((details) => toDeckAgentRows(details, nowMs)),
			},
		} satisfies DeckSectionEvent);
	} catch {
		/* no bus, or nothing listening */
	}
}

function startSubagentWidget(pi: ExtensionAPI, toolCallId: string): void {
	ACTIVE_SUBAGENT_RUNS.set(toolCallId, null);
}

function updateSubagentWidget(pi: ExtensionAPI, toolCallId: string, details: SubagentDetails): void {
	if (!ACTIVE_SUBAGENT_RUNS.has(toolCallId)) return;
	ACTIVE_SUBAGENT_RUNS.set(toolCallId, details);
	publishSubagents(pi);
}

function stopSubagentWidget(pi: ExtensionAPI, toolCallId: string): void {
	if (!ACTIVE_SUBAGENT_RUNS.delete(toolCallId)) return;
	publishSubagents(pi);
}

const SchemaParam = Type.Optional(
	Type.Any({
		description:
			"JSON Schema the agent's final answer must match. When set, the agent is instructed to end with a " +
			"fenced JSON block, the block is validated, and a validated object is returned. Constrain only the " +
			"fields you branch on; do NOT set additionalProperties:false, and mark anything that can be empty optional.",
	}),
);

/**
 * A per-call model override. Measured need: "the tool offered no way to choose
 * a different model" five times verbatim in one week, each time after a whole
 * read-only fan-out died on the delegation default's throttled account.
 * Refused before any spawn when the named model is not configured here.
 */
const ModelParam = Type.Optional(
	Type.String({
		description:
			"Model to run this worker on, as provider/id (e.g. openrouter/deepseek/deepseek-v4-flash). Omit to use " +
			"the role's pin or the delegation default; set it when that default's account is throttled or drained.",
	}),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelParam,
	schema: SchemaParam,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelParam,
	schema: SchemaParam,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: ModelParam,
	/**
	 * Backgrounding is SINGLE mode only, and that is a real constraint rather
	 * than an unfinished edge.
	 *
	 * Parallel mode already runs its tasks concurrently inside one call, so
	 * backgrounding it would only move where the waiting happens. Chain mode
	 * feeds each step's output into the next through `{previous}`, so there is
	 * no intermediate point at which a partial result means anything to the
	 * caller. Single mode is the one shape where "start it and come back" is
	 * both possible and useful.
	 */
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run this delegation in the background and return immediately. You are notified when it finishes. " +
				"Single mode only. Use it when the work is long and you have something else to get on with; " +
				"requires `what`.",
			default: false,
		}),
	),
	what: Type.Optional(
		Type.String({
			description:
				"Required when background is true: a short human-readable description of what the subagent is doing, " +
				"e.g. 'auditing the migration for data loss'. Shown to the person watching.",
		}),
	),
	schema: SchemaParam,
	verify: Type.Optional(
		StringEnum(["sample", "off"] as const, {
			description:
				'Mechanical verification of writer results. "sample" (default) chains one read-only verifier agent over ' +
				'the writer\'s claim after it finishes; "off" skips it.',
			default: "sample",
		}),
	),
});

/** A caller's schema, paired with pi's validator for delegate.ts; none when the caller passed none. */
function structuredRequest(schema: unknown): StructuredRequest | undefined {
	// `== null`: a JSON caller can send `schema: null`, which has always meant
	// "no schema" (the worker saw no instruction), never schema mode.
	return schema == null ? undefined : { schema, support: structuredSupport };
}

export default function (pi: ExtensionAPI) {
	registerDeliveryReview(pi);
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "subagent") stopSubagentWidget(pi, event.toolCallId);
	});
	pi.on("session_shutdown", () => {
		for (const toolCallId of [...ACTIVE_SUBAGENT_RUNS.keys()]) stopSubagentWidget(pi, toolCallId);
		// The worker agent-dir mirror, if this session built one (HIV-1969).
		// Idempotent, and a failure here is never worth surfacing at shutdown.
		cleanupWorkerAgentDir();
	});
	pi.events.on(DECK_SYNC_CHANNEL, () => publishSubagents(pi));

	// The roles a caller may select, named in the tool description itself. Without
	// a listing the model has to guess a name from whatever harness it learned on,
	// which is exactly how "general" reached this tool and cost a delegation.
	//
	// Names and aliases only. A description line is paid on every turn for the life
	// of the session, and the prose is already spent where it changes an outcome —
	// the unknown-agent error, which only a wrong guess pays for. Scope "user" is
	// package + user roles, which do not depend on cwd; project roles are
	// cwd-dependent and trust-gated, so they cannot be baked in at registration.
	const selectableRoles = discoverAgents(process.cwd(), "user").agents.map((role) =>
		role.aliases?.length ? `${role.name} (aka ${role.aliases.join(", ")})` : role.name,
	);

	/**
	 * Backgrounded delegations.
	 *
	 * The ids are namespaced `sub-N` because the `background` extension mints
	 * `bg-N` for its own shell jobs: two owners minting the same id would make
	 * `background_result bg-3` quietly return the wrong job.
	 *
	 * The abort controllers are OURS, never the tool call's signal — the tool
	 * call ends the moment we return, and that is precisely when the worker must
	 * not die. Cancellation arrives over the bus from `background_cancel`.
	 */
	let backgroundSeq = 0;
	const backgroundAborts = new Map<string, AbortController>();

	pi.events.on(BACKGROUND_CANCEL_CHANNEL, (payload) => {
		const id = (payload as { id?: string } | undefined)?.id;
		if (!id) return;
		const controller = backgroundAborts.get(id);
		if (!controller) return; // not ours — another owner's job
		controller.abort();
		// The `finish` event is NOT emitted here. `runSingleAgent` still has to
		// unwind: it releases the writer lock in its own teardown, and announcing
		// the job as over while that lock is still held would let the next writer
		// past a gate that has not actually opened.
	});

	/**
	 * Kill every backgrounded delegation when the session ends.
	 *
	 * Same reasoning as the `background` extension's own reaping, and it has to
	 * be repeated here because these workers are ours: a detached pi child that
	 * outlives its session is the measured orphan defect this house has already
	 * paid for once.
	 */
	pi.on("session_shutdown", () => {
		for (const controller of backgroundAborts.values()) controller.abort();
		backgroundAborts.clear();
	});

	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "guardWorkerCwd() refuses a writer role in a protected worktree before spawning" },
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			selectableRoles.length > 0 ? `Available agents: ${selectableRoles.join(", ")}.` : "",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		]
			.filter(Boolean)
			.join(" "),
		promptSnippet: "Delegate focused work to an isolated role-specific agent",
		promptGuidelines: [
			"Use subagent for read-heavy exploration, routine fixes, tests, documentation, and first-pass review; parallelize only read-only roles in one worktree.",
			"Verify subagent results before relying on them — a confident summary is not evidence.",
			DELIVERY_REVIEW_GUIDANCE,
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const ownerSessionId = params.background ? ctx.sessionManager.getSessionId() : "";
			const recordedBackgroundSeq = params.background ? lastSubagentId(ctx.sessionManager.getBranch(), ownerSessionId) : 0;
			startSubagentWidget(pi, toolCallId);
			const reportUpdate: OnUpdateCallback | undefined = onUpdate || ctx.mode === "tui"
				? (update) => {
					if (update.details) updateSubagentWidget(pi, toolCallId, update.details);
					onUpdate?.(update);
				}
				: undefined;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// The gate used to fire on the requested SCOPE, so `agentScope: "both"` in
			// an untrusted repo refused the whole delegation even when the repo
			// shipped no roles at all — observed 2026-08-06 in a hive worktree with no
			// .pi/agents directory, where "both" and the default "user" resolve to an
			// identical set of package roles. Nothing repo-supplied was in play; the
			// refusal protected nothing and blocked everything.
			const projectTrusted = ctx.isProjectTrusted();
			const agents = selectableAgents(discovery.agents, projectTrusted);

			if (!projectTrusted) {
				// Resolved against the UNFILTERED set: a caller who did name a project
				// role deserves the honest reason, not "Unknown agent".
				const refused = projectAgentsAmong(discovery.agents, requestedAgentNames(params));

				// `agentScope: "project"` in an untrusted repo empties the pool
				// outright. Naming trust as the cause beats letting it surface as
				// "Unknown agent … (none)", which blames the caller's spelling for a
				// decision that had nothing to do with it. Only reachable when trust
				// did the emptying — a trusted project keeps every discovered role.
				const withheldEverything = agents.length === 0 && discovery.agents.length > 0;

				if (refused.length > 0 || withheldEverything) {
					const names = refused.length > 0 ? refused.map((a) => `"${a.name}"`).join(", ") : "every role in scope";
					return {
						content: [
							{
								type: "text",
								text:
									`Refusing project-local agents because the current project is not trusted: ${names}.\n` +
									`Source: ${discovery.projectAgentsDir ?? "(unknown)"}\n` +
									"Trust the project to use them, or name a user or package agent instead.",
							},
						],
						details: {
							mode: "single",
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [],
						},
					};
				}
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const authModeFor: ModelAuthResolver = (provider, requestedModel) => {
				try {
					const model = ctx.modelRegistry.find(provider, requestedModel);
					if (!model) return "unknown";
					return ctx.modelRegistry.isUsingOAuth(model) === true ? "subscription" : "api_key";
				} catch {
					return "unknown";
				}
			};
			// What a worker may run on, read off ctx BEFORE the first await (ctx
			// goes stale when the session is replaced). The catalog is a
			// closure, fetched only on the paths that need a fallback.
			const modelEnv: WorkerModelEnv = {
				isConfigured: (spec) => {
					const at = spec.indexOf("/");
					if (at <= 0 || at === spec.length - 1) return null;
					try {
						return ctx.modelRegistry.find(spec.slice(0, at), spec.slice(at + 1)) !== undefined;
					} catch {
						return null;
					}
				},
				sessionModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				// One in-flight fetch per tool call: a parallel wave with an
				// unconfigured default would otherwise start up to four catalog
				// requests at once before modes.ts's own cache fills, each up to
				// 20s against a cold server.
				catalog: () => {
					catalogPromise ??= (async () => {
						const auth = resolveAuth();
						if (!auth) return [];
						return (await fetchAgentModeCatalog(auth))?.modes ?? [];
					})();
					return catalogPromise;
				},
			};
			let catalogPromise: Promise<readonly { key?: string; model: string }[]> | undefined;
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					usageByModel: subagentUsageByModel(results, authModeFor),
				});

			// Closed schemas are refused before a worker is spawned. This is an ERROR,
			// not a warning, on purpose: the caller is a model, and a warning in a tool
			// description is read once at registration while an error in a tool RESULT
			// arrives at the moment it can be acted on (technique #4).
			for (const candidate of [params.schema, ...(params.tasks ?? []).map((t) => t.schema)]) {
				if (candidate === undefined) continue;
				const rejection = rejectUnsupportedSchema(candidate);
				if (rejection) {
					return {
						content: [{ type: "text", text: rejection }],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						isError: true,
					};
				}
			}

			// A role may only name tools this process can actually provide. pi drops
			// an unknown `--tools` entry silently, so without this a role runs with
			// fewer tools than it declares and nothing says so — the defect that
			// left `research` and `retriever` with no knowledge access at all once
			// the local fallback they named stood down (wave 5).
			//
			// Refused here rather than warned, and at spawn time rather than at
			// load, because this is the moment it is actionable: the alternative is
			// a worker that runs, returns a confident answer, and never searched.
			//
			// This checks the PARENT's registry, which catches a name that exists
			// NOWHERE — a typo, or a tool this session did not load.
			//
			// It cannot catch a name that resolves HERE and is absent in the
			// worker, because a worker runs `--no-extensions` plus an explicit
			// `-e` allowlist. `mcp`/`mcpScript` were the measured instance: six
			// roles granted them, named `mcp__<server>__<tool>` calls in their
			// bodies, and ran without them, while this check saw `mcp` resolve
			// perfectly well (HIV-1581). That class is now covered by
			// `test/worker-tool-universe.test.ts`, which derives the worker's real
			// tool set instead of asking the parent.
			const registry = pi.getAllTools().map((tool) => tool.name);
			for (const name of requestedAgentNames(params)) {
				const role = resolveAgent(agents, name);
				if (!role) continue;

				const missing = unknownTools(role, registry);
				if (missing.length > 0) {
					return {
						content: [
							{
								type: "text",
								text:
									`Role "${role.name}" declares tools this session cannot provide: ${missing.join(", ")}.\n` +
									`Source: ${role.filePath}\n\n` +
									"Running it would silently give the role FEWER tools than it asks for. Fix the role's " +
									"`tools:` line to name tools that exist here, or run a role that does.",
							},
						],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						isError: true,
					};
				}
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				// Shared with the trust gate above, so the two cannot disagree — and
				// alias-aware, where a name match let a project role invoked through
				// one of its aliases skip this confirmation entirely.
				const projectAgentsRequested = projectAgentsAmong(agents, requestedAgentNames(params));

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// Everything above this point is validation — trust gate, schema
			// rejection, tool-universe check, mode count, project confirmation. The
			// background path sits AFTER all of it deliberately: a delegation that
			// would have been refused must be refused now, in the tool result the
			// model is reading, and not turned into a notification twenty minutes
			// later about a job that never had a chance to run.
			if (params.background) {
				const refusal = backgroundRefusal(params, ctx.mode);
				if (refusal) {
					return { content: [{ type: "text", text: refusal }], details: makeDetails("single")([]), isError: true };
				}

				// The cap has to be re-implemented on this side, not shared.
				//
				// `MAX_CONCURRENT` guards the background extension's own shell jobs,
				// and jiti isolation means the two counters cannot see each other.
				// Without this check the delegation path is UNBOUNDED — and each
				// entry is a real pi child, which is the fork bomb the constant's
				// own comment warns about, written by an agent that thought it was
				// being efficient.
				if (backgroundAborts.size >= MAX_CONCURRENT) {
					return {
						content: [
							{
								type: "text",
								text:
									`Already running ${backgroundAborts.size} background delegations (the limit). Wait for one ` +
									"to finish, or stop one with background_cancel.",
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				const agentName = params.agent as string;

				// Resolve the ROLE before announcing anything.
				//
				// `runSingleAgent` resolves it too and returns a perfectly good
				// "Unknown agent" result — but in the background that result becomes
				// a completion NOTIFICATION minutes later, about a job the model was
				// told had started. A name it could have retyped immediately instead
				// becomes a delayed report of nothing having happened, which is the
				// worst shape this feature can produce.
				if (!resolveAgent(agents, agentName)) {
					const available = agents.length > 0 ? agents.map(describeAgentForRecovery).join("\n") : "  (none)";
					return {
						content: [
							{
								type: "text",
								text:
									`Unknown agent: "${agentName}" — nothing was started. Retry with one of:\n${available}`,
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				backgroundSeq = Math.max(backgroundSeq, recordedBackgroundSeq) + 1;
				const jobId = `sub-${backgroundSeq}`;
				const jobIdentity = { id: jobId, sessionId: ownerSessionId, executionId: randomUUID() };
				const what = (params.what ?? "").trim();
				const controller = new AbortController();
				backgroundAborts.set(jobId, controller);

				pi.events.emit(BACKGROUND_JOB_CHANNEL, {
					action: "start",
					...jobIdentity,
					what,
					kind: "subagent",
					detail: `${agentName}: ${(params.task as string).slice(0, 200)}`,
				} satisfies BackgroundJobEvent);

				// Deliberately NOT awaited. The floating promise IS the feature; it
				// is given a terminal `.then` so nothing can reject unhandled and
				// take the session down with it.
				//
				// Through runAgentWithSchema, not runSingleAgent: all three
				// measured exit-0 handoffs were BACKGROUND delegations, and the
				// other-account re-run and the mid-work continuation live there.
				void runAgentWithSchema(
					ctx.cwd,
					agents,
					agentName,
					params.task as string,
					params.cwd,
					undefined,
					controller.signal,
					// No onUpdate: the live widget belongs to a tool call that has
					// already returned, and painting into it would resurrect a panel
					// the user has moved on from.
					undefined,
					makeDetails("single"),
					structuredRequest(params.schema),
					params.model,
					modelEnv,
				)
					.then((result) => {
						const usageByModel = subagentUsageByModel([result], authModeFor);
						if (usageByModel.length > 0) {
							pi.events.emit(HIVE_METRIC_CHANNEL, { kind: "nested_usage", models: usageByModel } satisfies HiveMetricEvent);
						}
						const completion = backgroundCompletion(result, controller.signal.aborted);
						if (completion.summary) {
							pi.events.emit(BACKGROUND_JOB_CHANNEL, {
								action: "output",
								...jobIdentity,
								chunk: completion.summary,
							} satisfies BackgroundJobEvent);
						}
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "finish",
							...jobIdentity,
							status: completion.status,
							exitCode: completion.exitCode,
						} satisfies BackgroundJobEvent);
					})
					.catch((err: unknown) => {
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "output",
							...jobIdentity,
							chunk: `The delegation threw: ${(err as Error)?.message ?? String(err)}`,
						} satisfies BackgroundJobEvent);
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "finish",
							...jobIdentity,
							status: "failed",
							exitCode: 1,
						} satisfies BackgroundJobEvent);
					})
					.finally(() => {
						backgroundAborts.delete(jobId);
					});

				return {
					content: [{ type: "text", text: backgroundStartedMessage(jobId, what, agentName) }],
					details: makeDetails("single")([]),
				};
			}

			// The modes themselves are harness-neutral (delegate.ts) — the Claude
			// adapter's MCP tool runs the same three. This is pi's half: the
			// tool-result shape and its usage accounting.
			const host: DelegationHost = { cwd: ctx.cwd, agents, modelEnv, signal, makeDetails, reportUpdate };
			const toToolResult = (outcome: DelegationOutcome) => ({
				content: [{ type: "text" as const, text: outcome.text }],
				details: makeDetails(outcome.mode)(outcome.results),
				// Only a run that produced results has usage to report; a refusal
				// before any spawn has none.
				...(outcome.results.length > 0
					? { usage: subagentToolUsage(subagentUsageByModel(outcome.results, authModeFor)) }
					: {}),
				...(outcome.isError ? { isError: true } : {}),
			});

			// Each step's schema travels with its validator (delegate.ts's StructuredRequest).
			const steps = (items: readonly { agent: string; task: string; cwd?: string; model?: string; schema?: unknown }[]): DelegationTask[] =>
				items.map((item) => ({ agent: item.agent, task: item.task, cwd: item.cwd, model: item.model, schema: structuredRequest(item.schema) }));
			if (params.chain && params.chain.length > 0) return toToolResult(await runChainDelegation(steps(params.chain), host));
			if (params.tasks && params.tasks.length > 0) return toToolResult(await runParallelDelegation(steps(params.tasks), params.verify, host));
			if (params.agent && params.task) {
				return toToolResult(
					await runSingleDelegation(
						{ agent: params.agent, task: params.task, cwd: params.cwd, model: params.model, schema: structuredRequest(params.schema) },
						params.verify,
						host,
					),
				);
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
