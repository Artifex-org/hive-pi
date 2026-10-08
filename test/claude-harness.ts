/**
 * Test harness for the Claude adapter (`claude/`): a launch's environment
 * built in a temp dir, so the CLI is exercised end to end as the plugin runs
 * it — `node claude/cli.ts <command>` with JSON on stdin.
 *
 *  - A fake PINNED pi: a package named `@earendil-works/pi-coding-agent`
 *    whose public entry re-exports the real one from this checkout's
 *    node_modules (so `pi-runtime.ts` finds pi's own parser and serializer
 *    exactly as on a node), and whose `bin/pi` is a scriptable fake. The fake
 *    logs its argv, env and any `@file` contents, and answers with the first
 *    scripted reply whose `match` substring appears in its input.
 *  - A leased store (`auth.json` with the given providers), a state dir, a
 *    spool path.
 *  - A fake Hive: `/api/v1/agent-modes`, `/agent-sessions/by-run/{id}`,
 *    `/activity`, `/you-should-know/findings`, `/surfaces/…`,
 *    `/resources/dev-server`, `/flow-runs/…`, recording every request.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO, "claude", "cli.ts");

export interface FakeReply {
	/** Substring of the child's prompt (argv + @file contents). */
	match: string;
	text: string;
	/** Exit code; default 0. */
	exit?: number;
	/** Delay before answering, ms. */
	delayMs?: number;
}

export interface LaunchEnv {
	root: string;
	piBin: string;
	agentDir: string;
	configDir: string;
	stateDir: string;
	spool: string;
	piLog: string;
	script: string;
	env: Record<string, string>;
	setReplies(replies: FakeReply[]): void;
	/** Every fake-pi invocation so far. */
	calls(): { argv: string[]; input: string; stdin: string; pid: number; agentDir: string | undefined; worker: string | undefined }[];
	spoolRecords(): Record<string, unknown>[];
	writeControl(control: unknown): void;
}

const FAKE_PI = (log: string, script: string) => `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = argv.join(" ");
// One-shots send their prompt on stdin (never argv); workers get /dev/null.
const stdin = fs.readFileSync(0, "utf8");
if (stdin) input += "\\n" + stdin;
for (const a of argv) if (a.startsWith("@")) input += "\\n" + fs.readFileSync(a.slice(1), "utf8");
const at = argv.indexOf("--append-system-prompt");
if (at >= 0 && fs.existsSync(argv[at + 1])) input += "\\n" + fs.readFileSync(argv[at + 1], "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, input, stdin, pid: process.pid, agentDir: process.env.PI_CODING_AGENT_DIR, worker: process.env.PI_AGENDA_WORKER }) + "\\n");
const replies = fs.existsSync(${JSON.stringify(script)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(script)}, "utf8")) : [];
const reply = replies.find((r) => input.includes(r.match)) ?? { text: "ok" };
setTimeout(() => {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "zai", model: "glm-low", stopReason: "stop",
		content: [{ type: "text", text: reply.text }],
		usage: { input: 100, output: 20, cacheRead: 3, cacheWrite: 0, totalTokens: 123, cost: { total: 0.0015 } } } }));
	process.exit(reply.exit ?? 0);
}, reply.delayMs ?? 0);
`;

export function makeLaunch(options: { providers?: string[] } = {}): LaunchEnv {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-claude-"));
	const pkg = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(pkg, "bin"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./index.mjs" } } }));
	const realEntry = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
	writeFileSync(join(pkg, "index.mjs"), `export * from ${JSON.stringify(pathToFileURL(realEntry).href)};\n`);
	const piLog = join(root, "pi-calls.jsonl");
	const script = join(root, "pi-replies.json");
	const piBin = join(pkg, "bin", "pi");
	writeFileSync(piBin, FAKE_PI(piLog, script));
	chmodSync(piBin, 0o755);

	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const auth: Record<string, unknown> = {};
	for (const provider of options.providers ?? ["zai"]) auth[provider] = { type: "api_key", key: "test-key" };
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	const configDir = join(root, "claude-config");
	const stateDir = join(configDir, "hive-pi");
	mkdirSync(stateDir, { recursive: true });
	const spool = join(root, "aux-spool.jsonl");

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: root,
		HIVE_PI_BIN: piBin,
		HIVE_PI_AGENT_DIR: agentDir,
		HIVE_PI_BASE: REPO,
		HIVE_CLAUDE_CONFIG_DIR: configDir,
		HIVE_AUX_SPOOL: spool,
		HIVE_SESSION_ID: "run-123",
		HIVE_LAUNCH_ID: "launch-1",
	};
	const readJsonl = (path: string) =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	return {
		root,
		piBin,
		agentDir,
		configDir,
		stateDir,
		spool,
		piLog,
		script,
		env,
		setReplies: (replies) => writeFileSync(script, JSON.stringify(replies)),
		calls: () => readJsonl(piLog) as ReturnType<LaunchEnv["calls"]>,
		spoolRecords: () => readJsonl(spool),
		writeControl: (control) => writeFileSync(join(stateDir, "control.json"), JSON.stringify(control)),
	};
}

export interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run the CLI with `stdin`, as the plugin does. */
export function runCli(args: string[], env: Record<string, string>, stdin = "", cwd = REPO, nodeArgs: string[] = []): Promise<CliResult> {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", fail);
		child.on("close", (code) => done({ code, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

export interface FakeHive {
	url: string;
	requests: { method: string; path: string; body: unknown; auth: string | undefined }[];
	modes: { key: string; model: string; thinking?: string }[];
	/** null → by-run answers 404 (session not attached). */
	sessionId: string | null;
	recording: { recording: boolean; recording_revision: number };
	/** null → `/flow-runs/claim` answers 404 (unsupported); else each claim takes every queued item. */
	flowClaims: unknown[] | null;
	close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const bytes = Buffer.concat(chunks);
	// A surface snapshot is an image; it is recorded by type and size.
	const type = req.headers["content-type"] ?? "";
	if (bytes.length > 0 && type.startsWith("image/")) return { contentType: type, bytes: bytes.length };
	const text = bytes.toString("utf8");
	return text ? (JSON.parse(text) as unknown) : undefined;
}

export async function startFakeHive(): Promise<FakeHive> {
	const hive: FakeHive = {
		url: "",
		requests: [],
		modes: [
			{ key: "high", model: "openai-codex/gpt-top", thinking: "high" },
			{ key: "mid", model: "zai/glm-mid", thinking: "medium" },
			{ key: "low", model: "zai/glm-low", thinking: "minimal" },
		],
		sessionId: "srv-uuid-1",
		recording: { recording: true, recording_revision: 2 },
		flowClaims: null,
		close: async () => {},
	};
	const server: Server = createServer((req, res) => {
		void (async () => {
			const body = await bodyOf(req);
			const path = req.url ?? "";
			hive.requests.push({ method: req.method ?? "", path, body, auth: req.headers.authorization });
			const json = (status: number, payload: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (path === "/api/v1/agent-modes") return json(200, { version: "1", modes: hive.modes });
			if (path.startsWith("/api/v1/agent-sessions/by-run/")) {
				return hive.sessionId ? json(200, { id: hive.sessionId }) : json(404, { error: "not found" });
			}
			if (path.endsWith("/activity")) return json(200, {});
			if (path.includes("/surfaces/")) return json(200, {});
			if (path.endsWith("/resources/dev-server")) return json(200, {});
			if (path.endsWith("/flow-runs/claim") && hive.flowClaims) return json(200, { items: hive.flowClaims.splice(0) });
			if (/\/flow-runs\/[^/]+\/complete$/.test(path)) return json(200, {});
			if (path.endsWith("/you-should-know/findings")) {
				const findings = req.method === "POST" ? ((body as { findings?: { id: string }[] }).findings ?? []).map((f) => ({ id: f.id, deliveries: [{ destination: "board", state: "delivered" }] })) : [];
				return json(200, { version: 1, ...hive.recording, findings });
			}
			json(404, { error: "no route" });
		})();
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake hive has no port");
	hive.url = `http://127.0.0.1:${address.port}`;
	hive.close = () => new Promise((closed) => server.close(() => closed()));
	return hive;
}

/** A Claude transcript (JSONL) with the given turns, written to `path`. */
export function writeTranscript(path: string, turns: ({ user: string } | { assistant: string; id?: string })[]): string {
	const lines = turns.map((turn, i) =>
		"user" in turn
			? { type: "user", uuid: `u-${i}`, message: { role: "user", content: turn.user } }
			: {
					type: "assistant",
					uuid: turn.id ?? `a-${i}`,
					message: { id: `msg-${i}`, role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: turn.assistant }] },
				},
	);
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return path;
}

export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface Rpc {
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/** The adapter's `mcp` command, driven over its real stdio transport. */
export class McpClient {
	readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, (message: Rpc) => void>();
	private nextId = 1;
	stderr = "";
	readonly exited: Promise<number | null>;

	constructor(env: Record<string, string>, cwd = REPO) {
		this.child = spawn(process.execPath, [CLI, "mcp"], { cwd, env });
		this.child.stderr.on("data", (d: Buffer) => {
			this.stderr += d.toString();
		});
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			const message = JSON.parse(line) as Rpc;
			if (message.id !== undefined) this.pending.get(message.id)?.(message);
		});
		this.exited = new Promise((done) => this.child.on("close", (code) => done(code)));
	}

	request(method: string, params: unknown = {}): Promise<Rpc> {
		return this.send(method, params).answer;
	}

	/** A request and its id — to cancel it (`notifications/cancelled`), which leaves it unanswered. */
	send(method: string, params: unknown = {}): { id: number; answer: Promise<Rpc> } {
		const id = this.nextId++;
		const answer = new Promise<Rpc>((done) => this.pending.set(id, done));
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return { id, answer };
	}

	notify(method: string, params: unknown = {}): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	/** A tool call: its text block, every content block, and whether it is an error. */
	async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; content: McpContent[] }> {
		const message = await this.request("tools/call", { name, arguments: args });
		if (message.error) throw new Error(message.error.message);
		const content = message.result?.content as McpContent[];
		return { text: content.find((block) => block.type === "text")?.text ?? "", isError: message.result?.isError === true, content };
	}

	close(): Promise<number | null> {
		this.child.stdin.end();
		return this.exited;
	}
}
