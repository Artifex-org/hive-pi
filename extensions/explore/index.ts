/**
 * explore — the pi wiring for `/explore`. All the reasoning about WHAT an
 * exploration is lives in ./state.ts; this file is the command, the two reads it
 * makes off the session, and the two writes it makes to it.
 *
 * NO EVENT HANDLERS, AND NO CLOSURE STATE. Both are decisions, not omissions.
 *
 * No handlers, because pi awaits them serially and an exploration is a thing that
 * happens over twenty minutes of the operator's time — there is nothing to
 * observe per message, and a handler that folded the transcript on every turn
 * would put an O(session) scan in the agent loop for a readout nobody is looking
 * at (`context-tree/index.ts` reaches the same conclusion for the same reason).
 * The whole cost of this extension is paid when the human types `/explore`.
 *
 * No closure state, because the log lives in the session file and this command is
 * the only writer. Rehydrating from `getEntries()` on every invocation costs one
 * backwards scan and buys the property that makes the feature worth having: the
 * record survives a `/tree` to another branch, a compaction, and a fork. A cached
 * copy in a closure would diverge from the file the first time either happened.
 *
 * WHY `getEntries()` AND NOT `getBranch()`. This is the load-bearing read.
 * `getBranch()` is the root→leaf path of the ACTIVE branch, and the whole shape
 * of this workflow is: open an exploration, `/tree` off to a side branch, work,
 * `/tree` back, close. The snapshot appended while on the side branch is NOT on
 * the trunk's path afterwards — so a `getBranch()` reader would lose the record
 * at exactly the moment the operator asks for the report. `getEntries()` returns
 * every entry in the file regardless of branch, which is what "what has this
 * session explored" means.
 *
 * WHAT IT DOES NOT DO. It never calls `ctx.navigateTree()` or `ctx.fork()`, both
 * of which pi really does expose on a command context
 * (`core/extensions/types.d.ts:268` and `:275`). That is the subject of the
 * README; the short version is that where to branch from is a judgement this
 * command does not have, and a wrong automatic branch is expensive to undo.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	EXPLORE_ENTRY_TYPE,
	close,
	formatDuration,
	openExploration,
	parseExploreCommand,
	rehydrate,
	renderList,
	renderReport,
	renderStart,
	start,
	toEntry,
	touchedSince,
	type ExploreLog,
} from "./state.ts";

/**
 * The session's entries, or none.
 *
 * A session replaced mid-command makes every `ctx` property access throw, and a
 * failure here should cost the history, not the command: an `/explore done` that
 * threw would leave the operator with an exploration they cannot close.
 */
function readEntries(ctx: ExtensionCommandContext): readonly unknown[] {
	try {
		return ctx.sessionManager.getEntries() as readonly unknown[];
	} catch {
		return [];
	}
}

/**
 * The entry the exploration starts from, when there is one.
 *
 * `getLeafId` is part of pi's `ReadonlySessionManager`, but it is read through a
 * `typeof … === "function"` check anyway: a session with no file has no entry ids
 * to hand out, and the record's contract (`entryId: string | null`) already says
 * that null is a normal outcome. An exploration whose purpose survived is worth
 * more than one that refused to open because it could not cite a position.
 */
function readLeafId(ctx: ExtensionCommandContext): string | null {
	try {
		const manager = ctx.sessionManager as { getLeafId?: () => string | null | undefined };
		if (typeof manager.getLeafId !== "function") return null;
		return manager.getLeafId() ?? null;
	} catch {
		return null;
	}
}

/**
 * Persist the whole log.
 *
 * Wrapped, because an ephemeral session has nothing to append to and the printed
 * report is still the thing the operator asked for. Same stance as
 * `context-tree/index.ts:87`. The return value says whether the record is
 * durable, so the caller can be honest about it rather than implying a write that
 * did not happen.
 */
function persist(pi: ExtensionAPI, log: ExploreLog): boolean {
	try {
		pi.appendEntry(EXPLORE_ENTRY_TYPE, toEntry(log));
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("explore", {
		description:
			"Label a side-branch with its purpose and collapse it to a report (`/explore <purpose>`, `/explore done [conclusion]`, `/explore`)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			// Everything is read off ctx here, before anything else: a handler that
			// reads ctx after an await can find every property throwing, and
			// `ui.notify` below is the one thing that must still work then.
			const ui = ctx.ui;
			const entries = readEntries(ctx);
			const leafId = readLeafId(ctx);
			const now = Date.now();

			const command = parseExploreCommand(args);
			const log = rehydrate(entries);

			if (command.kind === "list") {
				ui.notify(renderList(log, now).join("\n"));
				return;
			}

			if (command.kind === "start") {
				const result = start(log, { purpose: command.purpose, entryId: leafId, nowMs: now });
				if (!result.ok) {
					// Unreachable through this parser — a whitespace-only argument is
					// read as a listing, so `start` is never called with nothing. Kept
					// because `start` is a total function whose refusals are values,
					// and a caller that handled only some of them would be one parser
					// change away from opening an exploration with no purpose.
					if (result.reason === "empty-purpose") {
						ui.notify("explore: say what you are going to find out — `/explore <purpose>`.", "error");
						return;
					}
					// The refusal carries the open exploration's own purpose, because
					// the person typing `/explore` a second time is usually the person
					// who has forgotten what the first one was for.
					const age = formatDuration(now - result.open.startedAtMs);
					ui.notify(
						[
							`explore: ${result.open.id} is already open (${age}) — "${result.open.purpose}".`,
							"  `/explore done [conclusion]` closes it, then open the next one.",
						].join("\n"),
						"error",
					);
					return;
				}

				const durable = persist(pi, result.log);
				const lines = renderStart(result.record, result.clamped);
				if (!durable) lines.push("  (this session is not persisted — the record dies with it)");
				ui.notify(lines.join("\n"));
				return;
			}

			// `done`. The report is ASSEMBLED, never generated: the purpose and the
			// conclusion are the operator's own words, and the rest is a fold over
			// entries the session already holds. No model call — see state.ts.
			const open = openExploration(log);
			const touched = open ? touchedSince(entries, open.startedAtMs) : { files: [], artifacts: [] };
			const result = close(log, {
				conclusion: command.conclusion,
				nowMs: now,
				files: touched.files,
				artifacts: touched.artifacts,
			});

			if (!result.ok) {
				const tail = result.last
					? ` The last one (${result.last.id}) closed ${formatDuration(now - (result.last.endedAtMs ?? now))} ago.`
					: "";
				ui.notify(`explore: nothing open to close.${tail} \`/explore <purpose>\` starts one.`, "error");
				return;
			}

			const durable = persist(pi, result.log);
			const lines = renderReport(result.record, now);
			if (result.clamped) lines.push("", "(conclusion clamped for the record)");
			if (!durable) lines.push("", "(not persisted — this session has no file)");
			ui.notify(lines.join("\n"));
		},
	});
}
