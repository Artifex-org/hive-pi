/**
 * lens — read one symbol instead of a whole file.
 *
 * Replaces pi-lens, whose cost was measured rather than assumed: 22 MB, a
 * 79k-line bundle, a native ast-grep binding, downloaded tree-sitter grammars
 * and LSP binaries, ~4-6 s added to every session start, `loop_block` events
 * averaging 1.7 s (its own telemetry, blocking the agent loop hive-pi rules
 * forbid blocking), 20+ state files including a 4 MB latency log — and an
 * unguarded write from a debounced timer that killed two launched agents
 * mid-task by turning EROFS into an uncaughtException.
 *
 * Against that, its tools accounted for 12 of ~193 recorded calls. The one that
 * earns its place is reading a symbol's body instead of a 500-line file, which
 * needs no index and no grammar download.
 *
 * NOT reimplemented, deliberately: LSP diagnostics (we run the real gate —
 * `hive check --step lint` — which is stronger than editor diagnostics), and
 * complexity/maintainability reports (2 calls, ever). Real reference
 * resolution is an explicit LSP-backed tool, not a larger regex: rename_symbol
 * and move_file below, over the project's own TypeScript 7 language server.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describeMissingFile, isNotFound } from "./locate.ts";
import { findSymbol, listSymbols, type SymbolSpan } from "./symbols.ts";
import { moveFile, renameSymbol } from "./operations.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { exposureFor } from "../loadout/policy.ts";

/**
 * withPathAlias accepts `path` (and `file_path`) wherever these tools declare `file`.
 *
 * Every other file tool in this harness names the parameter `path` — `read`,
 * `edit` and `grep` all take pi's own schemas, which use `path`. These three
 * declare `file`, and a model that has learned the rest of the surface fills in
 * the name the rest of the surface uses.
 *
 * MEASURED 2026-08-22..24: `list_symbols` was called 79 times and 13 of those
 * failed `Validation failed for tool "list_symbols": - file: must have required
 * properties file`. The raw arguments of all 13 are exactly `{"path": "..."}`.
 * That is 16.5% of every call to the tool, and the most recent day was the
 * worst of the window — so this is not decaying on its own.
 *
 * `read_symbol` and `rename_symbol` have no measured failures (233+ calls, zero
 * errors), so the cost here is only real for `list_symbols`. They get the alias
 * anyway because the inconsistency is what causes the guess, and fixing one
 * name of three leaves the surface still teaching the wrong lesson.
 *
 * Renaming the parameter to `path` outright would be the cleaner fix and is NOT
 * done here: it would break any caller that correctly sends `file` today, and
 * an alias costs one line while a rename costs a migration.
 *
 * `prepareArguments` is pi's own mechanism for exactly this — it uses it at
 * `edit.js` to accept edits sent as a JSON string, "because some models send
 * edits as a JSON string".
 */
export function withPathAlias<T>(args: unknown): T {
	const a = args as { file?: string; path?: string; file_path?: string };
	if (a && typeof a === "object" && a.file === undefined) {
		const alias = a.path ?? a.file_path;
		if (typeof alias === "string" && alias) return { ...a, file: alias } as T;
	}
	return args as T;
}

/** Refuse rather than truncate: a silently truncated body is a body that
 *  compiles in the reader's head and not in the file. */
const MAX_BYTES = 400_000;

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: {}, ...(isError ? { isError: true } : {}) };
}

/**
 * The `symbol` envelope hive's transcript renders (HIV-1367).
 *
 * `content` is untouched — the envelope is an ADDITIONAL view for the browser,
 * never a replacement for what the model reads. The terminal keeps rendering
 * from the text exactly as before.
 */
function symbolResult(
	s: string,
	spec: {
		mode: "read" | "list";
		file: string;
		symbol?: string;
		language?: string;
		decls: { text: string; signature?: string; startLine?: number; endLine?: number; depth?: number }[];
	},
) {
	return {
		content: [{ type: "text" as const, text: s }],
		details: { hive_widget: { v: 1 as const, type: "symbol" as const, spec } },
	};
}

/** Extension family, for the widget's header. */
function languageOf(file: string): string {
	const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
	if (!ext) return "";
	if (ext === "py" || ext === "pyi") return "python";
	if (ext === "star" || ext === "bzl" || ext === "bazel") return "starlark";
	if (ext === "go") return "go";
	if (ext === "ts" || ext === "tsx") return "typescript";
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
	return ext;
}

async function read(file: string): Promise<string> {
	const path = resolve(file);
	const buf = await readFile(path);
	if (buf.byteLength > MAX_BYTES) {
		throw new Error(`${file} is ${buf.byteLength} bytes; read it directly or narrow the range`);
	}
	return buf.toString("utf8");
}

function render(file: string, span: SymbolSpan): string {
	return `${file}:${span.startLine}-${span.endLine}\n\n${span.text}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_symbol", exposure: exposureFor("read_symbol"),
		label: "Read symbol",
		description:
			"Read a single function, method, class, type or constant from a file, with its " +
			"doc comment, instead of reading the whole file. Use this when you know the name " +
			"you need — it is much cheaper than `read` on a large file. Returns every " +
			"declaration matching the name (a name is often both an interface and its " +
			"implementation), each with its line range. Supports Go, TypeScript/JavaScript " +
			"and Python. Use `list_symbols` first if you do not know the name.",
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file, absolute or relative to cwd" }),
			symbol: Type.String({ description: "Exact symbol name, case-sensitive" }),
		}),
		prepareArguments: withPathAlias,
		async execute(_id, params) {
			// A missing FILE is the same failure as a missing symbol one step
			// earlier, and agents hit it more often because the path is usually
			// inferred from a package name. Answered rather than thrown — see
			// locate.ts.
			let source: string;
			try {
				source = await read(params.file);
			} catch (err) {
				if (!isNotFound(err)) throw err;
				return text(await describeMissingFile(params.file));
			}
			const found = findSymbol(source, params.file, params.symbol);
			if (found.length === 0) {
				// Naming the alternative matters: the failure mode to avoid is an
				// agent concluding the symbol does not exist because one tool could
				// not see it.
				return text(
					`No declaration of \`${params.symbol}\` found in ${params.file}.\n` +
						`It may be defined elsewhere, generated, or declared in a form this tool does not model — ` +
						`try \`grep\` for the name, or \`list_symbols\` for what this file does declare.`,
				);
			}
			if (found.length === 1) return text(render(params.file, found[0]));
			const header = `${found.length} declarations of \`${params.symbol}\` in ${params.file}:\n`;
			return text([header, ...found.map((s) => render(params.file, s))].join("\n\n"));
		},
	});

	pi.registerTool({
		name: "list_symbols", exposure: exposureFor("list_symbols"),
		label: "List symbols",
		description:
			"Outline a file: its top-level functions, types, classes and constants with line " +
			"numbers, without reading the bodies. Use this to find the name to pass to " +
			"`read_symbol`, or to understand a file's shape before deciding what to read.",
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file, absolute or relative to cwd" }),
		}),
		prepareArguments: withPathAlias,
		async execute(_id, params) {
			let source: string;
			try {
				source = await read(params.file);
			} catch (err) {
				if (!isNotFound(err)) throw err;
				return text(await describeMissingFile(params.file));
			}
			const found = listSymbols(source, params.file);
			const spec = {
				mode: "list" as const,
				file: params.file,
				language: languageOf(params.file),
				decls: found.map((s) => ({
					text: s.signature,
					signature: s.signature,
					startLine: s.line,
					depth: s.depth,
				})),
			};
			if (found.length === 0) {
				return symbolResult(`No top-level declarations found in ${params.file}.`, spec);
			}
			const width = String(found[found.length - 1].line).length;
			return symbolResult(
				`${params.file} — ${found.length} declaration(s)\n\n` +
					found.map((s) => `${String(s.line).padStart(width)}  ${"  ".repeat(s.depth)}${s.signature}`).join("\n"),
				spec,
			);
		},
	});

	/**
	 * rename_symbol — the case the regex deliberately does not cover.
	 *
	 * The README's rule is "if we later need real reference resolution the
	 * answer is an LSP or ast-grep as an EXPLICIT TOOL, not a larger regex
	 * here". Rename is that case, and for a reason no regex reaches: with a
	 * barrel re-export the file that must change does not contain the name in a
	 * form grep can match, and the model's hand-rolled rename then produces a
	 * diff that typechecks locally and breaks the whole-project gate.
	 *
	 * No bundled LSP: the project's OWN TypeScript 7 language server answers,
	 * spawned per call and killed after (operations.ts, lsp.ts). A project
	 * without one gets a clean refusal.
	 */
	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "applyFileEdits runs guardTargets over every target file" },
		name: "rename_symbol",
		label: "Rename symbol",
		promptSnippet: "Rename a TypeScript symbol across the project, re-exports included",
		description:
			"Rename a TypeScript/JavaScript symbol everywhere it is referenced, using the project's own " +
			"TypeScript 7 language server — including barrel files and re-exports, which a text search cannot " +
			"see. Prefer this over hand-editing call sites: a partially-renamed symbol typechecks in the file " +
			"you edited and fails the project gate. Requires TypeScript 7+ installed in the project or a parent " +
			"directory. Point line/offset at the identifier itself. Reports every file it changed.",
		parameters: Type.Object({
			file: Type.String({ description: "File containing the declaration, absolute or relative to cwd" }),
			line: Type.Number({ description: "1-based line of the symbol" }),
			offset: Type.Number({ description: "1-based column of the symbol name on that line" }),
			newName: Type.String({ description: "The new name" }),
		}),
		prepareArguments: withPathAlias,
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const outcome = await renameSymbol({
					file: resolve(ctx.cwd, params.file),
					line: params.line,
					offset: params.offset,
					newName: params.newName,
					cwd: ctx.cwd,
					signal,
				});
				return text(outcome.text, outcome.isError);
			} catch (error) {
				return text(`Rename failed: ${(error as Error).message}`, true);
			}
		},
	});

	/**
	 * move_file — the other half of "the IDE is wired in".
	 *
	 * Moving a file is the case where the edit that matters is in files you did
	 * not touch: every importer's specifier, every barrel that re-exports through
	 * the old path, and the moved file's own relative imports.
	 * `workspace/willRenameFiles` asks the language server for exactly that set
	 * BEFORE the move, which is the only order that works — afterwards the old
	 * path no longer resolves and the server cannot compute it.
	 */
	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "applyFileEdits guards every edited file; the moved file is guarded explicitly" },
		name: "move_file",
		label: "Move file",
		promptSnippet: "Move a TypeScript file and fix every import that points at it",
		description:
			"Move or rename a TypeScript/JavaScript FILE and rewrite every import and re-export that " +
			"referenced it — and the moved file's own relative imports — using the project's own TypeScript 7 " +
			"language server. Use this instead of `bash mv` for source files: `mv` leaves every importer pointing " +
			"at a path that no longer exists, and barrel files make those importers hard to find by search. " +
			"Requires TypeScript 7+ installed in the project or a parent directory. Reports every file it changed.",
		parameters: Type.Object({
			from: Type.String({ description: "Current path, absolute or relative to cwd" }),
			to: Type.String({ description: "New path, absolute or relative to cwd" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const outcome = await moveFile({
					from: resolve(ctx.cwd, params.from),
					to: resolve(ctx.cwd, params.to),
					cwd: ctx.cwd,
					signal,
				});
				return text(outcome.text, outcome.isError);
			} catch (error) {
				return text(`Move failed: ${(error as Error).message}`, true);
			}
		},
	});
}
