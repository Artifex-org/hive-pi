/**
 * Live-session migration between directories.
 *
 * Adapted from `@thurstonsand/pi-wt` (MIT) — the one genuinely good trick in
 * that package: snapshot the session, rewrite the header's `cwd`, write it
 * into the DESTINATION's session store, `ctx.switchSession` onto it, and only
 * then delete the old file. The prepared file is discarded on cancel or
 * failure, so a half-move never leaves two live copies of one session.
 *
 * The migration notice is a MESSAGE, not a notification, deliberately: the
 * model's cwd just changed under it, and a fact the model must know cannot
 * live in UI chrome it never sees.
 */

import { mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const MOVE_NOTICE_TYPE = "worktrees-session-move";

export interface MoveNoticeDetails {
	fromCwd: string;
	toCwd: string;
	removedWorktree?: string;
}

export interface PreparedMigration {
	oldCwd: string;
	oldPath: string;
	newCwd: string;
	newPath: string;
}

export async function ensureDirectory(target: string): Promise<void> {
	const stats = await stat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new Error(`destination does not exist: ${target}`);
		throw error;
	});
	if (!stats.isDirectory()) throw new Error(`destination is not a directory: ${target}`);
}

export function isPersisted(ctx: ExtensionCommandContext): boolean {
	return ctx.sessionManager.getSessionFile() !== undefined;
}

async function prepareMigration(ctx: ExtensionCommandContext, destination: string): Promise<PreparedMigration> {
	const header = ctx.sessionManager.getHeader();
	if (!header) throw new Error("the current session has no valid header");
	const oldPath = ctx.sessionManager.getSessionFile();
	if (!oldPath) throw new Error("this in-memory session cannot move — start pi in the destination instead");

	const newCwd = await realpath(destination);
	const oldCwd = ctx.sessionManager.getCwd();
	const newPath = resolve(SessionManager.create(newCwd).getSessionDir(), basename(oldPath));
	if (resolve(oldPath) === newPath) throw new Error(`the session is already stored for ${newCwd}`);

	const entries = ctx.sessionManager.getEntries();
	const serialized = `${[{ ...header, cwd: newCwd }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	await mkdir(dirname(newPath), { recursive: true });
	await writeFile(newPath, serialized, { encoding: "utf8", flag: "w" });
	return { oldCwd, oldPath, newCwd, newPath };
}

async function discard(migration: PreparedMigration): Promise<void> {
	await unlink(migration.newPath).catch(() => {});
}

export interface MigrateOptions {
	/** Runs after the switch, from the NEW session's ctx. Returns extra notice
	 *  text (e.g. "old worktree removed") or throws to report-and-continue. */
	afterSwitch?: () => Promise<string | undefined>;
}

/** Returns true when the session actually moved. */
export async function migrateSession(
	ctx: ExtensionCommandContext,
	destination: string,
	options: MigrateOptions = {},
): Promise<boolean> {
	const migration = await prepareMigration(ctx, destination);

	let result: { cancelled: boolean };
	try {
		result = await ctx.switchSession(migration.newPath, {
			withSession: async (replacementCtx) => {
				await unlink(migration.oldPath).catch(() => {
					replacementCtx.ui.notify(`session moved, but the old file could not be removed: ${migration.oldPath}`, "warning");
				});

				let extra: string | undefined;
				if (options.afterSwitch) {
					try {
						extra = await options.afterSwitch();
					} catch (error) {
						replacementCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				}

				const content = [
					`Session moved to \`${migration.newCwd}\`; paths under \`${migration.oldCwd}\` now resolve there.`,
					...(extra ? [extra] : []),
				].join(" ");
				const details: MoveNoticeDetails = {
					fromCwd: migration.oldCwd,
					toCwd: migration.newCwd,
					...(extra ? { removedWorktree: migration.oldCwd } : {}),
				};
				try {
					replacementCtx.sendMessage({ customType: MOVE_NOTICE_TYPE, content, display: true, details });
				} catch {
					replacementCtx.ui.notify(content, "info");
				}
			},
		});
	} catch (error) {
		await discard(migration);
		throw error;
	}

	if (result.cancelled) {
		await discard(migration);
		return false;
	}
	return true;
}
