import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { headerTitle } from "./profile-common/profile.ts";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function installHeader(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;

	const location = displayPath(ctx.cwd);
	const branch = gitBranch(ctx.cwd);
	const workspace = branch ? `${location} · ${branch}` : location;
	const machine = hostname();

	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			const title = `${theme.fg("accent", "π")} ${theme.bold(headerTitle())} ${theme.fg("dim", `v${VERSION}`)}`;
			const subtitle = theme.fg("muted", `${greeting()} · ${machine} · ${workspace}`);
			const shortcuts = theme.fg("dim", "Ctrl+P model · Shift+Tab thinking · / commands · Ctrl+O resources");
			return ["", truncateToWidth(title, width), truncateToWidth(subtitle, width), truncateToWidth(shortcuts, width), ""];
		},
		invalidate() {},
	}));
}

export default function welcomeHeader(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => installHeader(ctx));

	pi.registerCommand("welcome-header", {
		description: "Restore the compact welcome header for this session",
		handler: async (_args, ctx) => {
			installHeader(ctx);
			ctx.ui.notify("Welcome header restored", "info");
		},
	});

	pi.registerCommand("builtin-header", {
		description: "Restore Pi's built-in startup header for this session",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
