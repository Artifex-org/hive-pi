/**
 * A minimal client for TypeScript 7's native language server — enough for
 * rename and file-move (HIV-1565, HIV-3816).
 *
 * `lens/` is deliberately regex-based and its README says so: no bundled LSP
 * infra, no grammar downloads, no session-start cost. What it also names is the
 * sanctioned escape hatch — real reference resolution belongs in an explicit
 * LSP-backed tool — and rename/move IS that case: a symbol's references are a
 * graph fact, and with a barrel re-export the file that must change does not
 * contain the name in a form grep can match.
 *
 * The shape: talk to the TARGET PROJECT'S OWN TypeScript, spawned per call and
 * killed after. Zero dependencies in hive-pi, no daemon, no state directory, and
 * the project's own compiler — the one its CI runs — is the one that answers.
 *
 * Why TypeScript 7 only. This used to drive `node_modules/typescript/bin/tsserver`.
 * TypeScript 7 ships no tsserver at all: it is a native binary that speaks LSP
 * (`<exe> --lsp --stdio`). pyERP pins 7.0.2 at its root and its largest
 * frontend has no TypeScript of its own, so the tsserver client refused there.
 * Measured 2026-10-06 on that frontend, renaming one hook: the native server
 * returned 28 files / 59 edits in 2.7 s at 2.0 GiB peak RSS; tsserver 5.9 gave
 * the identical edit set in 23.4 s at 2.9 GiB. There is no tsserver fallback,
 * by decision: a 5.x install is skipped while walking up, and a tree with only
 * 5.x gets a refusal that says so.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One request's patience. A cold server on a large project is the slow case. */
const REQUEST_TIMEOUT_MS = 120_000;

/** The first TypeScript major that ships the native language server. */
export const NATIVE_TS_MAJOR = 7;

export type ServerLookup =
	| { ok: true; exe: string; root: string; version: string }
	| { ok: false; reason: string };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readVersion(packageJson: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function majorOf(version: string): number {
	const major = Number.parseInt(version, 10);
	return Number.isFinite(major) ? major : 0;
}

/**
 * The platform binary for a TypeScript 7 install.
 *
 * Mirrors the installed-package branch of TypeScript's own
 * `lib/getExePath.js`: the binary lives in the optional dependency
 * `@typescript/typescript-<platform>-<arch>`, resolved FROM the typescript
 * package, at `lib/tsc`. Mirrored rather than imported, so resolving a binary
 * never executes the target project's JavaScript inside the agent's process.
 */
export function nativeExeFor(typescriptDir: string, version: string): ServerLookup {
	const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
	let packageJson: string;
	try {
		// From the REAL path, as getExePath's `import.meta.url` does: under pnpm's
		// isolated layout `node_modules/typescript` is a symlink into `.pnpm/`, and
		// the platform package sits beside the real directory, not the link.
		packageJson = createRequire(join(realpathSync(typescriptDir), "package.json")).resolve(`${platformPackage}/package.json`);
	} catch {
		return {
			ok: false,
			reason:
				`TypeScript ${version} at ${typescriptDir} has no \`${platformPackage}\` beside it — the package that ` +
				"carries its native binary. Reinstall the project's dependencies without omitting optional ones.",
		};
	}
	const exe = join(dirname(packageJson), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
	if (!existsSync(exe)) {
		return { ok: false, reason: `TypeScript ${version}'s native binary is missing: ${exe} does not exist.` };
	}
	return { ok: true, exe, root: dirname(dirname(typescriptDir)), version };
}

/**
 * Find the TypeScript 7 language server that belongs to the project containing
 * `startPath`.
 *
 * Walks up from the file, not from cwd, to the NEAREST `node_modules/typescript`
 * whose major is >= 7. Older installs are skipped, not stopped at: in pyERP the
 * storefront and mobile app each carry a local 5.9.3 while the repo root has
 * 7.0.2, and the root's native server handles their tsconfigs. What was skipped
 * is remembered, so a tree with only 5.x is refused with the version it found
 * rather than with "nothing found".
 */
export function findNativeServer(startPath: string, stopAt?: string): ServerLookup {
	let dir = resolve(startPath);
	if (existsSync(dir) && !isDirectory(dir)) dir = dirname(dir);
	const ceiling = stopAt ? resolve(stopAt) : null;
	const skipped: string[] = [];
	for (;;) {
		const typescriptDir = join(dir, "node_modules", "typescript");
		const version = readVersion(join(typescriptDir, "package.json"));
		if (version !== null) {
			if (majorOf(version) >= NATIVE_TS_MAJOR) return nativeExeFor(typescriptDir, version);
			skipped.push(`TypeScript ${version} at ${typescriptDir}`);
		}
		const parent = dirname(dir);
		if ((ceiling && dir === ceiling) || parent === dir) break;
		dir = parent;
	}
	const found =
		skipped.length > 0
			? `Found only ${skipped.join("; ")} — older than ${NATIVE_TS_MAJOR}, which has no native language server.`
			: "Found no `node_modules/typescript` in it or any parent directory.";
	return {
		ok: false,
		reason: `No TypeScript ${NATIVE_TS_MAJOR}+ install found above ${startPath}. ${found}`,
	};
}

// ── The protocol ─────────────────────────────────────────────────────────────

/** LSP positions: 0-based line, 0-based UTF-16 code-unit character. */
export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

/**
 * The two shapes a WorkspaceEdit takes, and the server uses both: measured,
 * `textDocument/rename` answers with `changes` even when the client advertises
 * `documentChanges`, while `workspace/willRenameFiles` answers with
 * `documentChanges` (each `version: null`).
 */
export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: (
		| { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
		| { kind: string; uri?: string; oldUri?: string; newUri?: string }
	)[];
}

export class LspError extends Error {
	readonly code: number;
	constructor(message: string, code: number) {
		super(message);
		this.code = code;
	}
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface Message {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

/**
 * Parse every complete `Content-Length` frame at the front of `buffer`.
 *
 * Bytes, not characters: Content-Length counts UTF-8 bytes, and a body with
 * non-ASCII text is shorter in characters than in bytes. Framing over a string
 * cuts such a body short and the next header lands mid-JSON.
 */
export function readFrames(buffer: Buffer): { messages: Message[]; rest: Buffer } {
	const messages: Message[] = [];
	let rest = buffer;
	for (;;) {
		const headerEnd = rest.indexOf("\r\n\r\n");
		if (headerEnd < 0) break;
		const match = /Content-Length: *(\d+)/i.exec(rest.subarray(0, headerEnd).toString("ascii"));
		if (!match) {
			// An unparseable header: drop it rather than spin on it forever.
			rest = rest.subarray(headerEnd + 4);
			continue;
		}
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (rest.length < bodyStart + length) break;
		const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
		rest = rest.subarray(bodyStart + length);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue; // a malformed body answers nothing; a pending request times out honestly
		}
		// `null`, an array, a number: valid JSON, not a message.
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) messages.push(parsed as Message);
	}
	return { messages, rest };
}

export function frame(message: Message): string {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/**
 * Rename preferences, sent once after `initialized`.
 *
 * `useAliasesForRenames: false` is the load-bearing one. The server's default
 * (true) answers a rename at a declaration by rewriting the barrel to
 * `export { newName as oldName }` — the public name survives and no importer
 * changes, which is the opposite of what `rename_symbol` promises. Off, the
 * rename propagates through re-exports to every importer, and the edit set is
 * identical to what tsserver 5.9 returned with no preferences (measured on a
 * fixture with a barrel and a shorthand property), so callers keep the
 * behaviour they had.
 */
const SETTINGS = { typescript: { preferences: { useAliasesForRenames: false } } };

const BOM = "\uFEFF";

/** Text without a leading byte-order mark — how the server sees every file. */
export function stripBom(text: string): string {
	return text.startsWith(BOM) ? text.slice(1) : text;
}

/** `languageId` for `didOpen`, by extension. */
export function languageIdFor(file: string): string {
	switch (extname(file).toLowerCase()) {
		case ".tsx":
			return "typescriptreact";
		case ".jsx":
			return "javascriptreact";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		default:
			return "typescript";
	}
}

/**
 * One native language server. One per tool call: start, open, ask, dispose.
 *
 * Deliberately not a long-lived daemon. A daemon would be faster on the second
 * call and would reintroduce exactly what dropping pi-lens removed — a
 * background process holding state (2 GiB of it, here), surviving turns, and
 * failing invisibly.
 */
export class NativeServer {
	private proc: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private buffer: Buffer = Buffer.alloc(0);
	private pending = new Map<number, Pending>();
	private exited: Error | null = null;

	private constructor(exe: string, root: string) {
		this.proc = spawn(exe, ["--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], shell: false });
		// EVERY handler below is a place where a throw becomes an uncaughtException
		// and takes the whole agent down with it — the failure that removed
		// pi-lens. So each one turns a problem into `fail`, which rejects the
		// outstanding requests: a broken server is a failed tool call, never a
		// dead session.
		this.proc.stdout.on("data", (chunk: Buffer) => {
			try {
				this.consume(chunk);
			} catch (error) {
				this.fail(new Error(`the TypeScript language server sent something this client could not handle: ${(error as Error).message}`));
				this.dispose();
			}
		});
		this.proc.on("error", (error) => this.fail(new Error(`could not start the TypeScript language server: ${error.message}`)));
		this.proc.on("exit", (code, signal) =>
			this.fail(new Error(`the TypeScript language server exited (${signal ?? `code ${code}`})`)),
		);
		// A write to a server that has exited, or was killed mid-request, fails
		// as an EPIPE `error` on stdin.
		this.proc.stdin.on("error", (error) => this.fail(new Error(`the TypeScript language server's input closed: ${error.message}`)));
		this.proc.stdout.on("error", (error) => this.fail(new Error(`the TypeScript language server's output failed: ${error.message}`)));
		this.proc.stderr.on("error", () => undefined);
		// The server logs to stderr; draining it keeps a full pipe from blocking it.
		this.proc.stderr.resume();
	}

	private fail(error: Error): void {
		if (!this.exited) this.exited = error;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	/** Spawn, `initialize`, `initialized`, and send the rename preferences. */
	static async start(exe: string, root: string): Promise<NativeServer> {
		const server = new NativeServer(exe, root);
		try {
			const rootUri = pathToFileURL(root).href;
			await server.request("initialize", {
				processId: process.pid,
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: root }],
				capabilities: {
					workspace: {
						workspaceEdit: { documentChanges: true },
						fileOperations: { willRename: true },
					},
					textDocument: { rename: { prepareSupport: true } },
				},
			});
			server.notify("initialized", {});
			server.notify("workspace/didChangeConfiguration", { settings: SETTINGS });
			return server;
		} catch (error) {
			server.dispose();
			throw error;
		}
	}

	private consume(chunk: Buffer): void {
		const { messages, rest } = readFrames(Buffer.concat([this.buffer, chunk]));
		this.buffer = rest;
		for (const message of messages) this.dispatch(message);
	}

	private dispatch(message: Message): void {
		if (message.method !== undefined) {
			// A request FROM the server must be answered or it can stall waiting.
			// Notifications (logMessage, publishDiagnostics) need nothing.
			if (message.id !== undefined) this.answer(message);
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new LspError(message.error.message, message.error.code));
		else pending.resolve(message.result ?? null);
	}

	private answer(message: Message): void {
		// Called from a stdout handler: a throw here would be uncaught.
		if (this.exited) return;
		const id = message.id as number | string;
		switch (message.method) {
			case "workspace/configuration": {
				const raw = (message.params as { items?: unknown } | null | undefined)?.items;
				const items = (Array.isArray(raw) ? raw : []).map((item: unknown) =>
					(item as { section?: unknown } | null)?.section === "typescript" ? SETTINGS.typescript : null,
				);
				this.write({ id, result: items });
				return;
			}
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
				this.write({ id, result: null });
				return;
			default:
				this.write({ id, error: { code: -32601, message: `${message.method} is not supported by this client` } });
		}
	}

	private write(message: Message): void {
		if (this.exited) throw this.exited;
		this.proc.stdin.write(frame(message));
	}

	notify(method: string, params: unknown): void {
		this.write({ method, params });
	}

	request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.exited) return Promise.reject(this.exited);
		const id = this.nextId++;
		return new Promise<T>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`the TypeScript language server did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer });
			this.write({ id, method, params });
		});
	}

	/** Open `file` from disk, so the server loads the project that contains it. */
	open(file: string): void {
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: pathToFileURL(file).href,
				languageId: languageIdFor(file),
				version: 1,
				// Without a byte-order mark: the server drops one when it reads a file
				// from disk, so sending it here would shift every position on line 0
				// by one against the files it reads itself.
				text: stripBom(readFileSync(file, "utf8")),
			},
		});
	}

	dispose(): void {
		// Retire requests synchronously: a reply can arrive before the child's
		// exit event, even after SIGTERM was sent, and must not win that race.
		this.fail(new Error("the TypeScript language server was disposed"));
		try {
			this.proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

// ── The two questions this client asks ───────────────────────────────────────

export type RenameAnswer =
	| { ok: true; name: string; edit: WorkspaceEdit }
	| { ok: false; reason: string };

function containsPosition(range: Range, position: Position): boolean {
	const afterStart =
		position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
	const beforeEnd =
		position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
	return afterStart && beforeEnd;
}

/** 1-based "line:column" for a 0-based LSP position — the form the tools take. */
function oneBased(position: Position): string {
	return `${position.line + 1}:${position.character + 1}`;
}

/**
 * Ask for a rename's edits. Does not apply them.
 *
 * `prepareRename` first, for two reasons. It names the symbol, so the report
 * says what was renamed. And it says WHICH symbol: the server snaps a position
 * that is not on an identifier to a nearby one — measured, the `import` keyword
 * of `import { helper } from …` resolves to `helper`. A rename the caller did
 * not point at is refused with the identifier's exact position, so a retry is
 * one call, rather than written.
 */
export async function requestRename(
	server: NativeServer,
	file: string,
	position: Position,
	newName: string,
): Promise<RenameAnswer> {
	const textDocument = { uri: pathToFileURL(file).href };
	let prepared: { range?: Range; placeholder?: string; start?: Position } | null;
	try {
		prepared = await server.request("textDocument/prepareRename", { textDocument, position });
	} catch (error) {
		if (error instanceof LspError) return { ok: false, reason: `Cannot rename at ${oneBased(position)}: ${error.message}` };
		throw error;
	}
	if (!prepared) return { ok: false, reason: `Cannot rename at ${oneBased(position)}: no renameable symbol there.` };
	// prepareRename may answer a bare Range, or {range, placeholder}.
	const range: Range | undefined = prepared.range ?? (prepared.start ? (prepared as Range) : undefined);
	const name = prepared.placeholder ?? "symbol";
	if (range && !containsPosition(range, position)) {
		return {
			ok: false,
			reason:
				`Position ${oneBased(position)} is not on an identifier; the nearest renameable symbol is \`${name}\` at ` +
				`${oneBased(range.start)}. Nothing was renamed — call again with that line and offset if \`${name}\` is the one.`,
		};
	}
	const edit = await server.request<WorkspaceEdit | null>("textDocument/rename", { textDocument, position, newName });
	if (!edit) return { ok: false, reason: `The language server found nothing to rename at ${oneBased(position)}.` };
	return { ok: true, name, edit };
}

/**
 * Ask for the edits a file move needs. Does not apply them or move anything.
 *
 * Asked BEFORE moving — the only order that works: afterwards the old path no
 * longer resolves and the server computes nothing, which reads as "no
 * importers". The answer includes edits to the moved file ITSELF (its own
 * relative imports, keyed by its old path) as well as to every importer.
 */
export async function requestFileMove(server: NativeServer, from: string, to: string): Promise<WorkspaceEdit | null> {
	return await server.request<WorkspaceEdit | null>("workspace/willRenameFiles", {
		files: [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }],
	});
}
