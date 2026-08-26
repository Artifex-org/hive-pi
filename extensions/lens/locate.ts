/**
 * What to say when the FILE is not there.
 *
 * `read_symbol` already handles a missing SYMBOL well — it names `grep` and
 * `list_symbols` so an agent cannot conclude the name does not exist just
 * because one tool could not see it. A missing FILE had no such answer: the
 * read threw, and the tool call failed with a bare `ENOENT`.
 *
 * That is the same failure one step earlier, and it is what agents actually
 * hit, because the path is usually INFERRED rather than known:
 *
 *   internal/retention/reaper.go   → the package is retention.go
 *   internal/mcp/mcp_test.go       → the helpers are in agentops_test.go
 *   .../machine_parameter_catalog/validation.py
 *
 * Every one costs a grep round-trip to learn something the directory listing
 * already knew. So on the miss — and only on the miss — say which part of the
 * path is real and what is actually next to it.
 *
 * Bounded by construction: ONE directory read, no recursion, no repo scan, a
 * capped list. A diagnostic that walks a tree is a diagnostic that can cost
 * more than the failure it explains.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";

/** How many neighbours to name. Enough to recognise the file, short enough to read. */
const MAX_NEIGHBOURS = 12;

/** Is this the error that means "nothing at that path"? */
export function isNotFound(err: unknown): boolean {
	const code = (err as { code?: string } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

async function isDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Rank a directory's entries by how likely each is the one that was meant.
 *
 * Same STEM first (`reaper.go` → `reaper.ts`), then the same extension, then
 * everything else. Deliberately not a fuzzy-distance score: the point is to
 * put the answer where it will be seen, and a wrong ranking of a list this
 * short costs nothing, while a scoring function nobody can predict is one more
 * thing to be surprised by.
 */
function rank(entries: string[], wanted: string): string[] {
	const stem = basename(wanted, extname(wanted));
	const ext = extname(wanted);
	const score = (name: string): number => {
		if (basename(name, extname(name)) === stem) return 0;
		if (ext !== "" && extname(name) === ext) return 1;
		return 2;
	};
	return [...entries].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/**
 * describeMissingFile explains a path that is not there.
 *
 * Two shapes, because they are different situations and want different next
 * moves: the directory exists and the FILE is wrong (here is what is in it), or
 * the path diverges higher up (here is the last real directory). Conflating
 * them is what a bare ENOENT does.
 *
 * Never throws: it runs on a failure path, and a diagnostic that can fail is
 * worse than the error it was explaining.
 */
export async function describeMissingFile(file: string): Promise<string> {
	const path = resolve(file);
	const parent = dirname(path);
	const wanted = basename(path);

	try {
		if (await isDir(parent)) {
			const entries = (await readdir(parent, { withFileTypes: true }))
				.filter((e) => !e.name.startsWith("."))
				.map((e) => (e.isDirectory() ? `${e.name}${sep}` : e.name));
			if (entries.length === 0) {
				return `${file} does not exist. Its directory exists but is empty.`;
			}
			const ranked = rank(entries, wanted);
			const shown = ranked.slice(0, MAX_NEIGHBOURS);
			const more = ranked.length - shown.length;
			return (
				`${file} does not exist. Its directory does — these are in it` +
				`${more > 0 ? ` (${shown.length} of ${ranked.length})` : ""}:\n` +
				shown.map((n) => `  ${n}`).join("\n") +
				(more > 0 ? `\n  … and ${more} more` : "") +
				`\n\nIf none of these is what you meant, \`grep\` for the symbol rather than guessing another path.`
			);
		}

		// The directory itself is missing, so the path went wrong ABOVE the
		// filename — naming the neighbours of a directory that does not exist
		// would answer a question nobody asked. Find where it stops being real.
		let cursor = parent;
		while (cursor !== dirname(cursor) && !(await isDir(cursor)))
			cursor = dirname(cursor);
		const diverged = parent.slice(cursor.length).split(sep).filter(Boolean)[0];
		const entries = (await readdir(cursor, { withFileTypes: true }))
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => `${e.name}${sep}`);
		const shown = rank(entries, diverged ?? "").slice(0, MAX_NEIGHBOURS);
		const head =
			`${file} does not exist, and neither does its directory. ` +
			`The path stops being real at \`${diverged ?? wanted}\`.`;
		if (shown.length === 0) return head;
		return (
			`${head} ${cursor} contains:\n` + shown.map((n) => `  ${n}`).join("\n")
		);
	} catch {
		// Unreadable directory, a permissions boundary, a race with a delete —
		// fall back to the plain fact, which is still true.
		return `${file} does not exist.`;
	}
}
