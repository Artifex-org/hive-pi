/**
 * The exec bridge: Cursor's tools, executed by pi's (HIV-2095).
 *
 * Cursor's `Run` is an AGENT api — the loop lives server-side and asks the
 * CLIENT to perform each tool call, then waits for the result inside the same
 * stream. Without an answer the turn stalls silently, which is how the missing
 * `requestContext` handler first presented.
 *
 * # Why pi's tools rather than raw fs/child_process
 *
 * pi exports its tool factories (`createReadTool` and friends), so every call
 * lands on the SAME implementation a pi-driven turn would use — the same
 * truncation limits, the same path handling, the same output shape. Reaching
 * for `fs.readFileSync` here would work and would quietly diverge: a file that
 * read as 2,000 truncated lines under pi would read whole under Cursor, and the
 * two harnesses would stop being comparable.
 *
 * It also keeps one enforcement point. Anything that wraps pi's tools —
 * guards, mutation queues — keeps applying, instead of being bypassed by a
 * second file-writing path nobody remembers exists.
 *
 * # What this does NOT give Cursor
 *
 * pi's EXTENSION tools (`factory_finish`, the hive tools) are not reachable
 * here. Cursor can only call its own native tool set, and pi does not expose a
 * registered extension tool's executable to a provider. Advertising them
 * through `requestContext.tools` as MCP definitions is the path, and it is a
 * separate piece of work — see the note in index.ts about what that means for
 * the factory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The minimum of pi's AgentTool this bridge uses. */
interface RunnableTool {
	execute(id: string, params: unknown, signal?: AbortSignal): Promise<{
		content?: Array<{ type?: string; text?: string }>;
		details?: unknown;
	}>;
}

/** The pi tools one Cursor turn may drive. */
export interface ExecBridge {
	cwd: string;
	read: RunnableTool;
	write: RunnableTool;
	ls: RunnableTool;
	grep: RunnableTool;
	bash: RunnableTool;
}

/**
 * Build the bridge, or return null when pi's tools cannot be resolved.
 *
 * The import is DYNAMIC, and that is not a style choice. This is the only
 * module in the vendored extension set that needs pi at RUNTIME rather than for
 * types — every other one imports `type` only, which the transpiler erases. A
 * static import therefore fails wherever the extension tree has no node_modules
 * of its own, which is exactly how it is vendored into the factory image, and
 * it fails at LOAD time: the whole provider disappears rather than the bridge.
 *
 * Returning null instead degrades to the pre-bridge behaviour — a text
 * generator, still useful for advice and review — and the caller says so once
 * rather than the model discovering it through a stalled tool call.
 */
export async function createExecBridge(cwd: string): Promise<ExecBridge | null> {
	try {
		const pi = (await import("@earendil-works/pi-coding-agent")) as {
			createReadTool(cwd: string): RunnableTool;
			createWriteTool(cwd: string): RunnableTool;
			createLsTool(cwd: string): RunnableTool;
			createGrepTool(cwd: string): RunnableTool;
			createBashTool(cwd: string): RunnableTool;
		};
		return {
			cwd,
			read: pi.createReadTool(cwd),
			write: pi.createWriteTool(cwd),
			ls: pi.createLsTool(cwd),
			grep: pi.createGrepTool(cwd),
			bash: pi.createBashTool(cwd),
		};
	} catch {
		return null;
	}
}

/** Text content out of a pi tool result, joined. */
function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** Resolve a Cursor-supplied path against the workspace. */
function resolve(cwd: string, p: string): string {
	return path.isAbsolute(p) ? p : path.resolve(cwd, p || ".");
}

/**
 * Run one pi tool, reducing both outcomes to data.
 *
 * pi's contract is THROW on failure; Cursor's is a `*Result` with an `error`
 * branch. Letting an exception escape would abandon the stream mid-turn, so
 * every failure becomes a value here and the turn continues — a failed tool
 * call is information the model can act on, not a reason to lose the run.
 */
async function run(
	tool: RunnableTool,
	toolCallId: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<{ ok: true; text: string; details: any } | { ok: false; error: string }> {
	try {
		const result = await tool.execute(toolCallId || "cursor", params as never, signal);
		return { ok: true, text: textOf(result), details: result?.details };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export interface ExecOutcome {
	/** The `execClientMessage` body to send back. */
	message: Record<string, unknown>;
	/**
	 * Frames to send BEFORE `message`, for the one request that is a stream
	 * rather than a call: `shellStreamArgs` expects start/stdout/exit, not a
	 * single result.
	 */
	precedingMessages?: Record<string, unknown>[];
	/** Short label for the caller's progress log, e.g. `read src/a.ts`. */
	label: string;
}

/**
 * How each unimplemented request is refused.
 *
 * The refusal MUST use the result type the request asked for. Answering a
 * `shellStreamArgs` with a `shellResult` is not a rejected request — it is a
 * dropped one, and the turn then waits forever on a result that will never come
 * in the shape it is watching for. MEASURED: exactly that, on a `shellStream`
 * the bridge did not implement; the run died on pi's timeout with no error.
 *
 * Everything here carries the same reason string, because from the model's side
 * the useful information is identical: this capability is absent, re-plan.
 */
const REFUSALS: Record<string, (reason: string) => Record<string, unknown>> = {
	diagnosticsArgs: (error) => ({ diagnosticsResult: { error: { path: "", error } } }),
	fetchArgs: (error) => ({ fetchResult: { error: { url: "", error } } }),
	backgroundShellSpawnArgs: (error) => ({
		backgroundShellSpawnResult: { error: { command: "", workingDirectory: "", error } },
	}),
	listMcpResourcesExecArgs: (error) => ({ listMcpResourcesExecResult: { error: { error } } }),
	readMcpResourceExecArgs: (error) => ({ readMcpResourceExecResult: { error: { error } } }),
	recordScreenArgs: (error) => ({ recordScreenResult: { failure: { error } } }),
	// The natural SECOND half of a streaming shell, which we do implement — so
	// this one is reachable by ordinary model behaviour, not an exotic capability
	// nobody asks for. Dropping it wedged the turn for as long as anyone waited.
	writeShellStdinArgs: (error) => ({ writeShellStdinResult: { error: { error } } }),
	// `actionCount`/`durationMs` are not optional in the message, and a refusal
	// that omits a required scalar is a decode failure — which is a drop again.
	computerUseArgs: (error) => ({
		computerUseResult: { error: { error, actionCount: 0, durationMs: 0 } },
	}),
};

/**
 * The result field each request is answered in.
 *
 * `fooArgs` -> `fooResult` is the protocol's own naming rule, and holding to it
 * mechanically is the point: the whole failure class is answering in the WRONG
 * oneof case, which the server discards in silence. A derived key is at least
 * dispatched; a guessed one never is.
 *
 * `shellStreamArgs` is the single exception — it is a stream, so its terminal
 * frame is `shellStream`, not `shellStreamResult`.
 */
function resultKeyFor(argsKey: string): string {
	if (argsKey === "shellStreamArgs") return "shellStream";
	return `${argsKey.replace(/Args$/, "")}Result`;
}

/**
 * Build the correctly-typed refusal for a request we cannot serve.
 *
 * MEASURED 2026-08-19 (HIV-2216): the old fallback answered any unlisted kind
 * with a failed `shellResult`, and that is what a "large tool result stalls the
 * turn" looks like from the outside. It was never the payload. A big result gets
 * truncated, truncation sends the model to the shell to verify what it could not
 * read, and the extra shell traffic eventually reaches a kind the table does not
 * cover — so the stall correlated with size while being caused by coverage. The
 * correlation was probabilistic and non-monotonic (26 KB stalled, 28 KB did
 * not), which is exactly the signature of a confounder rather than a threshold.
 *
 * So the fallback now answers in the request's OWN result case. An empty result
 * is a poor answer; it is still an answer, and the turn continues.
 */
export function refusalFor(
	exec: Record<string, any>,
	reason: string,
): Record<string, unknown> {
	const key = Object.keys(exec).find((k) => k.endsWith("Args"));
	const build = key ? REFUSALS[key] : undefined;
	if (build) return build(reason);
	if (key === "shellStreamArgs") {
		return { shellStream: { exit: { code: 1, cwd: "", aborted: false } } };
	}
	if (key === "shellArgs" || !key) {
		return {
			shellResult: {
				failure: {
					command: execKind(exec),
					workingDirectory: "",
					exitCode: 1,
					stdout: "",
					stderr: reason,
					aborted: false,
				},
			},
		};
	}
	// An unknown kind. `error: { error }` is the shape every refusal in the table
	// above uses, so it is the best-supported guess for the INNER variant — but
	// the outer case is now derived rather than guessed, which is the half that
	// decides whether the server sees an answer at all.
	return { [resultKeyFor(key)]: { error: { error: reason } } };
}

/**
 * Every request kind `agent.v1.ExecServerMessage` can carry.
 *
 * Transcribed from the generated descriptor (`agent.v1` oneof `ExecServerMessage.args`).
 * It exists so the coverage test can fail when Cursor adds a kind, because the
 * alternative way to discover that is a turn that hangs with no error anywhere.
 */
export const EXEC_REQUEST_KINDS = [
	"backgroundShellSpawnArgs",
	"computerUseArgs",
	"deleteArgs",
	"diagnosticsArgs",
	"fetchArgs",
	"grepArgs",
	"listMcpResourcesExecArgs",
	"lsArgs",
	"mcpArgs",
	"readArgs",
	"readMcpResourceExecArgs",
	"recordScreenArgs",
	"requestContextArgs",
	"shellArgs",
	"shellStreamArgs",
	"writeArgs",
	"writeShellStdinArgs",
] as const;

/** The kinds `handleExec` serves itself. */
export const EXEC_IMPLEMENTED_KINDS = [
	"deleteArgs",
	"grepArgs",
	"lsArgs",
	"readArgs",
	"shellArgs",
	"shellStreamArgs",
	"writeArgs",
] as const;

/** The kinds transport.ts answers before `handleExec` is ever reached. */
export const EXEC_TRANSPORT_KINDS = ["mcpArgs", "requestContextArgs"] as const;

/** The kinds with a hand-written, correctly-typed refusal. */
export function refusedKinds(): string[] {
	return Object.keys(REFUSALS);
}

/**
 * Answer one `execServerMessage`.
 *
 * Returns null when the request is not one we implement — the caller must still
 * reply with SOMETHING, because silence stalls the turn.
 */
export async function handleExec(
	bridge: ExecBridge,
	exec: Record<string, any>,
	signal?: AbortSignal,
): Promise<ExecOutcome | null> {
	const envelope = (body: Record<string, unknown>) => ({
		id: exec.id ?? 0,
		execId: exec.execId ?? "",
		...body,
	});

	// ---- read ---------------------------------------------------------------
	if (exec.readArgs) {
		const a = exec.readArgs;
		const r = await run(bridge.read, a.toolCallId, { path: a.path }, signal);
		if (!r.ok) {
			return {
				label: `read ${a.path} (failed)`,
				message: envelope({ readResult: { error: { path: a.path, error: r.error } } }),
			};
		}
		const lines = r.text ? r.text.split("\n").length : 0;
		return {
			label: `read ${a.path}`,
			message: envelope({
				readResult: {
					success: {
						path: a.path,
						content: r.text,
						totalLines: lines,
						// Reported from what the model actually receives, not from
						// stat(): if pi truncated, the honest size is the size of the
						// text handed over.
						fileSize: Buffer.byteLength(r.text, "utf8"),
						truncated: r.details?.truncation != null,
					},
				},
			}),
		};
	}

	// ---- write --------------------------------------------------------------
	if (exec.writeArgs) {
		const a = exec.writeArgs;
		// Binary writes are refused rather than mangled: fileBytes is base64 and
		// pi's write tool takes text, so "decoding" it would silently corrupt any
		// non-UTF8 payload.
		if (a.fileBytes && !a.fileText) {
			return {
				label: `write ${a.path} (binary refused)`,
				message: envelope({
					writeResult: {
						error: { path: a.path, error: "binary writes are not supported by this bridge" },
					},
				}),
			};
		}
		const content = a.fileText ?? "";
		const r = await run(bridge.write, a.toolCallId, { path: a.path, content }, signal);
		if (!r.ok) {
			return {
				label: `write ${a.path} (failed)`,
				message: envelope({ writeResult: { error: { path: a.path, error: r.error } } }),
			};
		}
		return {
			label: `write ${a.path}`,
			message: envelope({
				writeResult: {
					success: {
						path: a.path,
						linesCreated: content ? content.split("\n").length : 0,
						fileSize: Buffer.byteLength(content, "utf8"),
						...(a.returnFileContentAfterWrite ? { fileContentAfterWrite: content } : {}),
					},
				},
			}),
		};
	}

	// ---- ls -----------------------------------------------------------------
	if (exec.lsArgs) {
		const a = exec.lsArgs;
		const target = a.path || ".";
		const r = await run(bridge.ls, a.toolCallId, { path: target }, signal);
		if (!r.ok) {
			return {
				label: `ls ${target} (failed)`,
				message: envelope({ lsResult: { error: { path: target, error: r.error } } }),
			};
		}
		// Cursor wants a directory TREE; pi's ls returns text. Rather than parse
		// its formatting — which would break the moment pi changes it — read the
		// one directory level directly and let the model ls again to descend.
		// The pi call above still happens, so its guards and limits still apply.
		const abs = resolve(bridge.cwd, target);
		let dirs: string[] = [];
		let files: string[] = [];
		try {
			for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
				(entry.isDirectory() ? dirs : files).push(entry.name);
			}
		} catch (err) {
			return {
				label: `ls ${target} (failed)`,
				message: envelope({
					lsResult: {
						error: { path: target, error: err instanceof Error ? err.message : String(err) },
					},
				}),
			};
		}
		return {
			label: `ls ${target}`,
			message: envelope({
				lsResult: {
					success: {
						directoryTreeRoot: {
							absPath: abs,
							childrenDirs: dirs.map((name) => ({
								absPath: path.join(abs, name),
								childrenDirs: [],
								childrenFiles: [],
								// Explicitly NOT processed: claiming otherwise would tell the
								// model an empty directory has no children.
								childrenWereProcessed: false,
								numFiles: 0,
							})),
							childrenFiles: files.map((name) => ({ name })),
							childrenWereProcessed: true,
							numFiles: files.length,
						},
					},
				},
			}),
		};
	}

	// ---- grep ---------------------------------------------------------------
	if (exec.grepArgs) {
		const a = exec.grepArgs;
		const r = await run(
			bridge.grep,
			a.toolCallId,
			{
				pattern: a.pattern,
				...(a.path ? { path: a.path } : {}),
				...(a.glob ? { glob: a.glob } : {}),
				...(a.caseInsensitive ? { ignoreCase: true } : {}),
				...(typeof a.headLimit === "number" ? { limit: a.headLimit } : {}),
			},
			signal,
		);
		if (!r.ok) {
			return {
				label: `grep ${a.pattern} (failed)`,
				message: envelope({ grepResult: { error: { pattern: a.pattern, error: r.error } } }),
			};
		}
		// Answered in `files` mode regardless of what was asked. pi's grep returns
		// formatted text, and reconstructing per-line match structures from it
		// would be parsing a presentation format — brittle, and wrong in a way the
		// model could not detect. File paths are extractable reliably; a model
		// that needs the matching lines can read the file, which is one more cheap
		// call rather than a plausible-looking fabrication.
		const files = Array.from(
			new Set(
				r.text
					.split("\n")
					.map((line) => line.match(/^([^\s:]+):/)?.[1])
					.filter((f): f is string => !!f),
			),
		);
		return {
			label: `grep ${a.pattern} (${files.length} file${files.length === 1 ? "" : "s"})`,
			message: envelope({
				grepResult: {
					success: {
						pattern: a.pattern,
						path: a.path ?? "",
						outputMode: "files_with_matches",
						workspaceResults: {
							[bridge.cwd]: { files: { files, totalFiles: files.length } },
						},
					},
				},
			}),
		};
	}

	// ---- shell --------------------------------------------------------------
	// ---- shell, streamed ----------------------------------------------------
	// Same ShellArgs as `shellArgs`, but the server is watching for a SEQUENCE of
	// shellStream events rather than one result. Ours is a stream of one: pi's
	// bash tool returns the whole output at once, so the command runs to
	// completion and is then replayed as start / stdout / stderr / exit. The
	// model sees the same thing either way; only the timing differs.
	if (exec.shellStreamArgs) {
		const a = exec.shellStreamArgs;
		const r = await run(
			bridge.bash,
			a.toolCallId,
			{ command: a.command, ...(a.timeout ? { timeout: a.timeout } : {}) },
			signal,
		);
		const cwd = a.workingDirectory || bridge.cwd;
		const before: Record<string, unknown>[] = [
			envelope({
				shellStream: {
					start: { shellId: 1, command: a.command, workingDirectory: cwd },
				},
			}),
		];
		if (r.ok && r.text) {
			before.push(envelope({ shellStream: { stdout: { data: r.text } } }));
		}
		if (!r.ok) {
			before.push(envelope({ shellStream: { stderr: { data: r.error } } }));
		}
		return {
			label: `shell${r.ok ? "" : " (failed)"}: ${String(a.command).slice(0, 60)}`,
			precedingMessages: before,
			message: envelope({
				shellStream: {
					exit: {
						// A tool that threw reported no exit code; 1 is the honest
						// stand-in, where 0 would tell the model the command worked.
						code: r.ok ? (r.details?.exitCode ?? 0) : 1,
						cwd,
						aborted: false,
					},
				},
			}),
		};
	}

	if (exec.shellArgs) {
		const a = exec.shellArgs;
		const r = await run(
			bridge.bash,
			a.toolCallId,
			{ command: a.command, ...(a.timeout ? { timeout: a.timeout } : {}) },
			signal,
		);
		const cwd = a.workingDirectory || bridge.cwd;
		if (!r.ok) {
			return {
				label: `shell (failed): ${String(a.command).slice(0, 60)}`,
				message: envelope({
					shellResult: {
						failure: {
							command: a.command,
							workingDirectory: cwd,
							// A tool that threw did not report an exit code. 1 is the
							// honest stand-in for "did not succeed"; inventing 0 would tell
							// the model the command worked.
							exitCode: 1,
							stdout: "",
							stderr: r.error,
							aborted: false,
						},
					},
				}),
			};
		}
		return {
			label: `shell: ${String(a.command).slice(0, 60)}`,
			message: envelope({
				shellResult: {
					success: {
						command: a.command,
						workingDirectory: cwd,
						exitCode: r.details?.exitCode ?? 0,
						stdout: r.text,
					},
				},
			}),
		};
	}

	// ---- delete -------------------------------------------------------------
	if (exec.deleteArgs) {
		const a = exec.deleteArgs;
		// pi has no delete tool, so this is the one path that touches the
		// filesystem directly. Kept narrow on purpose: a single file, never a
		// directory, and the previous content is returned so the deletion is
		// recoverable from the transcript.
		const abs = resolve(bridge.cwd, a.path);
		try {
			const stat = fs.statSync(abs);
			if (!stat.isFile()) {
				return {
					label: `delete ${a.path} (not a file)`,
					message: envelope({ deleteResult: { notFile: { path: a.path } } }),
				};
			}
			const prev = fs.readFileSync(abs, "utf8");
			fs.unlinkSync(abs);
			return {
				label: `delete ${a.path}`,
				message: envelope({
					deleteResult: {
						success: {
							path: a.path,
							deletedFile: abs,
							fileSize: stat.size,
							prevContent: prev.length > 50_000 ? prev.slice(0, 50_000) : prev,
						},
					},
				}),
			};
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "ENOENT") {
				return {
					label: `delete ${a.path} (missing)`,
					message: envelope({ deleteResult: { fileNotFound: { path: a.path } } }),
				};
			}
			return {
				label: `delete ${a.path} (failed)`,
				message: envelope({
					deleteResult: { error: { path: a.path, error: e.message ?? String(err) } },
				}),
			};
		}
	}

	return null;
}

/** Which exec request this is, for logging and for the refusal message. */
export function execKind(exec: Record<string, any>): string {
	const key = Object.keys(exec).find((k) => k.endsWith("Args"));
	return key ? key.replace(/Args$/, "") : "unknown";
}

/**
 * The capability note handed to Cursor with the workspace description.
 *
 * Cursor's model otherwise discovers the unsupported calls by trying them and
 * receiving a rejection mid-task. Saying so up front costs a few tokens and
 * avoids a wasted turn.
 */
export function capabilityRule(): string {
	return [
		"This session runs through pi's tool implementations.",
		"Supported: read, write (text only), ls, grep (returns matching FILE PATHS,",
		"not matching lines — read the file for content), shell, delete (single file).",
		"Not supported: binary writes, background shells, writeShellStdin,",
		"MCP resources, diagnostics, recordScreen, computerUse.",
		"Prefer workspace-relative paths.",
	].join(" ");
}

/**
 * A bounded directory tree for `requestContext.projectLayouts`.
 *
 * WHY THIS EXISTS. Sending an empty layout leaves Cursor's server-side view of
 * the workspace blank, and the model then cannot locate a file it was told
 * about by name. Observed: asked to edit `greet.py` in a directory containing
 * exactly that file, the model reported "greet.py was not found in the current
 * directory" and fell into a search loop until the turn timed out — while the
 * bridge's own read of the same path succeeded. It never called read, because
 * nothing told it the file was there.
 *
 * Bounded on purpose: a repository walked to full depth would be enormous, and
 * this is sent on every turn. Depth and per-directory width are capped, and the
 * usual heavy directories are skipped — enough for the model to know what
 * exists and use `ls` to go deeper.
 */
const LAYOUT_MAX_DEPTH = 3;
const LAYOUT_MAX_ENTRIES = 200;
const LAYOUT_SKIP = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"target",
	".next",
	".cache",
]);

export interface LayoutNode {
	absPath: string;
	childrenDirs: LayoutNode[];
	childrenFiles: Array<{ name: string }>;
	childrenWereProcessed: boolean;
	numFiles: number;
}

export function projectLayout(root: string, depth = LAYOUT_MAX_DEPTH): LayoutNode {
	const node: LayoutNode = {
		absPath: root,
		childrenDirs: [],
		childrenFiles: [],
		// Truthfully reported: at depth 0 the children are NOT processed, and
		// claiming otherwise would tell the model an unexplored directory is empty.
		childrenWereProcessed: depth > 0,
		numFiles: 0,
	};
	if (depth <= 0) return node;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// An unreadable directory is reported as unprocessed rather than empty.
		node.childrenWereProcessed = false;
		return node;
	}

	let budget = LAYOUT_MAX_ENTRIES;
	for (const entry of entries) {
		if (budget-- <= 0) {
			node.childrenWereProcessed = false;
			break;
		}
		if (entry.name.startsWith(".") && entry.name !== ".hive") continue;
		if (entry.isDirectory()) {
			if (LAYOUT_SKIP.has(entry.name)) continue;
			node.childrenDirs.push(projectLayout(path.join(root, entry.name), depth - 1));
		} else if (entry.isFile()) {
			node.childrenFiles.push({ name: entry.name });
			node.numFiles += 1;
		}
	}
	return node;
}
