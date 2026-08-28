import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { diagnose, explain } from "./edit-common/diagnose.ts";
import { repairBashCwd } from "./toolcwd/cwd.ts";
import { appendHint } from "./toolhints/index.ts";
import { describeMissingFile } from "./lens/locate.ts";
import { HIVE_STDIN_WAIT_CHANNEL, type HiveStdinWaitEvent } from "./hive-common/channels.ts";
import { blockedNote, ptyAvailable, ptyBashOperations } from "./pty-exec/ops.ts";
import type { BlockedVerdict } from "./pty-exec/stdinWatch.ts";
import { TerminalSurfaceBridge } from "./pty-exec/terminalSurface.ts";

const PREVIEW_LINES = 4;

/**
 * The launch's terminal surface, created once and shared by every command.
 *
 * Lazily, and at most once: a human's attachment must outlive any single
 * command, and starting a bridge per call would tear down the lease between
 * them. Null when the launch published no surface — an interactive session, or
 * the factory lane.
 */
let surfaceBridge: TerminalSurfaceBridge | null | undefined;

function terminalSurface(): TerminalSurfaceBridge | null {
	if (surfaceBridge === undefined) surfaceBridge = TerminalSurfaceBridge.start();
	return surfaceBridge;
}

/** Test seam: drop the memoized bridge so a fixture can supply its own env. */
export function resetTerminalSurface(): void {
	surfaceBridge?.stop();
	surfaceBridge = undefined;
}

/** Marker on every augmented failure, so the A/B can split informed from blind retries. */
export const DIAGNOSIS_MARKER = "[edit-diagnosis]";

/**
 * Say what is wrong with a path, instead of only that something is.
 *
 * `read` and `grep` are the two busiest tools in the harness — 13,623 and 6,103
 * calls in three days — and neither had any failure handling: a missing path
 * came back as a bare ENOENT or `Path not found`, which tells the model nothing
 * it did not already know and is answered by guessing another path.
 *
 * MEASURED 2026-08-22..24: 52 read ENOENT/ENOTDIR and 23 grep Path-not-found —
 * 75 path failures, none carrying any explanation. read ENOENT was the single
 * largest error class on every day of the window; grep's was RISING (0, 12, 11
 * on the last three days).
 *
 * `describeMissingFile` (lens/locate.ts) already does the work and is already
 * tested, including empty string, /proc and a NUL byte. It was wired into
 * read_symbol and list_symbols only — 865 combined calls — while the two tools
 * that needed it most had nothing. This is mostly a WIRING change, not new
 * code, which is why it is cheap.
 *
 * It distinguishes the two cases that a bare ENOENT conflates: the directory
 * exists and the filename is wrong (here is what IS in it, ranked), versus the
 * path diverges higher up (here is the last real directory). The second half is
 * what answers the guessed-migration shape — `internal/store/migrations/0137_…`
 * in a repo whose migrations are timestamp-prefixed.
 *
 * Three properties, the same ones the edit wrapper documents and for the same
 * reasons:
 *
 *   - It NEVER converts a failure into a success. It appends evidence to an
 *     error that already happened.
 *   - It never replaces the original error, only extends it. Upstream wording
 *     is private and will drift.
 *   - It swallows its own exceptions. A diagnostic that can break the tool it
 *     explains is a bad trade.
 */
const PATH_MISSING = /ENOENT|ENOTDIR|no such file or directory|Path not found/i;
const GLOB_CHARS = /[*?[\]]/;

export async function explainPathFailure(err: unknown, rawPath: unknown, cwd: string): Promise<string | null> {
	try {
		if (typeof rawPath !== "string" || !rawPath) return null;
		const message = err instanceof Error ? err.message : String(err);
		if (!PATH_MISSING.test(message)) return null;

		// A glob in `path` is a DIFFERENT mistake wearing the same error, and
		// listing a directory's neighbours would answer a question nobody asked.
		// grep has a separate `glob` parameter; name it.
		if (GLOB_CHARS.test(rawPath)) {
			const dir = rawPath.split("/").filter((seg) => !GLOB_CHARS.test(seg)).join("/") || ".";
			const pattern = rawPath.slice(dir === "." ? 0 : dir.length + 1);
			return (
				`\`path\` is a directory or a file, not a pattern. Put \`${dir}\` in \`path\` ` +
				`and \`${pattern}\` in \`glob\`.`
			);
		}
		return await describeMissingFile(resolve(cwd, rawPath));
	} catch {
		return null;
	}
}

/**
 * Answer a rejected regex with the two things that actually fix it.
 *
 * MEASURED 2026-08-22..24: 8 grep failures, every one a literal paren or brace
 * the model meant as text — `CreateAttempt(ctx`, `execute_import(`,
 * `status IN ('succeeded'|…`, `agent-launches/{launchID}/complete|…`. Live on
 * the last day of the window.
 *
 * pi's grep already takes `literal: true` (wired to ripgrep's --fixed-strings),
 * which is the correct answer whenever the pattern was meant as text. The
 * parameter exists and is simply never reached for, so the message names it.
 *
 * Deliberately NOT auto-retried with the brackets escaped. An invalid regex has
 * no semantics to preserve, so a retry is safe in principle — but it would turn
 * a failed call into a successful one carrying results the model did not ask
 * for, and "never convert a failure into a success" is the property that makes
 * these wrappers safe to add anywhere.
 */
const REGEX_REJECTED = /regex parse error|unclosed group|repetition quantifier/i;

export function explainRegexFailure(err: unknown): string | null {
	const message = err instanceof Error ? err.message : String(err);
	if (!REGEX_REJECTED.test(message)) return null;
	return (
		"Your pattern is not a valid regex. If you meant it as literal text — a call like " +
		"`Foo(ctx`, or a path with `{}` in it — pass `literal: true`, which searches for the " +
		"string exactly. If you did mean a regex, escape the unbalanced `(`, `)`, `{` or `}`."
	);
}

/**
 * Put `read` in the same file-mutation queue as `edit` and `write`.
 *
 * pi queues its two WRITERS — `edit.js:183` and `write.js:149` both call
 * `withFileMutationQueue` — but `read.js` does a bare `ops.readFile`
 * (`read.js:173`/`:195`). A model routinely emits read and edit for the same
 * path in ONE assistant turn, and pi runs a batch through `Promise.all` unless
 * a tool asks to be sequential, so the read lands mid-write. `edit` writes by
 * truncate-then-write, and the window it opens is a file of length zero.
 *
 * Measured over 2026-08-22..24: 32 batches read and mutated the same path, and
 * 20 of them came back wrong — 13 as `Offset N is beyond end of file (1 lines
 * total)` and, worse, **7 as a SUCCESSFUL read of an empty file**, `isError:
 * false`, no marker of any kind. Control: one of the files reported as "1
 * lines total" is `internal/readiness/readiness_test.go`, which is 202 lines.
 *
 * The silent seven are why this is a correctness fix and not a papercut. A
 * model that reads a file, gets nothing, and is told the read succeeded can
 * reasonably conclude the file is empty — or that its own edit just wiped it.
 * Nothing in any error-rate metric can see this.
 *
 * WHY THIS WORKS, and the assumption it rests on: `fileMutationQueues` is a
 * module-global Map in the pi package (`core/tools/file-mutation-queue.js:3`).
 * Sharing it requires this import to resolve to the SAME module instance pi's
 * own edit/write use. Node caches ESM by resolved URL, so a bare specifier
 * resolving to the same physical package shares — but pi loads extensions
 * through jiti with `moduleCache: false` (see `guards-common/capability.ts`),
 * which is exactly the kind of thing that could hand this file its own copy of
 * the Map and turn this fix into a no-op that still looks correct.
 *
 * That assumption is not documented and is load-bearing, so it is TESTED
 * rather than trusted: `test/pretty-tools-read-queue.test.ts` fails if a read
 * concurrent with an edit of the same path ever observes a file shorter than
 * both the pre- and post-edit content.
 *
 * This wrapper is a MITIGATION, not the whole fix. Subagent workers run with
 * `--no-extensions` (`extensions/subagent/worker.ts:52`), so they use pi's
 * built-in read and stay exposed — in precisely the delegated lane used for
 * parallel work. The complete fix is upstream: put `read.js` in the queue.
 */
export function queuedRead<T>(cwd: string, run: () => Promise<T>, params: unknown): Promise<T> {
	let absolute: string;
	try {
		const path = (params as { path?: string } | undefined)?.path;
		if (typeof path !== "string" || !path) return run();
		absolute = resolve(cwd, path);
	} catch {
		// A queue is an optimisation on correctness, never a new way to fail:
		// anything odd about the params and the read proceeds exactly as before.
		return run();
	}
	return withFileMutationQueue(absolute, run);
}

/**
 * Turn a failed edit into a failed edit that says what is wrong.
 *
 * pi's applier reports an anchor miss without quoting the file, so 79% of our
 * measured edit failures hand the model no new information and it retries by
 * guessing (HIV-1562; see `edit-common/diagnose.ts` for the numbers).
 *
 * Three properties this deliberately keeps:
 *
 *   - It NEVER converts a failure into a success, and never edits anything. It
 *     appends evidence to an error that already happened.
 *   - It classifies by re-reading the file, not by parsing pi's error text.
 *     Upstream wording is private and will drift; a diagnosis that silently
 *     stops firing after a pi bump is the failure mode this house keeps
 *     writing tests about.
 *   - Anything unexpected — unreadable file, odd params, a thrown diagnosis —
 *     leaves the original error exactly as it was. A diagnostic that can break
 *     the tool it explains is a bad trade.
 */
export function diagnoseFailedEdit(
	params: unknown,
	cwd: string,
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
	try {
		const input = params as { path?: string; file_path?: string; edits?: Array<{ oldText?: string }>; oldText?: string };
		const path = input.path ?? input.file_path;
		if (typeof path !== "string" || !path) return null;

		const anchors = Array.isArray(input.edits)
			? input.edits.map((edit) => edit?.oldText).filter((text): text is string => typeof text === "string" && text.length > 0)
			: typeof input.oldText === "string" && input.oldText
				? [input.oldText]
				: [];
		if (anchors.length === 0) return null;

		// pi resolves a relative path against the session cwd before opening it;
		// reading it raw here would quietly diagnose the wrong file, or none.
		const content = read(resolve(cwd, path));
		// Report the FIRST anchor that is actually broken. pi fails the whole call
		// on the first bad edit, so later ones were never evaluated and diagnosing
		// them would invent problems the model has not hit yet.
		for (const anchor of anchors) {
			const message = explain(diagnose(content, anchor), path);
			if (message) return `${DIAGNOSIS_MARKER} ${message}`;
		}
		return null;
	} catch {
		return null;
	}
}

function preview(text: string, max = 88): string {
	const first = text.replace(/\s+/g, " ").trim();
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

function output(text: string, expanded: boolean, theme: { fg(color: string, text: string): string }): Text {
	const lines = text.split("\n").filter(Boolean);
	if (expanded) return new Text(theme.fg("toolOutput", text || "(no output)"), 0, 0);
	if (lines.length === 0) return new Text(theme.fg("success", "done"), 0, 0);
	const visible = lines.slice(0, PREVIEW_LINES);
	let rendered = theme.fg("toolOutput", visible.join("\n"));
	if (lines.length > PREVIEW_LINES) rendered += `\n${theme.fg("dim", `… ${lines.length - PREVIEW_LINES} more lines · Ctrl+O to expand`)}`;
	return new Text(rendered, 0, 0);
}

export default function prettyTools(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const read = createReadTool(cwd);
	const bash = createBashTool(cwd);
	const edit = createEditTool(cwd);
	const write = createWriteTool(cwd);
	const grep = createGrepTool(cwd);
	const find = createFindTool(cwd);
	const ls = createLsTool(cwd);

	pi.registerTool({
		name: "read", label: "Read", description: read.description, parameters: read.parameters,
		// The two wrappers COMPOSE, and the nesting order matters: the queue is
		// outermost, so the diagnosis in the catch also runs inside the slot. If it
		// ran outside, explainPathFailure would stat the path while a concurrent
		// edit still had the file truncated, and the message meant to say what is
		// actually there would describe the write's zero-length window instead.
		execute: (id, params, signal, onUpdate) =>
			queuedRead(cwd, async () => {
				try {
					return await read.execute(id, params, signal, onUpdate);
				} catch (err) {
					// Re-thrown, not swallowed: the read still failed, and pi still turns
					// the throw into the error result the model sees. The only change is
					// that the message now says what is actually at that path.
					const detail = await explainPathFailure(err, (params as { path?: string }).path, cwd);
					if (!detail) throw err;
					throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${detail}`);
				}
			}, params),
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "◌ read")} ${theme.fg("toolTitle", args.path)}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial
			? new Text(theme.fg("warning", "reading…"), 0, 0)
			: output(textContent(result), expanded, theme),
	});

	/**
	 * `bash`, plus the parameter it should always have had.
	 *
	 * pi's built-in `bashSchema` is `{command, timeout}` — `background_bash` has
	 * a `cwd` and `bash` does not — so a `cwd` the model passes is accepted by
	 * the wire format and dropped on the floor. Thirty papercuts in the seven
	 * days to 2026-08-28 asked for it, and 23 of them are complaints about the
	 * SILENCE rather than about a wrong answer: `toolcwd` used to repair the
	 * call and explain itself in the RESULT, which works and arrives one turn
	 * after the call it was meant to prevent. The other seven passed `workdir`,
	 * which nothing recognised at all — silently wrong answers about another
	 * checkout.
	 *
	 * Declaring it here is legitimate and not a trick: pi builds its registry
	 * from the built-ins and then `toolRegistry.set(tool.name, tool)` for every
	 * extension tool (`agent-session.js`), so an extension tool of the same name
	 * REPLACES the built-in — which this registration already relied on.
	 */
	const bashParameters = Type.Object({
		...bash.parameters.properties,
		cwd: Type.Optional(
			Type.String({
				description:
					"Absolute directory to run the command in. Unlike the stock pi bash tool, this harness honours it.",
			}),
		),
	});

	pi.registerTool({
		name: "bash", label: "Bash", description: bash.description, parameters: bashParameters,
		/**
		 * Runs the command on a real pty when one is available, so an interactive
		 * prompt can appear and a human can answer it, and says so when a command
		 * is blocked reading stdin.
		 *
		 * THE OVERRIDE STAYS HERE rather than in its own extension. pi resolves
		 * duplicate tool names first-registration-wins over `readdirSync` order, so
		 * a second extension registering `bash` is a coin flip decided by inode
		 * ordering (see filerank/README.md). `pty-exec/` is therefore a library
		 * with no index.ts, imported directly — which also means no new registered
		 * tool, so `SHELL_TOOLS`, `registerGuardedTool` and the READ_ONLY list are
		 * all untouched and guards-bridge still matches `bash` on `tool_call`
		 * exactly as before.
		 */
		execute: (id, params, signal, onUpdate) => {
			// WHERE IT RUNS, decided before either backend sees the command, so the
			// pty path and the stock fallback cannot disagree about it. The rules
			// are in toolcwd/cwd.ts, pure and tested; the note is null for the
			// declared `cwd` (honouring a parameter is not news) and set only for
			// a spelling nothing declares.
			const repair = repairBashCwd(params as Record<string, unknown>);
			const runParams = repair.command === null ? params : { ...params, command: repair.command };
			const cwdNote = repair.note;
			const withNote = <T extends { content: unknown }>(result: T): T =>
				cwdNote ? { ...result, content: appendHint(result.content, `\n\n[harness] ${cwdNote}`) } : result;

			if (!ptyAvailable()) return bash.execute(id, runParams, signal, onUpdate).then(withNote);

			/**
			 * `onUpdate` fires only when output arrives — which is precisely never
			 * for a blocked command. So keep the last snapshot and re-emit it
			 * decorated when the watch has something to say; without this the note
			 * has no way onto the screen.
			 */
			let last: Parameters<NonNullable<typeof onUpdate>>[0] = { content: [], details: undefined };
			let note: string | null = null;

			const decorate = (r: typeof last): typeof last => {
				if (!note) return r;
				const text = r.content.map((c) => ("text" in c ? c.text : "")).join("");
				return { ...r, content: [{ type: "text", text: text ? `${text}\n${note}` : note }] };
			};
			const forward = onUpdate
				? (r: typeof last) => {
						last = r;
						onUpdate(decorate(r));
					}
				: undefined;
			let announced: "waiting" | "resolved" = "resolved";
			const onBlocked = (v: BlockedVerdict) => {
				note = blockedNote(v);
				onUpdate?.(decorate(last));
				// Tell hive-remote, which is the half that can put this on the
				// session's activity row. A direct call is impossible — separate
				// extensions, separate jiti instances — so the bus is the seam.
				const phase = v.kind === "working" ? "resolved" : "waiting";
				if (phase === announced) return; // transitions only; never a heartbeat
				announced = phase;
				const event: HiveStdinWaitEvent = {
					callID: id,
					phase,
					confidence: v.kind === "blocked" ? "proven" : "quiet",
					quietSeconds: v.kind === "working" ? 0 : Math.round(v.quietMs / 1000),
				};
				pi.events.emit(HIVE_STDIN_WAIT_CHANNEL, event);
			};

			// The live terminal a human can attach to, when this launch published
			// one. Raw bytes go to it; the model's copy stays stripped and
			// collapsed. Keystrokes arrive on its local control FIFO and go
			// straight to the pty — never through Hive, never into the transcript.
			const surface = terminalSurface();
			const geometry = surface?.geometry();
			surface?.beginCommand(id, runParams.command, cwd);

			const operations = ptyBashOperations({
				onBlocked,
				onRaw: surface ? (chunk) => surface.writeOutput(chunk) : undefined,
				// A human at the terminal owns the session: never close stdin from
				// under someone who is typing.
				hasHuman: surface ? () => surface.hasLease() : undefined,
				rows: geometry?.rows,
				cols: geometry?.cols,
				attachInput: surface
					? (write) => {
							surface.onInput(write);
							// Detached when the command ends, so a keystroke that
							// arrives late cannot be delivered to the next one.
							return () => surface.onInput(() => {});
						}
					: undefined,
				onGeometry: surface
					? (apply) => {
							surface.onResize(apply);
							return () => surface.onResize(() => {});
						}
					: undefined,
			});
			if (!operations) return bash.execute(id, runParams, signal, onUpdate).then(withNote);

			// Constructed PER CALL: each call needs its own watch, its own raw sink
			// and its own tty file. Mirrors the gondolin example's shape.
			const tool = createBashTool(cwd, { operations });
			return tool.execute(id, runParams, signal, forward).then(
				(result) => {
					surface?.endCommand(id, 0);
					return withNote(result);
				},
				(err: unknown) => {
					surface?.endCommand(id, null);
					throw err;
				},
			).catch((err: unknown) => {
				// `script` missing or unrunnable. PTY mode has latched itself off, so
				// retrying on the stock backend costs one command, not every command.
				if (err instanceof Error && err.message === "pty-unavailable") {
					return bash.execute(id, runParams, signal, onUpdate).then(withNote);
				}
				throw err;
			});
		},
		renderCall: (args, theme) => new Text(
			`${theme.fg("accent", "›")} ${theme.fg("toolTitle", "$ ")}${theme.fg("text", preview(args.command))}` +
				(args.cwd ? theme.fg("dim", ` · in ${args.cwd}`) : ""),
			0,
			0,
		),
		/**
		 * The partial branch renders the harness note when there is one. It used to
		 * discard the text outright, which would have made a blocked-on-stdin
		 * warning invisible in the local TUI — the one place someone is sitting.
		 */
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (!isPartial) return output(textContent(result), expanded, theme);
			const harness = textContent(result)
				.split("\n")
				.filter((l) => l.startsWith("[harness]"))
				.join("\n");
			return harness
				? new Text(`${theme.fg("warning", "running…")}\n${theme.fg("warning", harness)}`, 0, 0)
				: new Text(theme.fg("warning", "running…"), 0, 0);
		},
	});

	pi.registerTool({
		name: "edit", label: "Edit", description: edit.description, parameters: edit.parameters,
		execute: async (id, params, signal, onUpdate) => {
			try {
				return await edit.execute(id, params, signal, onUpdate);
			} catch (err) {
				// Re-thrown, not swallowed: the edit still failed, and pi still turns
				// the throw into the error result the model sees. The only change is
				// that the message now contains the file.
				const detail = diagnoseFailedEdit(params, cwd);
				if (!detail) throw err;
				throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${detail}`);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "✎ edit")} ${theme.fg("toolTitle", args.path)}${theme.fg("dim", ` · ${args.edits.length} change${args.edits.length === 1 ? "" : "s"}`)}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial
			? new Text(theme.fg("warning", "editing…"), 0, 0)
			: output(textContent(result), expanded, theme),
	});

	pi.registerTool({
		name: "write", label: "Write", description: write.description, parameters: write.parameters,
		execute: (id, params, signal, onUpdate) => write.execute(id, params, signal, onUpdate),
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "✦ write")} ${theme.fg("toolTitle", args.path)}${theme.fg("dim", ` · ${args.content.split("\n").length} lines`)}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial
			? new Text(theme.fg("warning", "writing…"), 0, 0)
			: output(textContent(result), expanded, theme),
	});

	pi.registerTool({
		name: "grep", label: "Grep", description: grep.description, parameters: grep.parameters,
		execute: async (id, params, signal, onUpdate) => {
			try {
				return await grep.execute(id, params, signal, onUpdate);
			} catch (err) {
				// Two different mistakes reach here wearing similar errors: a path
				// that is not there (or is a glob in the wrong parameter), and a
				// pattern that is not a valid regex. Each gets its own answer.
				const detail =
					explainRegexFailure(err) ??
					(await explainPathFailure(err, (params as { path?: string }).path, cwd));
				if (!detail) throw err;
				throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${detail}`);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "⌕ grep")} ${theme.fg("toolTitle", `/${args.pattern}/`)}${theme.fg("dim", ` in ${args.path ?? "."}`)}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial ? new Text(theme.fg("warning", "searching…"), 0, 0) : output(textContent(result), expanded, theme),
	});

	pi.registerTool({
		name: "find", label: "Find", description: find.description, parameters: find.parameters,
		execute: (id, params, signal, onUpdate) => find.execute(id, params, signal, onUpdate),
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "⌕ find")} ${theme.fg("toolTitle", args.pattern)}${theme.fg("dim", ` in ${args.path ?? "."}`)}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial ? new Text(theme.fg("warning", "searching…"), 0, 0) : output(textContent(result), expanded, theme),
	});

	pi.registerTool({
		name: "ls", label: "List", description: ls.description, parameters: ls.parameters,
		execute: (id, params, signal, onUpdate) => ls.execute(id, params, signal, onUpdate),
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "≡ ls")} ${theme.fg("toolTitle", args.path ?? ".")}`, 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => isPartial ? new Text(theme.fg("warning", "listing…"), 0, 0) : output(textContent(result), expanded, theme),
	});
}
