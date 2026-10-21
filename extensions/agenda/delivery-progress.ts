/** Observe successful delivery milestones, including nested bash calls (HIV-3838). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "../guards-common/shell-split.ts";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { literalWords } from "../toolhints/contextual.ts";

export const DELIVERY_PROGRESS_ENTRY = "agenda-delivery-progress";
export const ADVICE_GIVEN_ENTRY = "agenda-advice-given";

/** Which milestone a command reached: a commit, a PR opening, or none. A PR anywhere in the chain wins. */
export type MilestoneKind = "commit" | "pr";

export function deliveryMilestone(command: string, output: string, succeeded = true): boolean {
	return milestoneKind(command, output, succeeded) !== null;
}

export function milestoneKind(command: string, output: string, succeeded = true): MilestoneKind | null {
	if (command.length > 8192) return null;
	let found: MilestoneKind | null = null;
	let pipeline = false;
	const parsed = command.replace(/\d*[<>]&\s*(?:\d+|-)/g, "");
	const segments = splitCommands(parsed, true, () => { pipeline = true; }).filter(segment => segment.trim());
	if (pipeline) return null; // the shell exit code may belong to cat, not the creator
	// In an all-success && chain, successful tool completion also establishes
	// the earlier creator succeeded. Do not infer that across ; or || recovery.
	const syntax = command.trim().replace(/'[^']*'|"[^"\\]*"/g, "");
	const allSuccessChain = !/[;\n]|\|\|/.test(syntax.replace(/&&\s*\n\s*/g, "&& "));
	for (const [index, segment] of segments.entries()) {
		const words = literalWords(segment, true);
		if (!words) continue;
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "git") {
			let i = 1;
			while (words[i] === "-C" || words[i] === "-c") i += 2;
			// Success evidence, not merely an attempted commit (a later command
			// may fail or recover with ||). Git's commit summary carries its SHA.
			if (words[i] === "commit" && allSuccessChain && /^\[[^\]\n]+ [0-9a-f]{7,40}\]/m.test(output)) found = "commit";
		}
		if ((words[0] === "gh" && words[1] === "pr" && words[2] === "create") ||
			(words[0] === "hive" && words[1] === "ship")) {
			// Do not attribute a fallback/read command\'s URL to a failed create.
			// A successful && suffix is also attributable to its earlier creator.
			const url = /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\b/.test(output);
			// gh prints the created URL on its own line. A later && suffix may
			// fail, but duplicate/error output must not masquerade as creation.
			const attributable = !syntax.includes("||") && segments.slice(0, index).every(before => {
				const args = literalWords(before);
				while (args && /^[A-Za-z_]\w*=/.test(args[0] ?? "")) args.shift();
				if (!args) return false;
				if (args[0] === "cd" && args.length === 2) return true;
				if (args[0] === "hive" && args[1] === "ship" && args.includes("--no-pr")) return true;
				let verb = 1; while (args[verb] === "-C" || args[verb] === "-c") verb += 2;
				return args[0] === "git" && ["add", "commit", "push", "status"].includes(args[verb]);
			});
			if (!attributable) continue; // a preceding PR view/echo cannot prove creation
			const createdUrl = /^(?:PR:\s*)?https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?\s*$/m.exec(output);
			const partialSuccess = createdUrl && allSuccessChain && index < segments.length - 1 &&
				!/(?:already exists|permission denied|fatal:|error:|HTTP [45]\d\d|GraphQL)/i.test(output.slice(0, createdUrl.index));
			if (url && (succeeded && (index === segments.length - 1 || allSuccessChain) || partialSuccess)) return "pr";
		}
	}
	return found;
}

/** Literal commit checkout, for quiet commits whose stdout has no summary. */
function commitCheckout(command: string, cwd: string): string | null {
	if (command.length > 8192) return null;
	let dir = cwd, pipeline = false;
	const segments = splitCommands(command.replace(/\d*[<>]&\s*(?:\d+|-)/g, ""), true, () => { pipeline = true; }).filter(segment => segment.trim());
	if (pipeline) return null;
	for (const [index, segment] of segments.entries()) {
		const words = literalWords(segment);
		if (!words) return null;
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "cd") {
			if (words.length !== 2) return null;
			dir = resolve(dir, words[1]);
		}
		if (words[0] !== "git") continue;
		let i = 1, target = dir;
		while (["-C", "-c"].includes(words[i]) && words[i + 1]) {
			if (words[i] === "-C") target = resolve(target, words[i + 1]);
			else if (!/^user\.(?:name|email)=/.test(words[i + 1])) return null;
			i += 2;
		}
		// HEAD-only evidence requires a real commit and no HEAD-changing suffix.
		// Quiet commit/push/reporting chains are safe when all && steps succeed.
		if (words[i] === "commit") {
			if (words.slice(i + 1).some(arg => ["--dry-run", "--short", "--long", "--porcelain"].includes(arg))) return null;
			const safeSuffix = !/[;\n]|\|\|/.test(command.trim().replace(/'[^']*'|"[^"\\]*"/g, "").replace(/&&\s*\n\s*/g, "&& ")) && segments.slice(index + 1).every(tail => {
				const args = literalWords(tail);
				while (args && /^[A-Za-z_]\w*=/.test(args[0] ?? "")) args.shift();
				return args && (["echo", "printf"].includes(args[0]) || args[0] === "git" && args[1] === "push" || args[0] === "hive" && args[1] === "ship" || args[0] === "gh" && args[1] === "pr" && args[2] === "create");
			});
			return index === segments.length - 1 || safeSuffix ? target : null;
		}
		if (["add", "status"].includes(words[i])) continue;
		return null;
	}
	return null;
}

const readHead = (cwd: string): string | null => {
	try { return execFileSync("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], {
		cwd, encoding: "utf8", timeout: 1000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
	}).trim(); } catch { return null; }
};

const committedHead = (cwd: string, sha: string): boolean => {
	try {
		const [hash, action] = execFileSync("git", ["--no-optional-locks", "reflog", "-1", "--format=%H%x00%gs", "HEAD"], {
			cwd, encoding: "utf8", timeout: 1000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"],
		}).trim().split("\0", 2);
		return hash === sha && /^commit(?: \([^)]+\))?:/.test(action ?? "");
	} catch { return false; }
};

/**
 * A command that may commit in its own directory but that commitCheckout could
 * not parse: a multi-line or quote-heavy message, or a chain with another git
 * verb first (`go vet && git diff --check && git add … && git commit`). Both
 * shapes went unrecognized in the round-5 eval, so the conductor's "final
 * review" reminder only fired once the PR was open and the review led to
 * commits after delivery. Matching is only the trigger to sample HEAD; the
 * reflog decides (see `requireReflog`).
 */
const MENTIONS_COMMIT = /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+commit\b/;

/** How long a background commit candidate is re-checked before it is dropped. */
const DEFERRED_COMMIT_MS = 30 * 60 * 1000;

/** The checkpoint request a commit may be answering (checkpoint.ts). */
export interface CheckpointCommits {
	outstanding(): boolean;
}

export function registerDeliveryProgress(
	pi: ExtensionAPI,
	head = readHead,
	checkpoint?: CheckpointCommits,
): (entries: readonly unknown[]) => void {
	let seen = false;
	// requireReflog: the command was not parsed, so a moved HEAD proves nothing
	// by itself (a later checkout, reset or rebase moves it too). Only the
	// newest reflog entry being a commit AT the new HEAD counts.
	const pending = new Map<string, { cwd: string; head: string | null; requireReflog: boolean }>();
	// A `background_bash` commit finishes after its tool result (which only says
	// the job started): round-6 eval, pi+Sol committed that way and the
	// conductor's pre-delivery review again fired only at PR open. Such a
	// candidate stays here and is re-checked after every later tool result and
	// at turn end, on reflog evidence only, until it lands or goes stale.
	const deferred = new Map<string, { cwd: string; head: string | null; since: number }>();
	const record = () => { seen = true; deferred.clear(); pi.appendEntry(DELIVERY_PROGRESS_ENTRY, { reached: true }); };
	const settleDeferred = () => {
		if (seen) return;
		const now = Date.now();
		for (const [id, job] of deferred) {
			if (now - job.since > DEFERRED_COMMIT_MS) { deferred.delete(id); continue; }
			const after = head(job.cwd);
			if (!after || after === job.head || !committedHead(job.cwd, after)) continue;
			if (checkpoint?.outstanding()) { deferred.delete(id); continue; }
			record();
			return;
		}
	};
	pi.on("tool_call", (event, ctx) => {
		if (seen || (event.toolName !== "bash" && event.toolName !== "background_bash")) return;
		const input = event.input as { command?: unknown; cwd?: unknown };
		if (typeof input.command !== "string") return;
		const base = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
		if (event.toolName === "background_bash") {
			if (input.command.length <= 8192 && MENTIONS_COMMIT.test(input.command)) {
				deferred.set(event.toolCallId, { cwd: base, head: head(base), since: Date.now() });
			}
			return;
		}
		const cwd = commitCheckout(input.command, base);
		if (cwd) pending.set(event.toolCallId, { cwd, head: head(cwd), requireReflog: false });
		else if (input.command.length <= 8192 && MENTIONS_COMMIT.test(input.command)) {
			pending.set(event.toolCallId, { cwd: base, head: head(base), requireReflog: true });
		}
	});
	pi.on("turn_end", () => settleDeferred());
	pi.on("tool_result", event => {
		const before = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		// The background job's own result is its start, not its outcome.
		if (!deferred.has(event.toolCallId)) settleDeferred();
		if (seen || event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const output = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		// A commit/PR may have succeeded before a later command failed. The
		// concrete summary/URL, rather than the whole chain's exit, decides.
		const after = before ? head(before.cwd) : null;
		const commit = before && after && after !== before.head &&
			(before.requireReflog || event.isError ? committedHead(before.cwd, after) : true);
		const kind = milestoneKind(command, output, !event.isError) ?? (commit ? "commit" : null);
		if (!kind) return;
		// A commit the conductor asked for as a checkpoint is not the end of
		// execution; a PR opening always is.
		if (kind === "commit" && checkpoint?.outstanding()) return;
		record();
	});
	return entries => {
		pending.clear();
		deferred.clear();
		seen = entries.some(entry => (entry as { customType?: string }).customType === DELIVERY_PROGRESS_ENTRY);
	};
}
