#!/usr/bin/env node
/**
 * mcp-lazy CLI. Used as an MCP server's `command` in `mcp.json`:
 *
 *   "asfam": {
 *     "command": "node",
 *     "args": ["~/repos/hive-pi__worktrees/main/mcp-lazy/cli.ts", "--idle", "600", "--",
 *              "bash", "-c", "exec asfam-mcp"]
 *   }
 *
 * Options (before `--`):
 *   --idle <seconds>   stop the server after this long idle (default 600, 0 = never)
 *   --cache <dir>      where discovery responses are cached
 *                      (default $MCP_LAZY_CACHE, else ~/.pi/mcp-lazy — a path
 *                      every Hive sandbox may write, so launches share the cache)
 *
 * See proxy.ts for the design.
 */

import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { LazyProxy } from "./proxy.ts";

export interface CliArgs {
	idleMs: number;
	cacheDir: string;
	command: string;
	args: string[];
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, home = os.homedir()): CliArgs {
	const sep = argv.indexOf("--");
	if (sep < 0 || sep === argv.length - 1) throw new Error("usage: mcp-lazy [--idle s] [--cache dir] -- <command> [args...]");
	const own = argv.slice(0, sep);
	const [command, ...args] = argv.slice(sep + 1);
	let idleMs = 600_000;
	let cacheDir = env.MCP_LAZY_CACHE || path.join(home, ".pi", "mcp-lazy");
	for (let i = 0; i < own.length; i++) {
		if (own[i] === "--idle") {
			const seconds = Number(own[++i]);
			if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`--idle must be a non-negative number of seconds, got ${own[i]}`);
			idleMs = seconds * 1000;
		} else if (own[i] === "--cache") {
			cacheDir = own[++i] ?? cacheDir;
		} else {
			throw new Error(`unknown option ${own[i]}`);
		}
	}
	return { idleMs, cacheDir, command, args };
}

async function main(): Promise<void> {
	let parsed: CliArgs;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	}
	const proxy = new LazyProxy({
		...parsed,
		cwd: process.cwd(),
		send: (line) => process.stdout.write(`${line}\n`),
		log: (line) => process.stderr.write(`${line}\n`),
	});
	// Serialise client lines: an `initialize` that starts the server must finish
	// before the next request is routed.
	let chain = Promise.resolve();
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", (line) => {
		chain = chain
			.then(() => proxy.fromClient(line))
			.catch((err) => {
				process.stderr.write(`mcp-lazy: ${String(err)}\n`);
			});
	});
	rl.on("close", () => {
		void chain.finally(() => {
			proxy.close();
			setTimeout(() => process.exit(0), 100).unref();
		});
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			proxy.close();
			setTimeout(() => process.exit(0), 100).unref();
		});
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mcp-lazy/cli.ts")) void main();
