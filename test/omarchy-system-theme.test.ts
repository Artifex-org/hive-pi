/**
 * The Omarchy theme sync must change what is on screen, never settings.json.
 *
 * pi's `ctx.ui.setTheme(name)` persists the name whenever it differs from the
 * saved theme. On a workstation `~/.pi/agent/settings.json` is a symlink into
 * the git-tracked overlay checkout, so a light/dark flip dirtied a pull-only
 * repository. Passing the Theme instance applies it without persisting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import themeSync from "../extensions/omarchy-system-theme.ts";

type Handler = (event: unknown, ctx: unknown) => void;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, h: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), h]);
		},
	} as unknown as ExtensionAPI;
	const setThemeArgs: unknown[] = [];
	const themes = new Map([
		["aether-dark", { name: "aether-dark" }],
		["aether-light", { name: "aether-light" }],
	]);
	const ctx = {
		mode: "tui",
		ui: {
			getTheme: (name: string) => themes.get(name),
			setTheme: (arg: unknown) => {
				setThemeArgs.push(arg);
				return { success: true };
			},
			notify: () => {},
		},
	};
	const emit = (name: string) => {
		for (const h of handlers.get(name) ?? []) h({ type: name }, ctx);
	};
	return { api, emit, setThemeArgs, themes };
}

let shutdown: (() => void) | undefined;
afterEach(() => shutdown?.());

describe("omarchy-system-theme", () => {
	it("applies a Theme instance, so pi does not write the name into settings.json", () => {
		const h = harness();
		themeSync(h.api);
		shutdown = () => h.emit("session_shutdown");
		h.emit("session_start");

		expect(h.setThemeArgs).toHaveLength(1);
		expect(typeof h.setThemeArgs[0]).not.toBe("string");
		expect([...h.themes.values()]).toContain(h.setThemeArgs[0]);
	});
});
