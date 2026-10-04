/**
 * mcp-lazy — a stdio MCP proxy that starts the real server on first use and
 * stops it when idle (HIV-3745).
 *
 * WHY. pi's built-in MCP connects every enabled server when a session starts
 * and keeps it until the session ends; there is no lazy lifecycle. For a stdio
 * server that is a process tree per session whether or not one tool is called.
 * The established remedy (mcp-snooze, lazy-mcp) is a thin proxy between client
 * and server, and this is ours:
 *
 *  - SLEEPING, it answers `initialize`, `ping` and the four discovery lists
 *    (`tools/list`, `prompts/list`, `resources/list`,
 *    `resources/templates/list`) from a cache of the server's last SUCCESSFUL
 *    responses. pi registers the tools at session start from that cache, so
 *    they are visible immediately and nothing has been spawned.
 *  - The first other request (a `tools/call`, a resource read, …) WAKES it:
 *    the real server is spawned in its own process group, the client's
 *    `initialize` and `notifications/initialized` are replayed to it, and the
 *    request is forwarded. Cold cost is the server's own start-up.
 *  - After `idleMs` with nothing in flight, the whole process group is killed
 *    (wrappers such as `bash -c`, `npx`, `uv run` die with their children) and
 *    the proxy goes back to sleep. Server-side session state does not survive
 *    a reap — a stateful server should get a long idle or none (0 = never).
 *  - With no cache yet (first ever run, or after a `list_changed`), it starts
 *    the server and proxies transparently, filling the cache as it goes.
 *
 * Framing is the MCP stdio rule: one JSON-RPC message per line, no embedded
 * newlines. The proxy writes nothing to stdout that is not a message; its own
 * diagnostics, and the server's stderr, go to stderr.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Requests answerable from cache while the server sleeps. */
export const CACHEABLE = ["initialize", "tools/list", "prompts/list", "resources/list", "resources/templates/list"] as const;
type Cacheable = (typeof CACHEABLE)[number];

/** Which cached list a `list_changed` notification invalidates. */
const INVALIDATES: Record<string, Cacheable[]> = {
	"notifications/tools/list_changed": ["tools/list"],
	"notifications/prompts/list_changed": ["prompts/list"],
	"notifications/resources/list_changed": ["resources/list", "resources/templates/list"],
};

type Id = string | number;
interface Message {
	jsonrpc?: "2.0";
	id?: Id | null;
	method?: string;
	params?: Record<string, unknown> & { cursor?: unknown };
	result?: unknown;
	error?: unknown;
}

export interface ProxyOptions {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	cacheDir: string;
	/** Kill the server after this long with nothing in flight. 0 = never. */
	idleMs: number;
	/** Write one line to the client (stdout). */
	send: (line: string) => void;
	/** Diagnostics (stderr). */
	log?: (line: string) => void;
	/** Injectable for tests. */
	spawnServer?: (command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv | undefined) => ChildProcess;
}

interface CacheDoc {
	[method: string]: unknown;
}

export function cacheKey(command: string, args: readonly string[], cwd: string, protocolVersion: string): string {
	return createHash("sha256").update(JSON.stringify([command, args, cwd, protocolVersion])).digest("hex").slice(0, 32);
}

const isRequest = (m: Message) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const isNotification = (m: Message) => typeof m.method === "string" && (m.id === undefined || m.id === null);
const isResponse = (m: Message) => m.method === undefined && m.id !== undefined;

export class LazyProxy {
	private readonly opts: ProxyOptions;
	private child: ChildProcess | null = null;
	private starting: Promise<void> | null = null;
	/** The client's own initialize request, replayed to every (re)started server. */
	private initRequest: Message | null = null;
	private clientInitialized = false;
	private cache: CacheDoc = {};
	private cachePath: string | null = null;
	/** Client request id → method, for requests forwarded to the server. */
	private readonly inflight = new Map<string, string>();
	/** Ids the proxy itself sent to the server (the replayed initialize). */
	private readonly own = new Map<string, (m: Message) => void>();
	private idleTimer: NodeJS.Timeout | null = null;
	private stdoutBuffer = "";
	private nextOwnId = 0;
	private closed = false;

	constructor(opts: ProxyOptions) {
		this.opts = opts;
	}

	get running(): boolean {
		return this.child !== null;
	}

	/** Handle one line from the client. */
	async fromClient(line: string): Promise<void> {
		if (!line.trim()) return;
		let msg: Message;
		try {
			msg = JSON.parse(line) as Message;
		} catch {
			this.log("dropping a client line that is not JSON");
			return;
		}

		if (isResponse(msg)) {
			// An answer to a server-initiated request (sampling, roots, elicitation).
			// Those only exist while the server runs.
			if (this.child) this.toServer(msg);
			return;
		}

		if (isNotification(msg)) {
			if (msg.method === "notifications/initialized") this.clientInitialized = true;
			// Before a server exists there is nobody to tell; the replay on start
			// sends `initialized` itself.
			if (this.child) this.toServer(msg);
			return;
		}

		if (!isRequest(msg)) return;
		const method = msg.method as string;

		if (method === "initialize") {
			this.initRequest = msg;
			this.loadCache(String((msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion ?? ""));
			const cached = this.cache.initialize;
			if (cached && !this.child) {
				this.reply(msg.id as Id, cached);
				return;
			}
			await this.ensureStarted({ replayInitialize: false });
			this.forward(msg);
			return;
		}

		if (method === "ping" && !this.child) {
			this.reply(msg.id as Id, {});
			return;
		}

		// A paginated list request (`cursor`) is not served from cache: the cache
		// holds the first page, and inventing later pages would be a lie.
		if (!this.child && (CACHEABLE as readonly string[]).includes(method) && !msg.params?.cursor) {
			const cached = this.cache[method];
			if (cached !== undefined) {
				this.reply(msg.id as Id, cached);
				return;
			}
		}

		await this.ensureStarted({ replayInitialize: true });
		this.forward(msg);
	}

	/** The client closed stdin: stop the server and finish. */
	close(): void {
		this.closed = true;
		this.clearIdle();
		this.stopServer("client closed");
	}

	// -------------------------------------------------------------------------

	private forward(msg: Message): void {
		this.inflight.set(String(msg.id), msg.method as string);
		this.clearIdle();
		this.toServer(msg);
	}

	private reply(id: Id, result: unknown): void {
		this.opts.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	private toServer(msg: Message): void {
		this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
	}

	private async ensureStarted(opts: { replayInitialize: boolean }): Promise<void> {
		if (this.child) return;
		if (!this.starting) this.starting = this.start(opts).finally(() => (this.starting = null));
		await this.starting;
	}

	private async start(opts: { replayInitialize: boolean }): Promise<void> {
		const spawnServer =
			this.opts.spawnServer ??
			((command, args, cwd, env) =>
				spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"], detached: true }));
		const child = spawnServer(this.opts.command, this.opts.args, this.opts.cwd, this.opts.env);
		this.child = child;
		this.log(`starting ${this.opts.command}`);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.fromServerChunk(chunk));
		child.on("exit", (code, signal) => this.onServerExit(child, code, signal));
		child.on("error", (err) => this.log(`server spawn failed: ${err.message}`));

		if (opts.replayInitialize && this.initRequest) {
			const result = await this.ownRequest({ method: "initialize", params: this.initRequest.params });
			if (result.result !== undefined) this.store("initialize", result.result);
			if (this.clientInitialized) this.toServer({ jsonrpc: "2.0", method: "notifications/initialized" });
		}
	}

	private ownRequest(msg: { method: string; params?: unknown }): Promise<Message> {
		const id = `mcp-lazy-${this.nextOwnId++}`;
		return new Promise((resolve) => {
			this.own.set(id, resolve);
			this.toServer({ jsonrpc: "2.0", id, method: msg.method, params: msg.params as Message["params"] });
		});
	}

	private fromServerChunk(chunk: string): void {
		this.stdoutBuffer += chunk;
		let nl = this.stdoutBuffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			this.fromServer(line);
			nl = this.stdoutBuffer.indexOf("\n");
		}
	}

	private fromServer(line: string): void {
		if (!line.trim()) return;
		let msg: Message;
		try {
			msg = JSON.parse(line) as Message;
		} catch {
			this.log("server wrote a non-JSON line to stdout; dropped");
			return;
		}

		if (isResponse(msg)) {
			const key = String(msg.id);
			const ownWaiter = this.own.get(key);
			if (ownWaiter) {
				this.own.delete(key);
				ownWaiter(msg);
				return;
			}
			const method = this.inflight.get(key);
			this.inflight.delete(key);
			if (method && msg.error === undefined && (CACHEABLE as readonly string[]).includes(method)) {
				// Only a first page is cached; a response that is itself paginated
				// (nextCursor) still describes page one correctly.
				this.store(method as Cacheable, msg.result);
			}
			this.opts.send(line);
			this.armIdle();
			return;
		}

		if (isNotification(msg)) {
			for (const method of INVALIDATES[msg.method as string] ?? []) this.forget(method);
		}
		this.opts.send(line);
	}

	private onServerExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.child !== child) return;
		this.child = null;
		this.stdoutBuffer = "";
		for (const [id, resolve] of this.own) resolve({ id, error: { code: -32000, message: "server exited" } });
		this.own.clear();
		// Requests the server took and never answered must not hang the client.
		for (const id of this.inflight.keys()) {
			this.opts.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: /^\d+$/.test(id) ? Number(id) : id,
					error: { code: -32000, message: `MCP server exited (${signal ?? code}) before answering` },
				}),
			);
		}
		this.inflight.clear();
		this.clearIdle();
		if (!this.closed) this.log(`server exited (${signal ?? code}); sleeping`);
	}

	private stopServer(reason: string): void {
		const child = this.child;
		if (!child?.pid) return;
		this.log(`stopping server: ${reason}`);
		try {
			// detached: true made it a process-group leader; signal the group so
			// `bash -c` / `npx` / `uv run` wrappers die with their children.
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		const pid = child.pid;
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* exited on SIGTERM */
			}
		}, 2_000).unref();
	}

	private armIdle(): void {
		if (this.opts.idleMs <= 0 || this.inflight.size > 0 || !this.child) return;
		this.clearIdle();
		this.idleTimer = setTimeout(() => {
			if (this.inflight.size === 0) this.stopServer(`idle ${Math.round(this.opts.idleMs / 1000)}s`);
		}, this.opts.idleMs);
		this.idleTimer.unref();
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	// -------------------------------------------------------------------------
	// Cache

	private loadCache(protocolVersion: string): void {
		const key = cacheKey(this.opts.command, this.opts.args, this.opts.cwd ?? process.cwd(), protocolVersion);
		this.cachePath = path.join(this.opts.cacheDir, `${key}.json`);
		try {
			const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as CacheDoc;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
	}

	private store(method: Cacheable, result: unknown): void {
		this.cache[method] = result;
		this.persist();
	}

	private forget(method: Cacheable): void {
		if (!(method in this.cache)) return;
		delete this.cache[method];
		this.persist();
	}

	private persist(): void {
		if (!this.cachePath) return;
		try {
			fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
			const tmp = `${this.cachePath}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(this.cache));
			fs.renameSync(tmp, this.cachePath);
		} catch (err) {
			this.log(`cache write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private log(line: string): void {
		this.opts.log?.(`mcp-lazy: ${line}`);
	}
}
