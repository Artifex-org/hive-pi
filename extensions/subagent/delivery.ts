/** Default-on, overridable pre-delivery review checkpoint (HIV-3802). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "../guards-common/shell-split.ts";
import { literalWords } from "../toolhints/contextual.ts";
import { captureDeliveryDiff, reviewFingerprint, stampableReview, type ReviewDiff } from "./reviewdiff.ts";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

export const DELIVERY_REVIEW_GUIDANCE = "Before pushing or opening a PR, run subagent with agent: code-reviewer on the diff and fix its findings. The harness supplies the diff/file list, not the author's design rationale. Docs-only or tiny diffs skip automatically; PI_DELIVERY_REVIEW=0 explicitly overrides the checkpoint.";

export function deliveryTargets(command: string, cwd: string): (string | null)[] {
	const targets: (string | null)[] = [];
	let dir: string | null = cwd;
	if (command.length > 8192) return splitCommands(command, true).some((segment) => /^\s*(?:\w+=\S+\s+)*(?:git|gh|hive)\s/.test(segment) && /\b(?:push|pr\s+create|ship)\b/.test(segment)) ? [null] : [];
	let pipeline = false;
	let precedingMutation = false;
	for (const segment of splitCommands(command, true, () => { pipeline = true; })) {
		const words = literalWords(segment);
		if (/^\s*cd\s/.test(segment)) {
			dir = words?.length === 2 && dir ? resolve(dir, words[1]) : null;
			continue;
		}
		if (!segment.trim()) continue;
		// Strip assignment WORDS, including quoted values with spaces. Ordinary
		// process settings do not change the reviewed repo; Git/gh selectors do.
		const cleaned = segment.replace(/^\s*(?:[A-Za-z_]\w*=(?:[^\s'"\\]+|'[^']*'|"[^"\\]*")*\s+)*/, "");
		// An unquoted substitution with spaces cannot be stripped as literal
		// assignment words. Recognize the delivery tail, but do not guess it.
		if (/^\s*[A-Za-z_]\w*=/.test(segment) && !/^(?:git|gh|hive)\s/.test(cleaned) &&
			/\b(?:git\s+push|gh\s+pr\s+create|hive\s+ship)\b/.test(cleaned.replace(/'[^']*'|"[^"\\]*"/g, ""))) {
			targets.push(null); precedingMutation = true; continue;
		}
		const assignments = segment.slice(0, segment.length - cleaned.length);
		const configuredEnv = !literalWords(assignments) || /\b(?:GIT_\w+|GH_REPO|GH_HOST|HOME|XDG_CONFIG_HOME|PATH)=/.test(assignments);
		const preceded = precedingMutation;
		// Committing already captured staged bytes is supported. Staging can
		// transform content through filters, so it must finish before review. Commands
		// that can switch HEAD, reconfigure the target, or generate new bytes
		// must be run separately, then reviewed against their resulting diff.
		const prefix = literalWords(cleaned, true);
		let verb = 1;
		while (prefix?.[verb] === "-C") verb += 2;
		const gitWritesOutput = prefix?.[0] === "git" && prefix.some(token => token === "--output" || token.startsWith("--output="));
		const dynamicGit = prefix?.[0] === "git" && !literalWords(cleaned);
		// Preserve the common read-only body-file substitution, not arbitrary
		// shell code that can reset HEAD before PR creation or a later push.
		const dynamicGh = prefix?.[0] === "gh" && !literalWords(cleaned) &&
			!literalWords(cleaned.replace(/\$\(\s*cat\s+[A-Za-z0-9_./-]+\s*\)/g, "body"));
		const redirected = /[<>]/.test(cleaned.replace(/'[^']*'|"[^"\\]*"/g, ""));
		if (!prefix || configuredEnv || gitWritesOutput || dynamicGit || dynamicGh || redirected || !(prefix[0] === "git" && ["commit", "status", "push"].includes(prefix[verb]) ||
			prefix[0] === "gh" && prefix[1] === "pr" && prefix[2] === "create" || prefix[0] === "hive" && prefix[1] === "ship")) precedingMutation = true;
		if (/^hive\s+ship\b/.test(cleaned)) {
			const tokens = literalWords(cleaned);
			targets.push(preceded || configuredEnv || redirected || !tokens || tokens.slice(2).some((token) => token !== "--no-pr") ? null : dir);
			continue;
		}
		if (/^gh\s/.test(cleaned)) {
			const tokens = literalWords(cleaned, true);
			if (!tokens) { if (/\bpr\s+create\b/.test(cleaned)) targets.push(null); continue; }
			let i = 1, targetOverride = false;
			while (tokens[i]?.startsWith("-")) {
				targetOverride = true;
				i += ["--repo", "--hostname", "-R"].includes(tokens[i]) ? 2 : 1;
			}
			if (tokens[i] !== "pr" || tokens[i + 1] !== "create") continue;
			for (i += 2; i < tokens.length; i++) {
				const option = tokens[i].split("=")[0];
				if (["--repo", "--head", "--base", "-R", "-H", "-B"].includes(option)) targetOverride = true;
				if (!tokens[i].includes("=") && ["--repo", "--head", "--base", "-R", "-H", "-B", "--title", "--body", "--body-file", "-t", "-b", "-F", "--assignee", "--reviewer", "--label", "--milestone", "--project", "--template"].includes(option)) i++;
			}
			targets.push(preceded || configuredEnv || redirected || dynamicGh || targetOverride ? null : dir);
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
		targets.push(preceded || configuredEnv || redirected ? null : target);
	}
	// Evaluate the LAST delivery verb first, but never let it conceal an
	// earlier push to another repo or an unsupported target in the same chain.
	return pipeline ? targets.map(() => null) : targets.reverse();
}
/** Supported chains contain literal status/commits and HEAD delivery.
 * They are not arbitrary shell programs: executable mutation hooks, helpers,
 * dynamic arguments and unknown predecessors must run separately, then be reviewed. */
function chainHookProblem(command: string, cwd: string): boolean {
	const segments = splitCommands(command, true);
	if (segments.length < 2) return false;
	let dir = cwd;
	for (const segment of segments) {
		const words = literalWords(segment);
		if (!words) continue; // unsupported dynamic shapes are rejected by deliveryTargets
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "cd" && words.length === 2) { dir = resolve(dir, words[1]); continue; }
		if (words[0] !== "git" && !(words[0] === "hive" && words[1] === "ship")) continue;
		let i = 1, target = dir;
		while (words[i] === "-C" && words[i + 1]) { target = resolve(target, words[i + 1]); i += 2; }
		if (words[0] === "git" && !["commit", "push"].includes(words[i])) continue;
		try {
			const hooks = execFileSync("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
				cwd: target, encoding: "utf8", timeout: 1000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "pre-push"]) {
				try { accessSync(join(hooks, name), constants.X_OK); return true; }
				catch (error) { if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return true; }
			}
		} catch { return true; } // cannot establish that the compound commit preserves reviewed bytes
	}
	return false;
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

export { reviewFingerprint } from "./reviewdiff.ts";

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
			pending.set(event.toolCallId, cwd);
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "background_bash") return;
		const command = typeof input.command === "string" ? input.command : "";
		if (!deliveryCommand(command)) return;
		// An explicit per-call override is visible in the transcript. It is not
		// a claim of review or a check passing, just an acknowledged skip.
		if (/^\s*PI_DELIVERY_REVIEW=0\s/.test(command)) return;
		if (chainHookProblem(command, cwd)) return { block: true, reason: 'Unsupported command shape: a compound delivery has executable hooks (or its hook configuration cannot be read), so later bytes cannot be reviewed by this preflight. Run each command separately, then run a foreground code-reviewer on the resulting diff before standalone delivery.' };
		for (const target of deliveryTargets(command, cwd)) {
			if (!target) return { block: true, reason: 'Unsupported command shape: delivery target/environment, pipeline, or preceding mutation cannot be evaluated. Run setup/mutation commands separately, then review and run a standalone `git push origin HEAD`, `hive ship --no-pr`, or `gh pr create` in the reviewed repo (without target overrides).' };
			const diff = capture(target, "");
			if (diff && (!needsDeliveryReview(diff) || (stampableReview(diff) && reviewed.has(reviewFingerprint(diff))))) continue;
			const reason = !diff ? "Complete delivery diff unavailable (no remote merge-base, repository/configuration scan failed, or scan budget exceeded). "
				: stampableReview(diff) ? "Delivery diff has no matching completed foreground review. "
				: "Delivery diff is not stampable: stage new files before review; binary or larger-than-budget changes require an explicit override. ";
			return { block: true, reason: `${DELIVERY_REVIEW_GUIDANCE}\n${reason}Run a foreground subagent({agent:"code-reviewer", task:"Review the change", cwd:${JSON.stringify(target)}}), then retry.` };
		}
	});
	pi.on("tool_result", (event) => {
		const cwd = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!cwd || event.isError) return;
		const details = event.details as { results?: { agent?: string; exitCode?: number; stopReason?: string; errorMessage?: string; midWork?: boolean; structuredError?: string; reviewFingerprint?: string }[] } | undefined;
		const result = details?.results?.find((r) => r.agent === "code-reviewer" && r.exitCode === 0 && !r.errorMessage && !r.midWork && !r.structuredError && r.stopReason !== "error" && r.stopReason !== "aborted");
		if (!result?.reviewFingerprint) return;
		const diff = capture(cwd, "");
		if (!diff || !stampableReview(diff) || reviewFingerprint(diff) !== result.reviewFingerprint) return;
		const fingerprint = result.reviewFingerprint;
		reviewed.add(fingerprint);
		pi.appendEntry("delivery-review", { fingerprint });
	});
}
