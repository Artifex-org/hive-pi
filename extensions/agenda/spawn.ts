/**
 * Spawning child `pi` processes.
 *
 * `getPiInvocation` moved here from `extensions/subagent/index.ts` so there is
 * one source of truth for "how do we re-invoke ourselves", and because this is
 * where PR 4 extracts the rest of the worker spawner.
 *
 * HARD RULE FOR THIS FILE: **nothing mutable at module scope.** pi builds a
 * fresh jiti per extension ENTRY with `moduleCache:false`, so `subagent` and
 * `agenda` each get their own instance of this module. A diamond import within
 * one extension shares state; across two extensions it silently forks. Pure
 * functions and per-call state are safe; a cache or a `Set` is not.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addUsage, budgetTokens, emptyUsage, type Usage, type WireUsage } from "../harness/usage.ts";
import { ensureWorkerMcpConfig } from "../mcp-common/config.ts";

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Explicit override, checked first.
	//
	// The `process.argv[1]` heuristic below is correct INSIDE pi — argv[1] is
	// pi's own entry, so re-invoking it spawns pi. It is wrong anywhere else:
	// under vitest, argv[1] is vitest's binary, so a worker is spawned as
	// `node <vitest> --mode json -p …` and dies in the ESM loader. That made the
	// spawner untestable outside pi, which is precisely the code that most needs
	// an end-to-end test.
	//
	// It is also genuinely useful in production: two `pi` binaries sit on PATH
	// (the pinned `~/.npm-global/bin/pi` and Omarchy's unpinned npx wrapper), so
	// being able to name the one workers should use is a real capability, not
	// only a test hook.
	const override = process.env.PI_HOUSE_PI_BIN;
	if (override) return { command: override, args };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface OneShotResult {
	/** Concatenated assistant text. Empty when the child produced none. */
	text: string;
	/** Tokens the child actually spent, for the caller's budget. */
	tokens: number;
	/** Full usage including dollars — see harness/usage.ts. */
	usage: Usage;
	exitCode: number;
	timedOut: boolean;
	stderr: string;
}

export interface OneShotOptions {
	prompt: string;
	model?: string;
	cwd: string;
	timeoutMs: number;
	/** Extra environment for the child, merged over `process.env`. */
	env?: Record<string, string>;
}

/**
 * Run a single tool-less prompt in a child `pi` and return its text.
 *
 * `--no-tools` rather than `--tools ""`: it resolves to `noTools:"all"` →
 * `allowedToolNames = []` (`main.js:380-381`, `sdk.js:133`, `args.js:79-90`).
 * The empty-string form happens to work only because `[]` is truthy at
 * `agent-session.js:148`, which is an accident to lean on rather than a
 * contract.
 *
 * Tool-less BY CONSTRUCTION matters: the evaluator must grade what the worker
 * surfaced in the transcript, not go and look for itself. A judge that can read
 * files will eventually decide the goal is met by checking directly, which is a
 * different — and unbounded — question from the one being asked.
 */
export function runOneShot(options: OneShotOptions): Promise<OneShotResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--no-tools"];
	if (options.model) args.push("--model", options.model);
	args.push(options.prompt);

	return new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...options.env },
		});

		const texts: string[] = [];
		let usage = emptyUsage();
		let stderr = "";
		let buffer = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Record<string, unknown> };
			try {
				event = JSON.parse(line);
			} catch {
				return; // the stream is a raw event dump; unknown lines are not ours
			}
			if (event.type !== "message_end" || !event.message) return;
			// NOT `Record<string, number>`: `usage.cost` is an OBJECT. Typing it as
			// a number makes the compiler agree with a wrong wire description and
			// the dollars are silently dropped — see harness/usage.ts.
			const message = event.message as { role?: string; content?: unknown; usage?: WireUsage };
			if (message.role !== "assistant") return;

			usage = addUsage(usage, message.usage);

			const content = message.content;
			if (typeof content === "string") {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					const p = part as { type?: string; text?: unknown };
					if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
				}
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) processLine(buffer);
			resolve({ text: texts.join("\n").trim(), tokens: budgetTokens(usage), usage, exitCode: code ?? 1, timedOut, stderr });
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ text: "", tokens: 0, usage: emptyUsage(), exitCode: 1, timedOut: false, stderr: String(err) });
		});
	});
}


/**
 * Run one plan node as a child `pi` with a role's tools and system prompt.
 *
 * Mirrors `subagent/index.ts`'s proven invocation exactly — same flags, same
 * newline-JSON parse — rather than inventing a second way to start a worker.
 * Unifying the two spawners is real follow-up work; doing it under the same
 * change that introduces the orchestrator would put the most-used code path in
 * this harness at risk for no immediate gain.
 */
export interface RoleAgentOptions {
	role: { name: string; tools?: string[]; model?: string; systemPrompt: string };
	prompt: string;
	cwd: string;
	model?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env?: Record<string, string>;
	/**
	 * Extra flags, inserted before the prompt positional.
	 *
	 * The reason this exists: `runRoleAgent` does NOT pass `--no-extensions`, so
	 * a role agent loads the caller's full interactive extension set. That is
	 * right for an agenda plan node — it wants the harness — and wrong for
	 * anything that runs *from inside* an extension hook, which would re-enter
	 * itself. `brief` passes `--no-extensions` plus the worker `-e` allowlist
	 * here (the same shape `subagent/worker.ts` builds) rather than growing a
	 * third spawner.
	 */
	extraArgs?: string[];
}

export interface RoleAgentResult {
	text: string;
	tokens: number;
	/** Full usage including dollars — see harness/usage.ts. */
	usage: Usage;
	exitCode: number;
	timedOut: boolean;
	stderr: string;
}

export function runRoleAgent(options: RoleAgentOptions): Promise<RoleAgentResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	// A role agent loads the caller's FULL extension set (see `extraArgs` above),
	// which includes `pi-mcp-adapter` reading the real config — so unlike a
	// subagent worker it would honour an eager lifecycle and connect to every
	// prewarmed server on spawn. Same reasoning as `subagent/worker.ts`: the
	// lifecycle belongs to the session kind, and a bounded child is not the kind
	// that benefits (HIV-1969). Null when nothing prewarms, in which case no flag
	// is passed and the child reads exactly what the adapter would.
	const workerMcpConfig = ensureWorkerMcpConfig();
	if (workerMcpConfig) args.push("--mcp-config", workerMcpConfig);
	const model = options.model ?? options.role.model;
	if (model) args.push("--model", model);
	if (options.role.tools && options.role.tools.length > 0) args.push("--tools", options.role.tools.join(","));
	if (options.extraArgs && options.extraArgs.length > 0) args.push(...options.extraArgs);

	let promptFile: string | null = null;
	if (options.role.systemPrompt.trim()) {
		promptFile = join(mkdtempSync(join(tmpdir(), "hive-pi-role-")), `${options.role.name}.md`);
		writeFileSync(promptFile, options.role.systemPrompt, "utf8");
		args.push("--append-system-prompt", promptFile);
	}
	args.push(options.prompt);

	return new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...options.env },
		});

		const texts: string[] = [];
		let usage = emptyUsage();
		let stderr = "";
		let buffer = "";
		let timedOut = false;

		const finish = (exitCode: number) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (promptFile) {
				try {
					rmSync(dirname(promptFile), { recursive: true, force: true });
				} catch {
					/* temp dir already gone */
				}
			}
			resolve({ text: texts.join("\n").trim(), tokens: budgetTokens(usage), usage, exitCode, timedOut, stderr });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		const onAbort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Record<string, unknown> };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			// NOT `Record<string, number>`: `usage.cost` is an OBJECT. Typing it as
			// a number makes the compiler agree with a wrong wire description and
			// the dollars are silently dropped — see harness/usage.ts.
			const message = event.message as { role?: string; content?: unknown; usage?: WireUsage };
			if (message.role !== "assistant") return;

			usage = addUsage(usage, message.usage);

			const content = message.content;
			if (typeof content === "string") {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					const p = part as { type?: string; text?: unknown };
					if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
				}
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 1);
		});
		child.on("error", (err) => {
			stderr += String(err);
			finish(1);
		});
	});
}
