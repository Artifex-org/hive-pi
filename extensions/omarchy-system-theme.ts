/**
 * Syncs Pi's Aether light/dark themes with the active Omarchy theme.
 *
 * Omarchy light themes include:
 *   ~/.config/omarchy/current/theme/light.mode
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const home = process.env.HOME ?? "";
const lightModePath = join(home, ".config/omarchy/current/theme/light.mode");

function omarchyPiTheme(): "aether-light" | "aether-dark" {
	return existsSync(lightModePath) ? "aether-light" : "aether-dark";
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let currentTheme: "aether-light" | "aether-dark" | undefined;
		const applyTheme = (nextTheme: "aether-light" | "aether-dark") => {
			// Apply the Theme INSTANCE, not the name. `setTheme(name)` also writes
			// the name into settings.json whenever it differs, and on a workstation
			// that file is a symlink into the git-tracked overlay checkout — so
			// every Omarchy light/dark flip dirtied a pull-only repository and
			// stopped its updater ("refusing update: has local changes"). The
			// instance form only changes what is on screen.
			const theme = ctx.ui.getTheme(nextTheme);
			if (!theme) {
				ctx.ui.notify(`Could not load ${nextTheme}: theme not found`, "error");
				return;
			}
			const result = ctx.ui.setTheme(theme);
			if (result.success) {
				currentTheme = nextTheme;
				return;
			}
			ctx.ui.notify(`Could not load ${nextTheme}: ${result.error ?? "unknown error"}`, "error");
		};

		applyTheme(omarchyPiTheme());
		intervalId = setInterval(() => {
			const nextTheme = omarchyPiTheme();
			if (nextTheme !== currentTheme) applyTheme(nextTheme);
		}, 2000);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
