/** Trusted launch configuration, access-only admission and ephemeral private state. */
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { accessLease, LOOPBACK_HOSTS, sandboxEgressEnv, type AccessLease } from "./options.ts";
import { SdkProviderError } from "./events.ts";
import { assertTreeIdentityReadable, killTree, releaseTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../hive-common/child-tree.ts";

export const CLI_VERSION = "2.1.286";
export interface LaunchConfig { executable: string; stateRoot: string; url: string; token: string; launch: string; cwd: string; pilot?: boolean; egress?: Record<string, string> }
export function launchConfig(env: NodeJS.ProcessEnv, cwd: string): LaunchConfig | undefined {
	if (env.HIVE_CLAUDE_SDK !== "1") return undefined;
	if (env.HIVE_CLAUDE_SDK_PILOT && !["0", "1"].includes(env.HIVE_CLAUDE_SDK_PILOT)) throw new SdkProviderError("Invalid Claude SDK pilot restriction");
	const { HIVE_CLAUDE_SDK_EXECUTABLE: executable, HIVE_CLAUDE_SDK_STATE_DIR: stateRoot,
		HIVE_URL: url, HIVE_TOKEN: token, HIVE_LAUNCH_ID: launch } = env;
	if (!executable || !stateRoot || !isAbsolute(executable) || !isAbsolute(stateRoot) || !isAbsolute(cwd) ||
		!url || !token || !launch || /[\s\p{Cc}]/u.test(token) || !/^[a-zA-Z0-9_-]+$/.test(launch)) {
		throw new SdkProviderError("Claude SDK requires absolute pinned executable/private state and Hive launch configuration");
	}
	const endpoint = new URL(url);
	if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && LOOPBACK_HOSTS.includes(endpoint.hostname))) {
		throw new SdkProviderError("Claude SDK requires HTTPS Hive URL (or loopback)");
	}
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new SdkProviderError("Invalid Hive URL");
	return { executable, stateRoot, url: url.replace(/\/$/, ""), token, launch, cwd, egress: sandboxEgressEnv(env),
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
		if (!response.ok) throw new SdkProviderError(`Claude SDK launch lease refused (HTTP ${response.status})`);
		let value: unknown;
		try { value = await response.json(); } catch { throw new SdkProviderError("Invalid access-only Claude lease response"); }
		return accessLease(value, Date.now());
	};
}

/** Coalesces concurrent GETs only; no cached authorization across model requests. */
/** The least remaining lease validity a turn may start with. */
export const LEASE_TURN_FLOOR_MS = 60_000;
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
		if (Date.parse(lease.expires_at) - this.now() < LEASE_TURN_FLOOR_MS) throw new SdkProviderError("Claude SDK lease too near expiry; wait for authd renewal");
		if (previous && lease.access_token === previous.access_token && Date.parse(previous.expires_at) <= this.now()) {
			throw new SdkProviderError("Claude SDK lease not renewed; reconciliation required");
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
		throw new SdkProviderError("Claude SDK state root must be an owned, non-symlink 0700 directory");
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
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new SdkProviderError("Unsafe pinned Claude executable");
	await access(config.executable, constants.X_OK);
	const { stdout } = await promisify(execFile)(config.executable, ["--version"], {
		env: { PATH: "/usr/bin:/bin", HOME: config.stateRoot, CLAUDE_CONFIG_DIR: config.stateRoot },
		timeout: 5000, maxBuffer: 4096, signal,
	});
	if (stdout.trim() !== `${CLI_VERSION} (Claude Code)`) throw new SdkProviderError(`Claude SDK requires pinned Claude Code ${CLI_VERSION}`);
}

/** Characters of the CLI's stderr a scope keeps: the tail, for failure diagnostics only. */
export const STDERR_TAIL_CHARS = 4096;
/** How the CLI child ended: `requested` when this scope or the SDK had already signalled it. */
export interface CliExit { code: number | null; signal: string | null; requested: boolean }
/** Raw, unsanitized evidence for a failure diagnostic. Never log or forward it unsanitized. */
export interface ProcessEvidence { stderr: string; exit?: CliExit }
/** How long evidence waits for an unsignalled CLI's exit and stderr to settle. */
export const STDERR_DRAIN_MS = 250;

/** SDK-only strict ownership: Linux readable procfs; never group-only fallback. */
export function processScope(): { spawn: NonNullable<Options["spawnClaudeCodeProcess"]>; close: () => Promise<void>; evidence: () => Promise<ProcessEvidence> } {
	const children = new Set<ReturnType<typeof spawn>>();
	let cleanupError: unknown;
	let closed = false;
	// The SDK's own `stderr` option is only wired to its built-in spawner, not to
	// spawnClaudeCodeProcess, so this scope keeps the tail itself (HIV-3906 follow-up).
	let stderr = "";
	let exit: CliExit | undefined;
	// The latest child, and when both its exit and its stderr close were observed.
	let latest: ReturnType<typeof spawn> | undefined;
	let settled: Promise<unknown> = Promise.resolve();
	let finished = false;
	const signalled = new WeakSet<ReturnType<typeof spawn>>();
	const signal = (child: ReturnType<typeof spawn>, value: NodeJS.Signals) => {
		signalled.add(child);
		try { killTree(child, value, true); return true; }
		catch (error) { cleanupError ??= error; return false; }
	};
	return {
		/**
		 * The stderr tail and exit status. A failing CLI may not have reported its
		 * exit yet, or may still have unread stderr when it does, so unless this
		 * scope or the SDK signalled it, this waits briefly for both, as the SDK's
		 * built-in spawner waits for stderr before reporting an exit.
		 */
		evidence: async () => {
			if (latest && !finished && !signalled.has(latest)) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, STDERR_DRAIN_MS); timer.unref(); })]);
				clearTimeout(timer);
			}
			return { stderr, ...(exit ? { exit: { ...exit } } : {}) };
		},
		spawn: options => {
			if (cleanupError) throw cleanupError;
			if (closed) throw new SdkProviderError("Claude SDK process scope closed");
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
			// Only a bounded tail is kept, for sanitized failure diagnostics.
			child.stderr!.setEncoding("utf8");
			latest = child; finished = false;
			settled = Promise.all([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => child.stderr!.once("close", resolve))])
				.then(() => { if (latest === child) finished = true; });
			child.stderr!.on("data", (chunk: string) => {
				stderr += chunk;
				if (stderr.length > STDERR_TAIL_CHARS) stderr = stderr.slice(-STDERR_TAIL_CHARS);
			});
			child.once("exit", (code, value) => { exit = { code, signal: value, requested: signalled.has(child) }; });
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
