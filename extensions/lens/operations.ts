/**
 * rename_symbol and move_file, end to end: find the project's TypeScript 7
 * server, ask it, apply its answer under the guard, report.
 *
 * Kept apart from the tool registrations so the whole path — resolution,
 * protocol, application, the move itself — runs in a test against a real
 * native server, not only its pieces.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";

import { guardTargets } from "../guards-common/capability.ts";
import { findNativeServer, NativeServer, requestFileMove, requestRename } from "./lsp.ts";
import { applyFileEdits, workspaceEditToFileEdits } from "./refactor.ts";

export interface Outcome {
	text: string;
	isError: boolean;
}

const done = (text: string): Outcome => ({ text, isError: false });

/**
 * Thrown before any write when the call was aborted. Killing the server only
 * stops a request still in flight; an abort that lands after the answer
 * arrived must still stop the writes, so they check this first.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("aborted before anything was written");
}

/**
 * The first ancestor of `dir` that exists, if it is not a directory. A move
 * into `a/b/c.ts` where `a/b` is a FILE fails at `mkdir` — and by then every
 * importer has been rewritten — so it is refused before anything is touched.
 */
function blockingFile(dir: string): string | null {
	let current = dir;
	for (;;) {
		if (existsSync(current)) return statSync(current).isDirectory() ? null : current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
const failed = (text: string): Outcome => ({ text, isError: true });

/**
 * Start a server for `anchor`'s project, run `work`, always dispose it. An
 * abort kills the server, which rejects whatever request is outstanding.
 */
async function withServer(
	anchor: string,
	signal: AbortSignal | undefined,
	work: (server: NativeServer) => Promise<Outcome>,
	missing: (reason: string) => Outcome,
): Promise<Outcome> {
	const lookup = findNativeServer(anchor);
	if (!lookup.ok) return missing(lookup.reason);
	throwIfAborted(signal);
	const server = await NativeServer.start(lookup.exe, lookup.root);
	const onAbort = () => server.dispose();
	if (signal?.aborted) onAbort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await work(server);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		server.dispose();
	}
}

export interface RenameRequest {
	/** Absolute path of the file containing the symbol. */
	file: string;
	/** 1-based line and column, as the tool takes them. */
	line: number;
	offset: number;
	newName: string;
	/** For relative paths in the report. */
	cwd: string;
	signal?: AbortSignal;
}

export async function renameSymbol(request: RenameRequest): Promise<Outcome> {
	if (!existsSync(request.file)) return failed(`${relative(request.cwd, request.file)} does not exist.`);
	return await withServer(
		request.file,
		request.signal,
		async (server) => {
			server.open(request.file);
			const answer = await requestRename(
				server,
				request.file,
				{ line: request.line - 1, character: request.offset - 1 },
				request.newName,
			);
			if (!answer.ok) return done(answer.reason);
			const converted = workspaceEditToFileEdits(answer.edit);
			if (!converted.ok) return failed(converted.reason);
			throwIfAborted(request.signal);
			if (converted.files.length === 0) {
				return done(
					`The language server found no references to \`${answer.name}\` to rename. ` +
						"Check that the file is part of a tsconfig project.",
				);
			}
			const applied = await applyFileEdits(converted.files, "rename_symbol");
			if (!applied.ok) {
				return failed(
					applied.blocked
						? `Refusing to rename: ${applied.blocked.length} target file(s) are guarded.\n\n${applied.reason}`
						: applied.reason,
				);
			}
			const total = applied.files.reduce((n, f) => n + f.edits, 0);
			const listed = applied.files.map((f) => `  ${relative(request.cwd, f.file)} (${f.edits})`).join("\n");
			return done(
				`Renamed \`${answer.name}\` → \`${request.newName}\`: ` +
					`${total} reference(s) across ${applied.files.length} file(s).\n\n${listed}\n\n` +
					"Run the project's typecheck to confirm — this updated references the language server knows about.",
			);
		},
		(reason) =>
			done(
				`${reason}\n\nrename_symbol uses the project's own TypeScript 7 language server. Install it, or rename by ` +
					"hand and run the project's typecheck to catch missed references.",
			),
	);
}

/**
 * What the language server does not rewrite, said in the result.
 *
 * A module path inside a string that is not an import — `vi.mock("…")`,
 * `jest.mock("…")` — is not a reference to the server, so a move leaves it
 * pointing at the old path. The typecheck still passes; the test silently
 * stops mocking. Measured on pyERP's web frontend: moving one hook rewrote
 * 27 importers and left 17 `vi.mock` paths behind. Searching the whole tree
 * here would cost a repo-wide scan on every move; naming the stem to grep for
 * costs the agent one call, and only when it matters.
 */
function stringSpecifierWarning(from: string): string {
	const stem = basename(from).replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
	return (
		"Not updated: module paths in strings that are not imports, such as `vi.mock(\"…\")` or `jest.mock(\"…\")`. " +
		`\`grep\` for \`${stem}\` to find any left behind.`
	);
}

export interface MoveRequest {
	/** Absolute paths. */
	from: string;
	to: string;
	cwd: string;
	signal?: AbortSignal;
}

export async function moveFile(request: MoveRequest): Promise<Outcome> {
	const { from, to, cwd } = request;
	if (!existsSync(from)) return failed(`${relative(cwd, from)} does not exist.`);
	if (existsSync(to)) return failed(`${relative(cwd, to)} already exists — refusing to overwrite it.`);

	// The file itself is written (moved), not merely referenced, so it is
	// guarded here too: guards-bridge cannot see this tool.
	const selfGuard = guardTargets([from, to], "move_file");
	if (selfGuard) return failed(`Refusing to move: guarded path.\n\n${selfGuard.reason}`);
	const blocker = blockingFile(dirname(to));
	if (blocker) return failed(`${relative(cwd, blocker)} is a file, so ${relative(cwd, to)} cannot be created. Nothing was changed.`);

	return await withServer(
		from,
		request.signal,
		async (server) => {
			// Opening the file is what loads its project; a move asked of a server
			// with no project loaded answers with no edits at all.
			server.open(from);
			const edit = await requestFileMove(server, from, to);
			const converted = workspaceEditToFileEdits(edit ?? {});
			if (!converted.ok) return failed(converted.reason);
			throwIfAborted(request.signal);

			// The answer includes the moved file's OWN relative imports, keyed by
			// its old path — they are applied before the move, with everything
			// else, in one all-or-nothing step. (The tsserver client dropped
			// them, which left a moved file's own imports pointing nowhere.)
			if (converted.files.length > 0) {
				const applied = await applyFileEdits(converted.files, "move_file");
				if (!applied.ok) {
					return failed(
						applied.blocked
							? `Refusing to move: ${applied.blocked.length} file(s) to update are guarded.\n\n${applied.reason}`
							: applied.reason,
					);
				}
			}

			// Edits are written; now move the file. A failure here leaves rewritten
			// importers pointing at a path that does not exist yet — say so.
			try {
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
			} catch (error) {
				return failed(
					`Updated ${converted.files.length} file(s), but MOVING the file failed: ` +
						`${(error as Error).message}. The tree is now inconsistent — check \`git diff\`.`,
				);
			}

			const changed = converted.files.map(
				(group) => `  ${relative(cwd, group.file === from ? to : group.file)} (${group.edits.length})`,
			);
			return done(
				`Moved ${relative(cwd, from)} → ${relative(cwd, to)}` +
					(changed.length > 0
						? `, updating ${changed.length} file(s):\n\n${changed.join("\n")}`
						: " (no file referenced it)") +
					"\n\n" +
					stringSpecifierWarning(from) +
					"\n\nRun the project's typecheck and tests to confirm.",
			);
		},
		(reason) =>
			done(
				`${reason}\n\nmove_file uses the project's own TypeScript 7 language server. Install it, or move by hand ` +
					"and fix importers yourself.",
			),
	);
}
