/** Default-on, overridable pre-delivery review checkpoint (HIV-3802). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "../guards-common/shell-split.ts";
import { literalWords } from "../toolhints/contextual.ts";
import { captureDeliveryDiff, explainDeliveryDiffFailure, headCommit, reviewFingerprint, stampableReview, type ReviewDiff } from "./reviewdiff.ts";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

export const DELIVERY_REVIEW_GUIDANCE = "Before pushing or opening a PR, run subagent with agent: code-reviewer on the diff and fix its findings. The harness supplies the diff/file list, not the author's design rationale. Docs-only or tiny diffs skip automatically; PI_DELIVERY_REVIEW=0 explicitly overrides the checkpoint.";

function commitPreservesStagedBytes(args: string[]): boolean {
	let nonInteractive = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (["-m", "--message", "-F", "--file"].includes(arg)) { if (args[++i] === undefined) return false; nonInteractive = true; continue; }
		if (/^(?:-m.+|-F.+|--(?:message|file)=)/.test(arg)) { nonInteractive = true; continue; }
		if (arg === "--no-edit") nonInteractive = true;
		if (["--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "--no-verify", "--quiet", "--verbose", "--signoff", "--reset-author", "--no-gpg-sign", "-q", "-s", "-S", "-v"].includes(arg)) continue;
		if (/^--gpg-sign(?:=|$)/.test(arg)) continue;
		return false; // paths, -a/-i/-o, patches and unknown staging/editor modes
	}
	return nonInteractive;
}

/**
 * `git push --help`, `gh pr create -h`, `hive ship --help`, `gh --version`: an
 * invocation that only prints help or a version, so it cannot push or open a PR.
 * Only the literal words `<cli> [subcommand…] <flag> …`, with no assignment in
 * front and no option before the flag: an option before it could take the flag
 * as its value (`gh pr create --title --help` creates a PR titled "--help").
 * git and gh (cobra) honour the flag after positional words; `hive` parses with
 * Go's `flag`, which stops at the first positional, so `hive ship x --help`
 * still ships — there the flag must follow the subcommand directly.
 */
export function helpInvocation(words: readonly string[] | null): boolean {
	if (!words || !["git", "gh", "hive"].includes(words[0])) return false;
	const flag = words.findIndex((word, i) => i > 0 && word.startsWith("-"));
	if (flag < 0 || !["--help", "-h", "--version"].includes(words[flag])) return false;
	return words[0] !== "hive" || flag <= 2;
}

/** One delivery leg: the repo it targets, or null with the leg and the cause that made it unevaluable. */
export interface DeliveryScan { target: string | null; leg?: string; cause?: string }

const clip = (text: string) => { const one = text.trim().replace(/\s+/g, " "); return one.length > 120 ? `${one.slice(0, 117)}...` : one; };

export function deliveryTargets(command: string, cwd: string): (string | null)[] {
	return scanDeliveryTargets(command, cwd).map((scan) => scan.target);
}

export function scanDeliveryTargets(command: string, cwd: string): DeliveryScan[] {
	const targets: DeliveryScan[] = [];
	const ok = (target: string | null): DeliveryScan => ({ target });
	let dir: string | null = cwd;
	if (command.length > 8192) {
		return splitCommands(command, true).some((segment) => /^\s*(?:\w+=\S+\s+)*(?:git|gh|hive)\s/.test(segment) && /\b(?:push|pr\s+create|ship)\b/.test(segment))
			? [{ target: null, leg: clip(command.slice(0, 120)), cause: `the command is ${command.length} characters, over the 8192-character limit this preflight reads` }] : [];
	}
	let pipeline = false;
	let precedingMutation = false;
	let mutationLeg = "";
	for (const segment of splitCommands(command, true, () => { pipeline = true; })) {
		const words = literalWords(segment);
		if (/^\s*cd\s/.test(segment)) {
			dir = words?.length === 2 && dir ? resolve(dir, words[1]) : null;
			continue;
		}
		if (!segment.trim()) continue;
		// Read-only: neither a delivery nor a mutation that precedes one.
		if (helpInvocation(words)) continue;
		// Strip assignment WORDS, including quoted values with spaces. Ordinary
		// process settings do not change the reviewed repo; Git/gh selectors do.
		// The unquoted branch takes ONE character: `(?:[^\s…]+|…)*` can split an
		// N-character run 2^(N-1) ways, and a value not followed by whitespace
		// (`src=/a/long/path; git …`) tries them all on the main thread.
		const cleaned = segment.replace(/^\s*(?:[A-Za-z_]\w*=(?:[^\s'"\\]|'[^']*'|"[^"\\]*")*\s+)*/, "");
		// An unquoted substitution with spaces cannot be stripped as literal
		// assignment words. Recognize the delivery tail, but do not guess it.
		if (/^\s*[A-Za-z_]\w*=/.test(segment) && !/^(?:git|gh|hive)\s/.test(cleaned) &&
			/\b(?:git\s+push|gh\s+pr\s+create|hive\s+ship)\b/.test(cleaned.replace(/'[^']*'|"[^"\\]*"/g, ""))) {
			targets.push({ target: null, leg: clip(segment), cause: "an assignment before the delivery verb holds a shell substitution, so what it changes cannot be read" }); precedingMutation = true; mutationLeg = clip(segment); continue;
		}
		const assignments = segment.slice(0, segment.length - cleaned.length);
		const configuredEnv = !literalWords(assignments) || /\b(?:GIT_\w+|GH_REPO|GH_HOST|HOME|XDG_CONFIG_HOME|PATH)=/.test(assignments);
		const preceded = precedingMutation;
		const precededBy = mutationLeg;
		// Committing already captured staged bytes is supported. Staging can
		// transform content through filters, so it must finish before review. Commands
		// that can switch HEAD, reconfigure the target, or generate new bytes
		// must be run separately, then reviewed against their resulting diff.
		const prefix = literalWords(cleaned, true);
		let verb = 1;
		while (prefix?.[verb] === "-C") verb += 2;
		const gitWritesOutput = prefix?.[0] === "git" && prefix.some(token => token === "--output" || token.startsWith("--output="));
		const implicitStaging = prefix?.[0] === "git" && prefix[verb] === "commit" && !commitPreservesStagedBytes(prefix.slice(verb + 1));
		const dynamicGit = prefix?.[0] === "git" && !literalWords(cleaned);
		// Preserve the common read-only body-file substitution, not arbitrary
		// shell code that can reset HEAD before PR creation or a later push.
		const dynamicGh = prefix?.[0] === "gh" && !literalWords(cleaned) &&
			!literalWords(cleaned.replace(/\$\(\s*cat\s+[A-Za-z0-9_./-]+\s*\)/g, "body"));
		const redirected = /[<>]/.test(cleaned.replace(/'[^']*'|"[^"\\]*"/g, ""));
		if (!prefix || configuredEnv || gitWritesOutput || implicitStaging || dynamicGit || dynamicGh || redirected || !(prefix[0] === "git" && ["commit", "push"].includes(prefix[verb]) ||
			prefix[0] === "gh" && prefix[1] === "pr" && prefix[2] === "create" || prefix[0] === "hive" && prefix[1] === "ship")) { precedingMutation = true; mutationLeg ||= clip(segment); }
		const leg = clip(segment);
		const why = (...checks: [unknown, string][]): DeliveryScan => ({ target: null, leg, cause: checks.find(([hit]) => hit)?.[1] ?? "its target cannot be resolved to one reviewed repo" });
		const precedingCause = `an earlier leg (\`${precededBy}\`) can change HEAD or the files after review`;
		const envCause = `\`${clip(assignments)}\` sets environment that can redirect or reconfigure the delivery`;
		if (/^hive\s+ship\b/.test(cleaned)) {
			const tokens = literalWords(cleaned);
			const extra = tokens?.slice(2).find((token) => token !== "--no-pr");
			targets.push(preceded || configuredEnv || redirected || !tokens || extra !== undefined ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, "the leg redirects input or output"], [!tokens, "its arguments are dynamic (substitution or variable)"], [extra !== undefined, `argument \`${extra}\` is not supported (only \`hive ship\` and \`hive ship --no-pr\`)`]) : ok(dir));
			continue;
		}
		if (/^gh\s/.test(cleaned)) {
			const tokens = literalWords(cleaned, true);
			if (!tokens) { if (/\bpr\s+create\b/.test(cleaned)) targets.push(why([true, "its arguments are dynamic (substitution or variable)"])); continue; }
			let i = 1, targetOverride: string | false = false;
			while (tokens[i]?.startsWith("-")) {
				targetOverride ||= tokens[i];
				i += ["--repo", "--hostname", "-R"].includes(tokens[i]) ? 2 : 1;
			}
			if (tokens[i] !== "pr" || tokens[i + 1] !== "create") continue;
			for (i += 2; i < tokens.length; i++) {
				const option = tokens[i].split("=")[0];
				if (["--repo", "--head", "--base", "-R", "-H", "-B"].includes(option)) targetOverride ||= option;
				if (!tokens[i].includes("=") && ["--repo", "--head", "--base", "-R", "-H", "-B", "--title", "--body", "--body-file", "-t", "-b", "-F", "--assignee", "--reviewer", "--label", "--milestone", "--project", "--template"].includes(option)) i++;
			}
			targets.push(preceded || configuredEnv || redirected || dynamicGh || targetOverride ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, "the leg redirects input or output"], [dynamicGh, "its arguments are dynamic (substitution or variable)"], [targetOverride, `\`${targetOverride}\` points at a repo/branch this preflight cannot match to the reviewed diff`]) : ok(dir));
			continue;
		}
		if (!/^git\s/.test(cleaned)) continue;
		const tokens = literalWords(cleaned);
		if (!tokens) { if (/\bpush\b/.test(cleaned)) targets.push(why([true, "its arguments are dynamic (substitution or variable)"])); continue; }
		let target = dir, i = 1, targetCause = "";
		while (tokens[i]?.startsWith("-")) {
			if (tokens[i] === "-C") { target = target && tokens[i + 1] ? resolve(target, tokens[i + 1]) : null; if (!target) targetCause = "the `-C`/`cd` directory is not a literal path"; i += 2; }
			else if (tokens[i] === "-c") { target = null; targetCause = `\`-c ${tokens[i + 1] ?? ""}\` overrides git configuration for this command`; i += 2; }
			else if (["--no-pager", "--no-optional-locks", "--paginate"].includes(tokens[i])) i++;
			else { if (tokens.slice(i).includes("push")) targets.push(why([true, `global option \`${tokens[i]}\` before the subcommand is not supported`])); i = tokens.length; break; }
		}
		if (tokens[i] !== "push") continue;
		const args = tokens.slice(i + 1);
		if (args.some((t) => t === "--dry-run" || t === "-n")) continue;
		const positional = args.filter((t) => !t.startsWith("-"));
		const badRemote = positional[0] !== undefined && positional[0] !== "origin" ? positional[0] : undefined;
		const badFlag = args.find((t) => ["--all", "--mirror", "--tags", "--follow-tags", "--repo"].includes(t) || t.startsWith("--repo="));
		const badRef = positional.slice(1).find((t) => !/^HEAD(?::.+)?$/.test(t));
		if (badRemote !== undefined || badFlag !== undefined || badRef !== undefined) { target = null; targetCause = badRemote !== undefined ? `remote \`${badRemote}\` is not \`origin\`` : badFlag !== undefined ? `\`${badFlag}\` pushes more than the current HEAD` : `refspec \`${badRef}\` is not \`HEAD\` or \`HEAD:<branch>\``; }
		targets.push(preceded || configuredEnv || redirected ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, "the leg redirects input or output"]) : target ? ok(target) : why([true, targetCause]));
	}
	// Evaluate the LAST delivery verb first, but never let it conceal an
	// earlier push to another repo or an unsupported target in the same chain.
	return pipeline ? targets.map((scan) => scan.target === null ? scan : { target: null, leg: scan.leg, cause: "it runs inside a pipeline, whose earlier stages cannot be evaluated" }) : targets.reverse();
}
/** Supported chains contain literal commits and HEAD delivery.
 * They are not arbitrary shell programs: executable mutation hooks, helpers,
 * dynamic arguments and unknown predecessors must run separately, then be reviewed. */
/** The first leg whose hook can change bytes between legs (or whose hooks cannot be read), or null. */
function chainHookProblem(command: string, cwd: string): { leg: string; hook: string } | null {
	const segments = splitCommands(command, true);
	if (segments.length < 2) return null;
	let dir = cwd;
	for (const segment of segments) {
		const words = literalWords(segment);
		if (!words || helpInvocation(words)) continue; // dynamic shapes are rejected by deliveryTargets; help runs no hook
		while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
		if (words[0] === "cd" && words.length === 2) { dir = resolve(dir, words[1]); continue; }
		if (words[0] !== "git" && !(words[0] === "hive" && words[1] === "ship")) continue;
		let i = 1, target = dir;
		while (words[i] === "-C" && words[i + 1]) { target = resolve(target, words[i + 1]); i += 2; }
		if (words[0] === "git" && !["commit", "push"].includes(words[i])) continue;
		const hookNames = words[0] === "git" && words[i] === "commit"
			? ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite"]
			: ["pre-push"];
		try {
			const hooks = execFileSync("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
				cwd: target, encoding: "utf8", timeout: 1000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			for (const name of hookNames) {
				try { accessSync(join(hooks, name), constants.X_OK); return { leg: clip(segment), hook: `executable hooks (${name})` }; }
				catch (error) { if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return { leg: clip(segment), hook: `a ${name} hook whose state cannot be read` }; }
			}
		} catch { return { leg: clip(segment), hook: "a hooks directory that git could not report" }; } // cannot establish that the compound commit preserves reviewed bytes
	}
	return null;
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

const short = (fingerprint: string) => fingerprint.slice(0, 8);

export function registerDeliveryReview(pi: ExtensionAPI, capture = captureDeliveryDiff): void {
	const reviewed = new Set<string>();
	const pending = new Map<string, string>();
	// Why a fingerprint is not covered: the last review per repo (for "stale after
	// commit X") and the repos where a review ran in the background (never counts).
	const lastReview = new Map<string, { fingerprint: string; head: string | null }>();
	const backgroundReview = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		reviewed.clear(); pending.clear(); lastReview.clear(); backgroundReview.clear();
		for (const raw of ctx.sessionManager.getBranch()) {
			const entry = raw as { customType?: string; data?: { fingerprint?: string; repo?: string; head?: string | null } };
			if (entry.customType !== "delivery-review" || typeof entry.data?.fingerprint !== "string") continue;
			reviewed.add(entry.data.fingerprint);
			if (typeof entry.data.repo === "string") lastReview.set(entry.data.repo, { fingerprint: entry.data.fingerprint, head: entry.data.head ?? null });
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (process.env.PI_DELIVERY_REVIEW === "0") return;
		const input = event.input as Record<string, unknown>;
		const cwd = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
		if (event.toolName === "subagent" && input.agent === "code-reviewer") {
			if (input.background === true) backgroundReview.add(cwd);
			else pending.set(event.toolCallId, cwd);
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "background_bash") return;
		const command = typeof input.command === "string" ? input.command : "";
		if (!deliveryCommand(command)) return;
		// An explicit per-call override is visible in the transcript. It is not
		// a claim of review or a check passing, just an acknowledged skip.
		if (/^\s*PI_DELIVERY_REVIEW=0\s/.test(command)) return;
		const hook = chainHookProblem(command, cwd);
		if (hook) return { block: true, reason: `Unsupported command shape: the chained leg \`${hook.leg}\` has ${hook.hook}, which can change bytes after review (or cannot be shown not to), so the legs after it cannot be reviewed by this preflight. Run \`${hook.leg}\` as its own command, then run a foreground code-reviewer on the resulting diff, then run the delivery (\`git push origin HEAD\`, \`hive ship --no-pr\` or \`gh pr create\`) standalone.` };
		for (const scan of scanDeliveryTargets(command, cwd)) {
			const target = scan.target;
			if (!target) return { block: true, reason: `Unsupported command shape: the leg \`${scan.leg ?? clip(command)}\` cannot be evaluated because ${scan.cause ?? "its target cannot be resolved to one reviewed repo"}. Run setup/mutation commands separately, then review and run a standalone \`git push origin HEAD\`, \`hive ship --no-pr\`, or \`gh pr create\` in the reviewed repo (without target overrides).` };
			const diff = capture(target, "");
			if (diff && (!needsDeliveryReview(diff) || (stampableReview(diff) && reviewed.has(reviewFingerprint(diff))))) continue;
			return { block: true, reason: `${DELIVERY_REVIEW_GUIDANCE}\n${blockCause(diff, target, lastReview, backgroundReview)}Run a foreground subagent({agent:"code-reviewer", task:"Review the change", cwd:${JSON.stringify(target)}}), then retry.` };
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
		const head = headCommit(diff.repo);
		reviewed.add(fingerprint);
		lastReview.set(diff.repo, { fingerprint, head });
		pi.appendEntry("delivery-review", { fingerprint, repo: diff.repo, head });
	});
}

/** The one cause that applies to this refusal, with the fingerprints/files that prove it. */
function blockCause(diff: ReviewDiff | null, target: string, lastReview: Map<string, { fingerprint: string; head: string | null }>, backgroundReview: Set<string>): string {
	if (!diff) return `Complete delivery diff unavailable: ${explainDeliveryDiffFailure(target)}. `;
	if (!stampableReview(diff)) {
		const causes: string[] = [];
		if (diff.untracked.length > 0) causes.push(`untracked file(s) ${diff.untracked.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${diff.untracked.length > 5 ? ` and ${diff.untracked.length - 5} more` : ""} are not in the diff: \`git add\` them (or delete them) before the review`);
		if (diff.truncatedBytes > 0) causes.push(`the diff exceeds the capture budget (${diff.truncatedBytes} bytes not captured${diff.omitted?.length ? `; no or partial patch for ${diff.omitted.slice(0, 8).join(", ")}${diff.omitted.length > 8 ? ", ..." : ""}` : ""}) and a truncated review cannot be stamped: PI_DELIVERY_REVIEW=0 is the explicit override`);
		if (/^(?:Binary files|GIT binary patch)/m.test(diff.text)) causes.push("the diff contains binary changes that cannot be stamped: PI_DELIVERY_REVIEW=0 is the explicit override");
		return `Delivery diff is not stampable: ${causes.join("; ")}. `;
	}
	const last = lastReview.get(diff.repo);
	const head = headCommit(diff.repo);
	const lines: string[] = [];
	if (last) lines.push(`A review exists for diff ${short(last.fingerprint)}${last.head ? ` (HEAD ${last.head} then)` : ""} but the diff is now ${short(reviewFingerprint(diff))}${head ? ` (HEAD ${head} now)` : ""}: it went stale: ${last.head && head && last.head !== head ? `HEAD moved from ${last.head} to ${head} since the review` : "a later edit or amend"}.`);
	if (backgroundReview.has(target) || backgroundReview.has(diff.repo)) lines.push("A code-reviewer ran in the background for this repo; only a foreground review counts.");
	if (lines.length === 0) lines.push("No code review has run for this diff fingerprint " + short(reviewFingerprint(diff)) + ".");
	return `Delivery diff has no matching completed foreground review. ${lines.join(" ")} `;
}
