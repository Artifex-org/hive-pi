/**
 * Applying tsserver edit sets — the write half of rename/move (HIV-1565).
 *
 * Two properties matter more than the mechanics:
 *
 * 1. **All or nothing.** A rename that updates 3 of 4 files leaves a tree that
 *    does not compile and a model that believes it succeeded. Every file is
 *    read and rewritten in memory first; a failure anywhere means nothing is
 *    written.
 *
 * 2. **The guard applies.** `guards-bridge` matches on tool NAME — `bash`,
 *    `edit`, `write` — so a new tool that writes files is invisible to it and
 *    would happily rewrite files inside a pull-only worktree (for hive-pi,
 *    the live stow anchor every session reads its config from). This module
 *    runs the same `decide()` over every target before touching anything.
 *    A new write path must opt INTO the guard; it does not inherit it.
 */

import { readFile, writeFile } from "node:fs/promises";

// guardTargets moved to guards-common/capability.ts in wave 5 — it was the
// only caller of the guard, and the point of that module is that it stops
// being the only one. Re-exported so existing importers are unaffected.
export { guardTargets } from "../guards-common/capability.ts";
import { guardTargets } from "../guards-common/capability.ts";

export interface TsEdit {
	start: { line: number; offset: number };
	end: { line: number; offset: number };
	newText: string;
}

export interface TsFileEdits {
	file: string;
	edits: TsEdit[];
}

/**
 * What tsserver's `rename` actually returns per location.
 *
 * Note what is NOT here: `newText`. The rename response gives spans only — the
 * client substitutes the new name itself. Assuming an edit-shaped response is
 * the mistake this type exists to prevent; it would apply `undefined` as the
 * replacement text and silently delete every reference.
 *
 * `prefixText`/`suffixText` are how tsserver handles a shorthand property:
 * renaming `x` in `{ x }` must produce `{ x: newName }`, so it returns the span
 * of `x` plus the prefix that turns it into a full property.
 */
export interface RenameSpan {
	start: { line: number; offset: number };
	end: { line: number; offset: number };
	prefixText?: string;
	suffixText?: string;
}

export interface RenameSpanGroup {
	file: string;
	locs: RenameSpan[];
}

/** Turn rename spans into applicable edits by substituting the new name. */
export function renameSpansToEdits(groups: RenameSpanGroup[], newName: string): TsFileEdits[] {
	return groups.map((group) => ({
		file: group.file,
		edits: group.locs.map((loc) => ({
			start: loc.start,
			end: loc.end,
			newText: `${loc.prefixText ?? ""}${newName}${loc.suffixText ?? ""}`,
		})),
	}));
}

/**
 * What `getEditsForFileRename` returns — and it is NOT the `rename` shape.
 *
 * Two commands in the same protocol use different field names for the same
 * idea: `rename` gives `{file, locs}` with spans and no text, while
 * `getEditsForFileRename` gives `{fileName, textChanges}` with `newText`
 * included. Reading the second with the first's field names yields an array of
 * `undefined`s that filters to empty — so the move reports "no importers
 * referenced it", performs the move anyway, and leaves every import broken with
 * a success message. Measured; it does not surface as a type error because the
 * response is `unknown` at the protocol boundary.
 */
export interface FileRenameEdits {
	fileName: string;
	textChanges: TsEdit[];
}

export function fileRenameEditsToFileEdits(groups: FileRenameEdits[]): TsFileEdits[] {
	return groups
		.filter((group) => Array.isArray(group?.textChanges) && group.textChanges.length > 0)
		.map((group) => ({ file: group.fileName, edits: group.textChanges }));
}

export type ApplyResult =
	| { ok: true; files: { file: string; edits: number }[] }
	| { ok: false; blocked: string[]; reason: string }
	| { ok: false; blocked?: undefined; reason: string };

/**
 * Convert tsserver's 1-based {line, offset} to a string index.
 *
 * `offset` is 1-based within the line and counts UTF-16 code units, which is
 * what JavaScript string indices are — so no conversion is needed there, but
 * the off-by-one on both axes is real and silent if you get it wrong.
 */
export function toIndex(text: string, position: { line: number; offset: number }): number {
	let index = 0;
	for (let line = 1; line < position.line; line++) {
		const next = text.indexOf("\n", index);
		if (next < 0) return text.length;
		index = next + 1;
	}
	return Math.min(index + position.offset - 1, text.length);
}

/**
 * Apply one file's edits to its text.
 *
 * Applied last-first so each edit's indices stay valid: computing every index
 * up front and applying in document order shifts everything after the first
 * replacement whose length changed.
 */
export function applyEdits(text: string, edits: TsEdit[]): string {
	const ordered = [...edits].sort((a, b) => {
		if (a.start.line !== b.start.line) return b.start.line - a.start.line;
		return b.start.offset - a.start.offset;
	});
	let result = text;
	for (const edit of ordered) {
		const start = toIndex(result, edit.start);
		const end = toIndex(result, edit.end);
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return result;
}

/**
 * Read → transform → write, atomically across files.
 *
 * "Atomic" here means no partial APPLICATION, not crash-safety: the writes are
 * ordinary and a power cut mid-loop still tears. That is the same guarantee the
 * built-in `edit` tool gives, and buying more would mean a temp-file-and-rename
 * dance across a set of files that may span filesystems.
 */
export async function applyFileEdits(fileEdits: TsFileEdits[], toolLabel: string): Promise<ApplyResult> {
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
		staged.push({ file: fileEdit.file, text: applyEdits(original, fileEdit.edits), edits: fileEdit.edits.length });
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
					`WARNING: earlier files in this rename were already written — the tree is now inconsistent. ` +
					`Check \`git diff\` before continuing.`,
			};
		}
	}
	return { ok: true, files: staged.map((s) => ({ file: s.file, edits: s.edits })) };
}
