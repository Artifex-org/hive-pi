/**
 * `quality_gate` — hive-pi's quality gate (`extensions/gate/tool.ts`), served
 * to a Claude session. Discovery, runners, ceilings and rendering are the pi
 * tool's; the host supplies only a buffered runner for the fallback path.
 * There is no live progress section in Claude, so the deck is not painted.
 */

import { spawn } from "node:child_process";
import { killTree, trackTree, treeSpawnOptions } from "../../extensions/hive-common/child-tree.ts";
import { runQualityGate, type GateHost, type QualityGateParams } from "../../extensions/gate/tool.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

export const QUALITY_GATE_TOOL: ToolDefinition = {
	name: "quality_gate",
	description:
		"Run the repository's real quality gate on your changes — the same checks the pre-commit hook and CI run. Use it AFTER " +
		"edits and BEFORE claiming work is done. When the repo declares `scripts/agent-check`, the default is mode `verify` " +
		"(deps bootstrap, quick gate, type-check, the tests CI would select; `tests:false` for the fast steps only). Otherwise " +
		"mode `quick` runs the vendored gate, lint only. In a repo that gates through Hive it runs `hive check` on the fleet " +
		"against your uncommitted working tree. Reports failed checks, findings, and any check that did not run.",
	inputSchema: {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["verify", "quick", "standard", "thorough"], description: "verify = the repo's scripts/agent-check; quick = vendored gate, lint only; standard = + tests for changed files; thorough = everything" },
			tests: { type: "boolean", description: "verify only: false passes --no-tests." },
			install: { type: "boolean", description: "verify only: false passes --no-install." },
			scope: { type: "string", enum: ["changed", "staged", "all"], description: "changed = vs merge base (default); staged = pre-commit set; all = every file" },
			only: { type: "string", description: "Comma-separated check names to run exclusively (Hive path: pipeline STEP names, default `lint`)." },
			stopEarly: { type: "boolean", description: "Stop at the first failing check. Default false." },
			skip: { type: "string", description: "Comma-separated check names to skip" },
			cwd: { type: "string", description: "Directory to gate, when your work is in a different checkout than the session's." },
			project: { type: "string", description: "Hive path only: the Hive project for `hive check --project`." },
		},
		additionalProperties: false,
	},
};

/** After the ceiling's SIGTERM, how long the group gets before SIGKILL, and the pipes before we stop waiting. */
const KILL_GRACE_MS = 2_000;

/**
 * pi's `exec` contract on plain node: buffered, in `cwd`, killed at `timeout`
 * or on abort. The command runs as its own process group (a gate spawns
 * linters, test runners, `hive check`), the kill goes to the whole group, a
 * group that ignores SIGTERM gets SIGKILL after a grace, and the result is
 * settled on exit — or after the grace, should an orphan keep the pipes open.
 */
export const nodeGateHost: GateHost = {
	publishDeck: () => {},
	exec: (command, args, options) =>
		new Promise((resolve) => {
			const tree = treeSpawnOptions();
			const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], ...tree });
			trackTree(child, tree.detached);
			let stdout = "";
			let stderr = "";
			let killed = false;
			let settled = false;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			let drain: ReturnType<typeof setTimeout> | undefined;
			const settle = (code: number | null, extraErr = "") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (escalation) clearTimeout(escalation);
				if (drain) clearTimeout(drain);
				options.signal?.removeEventListener("abort", stop);
				resolve({ stdout, stderr: stderr + extraErr, code, killed });
			};
			const stop = () => {
				if (killed) return;
				killed = true;
				killTree(child, "SIGTERM", tree.detached);
				escalation = setTimeout(() => killTree(child, "SIGKILL", tree.detached), KILL_GRACE_MS);
				drain = setTimeout(() => settle(null), KILL_GRACE_MS * 2);
			};
			const timer = setTimeout(stop, options.timeout);
			if (options.signal?.aborted) stop();
			else options.signal?.addEventListener("abort", stop, { once: true });
			child.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			child.on("error", (error) => settle(null, String(error)));
			child.on("exit", (code) => {
				// The pipes may still be held by a grandchild; give them the grace.
				if (!drain) drain = setTimeout(() => settle(killed ? null : code), KILL_GRACE_MS);
			});
			child.on("close", (code) => settle(killed ? null : code));
		}),
};

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
	return value as T;
}

export function parseGateParams(args: Record<string, unknown>): QualityGateParams {
	const bool = (key: string) => {
		const v = args[key];
		if (v !== undefined && typeof v !== "boolean") throw new Error(`${key} must be a boolean`);
		return v as boolean | undefined;
	};
	const text = (key: string) => {
		const v = args[key];
		if (v !== undefined && typeof v !== "string") throw new Error(`${key} must be a string`);
		return v as string | undefined;
	};
	const params: QualityGateParams = {
		mode: pick(args.mode, ["verify", "quick", "standard", "thorough"] as const, "mode"),
		tests: bool("tests"),
		install: bool("install"),
		scope: pick(args.scope, ["changed", "staged", "all"] as const, "scope"),
		only: text("only"),
		stopEarly: bool("stopEarly"),
		skip: text("skip"),
		cwd: text("cwd"),
		project: text("project"),
	};
	// Absent keys must stay ABSENT: the gate reads `params[k] !== undefined` as
	// "the caller asked for the vendored gate".
	for (const key of Object.keys(params) as (keyof QualityGateParams)[]) if (params[key] === undefined) delete params[key];
	return params;
}

export async function runGateTool(args: Record<string, unknown>, cwd: string, signal: AbortSignal, watchRun?: GateHost["watchRun"]): Promise<ToolResult> {
	// MCP suppresses the response to a cancelled request. Its job announcement
	// could never reach the driver, so do not start an unannounceable watch.
	const host: GateHost = { ...nodeGateHost, watchRun: watchRun ? (run, watchCwd) => signal.aborted
		? Promise.resolve({ text: "The MCP request was cancelled; no background watch was started. The fleet run is not cancelled.", isError: true })
		: watchRun(run, watchCwd) : undefined };
	const result = await runQualityGate(host, parseGateParams(args), cwd, signal);
	const first = result.content[0];
	return { text: first && first.type === "text" ? first.text : "quality_gate produced no report." };
}
