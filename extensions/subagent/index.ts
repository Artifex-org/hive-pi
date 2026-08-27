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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DECK_SECTION_CHANNEL,
	DECK_SYNC_CHANNEL,
	type DeckAgentRow,
	type DeckSectionEvent,
} from "../deck/protocol.ts";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	projectAgentsAmong,
	resolveAgent,
	selectableAgents,
	unknownTools,
} from "../harness/roles.ts";
import {
	describeLifecycleEvent,
	silenceError,
	shouldStopForSilence,
} from "./lifecycle.ts";
import { cleanupWorkerMcpConfig } from "../mcp-common/config.ts";
import { buildSubagentWorkerArgs } from "./worker.ts";
import { backgroundRefusal, backgroundStartedMessage } from "./background.ts";
import { MAX_CONCURRENT } from "../background/jobs.ts";
import {
	BACKGROUND_CANCEL_CHANNEL,
	BACKGROUND_JOB_CHANNEL,
	type BackgroundJobEvent,
} from "../background/channel.ts";
import { getPiInvocation } from "../agenda/spawn.ts";
import { acquireWriterLock, isWriterCapable, writerScopeFor } from "../harness/writer.ts";
import { guardWorkerCwd, workerCwdRefusal } from "../guards-common/capability.ts";
import {
	citationWarning,
	diffStamp,
	missingCitedPaths,
	NO_CHANGE_ERROR,
	VERIFY_FOOTER,
	writerMadeNoChange,
} from "../harness/verify.ts";
import { distillFailure } from "../harness/distill.ts";
import {
	MAX_SCHEMA_RETRIES,
	parseStructuredResult,
	rejectUnsupportedSchema,
	structuredInstruction,
	structuredRetryTask,
} from "../harness/structured.ts";
import { emptyJsonRunState, foldJsonLine } from "../harness/json-protocol.ts";
import { frame } from "../harness/framing.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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

interface UsageStats {
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
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
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

function isFailedResult(result: SingleResult): boolean {
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
function agentIsWriterCapable(agent: AgentConfig | undefined): boolean {
	return isWriterCapable(agent?.tools);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * A distilled retry note for a failed delegation (HIV-1232, the
 * Parallel-Distill-Refine result). The orchestrator writes retry prompts from
 * this tool result, so a compact what-was-tried/how-it-failed note here is
 * exactly what conditions the next attempt.
 */
function retryNote(result: SingleResult): string {
	return distillFailure({
		attempted: result.task,
		output: [result.errorMessage, result.stderr, getFinalOutput(result.messages)]
			.filter(Boolean)
			.join("\n"),
		stopReason: result.stopReason,
	});
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
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

async function mapWithConcurrencyLimit<TIn, TOut>(
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
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
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
		const settingsPath = path.join(getAgentDir(), "settings.json");
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


type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** One role, rendered so a model that guessed wrong can pick right on retry. */
export function describeAgentForRecovery(agent: AgentConfig): string {
	const aliases = agent.aliases?.length ? ` [aka ${agent.aliases.join(", ")}]` : "";
	return `  ${agent.name}${aliases} (${agent.source}): ${agent.description}`;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	schema?: unknown,
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
	const model = agent.model ?? getSubagentDefaultModel();

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
	const args = buildSubagentWorkerArgs(model, agent.tools, undefined, agent.opMode);

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
		const appended = [agent.systemPrompt.trim(), schema ? structuredInstruction(schema) : ""]
			.filter(Boolean)
			.join("\n\n");
		if (appended) {
			const tmp = await writePromptToTempFile(agent.name, appended);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		emitUpdate();

		// Writer verification, free tier: stamp the tree before and after. A
		// writer that "succeeded" without touching anything is folded to a
		// failure — see harness/verify.ts.
		const stampBefore = writerLock ? await diffStamp(executionCwd) : null;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
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
				env: { ...process.env, PI_AGENDA_WORKER: "1", ...(writerLock?.childEnv ?? {}) },
			});
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
				proc.kill("SIGTERM");
				forceKillTimer = setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
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
		if (wasAborted) throw new Error("Subagent was aborted");
		if (writerLock && !isFailedResult(currentResult) && writerMadeNoChange(stampBefore, await diffStamp(executionCwd))) {
			currentResult.stopReason = "error";
			currentResult.errorMessage = NO_CHANGE_ERROR;
		}
		// Schema check runs only on a run that otherwise succeeded: a crashed
		// worker's missing JSON block is not a schema problem, and reporting it as
		// one would bury the real failure under a formatting complaint.
		if (schema && !isFailedResult(currentResult)) {
			const parsed = parseStructuredResult(schema, getFinalOutput(currentResult.messages));
			if (parsed.ok) currentResult.structured = parsed.value;
			else currentResult.structuredError = parsed.error;
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
async function runAgentWithSchema(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	schema: unknown,
): Promise<SingleResult> {
	let attemptTask = task;
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
	);
	if (!schema) return result;

	for (let retry = 0; retry < MAX_SCHEMA_RETRIES; retry++) {
		if (!result.structuredError || isFailedResult(result)) break;
		if (agentIsWriterCapable(resolveAgent(agents, agentName))) break;
		attemptTask = structuredRetryTask(task, result.structuredError);
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
		);
		// Keep the retry only if it is not worse: a retry that crashed leaves the
		// original answer, which at least contained the work.
		if (isFailedResult(retried)) break;
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

const SchemaParam = Type.Optional(
	Type.Any({
		description:
			"JSON Schema the agent's final answer must match. When set, the agent is instructed to end with a " +
			"fenced JSON block, the block is validated, and a validated object is returned. Constrain only the " +
			"fields you branch on; do NOT set additionalProperties:false, and mark anything that can be empty optional.",
	}),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	schema: SchemaParam,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
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
async function runVerifierOn(
	defaultCwd: string,
	agents: AgentConfig[],
	target: SingleResult,
	targetCwd: string,
	signal: AbortSignal | undefined,
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
		const result = await runSingleAgent(defaultCwd, agents, "verifier", task, targetCwd, undefined, signal, undefined, (results) => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results,
		}));
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

export default function (pi: ExtensionAPI) {
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "subagent") stopSubagentWidget(pi, event.toolCallId);
	});
	pi.on("session_shutdown", () => {
		for (const toolCallId of [...ACTIVE_SUBAGENT_RUNS.keys()]) stopSubagentWidget(pi, toolCallId);
		// The derived worker MCP config, if this session wrote one (HIV-1969).
		// Idempotent, and a failure here is never worth surfacing at shutdown.
		cleanupWorkerMcpConfig();
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
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
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

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
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

				backgroundSeq += 1;
				const jobId = `sub-${backgroundSeq}`;
				const what = (params.what ?? "").trim();
				const controller = new AbortController();
				backgroundAborts.set(jobId, controller);

				pi.events.emit(BACKGROUND_JOB_CHANNEL, {
					action: "start",
					id: jobId,
					what,
					kind: "subagent",
					detail: `${agentName}: ${(params.task as string).slice(0, 200)}`,
				} satisfies BackgroundJobEvent);

				// Deliberately NOT awaited. The floating promise IS the feature; it
				// is given a terminal `.then` so nothing can reject unhandled and
				// take the session down with it.
				void runSingleAgent(
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
					params.schema,
				)
					.then((result) => {
						// `getFinalOutput`, not a hand-rolled join over `messages`.
						// `messages` is `Message[]`, so mapping it as if it were
						// strings yields a run of empty strings — every successful
						// delegation would have reported "it produced no output",
						// which is the quiet-failure shape rather than a visible bug.
						const summary = [getFinalOutput(result.messages), structuredSection(result), result.stderr?.trim()]
							.map((part) => part?.trim())
							.filter(Boolean)
							.join("\n\n");
						if (summary) {
							pi.events.emit(BACKGROUND_JOB_CHANNEL, {
								action: "output",
								id: jobId,
								chunk: summary,
							} satisfies BackgroundJobEvent);
						}
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "finish",
							id: jobId,
							// An aborted run is reported as CANCELED rather than failed:
							// the exit code of a killed worker says nothing about the work,
							// and calling it a failure would send the model debugging a
							// stop that a human asked for.
							status: controller.signal.aborted ? "canceled" : result.exitCode === 0 ? "done" : "failed",
							exitCode: controller.signal.aborted ? undefined : result.exitCode,
						} satisfies BackgroundJobEvent);
					})
					.catch((err: unknown) => {
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "output",
							id: jobId,
							chunk: `The delegation threw: ${(err as Error)?.message ?? String(err)}`,
						} satisfies BackgroundJobEvent);
						pi.events.emit(BACKGROUND_JOB_CHANNEL, {
							action: "finish",
							id: jobId,
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

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = reportUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									reportUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runAgentWithSchema(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.schema,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}\n\nRetry note (distilled):\n${retryNote(result)}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					// A validated step hands the NEXT step its object, not its prose.
					// That is the point of a typed chain: step 2's `{previous}`
					// becomes JSON it can rely on rather than a paragraph it has to
					// re-read. Unvalidated steps behave exactly as before.
					//
					// A step whose schema was NEVER satisfied is the case worth
					// being careful about. `runAgentWithSchema` gives up after its
					// retry budget and returns a SUCCESSFUL result still carrying
					// `structuredError`, so without the branch below it would slide
					// past `isFailedResult` and hand the next step prose with no
					// sign the contract broke — the silent degradation this change
					// exists to remove, one level down.
					//
					// It is marked rather than fatal, unlike the agenda side. There
					// `resolveRef` reads fields off the value and gets `undefined`
					// in silence; here `{previous}` is read by a MODEL, which can
					// adapt to "this is unvalidated" but not to a fact it is never
					// told. Failing would also throw away every earlier step.
					previousOutput =
						result.structured !== undefined
							? JSON.stringify(result.structured, null, 2)
							: getFinalOutput(result.messages) + structuredSection(result);
				}
				const last = results[results.length - 1];
				return {
					content: [
						{ type: "text", text: (getFinalOutput(last.messages) || "(no output)") + structuredSection(last) },
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const writerCwds = new Set<string>();
				for (const task of params.tasks) {
					const agent = agents.find((candidate) => candidate.name === task.agent);
					if (!agentIsWriterCapable(agent)) continue;
					const taskCwd = writerScopeFor(task.cwd ?? ctx.cwd);
					if (writerCwds.has(taskCwd)) {
						return {
							content: [
								{
									type: "text",
									text: `Refusing parallel writer-capable agents in the same worktree: ${taskCwd}. Run them sequentially or use separate worktrees.`,
								},
							],
							details: makeDetails("parallel")([]),
						};
					}
					writerCwds.add(taskCwd);
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						startedAtMs: Date.now(),
						lastActivityAtMs: Date.now(),
					};
				}

				const emitParallelUpdate = () => {
					if (reportUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						reportUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				emitParallelUpdate();

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runAgentWithSchema(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.schema,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r, index) => {
					const failed = isFailedResult(r);
					const output = truncateParallelOutput(getResultOutput(r));
					const status = failed
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					const cited = failed ? [] : missingCitedPaths(output, params.tasks?.[index]?.cwd ?? ctx.cwd);
					const warning = cited.length > 0 ? `\n\n${citationWarning(cited)}` : "";
					const note = failed ? `\n\nRetry note (distilled):\n${retryNote(r)}` : "";
					const structured = failed ? "" : structuredSection(r);
					return `### [${r.agent}] ${status}\n\n${output}${structured}${warning}${note}`;
				});

				// Sampled verification: the writer, if one succeeded — the result the
				// rest of the batch will be built on.
				let verifierSection = "";
				if ((params.verify ?? "sample") !== "off") {
					const writerIndex = results.findIndex(
						(r) => !isFailedResult(r) && agentIsWriterCapable(agents.find((a) => a.name === r.agent)),
					);
					if (writerIndex >= 0) {
						const report = await runVerifierOn(
							ctx.cwd,
							agents,
							results[writerIndex],
							params.tasks?.[writerIndex]?.cwd ?? ctx.cwd,
							signal,
						);
						if (report) verifierSection = `\n\n---\n\n### [verifier] on ${results[writerIndex].agent}\n\n${report}`;
					}
				}

				const parallelOutput = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${verifierSection}\n\n${VERIFY_FOOTER}`;
				return {
					content: [{ type: "text", text: truncateParallelOutput(parallelOutput) }],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runAgentWithSchema(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					reportUpdate,
					makeDetails("single"),
					params.schema,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}\n\nRetry note (distilled):\n${retryNote(result)}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const executionCwd = params.cwd ?? ctx.cwd;
				const output = getFinalOutput(result.messages) || "(no output)";
				const cited = missingCitedPaths(output, executionCwd);
				const parts = [output + structuredSection(result)];
				if (cited.length > 0) parts.push(citationWarning(cited));
				if (
					(params.verify ?? "sample") !== "off" &&
					agentIsWriterCapable(agents.find((a) => a.name === result.agent))
				) {
					const report = await runVerifierOn(ctx.cwd, agents, result, executionCwd, signal);
					if (report) parts.push(`### [verifier]\n\n${report}`);
				}
				parts.push(VERIFY_FOOTER);
				return {
					content: [{ type: "text", text: parts.join("\n\n") }],
					details: makeDetails("single")([result]),
				};
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
