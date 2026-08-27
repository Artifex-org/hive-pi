/**
 * A minimal tsserver client — enough for rename and file-move (HIV-1565).
 *
 * `lens/` is deliberately regex-based and its README says so: no bundled LSP
 * infra, no grammar downloads, no 4-6s session-start cost. That decision is not
 * being reversed here. What it also says is the sanctioned escape hatch —
 * "if we later need real reference resolution the answer is an LSP or ast-grep
 * as an explicit tool, not a larger regex here" — and rename IS that case, for
 * a reason a regex can never reach: a symbol's references are a graph fact, and
 * a barrel re-export means the file that must change does not contain the name.
 *
 * The shape that honours both: talk to the TARGET PROJECT'S OWN tsserver
 * (`node_modules/.bin/tsserver`), spawned per call and killed after. Zero new
 * dependencies in hive-pi, no daemon, no state directory, and the project's
 * own TypeScript version — the one its CI uses — is the one that answers.
 * When a project has no local tsserver, that is a clean refusal, not a
 * fallback to something weaker.
 *
 * Protocol note: tsserver's stdio protocol is asymmetric, and getting this
 * wrong looks like a hang. Requests are ONE LINE of JSON. Responses are
 * `Content-Length: N\r\n\r\n<body>` framed, and the stream carries unsolicited
 * `event` messages interleaved with responses, so a reader that assumes the
 * next message answers its request will read a `typingsInstallerPid` event as
 * a rename result.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** One request's patience. A cold tsserver on a large project is the slow case. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Time allowed for the project to load before the first real request. */
const PROJECT_LOAD_MS = 30_000;

export interface TextSpan {
	start: { line: number; offset: number };
	end: { line: number; offset: number };
}

export interface FileEdits {
	file: string;
	edits: { start: { line: number; offset: number }; end: { line: number; offset: number }; newText: string }[];
}

/**
 * Find the tsserver that belongs to the project containing `file`.
 *
 * Walks up from the file, not from cwd: a monorepo has a tsserver per package
 * and the nearest one is the one whose TypeScript version and settings match
 * the file being edited.
 */
export function findTsserver(startPath: string, stopAt?: string): string | null {
	let dir = resolve(startPath);
	// A file path starts at its directory; a directory starts at itself.
	if (existsSync(dir) && !isDirectory(dir)) dir = dirname(dir);
	const ceiling = stopAt ? resolve(stopAt) : null;
	for (;;) {
		const candidate = join(dir, "node_modules", "typescript", "bin", "tsserver");
		if (existsSync(candidate)) return candidate;
		if (ceiling && dir === ceiling) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function isDirectory(path: string): boolean {
	try {
		// Cheap and sync on purpose — this runs once per tool call, not per event.
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

interface PendingRequest {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A tsserver session. One per tool call: `open` the files, ask, `close`, kill.
 *
 * Deliberately not a long-lived daemon. A daemon would be faster on the second
 * call and would reintroduce exactly what dropping pi-lens removed — a
 * background process holding state, surviving turns, and failing invisibly.
 */
export class TsServer {
	private proc: ChildProcessWithoutNullStreams;
	private seq = 1;
	private buffer = "";
	private pending = new Map<number, PendingRequest>();
	private exited: Error | null = null;

	constructor(tsserverPath: string, cwd: string) {
		this.proc = spawn(process.execPath, [tsserverPath, "--disableAutomaticTypingAcquisition"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => this.consume(chunk));
		this.proc.on("exit", (code) => {
			this.exited = new Error(`tsserver exited with code ${code}`);
			for (const [, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(this.exited);
			}
			this.pending.clear();
		});
		// stderr is noise unless something breaks; draining it prevents a full
		// pipe from blocking the child.
		this.proc.stderr.resume();
	}

	/**
	 * Frame responses. Two things make this less trivial than it looks: a body
	 * can straddle chunks, and `event` messages arrive unsolicited between
	 * responses — so dispatch is by `request_seq`, never by arrival order.
	 */
	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.slice(0, headerEnd);
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) {
				// Unparseable header: drop it rather than spin forever on it.
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			// Content-Length counts BYTES; a body with non-ASCII is shorter in
			// characters than in bytes, so measure the way the sender did.
			const available = Buffer.byteLength(this.buffer.slice(bodyStart), "utf8");
			if (available < length) return;
			const bodyBuf = Buffer.from(this.buffer.slice(bodyStart), "utf8").subarray(0, length);
			const body = bodyBuf.toString("utf8");
			this.buffer = Buffer.from(this.buffer.slice(bodyStart), "utf8").subarray(length).toString("utf8");
			this.dispatch(body);
		}
	}

	private dispatch(body: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(body);
		} catch {
			return;
		}
		if (message.type !== "response") return;
		const seq = message.request_seq as number;
		const pending = this.pending.get(seq);
		if (!pending) return;
		this.pending.delete(seq);
		clearTimeout(pending.timer);
		pending.resolve(message);
	}

	/** Fire-and-forget commands (`open`, `close`) that produce no response. */
	notify(command: string, args: Record<string, unknown>): void {
		if (this.exited) throw this.exited;
		this.proc.stdin.write(`${JSON.stringify({ seq: this.seq++, type: "request", command, arguments: args })}\n`);
	}

	request(command: string, args: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
		if (this.exited) return Promise.reject(this.exited);
		const seq = this.seq++;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`tsserver did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(seq, { resolve: resolvePromise, reject, timer });
			this.proc.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
		});
	}

	dispose(): void {
		try {
			this.proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

/** Give the project a moment to load before asking about references. Asking
 *  too early returns a correct-looking answer over a partial program. */
export async function waitForProjectLoad(server: TsServer, file: string): Promise<void> {
	server.notify("open", { file });
	// `projectInfo` needs the project, so it doubles as a readiness probe.
	await server.request("projectInfo", { file, needFileNameList: false }, PROJECT_LOAD_MS).catch(() => undefined);
}
