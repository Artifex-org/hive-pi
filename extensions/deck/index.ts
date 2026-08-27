/**
 * deck — the one pinned widget between the transcript and the editor
 * (HIV-1219).
 *
 * Before this extension, five in-house widget keys (`tasks`, `plan`,
 * `conductor`, `agenda-run`, `subagent-status`) competed for the
 * `aboveEditor` band in Map insertion order, each with its own spacing and
 * its own idea of how much room to take. Now there is exactly one key,
 * `deck`, and the former owners publish section state over `pi.events`
 * (see protocol.ts for why a bus and not a shared module).
 *
 * The widget is a COMPONENT FACTORY, not a string array, deliberately:
 * string-array widgets are hard-truncated at 10 lines by pi
 * (`MAX_WIDGET_LINES`), factory widgets are not — and the expanded view can
 * legitimately exceed 10 lines. The deck enforces its own cap instead
 * (render.ts `TOTAL_CAP`), because escaping pi's guard means inheriting its
 * job.
 *
 * Nothing mutable at module scope — pi builds a fresh jiti per extension
 * entry with `moduleCache:false`, so state lives in the factory closure.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, sanitizeSectionEvent } from "./protocol.ts";
import type { DeckSectionId, DeckSectionState } from "./protocol.ts";
import { type DeckMode, type DeckStyle, isLive, renderDeck } from "./render.ts";

function themeStyle(theme: Theme): DeckStyle {
	return {
		accent: (text) => theme.fg("accent", text),
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
		muted: (text) => theme.fg("muted", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
	};
}

export default function (pi: ExtensionAPI) {
	const sections = new Map<DeckSectionId, DeckSectionState>();
	let mode: DeckMode = "auto";
	/**
	 * The most recent ctx, so a bus-triggered repaint has one to paint through.
	 * Goes stale on session replacement; every use is guarded. Same pattern and
	 * same reason as agenda's heldCtx.
	 */
	let heldCtx: ExtensionContext | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	/**
	 * One 1 s repaint interval, running only while a live section is showing
	 * elapsed time (running subagents compute elapsed at render time; the deck
	 * owns their tick so the publisher does not have to re-emit unchanged
	 * state every second).
	 */
	const syncTimer = () => {
		const wantTimer = mode !== "collapsed" && [...sections.values()].some(isLive);
		if (wantTimer && !timer) {
			timer = setInterval(() => paint(), 1_000);
			timer.unref?.();
		} else if (!wantTimer) {
			stopTimer();
		}
	};

	/** Cosmetic by definition — never fail anything because a widget could not draw. */
	const paint = () => {
		const ctx = heldCtx;
		if (!ctx) return;
		try {
			if (ctx.mode !== "tui") return;
			if (sections.size === 0) {
				ctx.ui.setWidget("deck", undefined);
				stopTimer();
				return;
			}
			ctx.ui.setWidget("deck", (_tui, theme) => {
				const container = new Container();
				const lines = renderDeck(sections, mode, Date.now(), themeStyle(theme));
				for (const line of lines ?? []) container.addChild(new Text(line, 0, 0));
				return container;
			});
			syncTimer();
		} catch {
			/* session replaced, or a mode without widgets */
		}
	};

	pi.events.on(DECK_SECTION_CHANNEL, (payload) => {
		const event = sanitizeSectionEvent(payload);
		if (!event) return;
		if (event.state === null) sections.delete(event.section);
		else sections.set(event.section, event.state);
		paint();
	});

	pi.on("session_start", (_event, ctx) => {
		heldCtx = ctx;
		// Load order is unknown; ask everyone to re-state what they know.
		try {
			pi.events.emit(DECK_SYNC_CHANNEL, {});
		} catch {
			/* no bus, or nothing listening */
		}
		paint();
	});

	pi.on("session_shutdown", () => stopTimer());

	const setMode = (next: DeckMode, ctx?: ExtensionContext) => {
		mode = next;
		if (ctx) heldCtx = ctx;
		paint();
	};

	pi.registerCommand("deck", {
		description: "Agent deck: /deck [expand|collapse|auto] — bare /deck toggles collapsed",
		handler: async (args: string, ctx: ExtensionContext) => {
			const argument = args.trim().toLowerCase();
			if (argument === "expand" || argument === "expanded") setMode("expanded", ctx);
			else if (argument === "collapse" || argument === "collapsed") setMode("collapsed", ctx);
			else if (argument === "auto" || argument === "") setMode(argument === "" ? (mode === "collapsed" ? "auto" : "collapsed") : "auto", ctx);
			else {
				ctx.ui.notify(`deck: unknown argument "${args.trim()}" — try /deck, /deck expand, /deck collapse, or /deck auto.`, "warning");
				return;
			}
			ctx.ui.notify(`deck: ${mode}${sections.size === 0 ? " (nothing to show right now)" : ""}`, "info");
		},
	});

	// ctrl+t is taken by pi core, ctrl+alt+* is the house shortcut namespace
	// (personalization.ts). Cycle auto → expanded → collapsed → auto: one key
	// reaches every mode, and the widget's own change is the feedback.
	pi.registerShortcut("ctrl+alt+t", {
		description: "Cycle the agent deck (auto → expanded → collapsed)",
		handler: (ctx: ExtensionContext) => {
			const next: DeckMode = mode === "auto" ? "expanded" : mode === "expanded" ? "collapsed" : "auto";
			setMode(next, ctx);
		},
	});
}
