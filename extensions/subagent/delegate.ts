/**
 * Delegation — running role workers, harness-neutral.
 *
 * Lifted out of `index.ts` (the pi `subagent` tool) so the Claude adapter's
 * MCP `subagent` tool runs the SAME worker spawn, model choice, writer lock,
 * worktree guard, retries, verifier and result rendering — not a second
 * implementation. What stays in `index.ts` is pi's half: the tool
 * registration and schema, the project-trust UI, the live widget, the
 * background-job bus and pi's usage accounting.
 *
 * Runs under plain node too (the adapter has no pi runtime): every import
 * from `@earendil-works/*` here is type-only, and the schema validator (which
 * needs typebox) is loaded only when a caller actually passes a schema.
 *
 * Derived from the MIT-licensed examples/extensions/subagent/ of
 * @earendil-works/pi-coding-agent (© 2025 Mario Zechner). See LICENSE.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getPiInvocation } from "../agenda/spawn.ts";
import { guardWorkerCwd, workerCwdRefusal } from "../guards-common/capability.ts";
import { killTree, trackTree, treeSpawnOptions } from "../hive-common/child-tree.ts";
import { distillFailure } from "../harness/distill.ts";
import { frame } from "../harness/framing.ts";
import { emptyJsonRunState, foldJsonLine, type WorkerRetries } from "../harness/json-protocol.ts";
import { resolveAgent, type AgentConfig, type AgentScope } from "../harness/roles-core.ts";
import type { SchemaValidation } from "../harness/structured.ts";
import {
	citationWarning,
	diffStamp,
	missingCitedPaths,
	NO_CHANGE_ERROR,
	treeStamp,
	VERIFY_FOOTER,
	writerMadeNoChange,
} from "../harness/verify.ts";
import { acquireWriterLock, isWriterCapable, writerScopeFor } from "../harness/writer.ts";
import { isQuotaExhaustedText } from "../hive-common/quota.ts";
import { agentDir } from "../mcp-common/config.ts";
import { describeLifecycleEvent, shouldStopForSilence, silenceError } from "./lifecycle.ts";
import {
	chooseWorkerModel,
	continuationTask,
	isAccountRefusal,
	pickAlternateAccount,
	RATE_LIMITED,
	stoppedMidWork,
	type WorkerModelEnv,
} from "./model.ts";
import { captureDeliveryDiff, captureReviewDiff, withReviewCallers, citedOutsideDiff, isReviewRole, neutralReviewTask, outsideDiffWarning, reviewFingerprint, reviewScopeFiles, reviewTaskWithDiff, stampableReview } from "./reviewdiff.ts";
import { buildSubagentWorkerArgs, workerMcpEnv } from "./worker.ts";

/**
 * A schema the caller wants the final answer validated against, WITH the
 * validator that does it. The validator (`harness/structured.ts`) needs
 * typebox, so it arrives from the host rather than being imported here: the
 * pi tool passes the real module, and a host without typebox (the Claude
 * adapter) simply never builds a request.
 */
export interface StructuredRequest {
	schema: unknown;
	support: StructuredSupport;
}

export interface StructuredSupport {
	MAX_SCHEMA_RETRIES: number;
	structuredInstruction(schema: unknown): string;
	parseStructuredResult(schema: unknown, output: string): SchemaValidation;
	structuredRetryTask(originalTask: string, error: string): string;
}

/**
 * A worker stopped by its abort signal. The message is the one this path has
 * always thrown; the partial result rides along so a host can still account
 * for what the worker spent before it was stopped.
 */
export class DelegationAborted extends Error {
	readonly result: SingleResult;
	constructor(result: SingleResult) {
		super("Subagent was aborted");
		this.name = "DelegationAborted";
		this.result = result;
	}
}

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	// Mirrors AgentConfig["source"], plus "unknown" for a result built before the
	// named agent was resolved (or when it does not exist).
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startedAtMs?: number;
	lastActivityAtMs?: number;
	activity?: string;
	/** Validated object, when the caller supplied a schema (HIV-1563). */
	structured?: unknown;
	/** Why the schema did not validate, after the retry budget was spent. */
	structuredError?: string;
	/** What pi already spent retrying a retryable provider error, if anything. */
	retries?: WorkerRetries;
	/**
	 * Why this worker ran on a model other than the one the caller would
	 * expect — a fallback from an unconfigured default, or a re-run on another
	 * account after a provider refusal. Printed with the result: a worker that
	 * silently ran elsewhere is the harder defect to diagnose.
	 */
	modelNote?: string;
	/** The final message announced work instead of delivering it (model.ts). */
	midWork?: boolean;
	/** For a review role: the files of the change it was handed (reviewdiff.ts). */
	reviewFiles?: string[];
	/** Complete diff fingerprint captured when the review prompt was built. */
	reviewFingerprint?: string;
	/** Paths the review cited that are not in that change. */
	outsideDiff?: string[];
}

export interface SubagentUsageByModel {
	provider: string;
	model: string;
	authMode: "api_key" | "subscription" | "unknown";
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	cost: number;
}

export type ModelAuthResolver = (provider: string, requestedModel: string) => SubagentUsageByModel["authMode"];

// Retries and sampled verifiers are separate child processes but one parent tool
// call. Keep their assistant messages off the rendered detail object while their
// usage remains part of the parent tool's durable accounting.
const telemetryMessages = new WeakMap<SingleResult, Message[]>();

export function messagesForTelemetry(result: Pick<SingleResult, "messages">): Message[] {
	return result instanceof Object && telemetryMessages.has(result as SingleResult)
		? telemetryMessages.get(result as SingleResult)!
		: result.messages;
}

export function appendTelemetryMessages(target: SingleResult, messages: readonly Message[]): void {
	telemetryMessages.set(target, [...messagesForTelemetry(target), ...messages]);
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/** Metric-only child accounting for telemetry; never transcript content. */
	usageByModel?: SubagentUsageByModel[];
}

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * subagentUsageByModel derives a narrow metrics contract from child assistant
 * messages. Telemetry receives this result, not transcript-bearing details.
 */
export function subagentUsageByModel(
	results: readonly Pick<SingleResult, "messages">[],
	authModeFor: ModelAuthResolver,
): SubagentUsageByModel[] {
	const buckets = new Map<string, SubagentUsageByModel>();
	for (const result of results) {
		for (const message of messagesForTelemetry(result)) {
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			const provider = assistant.provider?.trim();
			const requestedModel = assistant.model?.trim();
			const model = assistant.responseModel?.trim() || requestedModel;
			if (!provider || !requestedModel || !model) continue;
			let authMode: SubagentUsageByModel["authMode"] = "unknown";
			try {
				authMode = authModeFor(provider, requestedModel);
			} catch {
				// The live registry is unavailable: unknown is an honest billing fact.
			}
			if (!["api_key", "subscription", "unknown"].includes(authMode)) authMode = "unknown";
			const key = `${provider}/${model}/${authMode}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { provider, model, authMode, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				buckets.set(key, bucket);
			}
			const usage = assistant.usage;
			bucket.turns += 1;
			bucket.input += usageNumber(usage?.input);
			bucket.output += usageNumber(usage?.output);
			bucket.cacheRead += usageNumber(usage?.cacheRead);
			bucket.cacheWrite += usageNumber(usage?.cacheWrite);
			if (usage?.reasoning !== undefined) bucket.reasoning = (bucket.reasoning ?? 0) + usageNumber(usage.reasoning);
			bucket.cost += usageNumber(usage?.cost?.total);
		}
	}
	return [...buckets.values()];
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * Both of these used to be defined here, and both diverged from the copies in
 * `agenda/`: this file guarded with a module-level `Set` while agenda used a
 * lock file, and it walked up to the git root while agenda locked the raw cwd.
 * Either difference alone lets a `/delegate` writer and an `orchestrate` worker
 * both believe they hold the one writer slot for a checkout. See
 * `harness/writer.ts` (HIV-1132).
 */
export function agentIsWriterCapable(agent: AgentConfig | undefined): boolean {
	return isWriterCapable(agent?.tools);
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * The lines a caller must not miss about HOW a result was produced, appended
 * to every rendering of it (single, parallel, chain, background). Exported for
 * the test that pins them: a note that renders nowhere is a note nobody reads.
 */
export function resultNotes(result: SingleResult): string {
	const notes: string[] = [];
	if (result.modelNote) notes.push(`[model note] ${result.modelNote}`);
	if (result.midWork) {
		notes.push(
			"⚠ the worker ended WITHOUT delivering: its last message announces work rather than reporting it. " +
				"Treat this as incomplete — check the tree for partial edits before building on it.",
		);
	}
	if (result.outsideDiff && result.outsideDiff.length > 0) {
		notes.push(outsideDiffWarning(result.outsideDiff, result.reviewFiles?.length ?? 0));
	}
	return notes.length > 0 ? `\n\n${notes.join("\n\n")}` : "";
}

/**
 * Which provider refusal this is, and therefore whether retrying is worth
 * anything — the half of a delegation failure the caller cannot see.
 *
 * pi classifies these two as OPPOSITES and hive-pi rendered them identically.
 * A 429 is retryable, so pi already burned its whole budget with exponential
 * backoff before the string surfaced; a 403 "out of credits" is not, so it
 * failed on the first attempt. Both arrived as `Agent error: <raw string>` with
 * a `worker-error` class, which is also what a segfaulted worker gets — so the
 * caller re-issued into a drained account, or gave up on one that just needed a
 * minute.
 *
 * The account matters as much as the class: the worker runs on
 * `subagentDefaultModel`, a DIFFERENT account from this session's model and
 * from the balance `readiness` reports, which is why "$7.11 left but 403" keeps
 * reading as a bug.
 *
 * Exported for its own test: this is the load-bearing pure piece, and an
 * over-match here tells an agent "retrying will not help" when it would have.
 */
export function providerLimitGuidance(
	errorMessage: string | undefined,
	model: string | undefined,
	retries: WorkerRetries | undefined,
): string | undefined {
	if (!errorMessage) return undefined;
	const account = model ? `\`${model}\`` : "the worker's default model";

	// Exhaustion is tested FIRST because it is the more specific pattern, and
	// because the two mistakes are not symmetric: telling an agent to wait on a
	// drained account costs it the whole budget over again.
	if (isQuotaExhaustedText(errorMessage)) {
		return `provider allowance exhausted on ${account}. That is the WORKER's account — not this session's, and not the balance \`readiness\` reports. Waiting will not help; re-run with a role/model on another account, or do the work inline.`;
	}
	if (!RATE_LIMITED.test(errorMessage)) return undefined;

	// PAST HERE THE TEXT SAYS 429, AND THAT IS NOT THE SAME AS KNOWING IT IS A
	// THROTTLE. `isQuotaExhaustedText` returning false is not evidence of
	// anything: QUOTA_PATTERNS is deliberately narrow, calibrated for a
	// different decision (should the SESSION fail over) where a miss costs a
	// missed failover an operator can still fix by hand. Here a miss is not
	// cheap — it would emit the opposite instruction, telling someone whose
	// account is drained to wait. Providers do ship exhaustion under a 429
	// (OpenAI's "exceeded your current quota" is a 429), so an unmatched 429 is
	// AMBIGUOUS, and the honest answer depends on what else we know.
	//
	// Retry accounting is that evidence, used for CONFIDENCE and never as the
	// class on its own. A sequence that ran out means pi judged this refusal
	// retryable and actually spent backoff on it — positive evidence of a real
	// throttle, so the confident remedy is earned. Silence is NOT the opposite
	// evidence: pi may have declined to retry (which would point at exhaustion),
	// or retries may simply be disabled in this session's settings, and the two
	// are indistinguishable from here. So say so, and name the check that
	// settles it, rather than picking the branch that reads better.
	//
	// A sequence that LANDED describes an earlier, recovered turn — the fold's
	// `errorMessage` is latest-wins and never cleared, so a stale 429 outlives
	// its own successful retry.
	if (retries && retries.succeeded === true) {
		return `a 429 on ${account}, but the worker's last retry sequence SUCCEEDED (${retries.attempts}/${retries.maxAttempts} over ~${Math.round(retries.waitedMs / 1000)}s), so this failure is a different one — treat the 429 text as stale and read the worker's own output for the real cause.`;
	}
	if (retries) {
		return `throttled on ${account}. The worker already retried ${retries.attempts}/${retries.maxAttempts} times over ~${Math.round(retries.waitedMs / 1000)}s before failing. Waiting ~60s or dispatching fewer workers at once is the remedy; an immediate re-issue on the same account will likely fail the same way.`;
	}
	return `a 429 on ${account}, and this one CANNOT be classified from here. No retry accounting came back, which means either pi declined to retry it — pointing at an exhausted allowance, where waiting is useless — or retries are disabled in this session. Check that account's balance before assuming a wait will clear it; if it has headroom, treat it as a throttle and dispatch fewer workers at once.`;
}

/**
 * A distilled retry note for a failed delegation (HIV-1232, the
 * Parallel-Distill-Refine result). The orchestrator writes retry prompts from
 * this tool result, so a compact what-was-tried/how-it-failed note here is
 * exactly what conditions the next attempt.
 *
 * The provider-limit line is appended rather than folded into `output`:
 * `distillFailure` truncates, and the one sentence that says whether to retry
 * must not be the one that falls off the end.
 *
 * Exported so the append itself is tested. `isQuotaExhaustedText` was correct
 * and tested and had NO production caller for a whole ticket's worth of time —
 * a classifier nobody calls is indistinguishable from one that does not exist.
 */
export function retryNote(result: SingleResult): string {
	const note = distillFailure({
		attempted: result.task,
		output: [result.errorMessage, result.stderr, getFinalOutput(result.messages)]
			.filter(Boolean)
			.join("\n"),
		stopReason: result.stopReason,
	});
	const guidance = providerLimitGuidance(result.errorMessage, result.model, result.retries);
	return guidance ? `${note}\nprovider limit: ${guidance}` : note;
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	// A fresh mkdtemp directory nobody else can name, so there is nothing to
	// serialise against: pi's per-file mutation queue is not needed here.
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

let cachedSubagentDefaultModel: string | undefined | null = null;

/**
 * The default model for a role that does not pin one of its own.
 *
 * `PI_SUBAGENT_MODEL` wins over settings.json so that a session launched by an
 * orchestrator can choose the child model without writing to the workstation
 * config. It is deliberately an env var and not a settings key: on this
 * workstation `settings.json` is a stow symlink into a git checkout that pi
 * itself rewrites on `/model`, so a third writer would fight both of them.
 *
 * NOT read through the cache — an env var is per-process, so it is already
 * constant for this session, and reading it first keeps the cached settings
 * read from shadowing it.
 */
export function getSubagentDefaultModel(): string | undefined {
	const fromEnv = process.env.PI_SUBAGENT_MODEL?.trim();
	if (fromEnv) return fromEnv;
	if (cachedSubagentDefaultModel !== null) return cachedSubagentDefaultModel;
	try {
		const settingsPath = path.join(agentDir(), "settings.json");
		if (!fs.existsSync(settingsPath)) {
			cachedSubagentDefaultModel = undefined;
			return undefined;
		}
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
			subagentDefaultModel?: string;
			defaultProvider?: string;
			defaultModel?: string;
		};
		cachedSubagentDefaultModel =
			settings.subagentDefaultModel ??
			(settings.defaultProvider && settings.defaultModel && !settings.defaultModel.includes("/")
				? `${settings.defaultProvider}/${settings.defaultModel}`
				: settings.defaultModel);
	} catch {
		cachedSubagentDefaultModel = undefined;
	}
	return cachedSubagentDefaultModel;
}


/**
 * A live progress update: the shape pi's `onUpdate` takes, spelled
 * structurally so this module carries no runtime tie to pi.
 */
export interface DelegationUpdate {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
}

export type OnUpdateCallback = (partial: DelegationUpdate) => void;

/** One role, rendered so a model that guessed wrong can pick right on retry. */
export function describeAgentForRecovery(agent: AgentConfig): string {
	const aliases = agent.aliases?.length ? ` [aka ${agent.aliases.join(", ")}]` : "";
	return `  ${agent.name}${aliases} (${agent.source}): ${agent.description}`;
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	schema?: StructuredRequest,
	requestedModel?: string,
	env?: WorkerModelEnv,
	reviewPrepared = false,
): Promise<SingleResult> {
	const agent = resolveAgent(agents, agentName);

	if (!agent) {
		// Descriptions and aliases, not bare slugs. The caller here is a model that
		// guessed a name from another harness — "general" on 2026-08-06, for a task
		// the `research` role exists to serve — and a list of opaque slugs gives it
		// nothing to re-pick from. Aliases matter twice over: they are invocable but
		// invisible in every other listing, so `explorer` looked unavailable.
		const available = agents.length > 0 ? agents.map(describeAgentForRecovery).join("\n") : "  (none)";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Retry with one of:\n${available}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const executionCwd = cwd ?? defaultCwd;

	// Decided BEFORE the spawn, so an unconfigured model is refused in the tool
	// result the caller is reading rather than surfacing as a dead worker's
	// `No API key found for xai.` — the shape that cost eight delegations in a
	// day while readiness reported another provider ready (model.ts).
	const choice = await chooseWorkerModel(
		{ requested: requestedModel, preferred: agent.model ?? getSubagentDefaultModel(), roleName: agent.name, tier: agent.model ? undefined : agent.tier },
		env,
	);
	if (choice.refusal) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: choice.refusal,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: requestedModel ?? agent.model ?? getSubagentDefaultModel(),
			step,
		};
	}
	const model = choice.spec;

	// The worktree guard, for delegated work — and this is the ONLY place it can
	// happen. A worker spawns with `--no-extensions`, which strips guards-bridge
	// with everything else, so a worker has no worktree guard at all. Measured
	// against a synthetic repo carrying `.worktree-guard`, for which `decide()`
	// returns block: a worker-shaped pi wrote the file successfully.
	//
	// Read-only roles are deliberately not checked — refusing to READ a
	// pull-only worktree would break ordinary review work.
	if (agentIsWriterCapable(agent)) {
		const block = guardWorkerCwd(executionCwd, "subagent");
		if (block) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: workerCwdRefusal(agentName, executionCwd, block),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model,
				step,
			};
		}
	}

	// Orchestrators must be visible, durable Hive sessions. A hidden in-process
	// child cannot receive team/Factory doorbells or own the long-running reap
	// loop, even though the opmode extension could mechanically gate its tools.
	if (agent.opMode === "orchestrate") {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "The orchestrate operating mode is not available to in-process subagents; launch a visible Hive teammate instead.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model,
			step,
		};
	}

	// One writer per worktree, on the SAME lock agenda's workers take — see
	// harness/writer.ts. `null` when the role cannot write, so a read-only
	// subagent never contends for the slot.
	const writerLock = agentIsWriterCapable(agent)
		? acquireWriterLock(executionCwd, { pid: process.pid, runId: `subagent-${process.pid}`, nodeId: agentName })
		: null;
	if (writerLock && !writerLock.acquired) {
		const holder = writerLock.heldBy ? ` (held by run ${writerLock.heldBy.runId}, node ${writerLock.heldBy.nodeId})` : "";
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Refusing concurrent writer-capable agent in worktree${holder}: ${writerScopeFor(executionCwd)}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model,
			step,
		};
	}

	// A worker needs only the requested tools. Loading the interactive extension
	// set lets extension-owned handles survive agent_settled, so the child never
	// exits even after returning its final JSON result.
	const args = buildSubagentWorkerArgs(model, agent.tools, agent.opMode);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
		startedAtMs: Date.now(),
		lastActivityAtMs: Date.now(),
		activity: "preparing worker",
		modelNote: choice.note,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};
	const recordActivity = (activity: string) => {
		currentResult.activity = activity;
		currentResult.lastActivityAtMs = Date.now();
		emitUpdate();
	};

	try {
		// The schema contract is appended AFTER the role prompt, in the same file:
		// workers run `--no-extensions` (worker.ts), so there is no structured-output
		// tool to force inside the child — the appended prompt is the only channel.
		// Last-wins ordering matters; a contract ahead of the role guide competes
		// with it, which is how typed tools came to be called zero times (P3).
		const appended = [agent.systemPrompt.trim(), schema ? schema.support.structuredInstruction(schema.schema) : ""]
			.filter(Boolean)
			.join("\n\n");
		if (appended) {
			const tmp = await writePromptToTempFile(agent.name, appended);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// A review role is handed the change it is reviewing (reviewdiff.ts):
		// left to find it, a worker reviewed files that were not in the diff.
		const neutralize = agent.name === "code-reviewer" && !reviewPrepared;
		let effectiveTask = neutralize ? neutralReviewTask(task) : task;
		if (isReviewRole(agent.name)) {
			const captured = agent.name === "code-reviewer" ? captureDeliveryDiff(executionCwd, task) : captureReviewDiff(executionCwd, task);
			const diff = captured ? withReviewCallers(captured) : null;
			if (diff) {
				effectiveTask = reviewTaskWithDiff(task, diff, neutralize);
				currentResult.reviewFiles = reviewScopeFiles(diff);
				if (agent.name === "code-reviewer" && stampableReview(diff)) currentResult.reviewFingerprint = reviewFingerprint(diff);
			} else if (agent.name === "code-reviewer") {
				effectiveTask += "\nComplete merge-base diff unavailable. Review the requested scope paths, but report delivery scope as unverified; do not invent a change inventory.";
			}
		}
		args.push(`Task: ${effectiveTask}`);
		let wasAborted = false;
		emitUpdate();

		// Writer verification, free tier: stamp the tree before and after. A
		// writer that "succeeded" without touching anything is folded to a
		// failure — see harness/verify.ts.
		const stampBefore = writerLock ? await treeStamp(executionCwd) : null;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const tree = treeSpawnOptions();
			const proc = spawn(invocation.command, invocation.args, {
				cwd: executionCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// A subagent IS a worker: it must not run agenda policies, must not
				// re-enter its own loop, and must not inherit the interactive
				// session's context pack (~1,134 tokens it cannot use).
				//
				// Not a termination fix — HIV-1115 root-caused that to vitest's
				// worker-thread pool swallowing child close events (a test artifact)
				// plus a cold first-spawn cost (pi compiles the extension set through
				// jiti once, ~25-45s cold vs 7-13s warm). Neither is a pi bug.
				//
				// The writer token goes down too: a writer subagent that delegates
				// again in the same worktree is still one running writer, since this
				// frame is blocked awaiting it.
				//
				// workerMcpEnv points a worker that can reach MCP at the HTTP-only
				// agent-dir mirror (mcp-common/config.ts): native MCP has no lazy
				// lifecycle, so this is what keeps a fan-out cheap.
				env: { ...process.env, PI_AGENDA_WORKER: "1", ...workerMcpEnv(agent.tools), ...(writerLock?.childEnv ?? {}) },
				// A Claude helper's worker is a process group (hive-common/child-tree.ts).
				...tree,
			});
			trackTree(proc, tree.detached);
			let buffer = "";
			let closed = false;
			let seenWorkerEvent = false;
			let lastWorkerEventAtMs = Date.now();
			let silentWorkerError: string | undefined;
			let terminating = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let killProc: (() => void) | undefined;

			// The accounting half of this fold lives in harness/json-protocol.ts so
			// it is testable without spawning a worker; what stays here is the part
			// that genuinely needs the closure — the liveness clock and the UI.
			let runState = emptyJsonRunState();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}

				const activity = describeLifecycleEvent(event);
				if (activity) {
					seenWorkerEvent = true;
					lastWorkerEventAtMs = Date.now();
					recordActivity(activity);
				}

				const before = runState;
				runState = foldJsonLine(runState, line);
				if (runState === before) return;

				currentResult.messages = runState.messages as Message[];
				currentResult.usage = {
					input: runState.usage.input,
					output: runState.usage.output,
					cacheRead: runState.usage.cacheRead,
					cacheWrite: runState.usage.cacheWrite,
					cost: runState.usage.cost,
					contextTokens: runState.contextTokens,
					turns: runState.turns,
				};
				currentResult.model = runState.model ?? currentResult.model;
				currentResult.stopReason = runState.stopReason ?? currentResult.stopReason;
				currentResult.errorMessage = runState.errorMessage ?? currentResult.errorMessage;
				currentResult.retries = runState.retries ?? currentResult.retries;
				emitUpdate();
			};

			proc.stdout.on("data", (data) => {
				// Shared framing: a JSON object routinely straddles two chunks, and
				// dropping the straddler reads as "worker produced no output".
				const framed = frame(buffer, data.toString());
				buffer = framed.rest;
				for (const line of framed.lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			const terminateAfterGrace = () => {
				if (terminating) return;
				terminating = true;
				killTree(proc, "SIGTERM", tree.detached);
				forceKillTimer = setTimeout(() => {
					if (!closed) killTree(proc, "SIGKILL", tree.detached);
				}, 5000);
				forceKillTimer.unref?.();
			};
			const silenceTimer = setInterval(() => {
				if (closed || silentWorkerError) return;
				const nowMs = Date.now();
				const elapsedMs = nowMs - lastWorkerEventAtMs;
				if (!shouldStopForSilence(seenWorkerEvent, lastWorkerEventAtMs, nowMs)) return;
				silentWorkerError = silenceError(seenWorkerEvent, elapsedMs);
				currentResult.errorMessage = silentWorkerError;
				currentResult.stopReason = "error";
				recordActivity("worker unresponsive — stopping");
				terminateAfterGrace();
			}, 1000);
			silenceTimer.unref?.();

			proc.on("spawn", () => recordActivity("worker process spawned"));
			proc.on("close", (code) => {
				closed = true;
				clearInterval(silenceTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (signal && killProc) signal.removeEventListener("abort", killProc);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				clearInterval(silenceTimer);
				currentResult.errorMessage = `Could not start subagent: ${error.message}`;
				resolve(1);
			});

			if (signal) {
				killProc = () => {
					wasAborted = true;
					terminateAfterGrace();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new DelegationAborted(currentResult);
		if (writerLock && !isFailedResult(currentResult) && writerMadeNoChange(stampBefore, await treeStamp(executionCwd))) {
			currentResult.stopReason = "error";
			currentResult.errorMessage = NO_CHANGE_ERROR;
		}
		// Schema check runs only on a run that otherwise succeeded: a crashed
		// worker's missing JSON block is not a schema problem, and reporting it as
		// one would bury the real failure under a formatting complaint.
		if (schema && !isFailedResult(currentResult)) {
			const parsed = schema.support.parseStructuredResult(schema.schema, getFinalOutput(currentResult.messages));
			if (parsed.ok) currentResult.structured = parsed.value;
			else currentResult.structuredError = parsed.error;
		}
		// Exit 0 with an announcement for a final message is not a result. A
		// writer with no change already folded above; this catches the rest —
		// the reader that "completed" with "Checking the registry defaults…".
		if (!isFailedResult(currentResult) && stoppedMidWork(getFinalOutput(currentResult.messages))) {
			currentResult.midWork = true;
		}
		if (currentResult.reviewFiles && !isFailedResult(currentResult)) {
			const outside = citedOutsideDiff(getFinalOutput(currentResult.messages), currentResult.reviewFiles);
			if (outside.length > 0) currentResult.outsideDiff = outside;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		writerLock?.release();
	}
}

/**
 * `runSingleAgent` plus the bounded schema retry (HIV-1563).
 *
 * The retry is a whole fresh worker, because a worker is a `-p --no-session`
 * process with no memory of attempt 1 — so the second task text has to carry
 * the failure itself, the same shape `distillFailure` uses for retry notes.
 *
 * A retry is spent only on a run that SUCCEEDED and returned the wrong shape.
 * Re-running a writer that failed would be a second mutation attempt dressed
 * up as a formatting fix, and re-running one that already wrote its changes
 * would have the second worker fold to NO_CHANGE_ERROR on an unchanged tree.
 */
export async function runAgentWithSchema(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	schema: StructuredRequest | undefined,
	requestedModel?: string,
	env?: WorkerModelEnv,
): Promise<SingleResult> {
	// Only the author's initial request is neutralized. Runtime continuation
	// and schema-validation feedback must survive all subsequent attempts.
	const reviewPrepared = resolveAgent(agents, agentName)?.name === "code-reviewer";
	if (reviewPrepared) task = neutralReviewTask(task);
	let attemptTask = task;
	let attemptModel = requestedModel;
	let result = await runSingleAgent(
		defaultCwd,
		agents,
		agentName,
		attemptTask,
		cwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		schema,
		attemptModel,
		env,
		reviewPrepared,
	);
	const readOnly = !agentIsWriterCapable(resolveAgent(agents, agentName));

	// Provider refusal, read-only role: ONE re-run on another account.
	//
	// This is the sentence `providerLimitGuidance` already printed — "re-run
	// with a role/model on another account" — done by the tool instead of
	// being handed back to a caller that has no `model` in its own guidance
	// (39 papercuts, whole fan-outs at 0/4, each worker having already spent
	// pi's retry budget on the same throttled key). Read-only only, for the
	// same reason the schema retry is: re-running a writer is a second
	// mutation attempt. The retry is kept only if it is not worse; a fallback
	// that also failed leaves the original refusal, plus a note that the
	// alternate account was tried, so the caller does not try it a third time.
	if (readOnly && !signal?.aborted && isFailedResult(result) && isAccountRefusal(result.errorMessage, isQuotaExhaustedText)) {
		const alternate = await pickAlternateAccount(result.model, env);
		if (alternate) {
			const retried = await runSingleAgent(
				defaultCwd,
				agents,
				agentName,
				attemptTask,
				cwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				schema,
				alternate,
				env,
				reviewPrepared,
			);
			const attemptedMessages = [...messagesForTelemetry(result), ...messagesForTelemetry(retried)];
			const refusal = `${result.model ?? "the delegation default"} refused: ${(result.errorMessage ?? "").slice(0, 160)}`;
			if (isFailedResult(retried)) {
				telemetryMessages.set(result, attemptedMessages);
				result.modelNote = `also re-ran on ${alternate} (another account) and that failed too: ${(retried.errorMessage ?? retried.stderr ?? "").slice(0, 160)}`;
			} else {
				telemetryMessages.set(retried, attemptedMessages);
				retried.modelNote = `ran on ${alternate} — another account — after ${refusal}`;
				attemptModel = alternate;
				result = retried;
			}
		}
	}

	// Stopped mid-work, read-only role: ONE continuation. The first attempt's
	// announcement rides along in the task so the second worker knows what
	// "done" is not. A writer is only flagged (index.ts renders `midWork`);
	// re-running one would be a second mutation attempt.
	if (readOnly && !signal?.aborted && result.midWork) {
		const retried = await runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			continuationTask(attemptTask, getFinalOutput(result.messages)),
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			schema,
			attemptModel,
			env,
			reviewPrepared,
		);
		const attemptedMessages = [...messagesForTelemetry(result), ...messagesForTelemetry(retried)];
		if (isFailedResult(retried)) {
			telemetryMessages.set(result, attemptedMessages);
		} else {
			telemetryMessages.set(retried, attemptedMessages);
			retried.modelNote = retried.modelNote ?? result.modelNote;
			result = retried;
		}
	}

	if (!schema) return result;

	for (let retry = 0; retry < schema.support.MAX_SCHEMA_RETRIES; retry++) {
		if (!result.structuredError || isFailedResult(result)) break;
		if (!readOnly) break;
		attemptTask = schema.support.structuredRetryTask(task, result.structuredError);
		const retried = await runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			attemptTask,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			schema,
			attemptModel,
			env,
			reviewPrepared,
		);
		// Keep the retry only if it is not worse: a retry that crashed leaves the
		// original answer, which at least contained the work.
		const attemptedMessages = [...messagesForTelemetry(result), ...messagesForTelemetry(retried)];
		if (isFailedResult(retried)) {
			telemetryMessages.set(result, attemptedMessages);
			break;
		}
		telemetryMessages.set(retried, attemptedMessages);
		result = retried;
	}
	return result;
}

/**
 * The caller-facing rendering of a schema outcome, appended to the prose.
 *
 * Exported for tests: this is the ONLY thing standing between a step whose
 * schema was never satisfied and a caller (or a downstream chain step) that
 * cannot tell. `runAgentWithSchema` gives up after its retry budget and returns
 * a SUCCESSFUL result still carrying `structuredError`, so silence here is
 * indistinguishable from a validated answer.
 */
export function structuredSection(result: SingleResult): string {
	if (result.structured !== undefined) {
		return `\n\nStructured result (validated against your schema):\n\`\`\`json\n${JSON.stringify(result.structured, null, 2)}\n\`\`\``;
	}
	if (result.structuredError) {
		return `\n\nSchema NOT satisfied — treat the prose above as unvalidated:\n${result.structuredError}`;
	}
	return "";
}

/** Claim excerpt handed to the verifier. Beyond this, evidence beats volume. */
const VERIFIER_CLAIM_CHARS = 4000;

/**
 * The sampled tier: one read-only `verifier` role over a writer's claim.
 * Costs a single cheap-model call per delegation that mutated the tree, and
 * returns its report as text for the ORCHESTRATOR to weigh — the parent stays
 * the approval authority ("a headless subagent cannot obtain approval").
 * Never throws; a verifier that cannot run reports nothing rather than
 * failing the work it was meant to check.
 */
export async function runVerifierOn(
	defaultCwd: string,
	agents: AgentConfig[],
	target: SingleResult,
	targetCwd: string,
	signal: AbortSignal | undefined,
	env?: WorkerModelEnv,
): Promise<string | null> {
	if (!resolveAgent(agents, "verifier")) return null;
	const claim = getFinalOutput(target.messages).slice(0, VERIFIER_CLAIM_CHARS);
	if (!claim.trim()) return null;
	const status = await diffStamp(targetCwd);
	const task = [
		`Another agent (role "${target.agent}") just finished this task:`,
		"```",
		target.task.slice(0, 1000),
		"```",
		"It claims:",
		"```",
		claim,
		"```",
		status !== null ? `Current \`git status --porcelain\` of the worktree:\n\`\`\`\n${status.trim() || "(clean)"}\n\`\`\`` : "",
		"Verify the claim against the repository.",
	]
		.filter(Boolean)
		.join("\n");
	try {
		const result = await runSingleAgent(
			defaultCwd,
			agents,
			"verifier",
			task,
			targetCwd,
			undefined,
			signal,
			undefined,
			(results) => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results,
			}),
			undefined,
			undefined,
			env,
		);
		appendTelemetryMessages(target, messagesForTelemetry(result));
		if (isFailedResult(result)) return null;
		const report = getFinalOutput(result.messages).trim();
		return report ? report : null;
	} catch {
		return null;
	}
}

/**
 * Every agent name this call would invoke, across all three modes.
 *
 * Shared by the trust gate and the confirmation prompt so the two cannot
 * disagree about what the call is actually asking to run.
 */
export function requestedAgentNames(params: {
	agent?: string;
	tasks?: { agent: string }[];
	chain?: { agent: string }[];
}): string[] {
	const names = new Set<string>();
	if (params.chain) for (const step of params.chain) names.add(step.agent);
	if (params.tasks) for (const task of params.tasks) names.add(task.agent);
	if (params.agent) names.add(params.agent);
	return Array.from(names);
}


/* -------------------------------------------------------------------------- */
/* The three modes                                                            */
/* -------------------------------------------------------------------------- */

export type DelegationMode = "single" | "parallel" | "chain";

/** One delegated unit, as every mode's parameters spell it. */
export interface DelegationTask {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	schema?: StructuredRequest;
}

/** What a mode needs from the harness running it. */
export interface DelegationHost {
	/** The session's cwd; a task's own `cwd` overrides it. */
	cwd: string;
	/** The roles this call may run, already filtered for trust. */
	agents: AgentConfig[];
	modelEnv: WorkerModelEnv;
	signal: AbortSignal | undefined;
	makeDetails(mode: DelegationMode): (results: SingleResult[]) => SubagentDetails;
	/** Live progress; absent when nobody renders it. */
	reportUpdate?: OnUpdateCallback;
}

/**
 * A mode's answer: the text the caller reads, the results it came from, and
 * whether it is an error. `isError` is set only where the pi tool always set
 * it, so a host mapping this to its own result shape keeps pi's exact results.
 */
export interface DelegationOutcome {
	mode: DelegationMode;
	text: string;
	results: SingleResult[];
	isError?: true;
}

/** Chain: sequential, each step's `{previous}` is the prior step's output. */
export async function runChainDelegation(chain: readonly DelegationTask[], host: DelegationHost): Promise<DelegationOutcome> {
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		// Create update callback that includes all previous results
		const reportUpdate = host.reportUpdate;
		const chainUpdate: OnUpdateCallback | undefined = reportUpdate
			? (partial) => {
					// Combine completed results with current streaming result
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						reportUpdate({
							content: partial.content,
							details: host.makeDetails("chain")(allResults),
						});
					}
				}
			: undefined;

		const result = await runAgentWithSchema(
			host.cwd,
			host.agents,
			step.agent,
			taskWithContext,
			step.cwd,
			i + 1,
			host.signal,
			chainUpdate,
			host.makeDetails("chain"),
			step.schema,
			step.model,
			host.modelEnv,
		);
		results.push(result);

		if (isFailedResult(result)) {
			const errorMsg = getResultOutput(result);
			return {
				mode: "chain",
				text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}\n\nRetry note (distilled):\n${retryNote(result)}`,
				results,
				isError: true,
			};
		}
		// A validated step hands the NEXT step its object, not its prose.
		// That is the point of a typed chain: step 2's `{previous}` becomes
		// JSON it can rely on rather than a paragraph it has to re-read.
		// Unvalidated steps behave exactly as before.
		//
		// A step whose schema was NEVER satisfied is the case worth being
		// careful about. `runAgentWithSchema` gives up after its retry budget
		// and returns a SUCCESSFUL result still carrying `structuredError`, so
		// without the branch below it would slide past `isFailedResult` and
		// hand the next step prose with no sign the contract broke.
		//
		// It is marked rather than fatal, unlike the agenda side: `{previous}`
		// is read by a MODEL, which can adapt to "this is unvalidated" but not
		// to a fact it is never told. Failing would also throw away every
		// earlier step.
		previousOutput =
			result.structured !== undefined
				? JSON.stringify(result.structured, null, 2)
				: getFinalOutput(result.messages) + structuredSection(result);
	}
	const last = results[results.length - 1];
	const chainNotes = results.map(resultNotes).filter(Boolean).join("");
	return {
		mode: "chain",
		text: (getFinalOutput(last.messages) || "(no output)") + structuredSection(last) + chainNotes,
		results,
	};
}

/** Parallel: up to MAX_PARALLEL_TASKS, MAX_CONCURRENCY at a time, one writer per worktree. */
export async function runParallelDelegation(
	tasks: readonly DelegationTask[],
	verify: "sample" | "off" | undefined,
	host: DelegationHost,
): Promise<DelegationOutcome> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return { mode: "parallel", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`, results: [] };
	}

	const writerCwds = new Set<string>();
	for (const task of tasks) {
		const agent = host.agents.find((candidate) => candidate.name === task.agent);
		if (!agentIsWriterCapable(agent)) continue;
		const taskCwd = writerScopeFor(task.cwd ?? host.cwd);
		if (writerCwds.has(taskCwd)) {
			return {
				mode: "parallel",
				text: `Refusing parallel writer-capable agents in the same worktree: ${taskCwd}. Run them sequentially or use separate worktrees.`,
				results: [],
			};
		}
		writerCwds.add(taskCwd);
	}

	// Track all results for streaming updates
	const allResults: SingleResult[] = new Array(tasks.length);

	// Initialize placeholder results
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			exitCode: -1, // -1 = still running
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			startedAtMs: Date.now(),
			lastActivityAtMs: Date.now(),
		};
	}

	const emitParallelUpdate = () => {
		if (host.reportUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			host.reportUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: host.makeDetails("parallel")([...allResults]),
			});
		}
	};

	emitParallelUpdate();

	const results = await mapWithConcurrencyLimit([...tasks], MAX_CONCURRENCY, async (t, index) => {
		const result = await runAgentWithSchema(
			host.cwd,
			host.agents,
			t.agent,
			t.task,
			t.cwd,
			undefined,
			host.signal,
			// Per-task update callback
			(partial) => {
				if (partial.details?.results[0]) {
					allResults[index] = partial.details.results[0];
					emitParallelUpdate();
				}
			},
			host.makeDetails("parallel"),
			t.schema,
			t.model,
			host.modelEnv,
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r, index) => {
		const failed = isFailedResult(r);
		const output = truncateParallelOutput(getResultOutput(r));
		const status = failed ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed";
		const cited = failed ? [] : missingCitedPaths(output, tasks[index]?.cwd ?? host.cwd);
		const warning = cited.length > 0 ? `\n\n${citationWarning(cited)}` : "";
		const note = failed ? `\n\nRetry note (distilled):\n${retryNote(r)}` : "";
		const structured = failed ? "" : structuredSection(r);
		return `### [${r.agent}] ${status}\n\n${output}${structured}${warning}${note}${resultNotes(r)}`;
	});

	// Sampled verification: the writer, if one succeeded — the result the
	// rest of the batch will be built on.
	let verifierSection = "";
	if ((verify ?? "sample") !== "off") {
		const writerIndex = results.findIndex(
			(r) => !isFailedResult(r) && agentIsWriterCapable(host.agents.find((a) => a.name === r.agent)),
		);
		if (writerIndex >= 0) {
			const report = await runVerifierOn(
				host.cwd,
				host.agents,
				results[writerIndex],
				tasks[writerIndex]?.cwd ?? host.cwd,
				host.signal,
				host.modelEnv,
			);
			if (report) verifierSection = `\n\n---\n\n### [verifier] on ${results[writerIndex].agent}\n\n${report}`;
		}
	}

	const parallelOutput = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${verifierSection}\n\n${VERIFY_FOOTER}`;
	return { mode: "parallel", text: truncateParallelOutput(parallelOutput), results };
}

/** Single: one worker, then (for a writer) one sampled verifier. */
export async function runSingleDelegation(
	params: DelegationTask,
	verify: "sample" | "off" | undefined,
	host: DelegationHost,
): Promise<DelegationOutcome> {
	const result = await runAgentWithSchema(
		host.cwd,
		host.agents,
		params.agent,
		params.task,
		params.cwd,
		undefined,
		host.signal,
		host.reportUpdate,
		host.makeDetails("single"),
		params.schema,
		params.model,
		host.modelEnv,
	);
	if (isFailedResult(result)) {
		const errorMsg = getResultOutput(result);
		return {
			mode: "single",
			text: `Agent ${result.stopReason || "failed"}: ${errorMsg}\n\nRetry note (distilled):\n${retryNote(result)}${resultNotes(result)}`,
			results: [result],
			isError: true,
		};
	}
	const executionCwd = params.cwd ?? host.cwd;
	const output = getFinalOutput(result.messages) || "(no output)";
	const cited = missingCitedPaths(output, executionCwd);
	const parts = [output + structuredSection(result) + resultNotes(result)];
	if (cited.length > 0) parts.push(citationWarning(cited));
	if ((verify ?? "sample") !== "off" && agentIsWriterCapable(host.agents.find((a) => a.name === result.agent))) {
		const report = await runVerifierOn(host.cwd, host.agents, result, executionCwd, host.signal, host.modelEnv);
		if (report) parts.push(`### [verifier]\n\n${report}`);
	}
	parts.push(VERIFY_FOOTER);
	return { mode: "single", text: parts.join("\n\n"), results: [result] };
}

/** How a backgrounded delegation ended, for its completion notice. */
export interface BackgroundCompletion {
	/** Everything worth reading about the run; empty when it said nothing at all. */
	summary: string;
	status: "done" | "failed" | "canceled";
	/** Undefined for a canceled run — a killed worker's exit code says nothing about the work. */
	exitCode: number | undefined;
}

/**
 * The completion of a backgrounded delegation, harness-neutral: the pi tool
 * announces it on the background-job bus, the Claude adapter as a wake record.
 */
export function backgroundCompletion(result: SingleResult, aborted: boolean): BackgroundCompletion {
	// `getFinalOutput`, not a hand-rolled join over `messages`: `messages` is
	// `Message[]`, so mapping it as if it were strings yields a run of empty
	// strings — every successful delegation would have reported "it produced
	// no output". `errorMessage` is part of the summary because it is where a
	// worker's failure actually lives: a writer that touched nothing exits 0
	// with NO_CHANGE_ERROR in `errorMessage` and an empty stderr.
	const failed = isFailedResult(result);
	const summary = [
		failed ? result.errorMessage : undefined,
		getFinalOutput(result.messages),
		structuredSection(result),
		result.stderr?.trim(),
		resultNotes(result).trim(),
	]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join("\n\n");
	return {
		summary,
		// An aborted run is CANCELED rather than failed: calling it a failure
		// would send the model debugging a stop that a human asked for.
		// `isFailedResult`, not the exit code: a provider error and a no-change
		// writer both exit 0 with `stopReason: "error"`.
		status: aborted ? "canceled" : failed ? "failed" : "done",
		exitCode: aborted ? undefined : failed && result.exitCode === 0 ? 1 : result.exitCode,
	};
}
