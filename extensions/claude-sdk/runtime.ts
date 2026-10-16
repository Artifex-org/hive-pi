/** Trusted launch configuration, access-only admission and ephemeral private state. */
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { accessLease, type AccessLease } from "./options.ts";
import { assertTreeIdentityReadable, killTree, releaseTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../hive-common/child-tree.ts";

export const CLI_VERSION = "2.1.286";
export interface LaunchConfig { executable: string; stateRoot: string; url: string; token: string; launch: string; cwd: string; pilot?: boolean }
export function launchConfig(env: NodeJS.ProcessEnv, cwd: string): LaunchConfig | undefined {
	if (env.HIVE_CLAUDE_SDK !== "1") return undefined;
	if (env.HIVE_CLAUDE_SDK_PILOT && !["0", "1"].includes(env.HIVE_CLAUDE_SDK_PILOT)) throw new Error("Invalid Claude SDK pilot restriction");
	const { HIVE_CLAUDE_SDK_EXECUTABLE: executable, HIVE_CLAUDE_SDK_STATE_DIR: stateRoot,
		HIVE_URL: url, HIVE_TOKEN: token, HIVE_LAUNCH_ID: launch } = env;
	if (!executable || !stateRoot || !isAbsolute(executable) || !isAbsolute(stateRoot) || !isAbsolute(cwd) ||
		!url || !token || !launch || /[\s\p{Cc}]/u.test(token) || !/^[a-zA-Z0-9_-]+$/.test(launch)) {
		throw new Error("Claude SDK requires absolute pinned executable/private state and Hive launch configuration");
	}
	const endpoint = new URL(url);
	if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
		throw new Error("Claude SDK requires HTTPS Hive URL (or loopback)");
	}
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid Hive URL");
	return { executable, stateRoot, url: url.replace(/\/$/, ""), token, launch, cwd,
		...(env.HIVE_CLAUDE_SDK_PILOT === "1" ? { pilot: true } : {}) };
}

export type LeaseSource = (signal: AbortSignal) => Promise<AccessLease>;
/** Every GET is independently authorized by Hive. Env availability is NOT admission. */
export function hiveLease(config: LaunchConfig, fetcher: typeof fetch = fetch,
	excludedAccounts: () => readonly string[] = () => []): LeaseSource {
	return async signal => {
		const url = new URL(`${config.url}/api/v1/agent-launches/${encodeURIComponent(config.launch)}/claude-auth`);
		for (const account of excludedAccounts()) url.searchParams.append("exclude", account);
		const response = await fetcher(url.href, {
			method: "GET", headers: { Authorization: `Bearer ${config.token}` }, redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		});
		if (!response.ok) throw new Error(`Claude SDK launch lease refused (HTTP ${response.status})`);
		let value: unknown;
		try { value = await response.json(); } catch { throw new Error("Invalid access-only Claude lease response"); }
		return accessLease(value, Date.now());
	};
}

/** Coalesces concurrent GETs only; no cached authorization across model requests. */
export class LeaseManager {
	private flight?: Promise<AccessLease>;
	private readonly controller = new AbortController();
	constructor(private readonly source: LeaseSource, private readonly now = Date.now) {}
	async get(signal: AbortSignal, previous?: AccessLease): Promise<AccessLease> {
		signal.throwIfAborted(); this.controller.signal.throwIfAborted();
		if (!this.flight) {
			const bounded = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]);
			const flight = cancellable(this.source(bounded), bounded).then(value => accessLease(value, this.now()));
			this.flight = flight;
			void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
		}
		const lease = await cancellable(this.flight, signal);
		// Never restart with a token whose remaining validity cannot support a turn.
		if (Date.parse(lease.expires_at) - this.now() < 60_000) throw new Error("Claude SDK lease too near expiry; wait for authd renewal");
		if (previous && lease.access_token === previous.access_token && Date.parse(previous.expires_at) <= this.now()) {
			throw new Error("Claude SDK lease not renewed; reconciliation required");
		}
		return lease;
	}
	close(): void { this.controller.abort(); }
}
export function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// The operation may already have started; still observe a later rejection.
		void promise.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Aborted"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function validateStateRoot(root: string): Promise<void> {
	// Do not chmod a potentially shared or attacker-owned existing directory.
	await mkdir(root, { mode: 0o700, recursive: true });
	const stat = await lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.() || await realpath(root) !== root) {
		throw new Error("Claude SDK state root must be an owned, non-symlink 0700 directory");
	}
}

export async function privateDirectory(root: string): Promise<string> {
	await validateStateRoot(root);
	return mkdtemp(join(root, "query-"));
}
export async function privateFile(dir: string, name: string, value: unknown): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	return path;
}

/** Only version inspection, never login, inference, wrapper scripts or CLI rewriting. */
export async function validateExecutable(config: LaunchConfig, signal: AbortSignal): Promise<void> {
	assertTreeIdentityReadable();
	const stat = await lstat(config.executable);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error("Unsafe pinned Claude executable");
	await access(config.executable, constants.X_OK);
	const { stdout } = await promisify(execFile)(config.executable, ["--version"], {
		env: { PATH: "/usr/bin:/bin", HOME: config.stateRoot, CLAUDE_CONFIG_DIR: config.stateRoot },
		timeout: 5000, maxBuffer: 4096, signal,
	});
	if (stdout.trim() !== `${CLI_VERSION} (Claude Code)`) throw new Error(`Claude SDK requires pinned Claude Code ${CLI_VERSION}`);
}

/** SDK-only strict ownership: Linux readable procfs; never group-only fallback. */
export function processScope(): { spawn: NonNullable<Options["spawnClaudeCodeProcess"]>; close: () => Promise<void> } {
	const children = new Set<ReturnType<typeof spawn>>();
	let cleanupError: unknown;
	let closed = false;
	const signal = (child: ReturnType<typeof spawn>, value: NodeJS.Signals) => {
		try { killTree(child, value, true); return true; }
		catch (error) { cleanupError ??= error; return false; }
	};
	return {
		spawn: options => {
			if (cleanupError) throw cleanupError;
			if (closed) throw new Error("Claude SDK process scope closed");
			assertTreeIdentityReadable();
			// spawn is synchronous: the child inherits 077, then the parent immediately restores its mask.
			// No shell shim, executable rewrite, token argv or asynchronous work in this critical section.
			const tree = { ...treeSpawnOptions(options.env), detached: true };
			const mask = process.umask(0o077);
			let child: ReturnType<typeof spawn>;
			try { child = spawn(options.command, options.args, { ...tree, cwd: options.cwd,
				stdio: ["pipe", "pipe", "pipe"] }); }
			finally { process.umask(mask); }
			trackTree(child, true, tree.env[TREE_TOKEN], { requireIdentity: true });
			children.add(child);
			// Never forward raw stderr: it may contain credentials or request content.
			child.stderr!.resume();
			const kill = () => signal(child, "SIGTERM");
			options.signal.addEventListener("abort", kill, { once: true });
			// Keep handles even after close: orphan discovery and sticky failures
			// remain owned until explicit scope cleanup (one query's bounded set).
			child.once("close", () => { options.signal.removeEventListener("abort", kill); });
			if (options.signal.aborted) kill();
			// SDK transport/exit observers also call kill directly. Do not expose
			// ChildProcess.kill, including to delayed callbacks after scope close.
			return {
				stdin: child.stdin!, stdout: child.stdout!,
				get killed() { return child.killed; },
				get exitCode() { return child.exitCode; },
				get signalCode() { return child.signalCode; },
				kill: value => signal(child, value),
				on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
			};
		},
		close: async () => {
			closed = true;
			const owned = [...children];
			for (const child of owned) signal(child, "SIGTERM");
			if (owned.length) await new Promise(resolve => setTimeout(resolve, 100));
			// Revalidate ownership even if TERM closed the leader's pipes meanwhile.
			for (const child of owned) signal(child, "SIGKILL");
			for (const child of owned) {
				try { releaseTree(child); children.delete(child); } catch (error) { cleanupError ??= error; }
			}
			if (cleanupError) throw cleanupError;
		},
	};
}
export async function removePrivateDirectory(dir: string): Promise<void> { await rm(dir, { recursive: true, force: true }); }
