/** Observe successful delivery milestones, including nested bash calls (HIV-3838). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "../guards-common/shell-split.ts";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { literalWords } from "../toolhints/contextual.ts";

export const DELIVERY_PROGRESS_ENTRY = "agenda-delivery-progress";
export const ADVICE_GIVEN_ENTRY = "agenda-advice-given";

export function deliveryMilestone(command: string, output: string): boolean {
	if (command.length > 8192) return false;
	for (const segment of splitCommands(command, true)) {
		const words = literalWords(segment, true);
		if (!words) continue;
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "git") {
			let i = 1;
			while (words[i] === "-C" || words[i] === "-c") i += 2;
			// Success evidence, not merely an attempted commit (a later command
			// may fail or recover with ||). Git's commit summary carries its SHA.
			if (words[i] === "commit" && /^\[[^\]\n]+ [0-9a-f]{7,40}\]/m.test(output)) return true;
		}
		if ((words[0] === "gh" && words[1] === "pr" && words[2] === "create") ||
			(words[0] === "hive" && words[1] === "ship")) {
			if (/https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\b/.test(output)) return true;
		}
	}
	return false;
}

/** Literal commit checkout, for quiet commits whose stdout has no summary. */
function commitCheckout(command: string, cwd: string): string | null {
	if (command.length > 8192) return null;
	let dir = cwd;
	for (const segment of splitCommands(command, true)) {
		const words = literalWords(segment);
		if (!words) return null;
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "cd") {
			if (words.length !== 2) return null;
			dir = resolve(dir, words[1]);
		}
		if (words[0] !== "git") continue;
		let i = 1, target = dir;
		while (words[i] === "-C" && words[i + 1]) { target = resolve(target, words[i + 1]); i += 2; }
		if (words[i] === "commit") return target;
	}
	return null;
}

const readHead = (cwd: string): string | null => {
	try { return execFileSync("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], {
		cwd, encoding: "utf8", timeout: 1000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
	}).trim(); } catch { return null; }
};

export function registerDeliveryProgress(pi: ExtensionAPI, head = readHead): (entries: readonly unknown[]) => void {
	let seen = false;
	const pending = new Map<string, { cwd: string; head: string | null }>();
	pi.on("tool_call", (event, ctx) => {
		if (seen || event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; cwd?: unknown };
		if (typeof input.command !== "string") return;
		const cwd = commitCheckout(input.command, typeof input.cwd === "string" ? input.cwd : ctx.cwd);
		if (cwd) pending.set(event.toolCallId, { cwd, head: head(cwd) });
	});
	pi.on("tool_result", event => {
		const before = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (seen || event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const output = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		// A commit/PR may have succeeded before a later command failed. The
		// concrete summary/URL, rather than the whole chain's exit, decides.
		const after = before ? head(before.cwd) : null;
		if (!deliveryMilestone(command, output) && !(after && after !== before?.head)) return;
		seen = true;
		pi.appendEntry(DELIVERY_PROGRESS_ENTRY, { reached: true });
	});
	return entries => {
		pending.clear();
		seen = entries.some(entry => (entry as { customType?: string }).customType === DELIVERY_PROGRESS_ENTRY);
	};
}
