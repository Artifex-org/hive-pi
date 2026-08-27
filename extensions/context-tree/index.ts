/**
 * context-tree — `/context`, the per-agent cost tree (HIV-1243, prime half).
 *
 * The question this answers is "where did this session's tokens go", which
 * neither existing surface can: the footer sums the session and stops there,
 * and a subagent's usage line is buried in the tool result that produced it,
 * one screen per agent. Fanning out over a dozen workers makes that the only
 * number anyone wants and the hardest one to see.
 *
 * ALL the arithmetic and layout is in ./tree.ts, which imports nothing from
 * pi. This file is the thin part: read the session, render, persist the
 * envelope. That split is why the "rows sum exactly" property is checkable
 * without a TUI.
 *
 * NO EVENT HANDLERS AT ALL. pi awaits handlers serially, so a handler that
 * walked the transcript on every message would put an O(session) fold in the
 * agent loop for a readout nobody is looking at. The whole cost of this
 * extension is paid when the human types `/context`.
 *
 * No config file either: a command is opt-in by being typed, it sends nothing
 * off the machine, and it changes no posture — so there is nothing for the
 * settings page to hold.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { type ReportLine, buildTree, contextTreeEnvelope, renderReport } from "./tree.ts";

/**
 * Persisted with `appendEntry`, NOT `sendMessage`: this is the operator's
 * record, and a cost-inspection command that grows the model's context every
 * time it is run would be a cost bug of its own. Same reasoning as `brief`.
 */
const ENTRY_TYPE = "context-tree";

/**
 * `as const` is load-bearing: pi's `Theme.fg` takes a `ThemeColor` union, so
 * a `Record<…, string>` here would not typecheck at the call site.
 */
const TONE_COLORS = {
	head: "muted",
	row: "dim",
	warn: "error",
	total: "accent",
	note: "muted",
} as const satisfies Record<ReportLine["tone"], string>;

/**
 * What the root row knows about itself. `getContextUsage()` is the live
 * reading; `ctx.model.contextWindow` is the fallback divisor for a session
 * that has not yet been told its own window — the same two-step
 * status-footer's gauge uses, and for the same reason: an empty gauge against
 * a known window is information, a missing row is not.
 */
function rootFacts(ctx: ExtensionContext): { label: string; contextTokens: number | null; contextWindow: number | null } {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	return {
		label: model ? `session · ${model.provider}/${model.id}` : "session",
		contextTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? null,
	};
}

/** The branch, or nothing — a session replaced mid-read must not take the command with it. */
function readBranch(ctx: ExtensionContext): readonly unknown[] {
	try {
		return ctx.sessionManager.getBranch() as readonly unknown[];
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Where this session's tokens went: one row per agent, own spend only",
		handler: async (_args: string, ctx: ExtensionContext): Promise<void> => {
			// Read every ctx property BEFORE the first await: the ctx can go stale
			// across one, and the overlay below awaits for as long as the human
			// leaves it open.
			const mode = ctx.mode;
			const root = buildTree(readBranch(ctx), rootFacts(ctx));
			const lines = renderReport(root);

			try {
				pi.appendEntry(ENTRY_TYPE, contextTreeEnvelope(root));
			} catch {
				/* no session to append to — the readout is still worth showing */
			}

			if (mode !== "tui") {
				ctx.ui.notify(lines.map((line) => line.text).join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => ({
					render(width: number): string[] {
						const contentWidth = Math.max(1, width - 4);
						return [
							theme.fg("accent", "context"),
							// Truncate BEFORE colouring: an ANSI sequence cut in half
							// bleeds its colour into the rest of the overlay.
							...lines.map((line) => theme.fg(TONE_COLORS[line.tone], truncateToWidth(line.text, contentWidth))),
							theme.fg("dim", "Esc or Enter to close"),
						];
					},
					invalidate() {},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
						tui.requestRender();
					},
				}),
				{
					overlay: true,
					overlayOptions: { width: "80%", minWidth: 56, maxHeight: "70%", anchor: "center", margin: 2 },
				},
			);
		},
	});
}
