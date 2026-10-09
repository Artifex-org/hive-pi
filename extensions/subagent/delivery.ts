/** Default-on, overridable pre-delivery review checkpoint (HIV-3802). */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "../guards-common/shell-split.ts";
import { literalWords } from "../toolhints/contextual.ts";
import { captureDeliveryDiff, type ReviewDiff } from "./reviewdiff.ts";
import { resolve } from "node:path";

export const DELIVERY_REVIEW_GUIDANCE = "Before pushing or opening a PR, run subagent with agent: code-reviewer on the diff and fix its findings. The harness supplies the diff/file list, not the author's design rationale. Docs-only or tiny diffs skip automatically; PI_DELIVERY_REVIEW=0 explicitly overrides the checkpoint.";

export function deliveryTargets(command: string, cwd: string): (string | null)[] {
	const targets: (string | null)[] = [];
	let dir: string | null = cwd;
	if (command.length > 8192) return splitCommands(command, true).some((segment) => /^\s*(?:\w+=\S+\s+)*(?:git|gh)\s/.test(segment) && /\b(?:push|pr\s+create)\b/.test(segment)) ? [null] : [];
	let pipeline = false;
	for (const segment of splitCommands(command, true, () => { pipeline = true; })) {
		const words = literalWords(segment);
		if (/^\s*cd\s/.test(segment)) {
			dir = words?.length === 2 && dir ? resolve(dir, words[1]) : null;
			continue;
		}
		// Only inspect the command prefix: a gh body can legitimately contain
		// substitutions, without changing which command/repo is being delivered.
		const cleaned = segment.replace(/^\s*(?:\w+=\S+\s+)*/, "");
		const assignments = segment.slice(0, segment.length - cleaned.length);
		const configuredEnv = /\b(?!(?:PI_DELIVERY_REVIEW|FORCE_COLOR)=)\w+=/.test(assignments);
		if (/^gh\s+pr\s+create\b/.test(cleaned)) {
			targets.push(configuredEnv || /(?:^|\s)(?:--repo|-R)(?:\s|=)/.test(cleaned) ? null : dir);
			continue;
		}
		if (!/^git\s/.test(cleaned)) continue;
		const tokens = literalWords(cleaned);
		if (!tokens) { if (/\bpush\b/.test(cleaned)) targets.push(null); continue; }
		let target = dir, i = 1;
		while (tokens[i]?.startsWith("-")) {
			if (tokens[i] === "-C") { target = target && tokens[i + 1] ? resolve(target, tokens[i + 1]) : null; i += 2; }
			else if (tokens[i] === "-c") { target = null; i += 2; }
			else if (["--no-pager", "--no-optional-locks", "--paginate"].includes(tokens[i])) i++;
			else { if (tokens.slice(i).includes("push")) targets.push(null); i = tokens.length; break; }
		}
		if (tokens[i] !== "push") continue;
		const args = tokens.slice(i + 1);
		if (args.some((t) => t === "--dry-run" || t === "-n")) continue;
		const positional = args.filter((t) => !t.startsWith("-"));
		if ((positional[0] !== undefined && positional[0] !== "origin") ||
			args.some((t) => ["--all", "--mirror", "--tags", "--follow-tags", "--repo"].includes(t) || t.startsWith("--repo=")) ||
			positional.slice(1).some((t) => !/^HEAD(?::.+)?$/.test(t))) target = null;
		targets.push(configuredEnv ? null : target);
	}
	return pipeline ? targets.map(() => null) : targets;
}
export function deliveryCommand(command: string): boolean {
	return deliveryTargets(command, "/").length > 0;
}

export function needsDeliveryReview(diff: ReviewDiff): boolean {
	const files = [...diff.files, ...diff.untracked];
	if (/^(?:Binary files|GIT binary patch)/m.test(diff.text)) return true;
	if (files.length === 0 || files.every((p) => /\.(?:md|rst|txt)$/i.test(p))) return false;
	const changedLines = diff.text.split("\n").filter((l) => /^[+-]/.test(l) && !/^(?:---|\+\+\+)/.test(l)).length;
	return diff.untracked.length > 0 || diff.truncatedBytes > 0 || files.length > 1 || changedLines > 5;
}

function stampable(diff: ReviewDiff): boolean {
	return diff.truncatedBytes === 0 && diff.untracked.length === 0 && !/^(?:Binary files|GIT binary patch)/m.test(diff.text);
}

export function reviewFingerprint(diff: ReviewDiff): string {
	// Ignore commit ids and working-tree/base scope: committing the reviewed
	// bytes must not require a second review. Truncated diffs cannot be stamped.
	return createHash("sha256").update(JSON.stringify([diff.repo, diff.files, diff.untracked, diff.text.replace(/^index .*$/gm, "")])).digest("hex");
}

export function registerDeliveryReview(pi: ExtensionAPI, capture = captureDeliveryDiff): void {
	const reviewed = new Set<string>();
	const pending = new Map<string, string>();
	pi.on("session_start", (_event, ctx) => {
		reviewed.clear(); pending.clear();
		for (const raw of ctx.sessionManager.getBranch()) {
			const entry = raw as { customType?: string; data?: { fingerprint?: string } };
			if (entry.customType === "delivery-review" && typeof entry.data?.fingerprint === "string") reviewed.add(entry.data.fingerprint);
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (process.env.PI_DELIVERY_REVIEW === "0") return;
		const input = event.input as Record<string, unknown>;
		const cwd = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
		if (event.toolName === "subagent" && input.agent === "code-reviewer" && input.background !== true) {
			const diff = capture(cwd, typeof input.task === "string" ? input.task : "");
			if (diff && stampable(diff)) pending.set(event.toolCallId, reviewFingerprint(diff));
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "background_bash") return;
		const command = typeof input.command === "string" ? input.command : "";
		if (!deliveryCommand(command)) return;
		// An explicit per-call override is visible in the transcript. It is not
		// a claim of review or a check passing, just an acknowledged skip.
		if (/^\s*PI_DELIVERY_REVIEW=0\s/.test(command)) return;
		for (const target of deliveryTargets(command, cwd)) {
			const diff = target ? capture(target, "") : null;
			if (diff && (!needsDeliveryReview(diff) || (stampable(diff) && reviewed.has(reviewFingerprint(diff))))) continue;
			return { block: true, reason: `${DELIVERY_REVIEW_GUIDANCE}\n${diff ? "Stage new files before review. " : "Complete delivery diff unavailable (unsupported target/configuration, no remote merge-base, or scan budget exceeded). "}Run a foreground subagent({agent:"code-reviewer", task:"Review the change", cwd:${JSON.stringify(target ?? cwd)}}), then retry. Untracked, binary, or larger-than-budget changes require staging/review or an explicit override; they are never stamped as reviewed.` };
		}
	});
	pi.on("tool_result", (event) => {
		const fingerprint = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!fingerprint || event.isError) return;
		const details = event.details as { results?: { agent?: string; exitCode?: number; stopReason?: string; errorMessage?: string; midWork?: boolean; structuredError?: string }[] } | undefined;
		if (!details?.results?.some((r) => r.agent === "code-reviewer" && r.exitCode === 0 && !r.errorMessage && !r.midWork && !r.structuredError && r.stopReason !== "error" && r.stopReason !== "aborted")) return;
		reviewed.add(fingerprint);
		pi.appendEntry("delivery-review", { fingerprint });
	});
}
