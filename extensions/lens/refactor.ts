/**
 * Applying a language server's WorkspaceEdit — the write half of rename/move
 * (HIV-1565, HIV-3816).
 *
 * Two properties matter more than the mechanics:
 *
 * 1. **All or nothing.** A rename that updates 3 of 4 files leaves a tree that
 *    does not compile and a model that believes it succeeded. Every file is
 *    read and rewritten in memory first; a failure anywhere — an unreadable
 *    file, overlapping edits, an operation this module does not apply — means
 *    nothing is written.
 *
 * 2. **The guard applies.** `guards-bridge` matches on tool NAME — `bash`,
 *    `edit`, `write` — so a new tool that writes files is invisible to it and
 *    would happily rewrite files inside a pull-only worktree (for hive-pi,
 *    the live stow anchor every session reads its config from). This module
 *    runs the same `decide()` over every target before touching anything.
 *    A new write path must opt INTO the guard; it does not inherit it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { guardTargets } from "../guards-common/capability.ts";
import { stripBom, type Position, type TextEdit, type WorkspaceEdit } from "./lsp.ts";

export interface FileEdits {
	file: string;
	edits: TextEdit[];
}

export type Conversion = { ok: true; files: FileEdits[] } | { ok: false; reason: string };

/**
 * Flatten a WorkspaceEdit into one edit list per file path.
 *
 * Both shapes are read because the server sends both (see `WorkspaceEdit`).
 * When `documentChanges` is present it wins and `changes` is ignored — that is
 * the protocol's rule, and applying both would apply every edit twice.
 *
 * A create/rename/delete operation inside `documentChanges` is REFUSED, not
 * skipped: dropping it would apply the text edits around a file operation that
 * never happened, and report success. None was requested (the client does not
 * advertise `resourceOperations`), so one arriving is a server this code does
 * not understand.
 */
export function workspaceEditToFileEdits(edit: WorkspaceEdit): Conversion {
	const byFile = new Map<string, TextEdit[]>();
	const add = (uri: string, edits: TextEdit[]): string | null => {
		if (!uri.startsWith("file:")) return `the language server returned an edit for a non-file URI (${uri})`;
		const file = fileURLToPath(uri);
		const list = byFile.get(file) ?? [];
		list.push(...edits);
		byFile.set(file, list);
		return null;
	};

	if (edit.documentChanges) {
		const seen = new Set<string>();
		for (const change of edit.documentChanges) {
			if (!("textDocument" in change)) {
				return {
					ok: false,
					reason:
						`The language server returned a \`${change.kind}\` file operation, which this tool does not apply. ` +
						"Nothing was written.",
				};
			}
			// Two groups for one document apply IN SEQUENCE by the protocol: the
			// second's positions refer to the text after the first. Merging them
			// would resolve both against the original. Never observed from this
			// server, so refused rather than half-supported.
			if (seen.has(change.textDocument.uri)) {
				return {
					ok: false,
					reason: `The language server returned two edit groups for ${change.textDocument.uri}, which this tool does not apply. Nothing was written.`,
				};
			}
			seen.add(change.textDocument.uri);
			const problem = add(change.textDocument.uri, change.edits);
			if (problem) return { ok: false, reason: `${problem}. Nothing was written.` };
		}
	} else {
		for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
			const problem = add(uri, edits);
			if (problem) return { ok: false, reason: `${problem}. Nothing was written.` };
		}
	}
	const files = [...byFile.entries()]
		.filter(([, edits]) => edits.length > 0)
		.map(([file, edits]) => ({ file, edits }));
	return { ok: true, files };
}

/**
 * Convert an LSP position (0-based line, 0-based UTF-16 character) to a string
 * index. UTF-16 code units are what JavaScript string indices count, so the
 * character needs no conversion — only the line has to be walked.
 *
 * Lines end at `\r\n`, `\r` or `\n`, as the protocol (and the server) count
 * them; counting `\n` alone mis-places every edit in a `\r`-terminated file.
 * A character past the end of its line clamps to the line end, as the
 * protocol requires, rather than running into the next line.
 */
export function toIndex(text: string, position: Position): number {
	let index = 0;
	for (let line = 0; line < position.line; line++) {
		const end = lineEnd(text, index);
		if (end >= text.length) return text.length;
		index = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1);
	}
	return Math.min(index + position.character, lineEnd(text, index));
}

/** Index of the line break ending the line that starts at `from`, or the text length. */
function lineEnd(text: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === "\n" || c === "\r") return i;
	}
	return text.length;
}

/**
 * Apply one file's edits to its text.
 *
 * Every range is resolved against the ORIGINAL text — which is what the
 * protocol means — and then applied last-first, so no replacement shifts one
 * still to come. Two inserts at the same point keep their array order (the
 * protocol's rule), which is why ties are applied in reverse. Overlapping
 * ranges are invalid by the protocol and have no right answer, so they throw
 * rather than produce whichever text happened to win.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
	const resolved = edits.map((edit, order) => ({
		start: toIndex(text, edit.range.start),
		end: toIndex(text, edit.range.end),
		newText: edit.newText,
		order,
	}));
	resolved.sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
	let result = text;
	let floor = Number.POSITIVE_INFINITY;
	for (const edit of resolved) {
		if (edit.end > floor || edit.end < edit.start) {
			throw new Error(`overlapping or inverted edit ranges at character ${edit.start}`);
		}
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
		floor = edit.start;
	}
	return result;
}

export type ApplyResult =
	| { ok: true; files: { file: string; edits: number }[] }
	| { ok: false; blocked: string[]; reason: string }
	| { ok: false; blocked?: undefined; reason: string };

/**
 * Read → transform → write, atomically across files.
 *
 * "Atomic" here means no partial APPLICATION, not crash-safety: the writes are
 * ordinary and a power cut mid-loop still tears. That is the same guarantee the
 * built-in `edit` tool gives, and buying more would mean a temp-file-and-rename
 * dance across a set of files that may span filesystems.
 */
export async function applyFileEdits(fileEdits: FileEdits[], toolLabel: string): Promise<ApplyResult> {
	if (fileEdits.length === 0) return { ok: false, reason: "No edits to apply." };

	const guard = guardTargets(
		fileEdits.map((f) => f.file),
		toolLabel,
	);
	if (guard) return { ok: false, blocked: guard.blocked, reason: guard.reason };

	const staged: { file: string; text: string; edits: number }[] = [];
	for (const fileEdit of fileEdits) {
		let original: string;
		try {
			original = await readFile(fileEdit.file, "utf8");
		} catch (error) {
			return { ok: false, reason: `Could not read ${fileEdit.file}: ${(error as Error).message}. Nothing was written.` };
		}
		// The server's positions are against the text WITHOUT a byte-order mark
		// (see `stripBom`); apply them there, and put the mark back.
		const bom = original.length !== stripBom(original).length ? original[0] : "";
		let text: string;
		try {
			text = bom + applyEdits(stripBom(original), fileEdit.edits);
		} catch (error) {
			return { ok: false, reason: `Could not apply the edits to ${fileEdit.file}: ${(error as Error).message}. Nothing was written.` };
		}
		staged.push({ file: fileEdit.file, text, edits: fileEdit.edits.length });
	}

	for (const item of staged) {
		try {
			await writeFile(item.file, item.text, "utf8");
		} catch (error) {
			// Partial write: say so loudly. Silence here is the worst outcome —
			// the tree is inconsistent and only this message knows it.
			return {
				ok: false,
				reason:
					`Failed writing ${item.file}: ${(error as Error).message}. ` +
					`WARNING: earlier files in this change were already written — the tree is now inconsistent. ` +
					`Check \`git diff\` before continuing.`,
			};
		}
	}
	return { ok: true, files: staged.map((s) => ({ file: s.file, edits: s.edits })) };
}
