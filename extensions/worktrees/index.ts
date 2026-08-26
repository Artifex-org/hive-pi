/**
 * worktrees — gwq-native `/wt` + `/mv` (HIV-1223, replacing
 * `@thurstonsand/pi-wt`).
 *
 * The external package shelled out to `wt`, a tool that knows nothing about
 * this machine's layout: no gwq `setup_command` (submodules, pnpm install,
 * uv sync), no bare-repo `__worktrees/` convention, no pull-only anchors —
 * the exact failure class that got `herdr worktree create` wrapped and raw
 * `git worktree add` guard-blocked. This one speaks gwq and refuses the two
 * moves the guards exist for:
 *
 *  - a session never moves INTO a pull-only anchor (`…__worktrees/main` /
 *    `feature`): hive-pi's anchor IS the live stowed config, anchors are
 *    hard-reset hourly by repo-sync, and non-git mutations there are blocked.
 *  - `/wt rm` of the current worktree first migrates the session to the
 *    anchor, then removes — never `rm -rf` under a live session.
 *
 * gwq is only ever given EXACT branch names (resolution happens in
 * model.ts): an ambiguous pattern makes gwq open a fuzzy finder, which
 * inside a command handler is a hung process.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	anchorOf,
	formatList,
	isPullOnlyAnchor,
	parseWorktreeList,
	parseWtArgs,
	resolveWorktree,
	type WorktreeInfo,
} from "./model.ts";
import { ensureDirectory, isPersisted, migrateSession, MOVE_NOTICE_TYPE, type MoveNoticeDetails } from "./session-move.ts";

const ANCHOR_REFUSAL =
	"that is a pull-only anchor (repo-sync hard-resets it; mutations there are guard-blocked). Fork a work worktree instead: /wt fork <branch>";

function expandPath(input: string, cwd: string): string {
	const expanded = input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
	return path.resolve(cwd, expanded);
}

export default function (pi: ExtensionAPI) {
	/** `gwq` from PATH, falling back to the known install location — pi may be
	 *  launched from an environment that never sourced the shell profile. */
	let gwqCommand = "gwq";

	const runGwq = async (cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
		const first = await pi.exec(gwqCommand, args, { cwd }).catch(() => null);
		if (first !== null) return first;
		gwqCommand = path.join(os.homedir(), "go", "bin", "gwq");
		return pi.exec(gwqCommand, args, { cwd });
	};

	const listWorktrees = async (cwd: string): Promise<WorktreeInfo[]> => {
		const result = await runGwq(cwd, ["list", "--json"]);
		return result.code === 0 ? parseWorktreeList(result.stdout) : [];
	};

	const moveTo = async (ctx: ExtensionCommandContext, destination: string, afterSwitch?: () => Promise<string | undefined>) => {
		if (!isPersisted(ctx)) {
			ctx.ui.notify(`this in-memory session cannot move to ${destination}; start pi there instead.`, "warning");
			return;
		}
		await ctx.waitForIdle();
		try {
			await migrateSession(ctx, destination, afterSwitch ? { afterSwitch } : {});
		} catch (error) {
			ctx.ui.notify(`wt: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerMessageRenderer<MoveNoticeDetails>(MOVE_NOTICE_TYPE, (message, _options, theme: Theme) => {
		const details = message.details;
		const arrow = details ? `${details.fromCwd} → ${details.toCwd}` : "";
		return new Text(theme.fg("accent", "⇄ session moved") + (arrow ? theme.fg("dim", `  ${arrow}`) : ""), 0, 0);
	});

	pi.registerCommand("wt", {
		description: "Worktrees via gwq: /wt [list] · fork <branch> · checkout <pattern> · rm [pattern]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["list", "fork ", "checkout ", "rm"];
			const matches = subs.filter((sub) => sub.startsWith(prefix.trimStart()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value.trim() })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = parseWtArgs(args);
			if ("error" in command) {
				ctx.ui.notify(`wt: ${command.error}`, "warning");
				return;
			}

			const list = await listWorktrees(ctx.cwd);
			if (list.length === 0 && command.sub !== "fork") {
				ctx.ui.notify("wt: no worktrees here (or gwq is unavailable).", "warning");
				return;
			}

			switch (command.sub) {
				case "list": {
					ctx.ui.notify(formatList(list, ctx.cwd).join("\n"), "info");
					return;
				}

				case "fork": {
					const add = await runGwq(ctx.cwd, ["add", "-b", command.branch]);
					if (add.code !== 0) {
						ctx.ui.notify(`wt: gwq add failed: ${(add.stderr || add.stdout).trim()}`, "error");
						return;
					}
					const resolved = resolveWorktree(await listWorktrees(ctx.cwd), command.branch);
					if (!resolved.ok) {
						ctx.ui.notify(`wt: created, but could not locate the new worktree (${resolved.error})`, "error");
						return;
					}
					await moveTo(ctx, resolved.worktree.path);
					return;
				}

				case "checkout": {
					const resolved = resolveWorktree(list, command.pattern);
					if (!resolved.ok) {
						ctx.ui.notify(`wt: ${resolved.error}`, "warning");
						return;
					}
					if (isPullOnlyAnchor(resolved.worktree.path)) {
						ctx.ui.notify(`wt: ${ANCHOR_REFUSAL}`, "warning");
						return;
					}
					await moveTo(ctx, resolved.worktree.path);
					return;
				}

				case "rm": {
					const here = path.resolve(ctx.cwd);
					const target = command.pattern
						? resolveWorktree(list, command.pattern)
						: ((): ReturnType<typeof resolveWorktree> => {
								const current = list.find((worktree) => path.resolve(worktree.path) === here);
								return current
									? { ok: true, worktree: current }
									: { ok: false, error: "the current directory is not a listed worktree — pass a pattern" };
							})();
					if (!target.ok) {
						ctx.ui.notify(`wt: ${target.error}`, "warning");
						return;
					}
					if (isPullOnlyAnchor(target.worktree.path)) {
						ctx.ui.notify(`wt: refusing to remove a pull-only anchor.`, "warning");
						return;
					}

					const confirmed = await ctx.ui.confirm(
						"Remove worktree?",
						`${target.worktree.branch}\n${target.worktree.path}\n\nThe directory is removed via gwq; the branch is kept (the weekly cleanup handles merged branches). A dirty worktree is refused.`,
					);
					if (!confirmed) {
						ctx.ui.notify("wt: nothing removed.", "info");
						return;
					}

					const removingCurrent = path.resolve(target.worktree.path) === here;
					if (removingCurrent) {
						const anchor = anchorOf(list);
						if (!anchor || path.resolve(anchor.path) === here) {
							ctx.ui.notify("wt: no anchor worktree to land the session on — /wt checkout elsewhere first.", "warning");
							return;
						}
						const branch = target.worktree.branch;
						const anchorPath = anchor.path;
						await moveTo(ctx, anchorPath, async () => {
							const removal = await runGwq(anchorPath, ["remove", branch]);
							if (removal.code !== 0) throw new Error(`gwq remove failed: ${(removal.stderr || removal.stdout).trim()}`);
							return `The old worktree (\`${branch}\`) was removed.`;
						});
						return;
					}

					const removal = await runGwq(ctx.cwd, ["remove", target.worktree.branch]);
					if (removal.code !== 0) {
						ctx.ui.notify(`wt: gwq remove failed: ${(removal.stderr || removal.stdout).trim()}`, "error");
						return;
					}
					ctx.ui.notify(`wt: removed ${target.worktree.branch} (branch kept).`, "info");
					return;
				}
			}
		},
	});

	pi.registerCommand("mv", {
		description: "Move this live session to another directory",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("usage: /mv <dir>", "warning");
				return;
			}
			const destination = expandPath(raw, ctx.cwd);
			try {
				await ensureDirectory(destination);
			} catch (error) {
				ctx.ui.notify(`mv: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (isPullOnlyAnchor(destination)) {
				ctx.ui.notify(`mv: ${ANCHOR_REFUSAL}`, "warning");
				return;
			}
			await moveTo(ctx, destination);
		},
	});
}
