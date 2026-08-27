/**
 * settings — one page for every hive-pi toggle (`/toggles`).
 *
 * Until now each extension owned a config file and, at best, a `-status`
 * command that printed it. That is fine when you know which extension owns the
 * behaviour you want to change and worthless when you do not, which is the
 * usual case. This is the index.
 *
 * THE COMMAND IS `/toggles`, NOT `/settings`. `settings` is one of pi's own
 * BUILTIN_SLASH_COMMANDS (core/slash-commands.js), and a builtin always wins:
 * `getBuiltInCommandConflictDiagnostics` filters any extension command whose
 * name collides, and the invocation-name fallback that rescues extension-vs-
 * extension collisions does NOT apply here — `runner.js` only assigns a
 * suffixed `invocationName` when two EXTENSIONS claim one name, so a builtin
 * collision degrades all the way to "Skipping in autocomplete." The page was
 * therefore unreachable: every session printed the conflict warning, the row
 * was gone from autocomplete, and typing the name ran pi's builtin instead.
 * Verified against pi-coding-agent 2.20.x on 2026-08-19. The directory keeps
 * its `settings/` name — only the slash command had to move.
 *
 * TWO HONESTIES THE PAGE OWES THE USER, both implemented rather than
 * documented-and-ignored:
 *
 * 1. **A toggle does not take effect now.** Every extension in this package
 *    reads its config once, in its factory, and several return early and
 *    register nothing when disabled — which is deliberate (see
 *    `narrate/index.ts` on why a no-op handler is worse than no handler). So a
 *    flag flipped here applies at the next session or `/reload`, and the page
 *    says so on every change instead of letting you conclude it is broken.
 *
 * 2. **A failed write must not look like a successful one.** The row reflects
 *    what is on disk, never what you just pressed: on a write error the value
 *    is rolled back in the view and the error is shown.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";

import { atomicWrite, configPathFor, readJSON } from "../hive-common/identity.ts";
import {
	SETTINGS,
	navigationOrder,
	readSetting,
	writeSetting,
	type SettingRow,
	type SettingSpec,
} from "./registry.ts";
import {
	PLAIN_SETTINGS_STYLE,
	moveCursor,
	renderSettingsLines,
	switchLabel,
	type SettingsStyle,
	type SettingsViewState,
} from "./view.ts";

const RELOAD_NOTE = "saved — takes effect in the next session or after /reload";

function loadRows(): SettingRow[] {
	return SETTINGS.map((spec) => ({
		spec,
		value: readSetting(readJSON<Record<string, unknown>>(configPathFor(spec.config)), spec),
	}));
}

/** Returns an error message, or null on success. */
function persist(spec: SettingSpec, value: boolean): string | null {
	try {
		const path = configPathFor(spec.config);
		const raw = readJSON<Record<string, unknown>>(path);
		atomicWrite(path, `${JSON.stringify(writeSetting(raw, spec, value), null, "\t")}\n`);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function styleFrom(theme: ExtensionContext["ui"]["theme"]): SettingsStyle {
	return {
		accent: (text) => theme.fg("accent", text),
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
		muted: (text) => theme.fg("muted", text),
		warning: (text) => theme.fg("warning", text),
		success: (text) => theme.fg("success", text),
	};
}

/** What a keypress means to the overlay. `null` is "not ours, ignore it". */
export type SettingsAction = "close" | "up" | "down" | "toggle";

/**
 * Route a raw terminal keypress.
 *
 * MUST GO THROUGH `matchesKey`/`parseKey`, NEVER through a byte comparison, and
 * the first version of this file got that wrong in a way no test could see. It
 * compared `data === "\x1b"`, `"\x1b[A"`, `" "` and `"\r"` directly. Those are
 * the *legacy* encodings. pi negotiates the Kitty keyboard protocol at startup
 * (`pi-tui/terminal.js` → `setKittyProtocolActive(true)`) and every terminal on
 * this workstation — Ghostty — accepts, after which the same keys arrive as
 * CSI-u sequences instead:
 *
 *     esc    \x1b      ->  \x1b[27u      space  " "   ->  \x1b[32u
 *     enter  \r        ->  \x1b[13u      k      "k"   ->  \x1b[107u
 *
 * Arrow keys keep their legacy form, so the observable failure was an overlay
 * where the arrows moved the cursor and NOTHING ELSE WORKED — including esc and
 * q, which made `/toggles` a modal you could only leave by killing the
 * session. `matchesKey` understands both encodings, which is why every other
 * overlay in this package (ask, usage, context-tree, status-footer,
 * personalization) uses it.
 *
 * Exported and pure so the routing is testable without a mounted TUI — the
 * `ask/routeKey` idiom, for the same reason: the parts of an overlay that are
 * only reachable by a real keypress are the parts that ship broken.
 */
export function routeSettingsKey(data: string): SettingsAction | null {
	if (matchesKey(data, Key.escape)) return "close";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) return "toggle";
	// The vim aliases. `parseKey` rather than three more `matchesKey` calls
	// because it resolves the CSI-u form of a plain letter to the letter itself.
	switch (parseKey(data)) {
		case "q":
			return "close";
		case "k":
			return "up";
		case "j":
			return "down";
		default:
			return null;
	}
}

/**
 * Match a user-typed name against a row. Accepts the config id (`term-title`)
 * or any unambiguous prefix of the label, because nobody remembers whether the
 * flag is called `skill-scope` or `skillscope` — the page's whole point is not
 * having to.
 */
export function matchRow(rows: readonly SettingRow[], query: string): SettingRow | "ambiguous" | null {
	const needle = query.trim().toLowerCase();
	if (!needle) return null;
	const exact = rows.find((row) => row.spec.config.toLowerCase() === needle);
	if (exact) return exact;
	const hits = rows.filter(
		(row) => row.spec.label.toLowerCase().startsWith(needle) || row.spec.config.toLowerCase().startsWith(needle),
	);
	if (hits.length === 1) return hits[0];
	return hits.length > 1 ? "ambiguous" : null;
}

/** `/toggles <name> on|off` — the path that works in every mode. */
export function parseArgs(args: string): { name: string; value: boolean | null } | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return null;
	const last = parts[parts.length - 1].toLowerCase();
	if (last === "on" || last === "off") {
		return { name: parts.slice(0, -1).join(" "), value: last === "on" };
	}
	return { name: parts.join(" "), value: null };
}

function textReport(rows: readonly SettingRow[]): string {
	const lines = renderSettingsLines({ rows, cursor: -1 }, PLAIN_SETTINGS_STYLE, 72);
	return [...lines, "", "toggle with: /toggles <name> on|off"].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("toggles", {
		description: "View and toggle hive-pi extension settings",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const parsed = parseArgs(args);

			// Direct form first: it is the only one available headless, in RPC and
			// to a script, and it is faster than the overlay even when the overlay
			// would work.
			if (parsed) {
				const rows = loadRows();
				const hit = matchRow(rows, parsed.name);
				if (hit === null) {
					ctx.ui.notify(`No setting matches "${parsed.name}".\n\n${textReport(rows)}`, "warning");
					return;
				}
				if (hit === "ambiguous") {
					ctx.ui.notify(`"${parsed.name}" matches more than one setting — use the exact name.`, "warning");
					return;
				}
				if (parsed.value === null) {
					const detail = hit.spec.warning ? `\n⚠ ${hit.spec.warning}` : "";
					ctx.ui.notify(`${hit.spec.label}: ${switchLabel(hit.value)}${detail}`, "info");
					return;
				}
				if (parsed.value === hit.value) {
					ctx.ui.notify(`${hit.spec.label} is already ${switchLabel(hit.value)}.`, "info");
					return;
				}
				const error = persist(hit.spec, parsed.value);
				if (error) {
					ctx.ui.notify(`Could not save ${hit.spec.label}: ${error}`, "error");
					return;
				}
				const warn = parsed.value && hit.spec.warning ? `\n⚠ ${hit.spec.warning}` : "";
				ctx.ui.notify(`${hit.spec.label} → ${switchLabel(parsed.value)}\n${RELOAD_NOTE}${warn}`, "info");
				return;
			}

			// No args. `ctx.ui.custom` mounts a pi-tui component and needs a real
			// terminal, so the guard is on the MODE being "tui" and nothing else —
			// the same test every other overlay in this package uses (usage,
			// context-tree). The first version guarded on `!ctx.hasUI || mode ===
			// "rpc"`, which happens to be equivalent today only because "tui" and
			// "rpc" are the two modes with `hasUI`; a fifth mode with a dialog
			// surface but no terminal would have opened an overlay into nothing.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(textReport(loadRows()), "info");
				return;
			}

			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => {
					const state: SettingsViewState & { rows: SettingRow[] } = {
						rows: loadRows(),
						cursor: 0,
					};
					const style = styleFrom(theme);

					const toggleAt = (index: number): void => {
						const order = navigationOrder(state.rows);
						const target = order[index];
						if (!target) return;
						const next = !target.value;
						const error = persist(target.spec, next);
						if (error) {
							state.error = error;
							return;
						}
						state.error = undefined;
						// Re-read rather than trusting the write: the row must show what
						// is on disk. A concurrent hand-edit wins, and is visible.
						state.rows = loadRows();
						ctx.ui.notify(`${target.spec.label} → ${switchLabel(next)} · ${RELOAD_NOTE}`, "info");
					};

					return {
						render: (width: number) => renderSettingsLines(state, style, width),
						invalidate() {},
						handleInput(data: string): void {
							const count = navigationOrder(state.rows).length;
							switch (routeSettingsKey(data)) {
								case "close":
									done(null);
									break;
								case "up":
									state.cursor = moveCursor(state.cursor, -1, count);
									break;
								case "down":
									state.cursor = moveCursor(state.cursor, 1, count);
									break;
								case "toggle":
									toggleAt(state.cursor);
									break;
							}
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "90%",
						margin: { left: 0, right: 0, bottom: 0 },
					},
				},
			);
		},
	});
}
