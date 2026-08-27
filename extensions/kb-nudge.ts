/**
 * kb-nudge — nudges KB-first search on the first task-like prompt of a
 * session. Bridged to ~/.claude/hooks/kb-task-nudge.sh (single source of
 * truth shared with Claude Code: length/verb classification + library
 * domain hints for trading/options/ops tasks).
 *
 * Deliberately stricter than Claude's per-prompt hook: fires at most ONCE
 * per session (cache stability — see KB infrastructure/harness/).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOOK = join(process.env.HOME ?? "", ".claude/hooks/kb-task-nudge.sh");

function classify(prompt: string): string | null {
	if (!existsSync(HOOK)) return null;
	const res = spawnSync("bash", [HOOK], {
		input: JSON.stringify({ prompt }),
		encoding: "utf8",
		timeout: 5_000,
	});
	if (res.error || res.status !== 0) return null;
	try {
		const parsed = JSON.parse((res.stdout ?? "").trim()) as { additionalContext?: string };
		return parsed.additionalContext?.trim() ? parsed.additionalContext : null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let nudged = false;

	pi.on("session_start", (event) => {
		if (event.reason === "startup" || event.reason === "new") nudged = false;
	});

	pi.on("before_agent_start", (event) => {
		if (nudged) return;
		const nudge = classify(event.prompt ?? "");
		if (!nudge) return; // not task-like — stay armed for a later prompt
		nudged = true;
		return {
			message: {
				customType: "kb-nudge",
				content: nudge,
				display: false,
			},
		};
	});
}
