/**
 * `quality_gate` — hive-pi's quality gate (`extensions/gate/tool.ts`), served
 * to a Claude session. Discovery, runners, ceilings and rendering are the pi
 * tool's; the host supplies only a buffered runner for the fallback path.
 * There is no live progress section in Claude, so the deck is not painted.
 */

import { spawn } from "node:child_process";
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

/** pi's `exec` contract on plain node: buffered, killed (SIGTERM) at `timeout`, abortable. */
export const nodeGateHost: GateHost = {
	publishDeck: () => {},
	exec: (command, args, options) =>
		new Promise((resolve) => {
			const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
			let stdout = "";
			let stderr = "";
			let killed = false;
			const timer = setTimeout(() => {
				killed = true;
				child.kill("SIGTERM");
			}, options.timeout);
			child.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ stdout, stderr: stderr + String(error), code: null, killed: killed || options.signal?.aborted === true });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code, killed: killed || options.signal?.aborted === true });
			});
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

export async function runGateTool(args: Record<string, unknown>, cwd: string, signal: AbortSignal): Promise<ToolResult> {
	const result = await runQualityGate(nodeGateHost, parseGateParams(args), cwd, signal);
	const first = result.content[0];
	return { text: first && first.type === "text" ? first.text : "quality_gate produced no report." };
}
