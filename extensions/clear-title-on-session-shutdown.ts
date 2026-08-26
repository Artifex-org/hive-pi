import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi owns the pane title while it is running. Clear it on every lifecycle
 * transition so tmux can fall back to its worktree/window title afterwards.
 */
export default function (pi: ExtensionAPI): void {
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setTitle("");
	});
}
