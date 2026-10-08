/**
 * hive-pi's Claude adapter — the entry Hive's Claude Code plugin and driver
 * run: `$HIVE_NODE $HIVE_PI_BASE/claude/cli.ts <command>`.
 *
 * Plain node with type stripping: every file this loads uses erasable syntax
 * only and imports nothing from `@earendil-works/*` at runtime (the pinned pi
 * is reached as a child process, and its frontmatter parser through
 * pi-runtime.ts). See README.md for the contract.
 */

import { readFileSync } from "node:fs";
import { applyPiChildEnv, hiveAuth, modelUnavailableReason, readEnv, stateDir, type AdapterEnv } from "./env.ts";
import { denyToolUse, parseHookInput, readStdin, type HookInput, type HookOutput } from "./hooks/io.ts";
import { createSpool } from "./spool.ts";
import { DEFAULT_CONTROL, readControl } from "./state.ts";

// Each command imports only what it runs: PreToolUse sits in front of EVERY
// tool call, and loading the MCP server's or the agenda's module graph there
// would be latency on all of them.
const USAGE = `usage: node claude/cli.ts <command>

  hook pre-tool     PreToolUse: op-mode enforcement and the worktree guard
  hook post-tool    PostToolUse: format the edited file with the repo's formatter
  hook prompt       UserPromptSubmit: the op mode's instructions
  hook stop         Stop (sync): repo gate → drift → goal judge; may block the stop
  hook settle       Stop (async): you-should-know scan and the status recap
  brief --cwd <dir> --prompt-file <file>
                    compile a retrieval-backed brief for an opening prompt
  mcp               stdio MCP server: subagent, advisor, goal_set/status/clear, quality_gate

Every command reads Claude Code's hook JSON (or MCP JSON-RPC) on stdin. See claude/README.md.`;

const stderr = (line: string) => process.stderr.write(`${line}\n`);

function print(output: HookOutput): void {
	if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function runHook(name: string, env: AdapterEnv): Promise<void> {
	const input: HookInput = parseHookInput(await readStdin());
	const dir = stateDir(env);
	const unavailable = modelUnavailableReason(env);
	const spool = createSpool(env.spool, stderr);

	switch (name) {
		case "pre-tool": {
			const { preToolDecision } = await import("./hooks/pre-tool.ts");
			const control = dir ? readControl(dir) : DEFAULT_CONTROL;
			let rootCause = false;
			if (dir) {
				// Also discards a stale episode once the session has left bugfix.
				const { currentEpisode } = await import("./bugfix.ts");
				rootCause = currentEpisode(dir, control)?.rootCause != null;
			}
			print(preToolDecision(input, control, rootCause));
			return;
		}
		case "prompt": {
			const { promptDecision } = await import("./hooks/prompt.ts");
			print(promptDecision(dir ? readControl(dir) : DEFAULT_CONTROL));
			return;
		}
		case "post-tool": {
			const { postToolDecision } = await import("./hooks/post-tool.ts");
			let bugfixLive = false;
			if (dir) {
				const { currentEpisode } = await import("./bugfix.ts");
				const phase = currentEpisode(dir, readControl(dir))?.machine.phase;
				bugfixLive = phase !== undefined && phase !== "done" && phase !== "blocked";
			}
			print(await postToolDecision(input, dir, bugfixLive));
			return;
		}
		case "stop": {
			if (!dir) {
				stderr("hive-pi: agenda off — HIVE_CLAUDE_CONFIG_DIR is unset, so no goal or ledger can persist");
				return;
			}
			const { stopDecision } = await import("./hooks/stop.ts");
			const { leasedProviders, resolveEvaluator } = await import("./models.ts");
			const providers = unavailable ? new Set<string>() : leasedProviders(env.piAgentDir as string);
			print(
				await stopDecision(input, {
					stateDir: dir,
					spool,
					modelUnavailable: unavailable,
					resolveEvaluator: () => resolveEvaluator(env, providers),
					transcriptPath: env.transcript,
					stderr,
				}),
			);
			return;
		}
		case "settle": {
			if (!dir) {
				stderr("hive-pi: settle helpers off — HIVE_CLAUDE_CONFIG_DIR is unset");
				return;
			}
			if (unavailable) {
				stderr(`hive-pi: you-should-know and the status recap are off — ${unavailable}`);
				return;
			}
			const { runRecap, runYouShouldKnow } = await import("./hooks/settle.ts");
			const { leasedProviders, resolveEvaluator, resolveYskModel } = await import("./models.ts");
			const { accountedOneShot } = await import("./oneshot.ts");
			const { serverSessionId } = await import("./session.ts");
			const providers = leasedProviders(env.piAgentDir as string);
			const auth = hiveAuth(env);
			let session: ReturnType<typeof serverSessionId> | undefined;
			const deps = {
				stateDir: dir,
				control: readControl(dir),
				auth,
				session: () => (session ??= serverSessionId(auth, env.sessionRunId, dir)),
				resolveYskModel: () => resolveYskModel(env, providers),
				resolveEvaluator: () => resolveEvaluator(env, providers),
				oneShot: (role: "ysk" | "recap") => accountedOneShot(spool, role),
				transcriptPath: env.transcript,
				stderr,
			};
			// Both run; one failing must not cost the other, and neither failure is
			// swallowed — each is reported and the hook exits non-zero.
			const failures: string[] = [];
			for (const [label, step] of [["recap", runRecap], ["you-should-know", runYouShouldKnow]] as const) {
				try {
					await step(input, deps);
				} catch (error) {
					failures.push(`${label}: ${(error as Error).message}`);
				}
			}
			if (failures.length > 0) throw new Error(failures.join("; "));
			return;
		}
		default:
			throw new Error(`unknown hook "${name}"\n${USAGE}`);
	}
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(`${USAGE}\n`);
		return command ? 0 : 2;
	}
	const env = readEnv();
	applyPiChildEnv(env);
	switch (command) {
		case "hook":
			if (rest[0] === "pre-tool") {
				// Enforcement fails CLOSED. Claude reads any exit other than 2 from a
				// PreToolUse hook as "proceed", so an error here — a half-written
				// control.json, a failed import — would silently lift a discuss or
				// plan restriction. It is a deny instead, with the cause.
				try {
					await runHook("pre-tool", env);
				} catch (error) {
					const cause = error instanceof Error ? error.message : String(error);
					stderr(`hive-pi: pre-tool could not decide: ${cause}`);
					print(denyToolUse(`hive-pi could not check this call against the session's operating mode (${cause}), so it is refused rather than allowed unchecked.`));
				}
				return 0;
			}
			await runHook(rest[0] ?? "", env);
			return 0;
		case "brief": {
			const cwd = flag(rest, "--cwd");
			const promptFile = flag(rest, "--prompt-file");
			if (!cwd || !promptFile) throw new Error(`brief needs --cwd and --prompt-file\n${USAGE}`);
			const { runBriefCommand } = await import("./brief.ts");
			const result = await runBriefCommand(cwd, readFileSync(promptFile, "utf8"), env, createSpool(env.spool, stderr));
			process.stdout.write(`${JSON.stringify(result)}\n`);
			return 0;
		}
		case "mcp": {
			const { runMcpServer } = await import("./mcp/server.ts");
			await runMcpServer(env, process.stdin, process.stdout, stderr);
			return 0;
		}
		default:
			throw new Error(`unknown command "${command}"\n${USAGE}`);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		stderr(`hive-pi: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
