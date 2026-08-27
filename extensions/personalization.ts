import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { headerTitle } from "./profile-common/profile.ts";

type PersonalizationState = {
	focus: boolean;
	workspace: string;
	branch: string | undefined;
};

function displayPath(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function gitBranch(cwd: string): string | undefined {
	try {
		const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return branch || undefined;
	} catch {
		return undefined;
	}
}

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 12) return "Good morning";
	if (hour < 18) return "Good afternoon";
	return "Good evening";
}

function installHeader(ctx: ExtensionContext, state: PersonalizationState): void {
	if (ctx.mode !== "tui") return;
	if (state.focus) {
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		return;
	}

	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			const workspace = [state.workspace, state.branch].filter(Boolean).join(" · ");
			const title = `${theme.fg("accent", "π")} ${theme.bold(headerTitle())}`;
			if (width < 70) return [truncateToWidth(`${title}  ${workspace}`, width)];

			const subtitle = theme.fg("muted", `${greeting()} · ${hostname()} · ${workspace}`);
			const hints = theme.fg("dim", "Ctrl+L model · Shift+Tab thinking · Ctrl+Alt+F focus · Ctrl+Alt+W workspace");
			if (width < 110) return [truncateToWidth(title, width), truncateToWidth(subtitle, width)];
			return ["", truncateToWidth(title, width), truncateToWidth(subtitle, width), truncateToWidth(hints, width), ""];
		},
		invalidate() {},
	}));
}

async function showWorkspace(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Workspace: ${ctx.cwd}`, "info");
		return;
	}

	const branch = gitBranch(ctx.cwd) ?? "not a git repository";
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model selected";
	const session = ctx.sessionManager.getSessionFile() ?? "ephemeral session";
	const name = pi.getSessionName() ?? "unnamed";
	const context = ctx.getContextUsage();
	const lines = [
		["Workspace", displayPath(ctx.cwd)],
		["Branch", branch],
		["Model", model],
		["Thinking", ctx.thinkingLevel ?? "default"],
		["Session", name],
		["File", session],
		["Context", context?.percent === null || context?.percent === undefined ? "unavailable" : `${Math.round(context.percent)}%`],
	] as const;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => ({
		render(width: number): string[] {
			const contentWidth = Math.max(1, width - 4);
			return [
				theme.fg("accent", theme.bold("Workspace")),
				...lines.map(([label, value]) => truncateToWidth(`${theme.fg("muted", `${label}:`)} ${value}`, contentWidth)),
				theme.fg("dim", "Esc or Enter to close"),
			];
		},
		invalidate() {},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
			tui.requestRender();
		},
	}), {
		overlay: true,
		overlayOptions: { width: "60%", minWidth: 48, maxHeight: "60%", anchor: "center", margin: 2 },
	});
}

export default function personalization(pi: ExtensionAPI) {
	const state: PersonalizationState = { focus: false, workspace: "", branch: undefined };

	const toggleFocus = (ctx: ExtensionContext): void => {
		state.focus = !state.focus;
		ctx.ui.setStatus("pi-focus", state.focus ? "focus" : undefined);
		installHeader(ctx, state);
		ctx.ui.notify(state.focus ? "Focus mode enabled" : "Focus mode disabled", "info");
	};

	pi.on("session_start", (_event, ctx) => {
		state.focus = false;
		state.workspace = displayPath(ctx.cwd);
		state.branch = gitBranch(ctx.cwd);
		ctx.ui.setStatus("pi-focus", undefined);
		installHeader(ctx, state);
	});

	pi.registerCommand("focus", {
		description: "Toggle compact focus mode",
		handler: async (_args, ctx) => toggleFocus(ctx),
	});
	pi.registerCommand("workspace", {
		description: "Show current workspace and session details",
		handler: async (_args, ctx) => showWorkspace(pi, ctx),
	});
	pi.registerShortcut("ctrl+alt+f", {
		description: "Toggle compact focus mode",
		handler: toggleFocus,
	});
	pi.registerShortcut("ctrl+alt+w", {
		description: "Show workspace details",
		handler: (ctx) => showWorkspace(pi, ctx),
	});
}
