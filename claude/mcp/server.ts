/**
 * The adapter's MCP server (`cli.ts mcp`): subagent, advisor, goal_set,
 * goal_status, goal_clear, quality_gate, bugfix_evidence, bugfix_root_cause.
 *
 * Lifetime: the server lives as long as Claude keeps its stdin open. When the
 * input ends (or the process is told to terminate), every background
 * delegation is aborted and AWAITED — each worker unwinds, releasing its
 * writer lock and reaping its pi child — before the process exits. A detached
 * worker outliving its session is the orphan defect pi's own subagent tool
 * reaps for; this is the same rule.
 */

import { fetchAgentModeCatalog } from "../../extensions/advisor/modes.ts";
import { discoverAgentsWith } from "../../extensions/harness/roles-core.ts";
import { cleanupWorkerAgentDir } from "../../extensions/mcp-common/config.ts";
import { hiveAuth, modelUnavailableReason, stateDir, type AdapterEnv } from "../env.ts";
import { isConfiguredWith, lazyLease } from "../models.ts";
import { accountedOneShot } from "../oneshot.ts";
import { loadPinnedPi } from "../pi-runtime.ts";
import { createSpool } from "../spool.ts";
import { DEFAULT_CONTROL, readControl } from "../state.ts";
import { ADVISOR_TOOL, runAdvisor } from "./advisor-tool.ts";
import { BUGFIX_TOOLS, bugfixEvidence, bugfixRootCause } from "./bugfix-tools.ts";
import { QUALITY_GATE_TOOL, runGateTool } from "./gate-tool.ts";
import { GOAL_TOOLS, goalClear, goalSet, goalStatus } from "./goal-tools.ts";
import { serve, type ToolDefinition, type ToolResult, type ToolServer } from "./protocol.ts";
import { BackgroundJobs, leasedModelEnv, runSubagentTool, subagentToolDefinition } from "./subagent-tool.ts";

const SERVER_VERSION = "0.1.0";
const TOOL_NAMES = new Set(["subagent", "advisor", "goal_set", "goal_status", "goal_clear", "quality_gate", "bugfix_evidence", "bugfix_root_cause"]);

export async function runMcpServer(env: AdapterEnv, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, log: (line: string) => void): Promise<void> {
	const dir = stateDir(env);
	const unavailable = modelUnavailableReason(env);
	const spool = createSpool(env.spool, log);
	const jobs = new BackgroundJobs(log);
	const cwd = process.cwd();
	// Read on first use by a model-backed tool: a malformed lease must not stop
	// goal_* and quality_gate from answering (they are model-free).
	const lease = lazyLease(unavailable ? undefined : env.piAgentDir);
	const isConfigured = (spec: string) => isConfiguredWith(lease())(spec);
	const pinned = () => loadPinnedPi(env.piBin as string, env.piAgentDir as string);
	const auth = hiveAuth(env);
	const catalog = async () => (auth ? ((await fetchAgentModeCatalog(auth))?.modes ?? []) : []);

	const noCredential = (): ToolResult => ({ text: `This tool needs an outside model, and ${unavailable}.`, isError: true });
	const noState = (): ToolResult => ({ text: "Session state is unavailable: HIVE_CLAUDE_CONFIG_DIR is unset.", isError: true });

	const server: ToolServer = {
		name: "hive-pi",
		version: SERVER_VERSION,
		instructions:
			"hive-pi's helpers on non-Anthropic models: delegate to role subagents, consult a cross-family advisor, set a goal " +
			"a judge holds you to, and run the repository's quality gate.",
		has: (name) => TOOL_NAMES.has(name),
		async tools(): Promise<ToolDefinition[]> {
			let roles: Parameters<typeof subagentToolDefinition>[0] = [];
			if (!unavailable) {
				try {
					roles = discoverAgentsWith(cwd, "user", (await pinned()).roles).agents;
				} catch (error) {
					// The listing still answers — every call of `subagent` will
					// report the same failure where it can be acted on.
					log(`hive-pi mcp: cannot list subagent roles: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return [subagentToolDefinition(roles), ADVISOR_TOOL, ...GOAL_TOOLS, QUALITY_GATE_TOOL, ...BUGFIX_TOOLS];
		},
		async call(name, args, signal) {
			const now = Date.now();
			switch (name) {
				case "goal_set":
					return dir ? goalSet(dir, args, now, unavailable) : noState();
				case "goal_status":
					return dir ? goalStatus(dir, now) : noState();
				case "goal_clear":
					return dir ? goalClear(dir, now) : noState();
				case "bugfix_evidence":
					return dir ? bugfixEvidence(dir, readControl(dir), env.transcript, args) : noState();
				case "bugfix_root_cause":
					return dir ? bugfixRootCause(dir, readControl(dir), args) : noState();
				case "quality_gate": {
					// A read-only posture never lets the gate install dependencies
					// (pre-tool also denies the tool there under plan and discuss).
					const mode = (dir ? readControl(dir) : DEFAULT_CONTROL).opMode;
					const readOnly = mode === "plan" || mode === "discuss" || mode === "orchestrate";
					return runGateTool(readOnly ? { ...args, install: false } : args, cwd, signal);
				}
				case "advisor": {
					if (unavailable) return noCredential();
					const pi = await pinned();
					return runAdvisor({ env, providers: lease(), serializeConversation: pi.serializeConversation, oneShot: accountedOneShot(spool, "advisor"), cwd });
				}
				case "subagent": {
					if (unavailable) return noCredential();
					const pi = await pinned();
					return runSubagentTool(args, { opMode: () => (dir ? readControl(dir) : DEFAULT_CONTROL).opMode, cwd, roles: pi.roles, modelEnv: leasedModelEnv(isConfigured, catalog), spool, jobs, canWake: Boolean(env.spool) }, signal);
				}
				default:
					return { text: `Unknown tool: ${name}`, isError: true };
			}
		},
	};

	const shutdown = async () => {
		await jobs.stopAll();
		cleanupWorkerAgentDir();
	};
	// SIGTERM/SIGINT, or the parent gone: stop reading, abort and AWAIT every
	// in-flight request (its worker unwinds, releasing its writer lock and
	// reaping its pi child) and every background job, then return. SIGKILL
	// cannot be caught: detached worker groups then outlive the server — the
	// residual the README names.
	const stop = new AbortController();
	const onSignal = () => stop.abort();
	// `on`, not `once`, until shutdown is done: pi's runtime (loaded for the
	// role parser) brings signal-exit, which re-raises a signal it believes no
	// one else handles — and a `once` listener is already gone when it looks.
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);
	// Parent-death guard: an MCP server whose Claude died without closing its
	// stdin is reparented; checking every few seconds is all it costs.
	const parent = process.ppid;
	const guard = setInterval(() => {
		if (process.ppid !== parent) {
			log("hive-pi mcp: parent process is gone; shutting down");
			stop.abort();
		}
	}, 5_000);
	guard.unref();
	try {
		await serve(server, input, output, log, stop.signal);
	} finally {
		clearInterval(guard);
		await shutdown();
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
		// The input may still be open (a signal, not EOF): let go of it so the
		// process can exit.
		if (stop.signal.aborted && "destroy" in input && typeof input.destroy === "function") input.destroy();
	}
}
