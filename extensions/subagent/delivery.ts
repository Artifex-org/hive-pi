/** Default-on, overridable pre-delivery review checkpoint (HIV-3802). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitCommandList, splitCommands, stripBenignRedirects, type CommandSegment } from "../guards-common/shell-split.ts";
import { deliveryBaseBranch, deliveryMergeBase, type GitReader } from "../guards-common/git-base.ts";
import { literalProblem, literalWords } from "../toolhints/contextual.ts";
import { appendHint } from "../toolhints/index.ts";
import { BACKGROUND_JOB_CHANNEL, type BackgroundJobEvent } from "../background/channel.ts";
import { captureDeliveryDiff, explainDeliveryDiffFailure, headCommit, isDocsPath, reviewFingerprint, stampableReview, type ReviewDiff } from "./reviewdiff.ts";
import { getFinalOutput, resultNotes, type SingleResult } from "./delegate.ts";
import { anchorFor, captureAnchor, captureDelta, clearAnchors, dropAnchor, hasAnchors, markDeltaUsed, offerDelta, setAnchor, withdrawDelta, type ReviewAnchor } from "./review-anchor.ts";
import { backgroundStartedMessage } from "./background.ts";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { captureReleaseDiff, isReviewTarget, type ReviewTarget } from "./release-review.ts";

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
export interface DeliveryScan { target: string | null; leg?: string; cause?: string; reviewTarget?: ReviewTarget }

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
	const list = splitCommandList(command, true);
	const shape = pipelineShape(list);
	const pipeline = shape.poisoned;
	let precedingMutation = false;
	let mutationLeg = "";
	for (const [index, { text: raw }] of list.entries()) {
		if (shape.filters.has(index)) continue;
		// `2>&1`, `>/dev/null` and here-document operators neither read nor write
		// a file; any other redirection is a leg whose effect cannot be read.
		const { text: segment, other: redirected } = stripBenignRedirects(raw);
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
			targets.push({ target: null, leg: clip(raw), cause: "an assignment before the delivery verb holds a shell substitution, so what it changes cannot be read" }); precedingMutation = true; mutationLeg = clip(raw); continue;
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
		const ghBodyFile = cleaned.replace(/\$\(\s*cat\s+[A-Za-z0-9_./-]+\s*\)/g, "body");
		const dynamicGh = prefix?.[0] === "gh" && !literalWords(cleaned) && !literalWords(ghBodyFile);
		const dynamicCause = (text: string) => `its arguments are dynamic: ${literalProblem(text) ?? "a substitution or variable"} cannot be read before it runs`;
		// A listing (`gofmt -l`, `ls`) cannot change what was reviewed. Only fully literal
		// words, no assignments (a substitution or LD_PRELOAD runs code), no redirects and
		// no glob (an expanded `-w` file name becomes a flag).
		const literal = assignments.trim() === "" && !redirected && !/[*?[]/.test(cleaned) ? literalWords(cleaned) : null;
		const inert = !!literal && readOnlyLeg(literal);
		if (!inert && (!prefix || configuredEnv || gitWritesOutput || implicitStaging || dynamicGit || dynamicGh || redirected || !(prefix[0] === "git" && ["commit", "push"].includes(prefix[verb]) ||
			prefix[0] === "gh" && prefix[1] === "pr" && prefix[2] === "create" || prefix[0] === "hive" && prefix[1] === "ship"))) { precedingMutation = true; mutationLeg ||= clip(raw); }
		const leg = clip(raw);
		const why = (...checks: [unknown, string][]): DeliveryScan => ({ target: null, leg, cause: checks.find(([hit]) => hit)?.[1] ?? "its target cannot be resolved to one reviewed repo" });
		const precedingCause = `an earlier leg (\`${precededBy}\`) can change HEAD or the files after review${/^\s*cat\s*>/.test(precededBy)
			? " (write the PR body file in its own command first, then run `gh pr create … --body-file <file>` standalone)" : ""}`;
		const envCause = `\`${clip(assignments)}\` sets environment that can redirect or reconfigure the delivery`;
		if (/^hive\s+ship\b/.test(cleaned)) {
			const tokens = literalWords(cleaned);
			const extra = tokens?.slice(2).find((token) => !["--no-pr", "--draft"].includes(token));
			targets.push(preceded || configuredEnv || redirected || !tokens || extra !== undefined ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, REDIRECT_CAUSE], [!tokens, dynamicCause(cleaned)], [extra !== undefined, `argument \`${extra}\` is not supported (supported flags: \`--no-pr\`, \`--draft\`)`]) : ok(dir));
			continue;
		}
		if (/^gh\s/.test(cleaned)) {
			const tokens = literalWords(cleaned, true);
			if (!tokens) { if (/\bpr\s+create\b/.test(cleaned)) targets.push(why([true, dynamicCause(ghBodyFile)])); continue; }
			let i = 1, targetOverride: string | false = false;
			while (tokens[i]?.startsWith("-")) {
				targetOverride ||= tokens[i];
				i += ["--repo", "--hostname", "-R"].includes(tokens[i]) ? 2 : 1;
			}
			if (tokens[i] !== "pr" || tokens[i + 1] !== "create") continue;
			const selected: Partial<ReviewTarget> = {};
			let unsupportedOption: string | undefined;
			const valueOptions = ["--repo", "--head", "--base", "-R", "-H", "-B", "--title", "--body", "--body-file", "-t", "-b", "-F", "--assignee", "--reviewer", "--label", "--milestone", "--project", "--template"];
			for (i += 2; i < tokens.length; i++) {
				const option: string = tokens[i].split("=")[0];
				if (![...valueOptions, "--draft", "-d", "--fill", "--fill-first", "--fill-verbose", "--no-maintainer-edit"].includes(option)) unsupportedOption ||= option;
				if (["--repo", "-R"].includes(option)) targetOverride ||= option;
				if (["--base", "-B", "--head", "-H"].includes(option)) {
					const key = option === "--base" || option === "-B" ? "base" : "head";
					if (selected[key] !== undefined) targetOverride ||= "duplicate target";
					selected[key] = tokens[i].includes("=") ? tokens[i].slice(tokens[i].indexOf("=") + 1) : tokens[i + 1];
				}
				// Attached short options cannot silently select another target.
				if (/^-[BHR].+/.test(tokens[i]) && !["-B", "-H", "-R"].includes(option)) targetOverride ||= option;
				if (!tokens[i].includes("=") && ["--repo", "--head", "--base", "-R", "-H", "-B", "--title", "--body", "--body-file", "-t", "-b", "-F", "--assignee", "--reviewer", "--label", "--milestone", "--project", "--template"].includes(option)) i++;
			}
			// `--base <default branch>` alone names exactly what gh targets when
			// `--base` is omitted (round-5 eval: a correct `gh pr create --draft
			// --base main` was refused). Unresolvable defaults keep refusing.
			if (selected.base !== undefined && selected.head === undefined && targetOverride === false && dir !== null && selected.base === defaultBranch(dir)) delete selected.base;
			const explicit = Object.keys(selected).length > 0;
			if (explicit && unsupportedOption) targetOverride ||= unsupportedOption;
			if (explicit && !isReviewTarget(selected)) targetOverride ||= selected.base !== undefined ? "--base" : "--head";
			const baseOnly = targetOverride === "--base" && selected.head === undefined;
			targets.push(preceded || configuredEnv || redirected || dynamicGh || targetOverride ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, REDIRECT_CAUSE], [dynamicGh, dynamicCause(ghBodyFile)], [targetOverride, baseOnly ? BASE_ONLY_CAUSE : `\`${targetOverride}\` points at a repo/branch this preflight cannot match to the reviewed diff`]) : explicit ? { target: dir, reviewTarget: selected as ReviewTarget } : ok(dir));
			continue;
		}
		if (!/^git\s/.test(cleaned)) continue;
		const tokens = literalWords(cleaned);
		if (!tokens) { if (/\bpush\b/.test(cleaned)) targets.push(why([true, dynamicCause(cleaned)])); continue; }
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
		targets.push(preceded || configuredEnv || redirected ? why([preceded, precedingCause], [configuredEnv, envCause], [redirected, REDIRECT_CAUSE]) : target ? ok(target) : why([true, targetCause]));
	}
	// Evaluate the LAST delivery verb first, but never let it conceal an
	// earlier push to another repo or an unsupported target in the same chain.
	if (pipeline) return targets.map((scan) => scan.target === null ? scan : { target: null, leg: scan.leg, cause: "it runs inside a pipeline or background job this preflight cannot evaluate (supported: a delivery piped only into read-only filters such as `grep`, `head`, `tail`, `wc` or `sed -n …p`)" });
	// A release-target PR stays fail-closed: it runs on its own, never piped.
	if (shape.filters.size > 0) return targets.map((scan) => scan.reviewTarget ? { target: null, leg: scan.leg, cause: "an explicit --base/--head PR must run on its own, not in a pipeline" } : scan).reverse();
	return targets.reverse();
}

const REDIRECT_CAUSE = "the leg redirects to or from a file (only fd duplication such as `2>&1`, output to `/dev/null` and here-documents are supported). To write a PR body, run `cat > /tmp/pr-body.md <<'EOF' … EOF` as its own command first, then `gh pr create --title … --body-file /tmp/pr-body.md` standalone";
// `--base` alone, naming anything but the default branch, is neither the default target nor a release target.
const BASE_ONLY_CAUSE = "`--base` without `--head` cannot be matched to the reviewed diff. For the repository's default branch, omit `--base` (gh targets it by default); a release PR names both `--base` and `--head`";

/** The branch the delivery diff is measured against (guards-common/git-base.ts), or undefined. */
function defaultBranch(dir: string): string | undefined {
	return deliveryBaseBranch(dir, (args, cwd) => {
		try { return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 1000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"] }); }
		catch { return null; }
	}) ?? undefined;
}

/** The literal words of a leg, after its environment assignments and benign redirects. */
function commandWords(segment: string): string[] | null {
	const { text, other } = stripBenignRedirects(segment);
	const words = other ? null : literalWords(text);
	while (words && /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
	return words;
}

type LegKind = "commit" | "push" | "ship" | "pr";

/** Which delivery-relevant verb a leg runs, and in which directory; null kind for anything else. */
function legKind(words: readonly string[], dir: string): { kind: LegKind | null; target: string } {
	if (words[0] === "hive" && words[1] === "ship") return { kind: "ship", target: dir };
	if (words[0] === "gh") return { kind: words.includes("pr") && words[words.indexOf("pr") + 1] === "create" ? "pr" : null, target: dir };
	if (words[0] !== "git") return { kind: null, target: dir };
	let i = 1, target = dir;
	while ((words[i] === "-C" || words[i] === "-c") && words[i + 1]) { if (words[i] === "-C") target = resolve(target, words[i + 1]); i += 2; }
	if (words[i] === "commit") return { kind: "commit", target };
	if (words[i] === "push" && !words.slice(i + 1).some((t) => t === "--dry-run" || t === "-n")) return { kind: "push", target };
	return { kind: null, target };
}

const GOFMT_READ_FLAGS = new Set(["-l", "-d", "-e", "-s"]);

/**
 * A leg that only reads and prints: an allowlist of commands AND options, never a
 * denylist. Git subcommands never qualify (`git status` can run `core.fsmonitor`, a
 * diff runs configured drivers), and option-taking tools such as `sort` or `sed` can write.
 */
export function readOnlyLeg(words: readonly string[]): boolean {
	const args = words.slice(1);
	switch (words[0]) {
		case "gofmt": {
			const flags = args.filter((a) => a.startsWith("-"));
			return flags.every((a) => GOFMT_READ_FLAGS.has(a)) && flags.some((a) => a === "-l" || a === "-d");
		}
		case "ls": case "pwd": case "echo": case "true":
			return true;
		default:
			return false;
	}
}

/** A stage that only reads its stdin (and named files) and writes stdout. */
export function readOnlyFilter(segment: string): boolean {
	const words = commandWords(segment);
	if (!words?.length) return false;
	const args = words.slice(1);
	switch (words[0]) {
		case "grep": case "egrep": case "fgrep": case "head": case "tail": case "cat": case "wc": case "cut": case "tr": case "nl":
			return true;
		case "sort":
			return !args.some((a) => /^(?:--output|-[^-]*o)/.test(a));
		case "uniq":
			return args.filter((a) => !a.startsWith("-")).length <= 1;
		case "sed": {
			// Print-only scripts: `sed -n 1,20p`, `sed -n '/x/p'`. No -i, no w/e commands.
			if (!args.includes("-n") || args.some((a) => /^(?:-i|--in-place|-[^-]*i)/.test(a))) return false;
			const scripts = args.filter((a) => !a.startsWith("-"));
			return scripts.length >= 1 && /^(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/))?p$/.test(scripts[0]);
		}
		default:
			return false;
	}
}

/**
 * Pipelines and background jobs hide what the shell does with exit status and
 * working directory, so they used to poison the whole command. One shape is
 * plain to read: a delivery leg piped only into read-only filters
 * (`git push 2>&1 | tail -5`). Those filter stages are returned to skip; any
 * other pipeline or a background `&` poisons the command as before.
 */
function pipelineShape(list: readonly CommandSegment[]): { poisoned: boolean; filters: Set<number> } {
	const filters = new Set<number>();
	let poisoned = false;
	for (let start = 0; start < list.length; start++) {
		if (list[start].separator === "&") poisoned = true;
		if (list[start].separator !== "|") continue;
		let end = start;
		while (list[end].separator === "|" && end + 1 < list.length) end++;
		const head = commandWords(list[start].text);
		const kind = head ? legKind(head, "/").kind : null;
		const delivery = kind === "push" || kind === "pr" || kind === "ship";
		const stages = list.slice(start + 1, end + 1);
		if (delivery && stages.every((stage) => readOnlyFilter(stage.text))) for (let i = start + 1; i <= end; i++) filters.add(i);
		else poisoned = true;
		if (list[end].separator === "&") poisoned = true; // `git push | tail &`
		start = end;
	}
	return { poisoned, filters };
}
/**
 * A chain is checked before any of it runs, so a leg whose git hooks can
 * rewrite bytes (a formatter in pre-commit, a commit made by post-rewrite or
 * pre-push) leaves every LATER delivery leg acting on bytes nobody reviewed.
 *
 * Only that shape is refused: a hooked commit, push or `hive ship` followed by
 * another delivery leg (`gh pr create`, `hive ship`, another push). A commit
 * followed by the one push that sends it, or a chain whose hooked leg is the
 * last delivery, is allowed — the push sends what the commit made, and any
 * later standalone delivery is checked again against the new diff (a
 * hook-made change then needs its own review before the PR can open). `cd`
 * legs only move the directory. `--no-verify` is deliberately NOT read as "no
 * hooks": skipping the repo's hooks must never be what makes a chain pass.
 */
function chainHookProblem(command: string, cwd: string): { leg: string; hook: string; later: string } | null {
	const legs = chainLegs(command, cwd);
	for (const [index, leg] of legs.entries()) {
		if (leg.kind === "pr") continue;
		const deliveries = legs.slice(index + 1).filter((later) => later.kind !== "commit");
		// A commit's own push is how the commit is delivered, not a later leg.
		const unreviewable = leg.kind === "commit" && deliveries[0]?.kind === "push" ? deliveries.slice(1) : deliveries;
		if (unreviewable.length === 0) continue;
		const hook = hookProblem(leg.kind === "commit" ? ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite"] : ["pre-push"], leg.target);
		if (hook) return { leg: clip(leg.segment), hook, later: clip(unreviewable[0].segment) };
	}
	return null;
}

/** The commit, push, `hive ship` and `gh pr create` legs of a chain, in order, with their directories. */
function chainLegs(command: string, cwd: string): { segment: string; kind: LegKind; target: string }[] {
	const segments = splitCommands(command, true);
	if (segments.length < 2) return [];
	let dir = cwd;
	const legs: { segment: string; kind: LegKind; target: string }[] = [];
	for (const segment of segments) {
		const words = commandWords(segment);
		if (!words || helpInvocation(words)) continue; // dynamic shapes are rejected by deliveryTargets; help runs no hook
		if (words[0] === "cd" && words.length === 2) { dir = resolve(dir, words[1]); continue; }
		const { kind, target } = legKind(words, dir);
		if (kind) legs.push({ segment, kind, target });
	}
	return legs;
}

/** Repositories where this chain commits and then pushes (or ships) the result. */
function committedThenDelivered(command: string, cwd: string): string[] {
	const legs = chainLegs(command, cwd);
	return [...new Set(legs.filter((leg, i) => leg.kind === "commit" && legs.slice(i + 1).some((later) => later.kind === "push" || later.kind === "ship")).map((leg) => leg.target))];
}

/** Which of these hooks would run in `target` (or why that cannot be told), or null. */
function hookProblem(hookNames: readonly string[], target: string): string | null {
	try {
		const hooks = execFileSync("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
			cwd: target, encoding: "utf8", timeout: 1000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		for (const name of hookNames) {
			try { accessSync(join(hooks, name), constants.X_OK); return `executable hooks (${name})`; }
			catch (error) { if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return `a ${name} hook whose state cannot be read`; }
		}
		return null;
	} catch { return "a hooks directory that git could not report"; } // cannot establish that the compound commit preserves reviewed bytes
}

export function deliveryCommand(command: string): boolean {
	return deliveryTargets(command, "/").length > 0;
}

export function needsDeliveryReview(diff: ReviewDiff): boolean {
	const files = [...diff.files, ...diff.untracked];
	if (/^(?:Binary files|GIT binary patch)/m.test(diff.text)) return true;
	if (files.length === 0 || files.every(isDocsPath)) return false;
	const changedLines = diff.text.split("\n").filter((l) => /^[+-]/.test(l) && !/^(?:---|\+\+\+)/.test(l)).length;
	return diff.untracked.length > 0 || diff.truncatedBytes > 0 || files.length > 1 || changedLines > 5;
}

export { reviewFingerprint } from "./reviewdiff.ts";

const short = (fingerprint: string) => fingerprint.slice(0, 8);

const treeGit: GitReader = (args, cwd) => {
	try { return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
	catch { return null; }
};

/**
 * Fingerprint of WHAT the branch delivers — the net patch from the merge-base
 * — independent of which part is committed, staged or still in the working
 * tree. `reviewFingerprint` keys the evidence the reviewer was shown, layer by
 * layer, so committing an already-reviewed tree changed it and demanded a
 * second review of identical code. `worktree` reads the reviewed state;
 * `head` reads what a push sends, and is only meaningful (and only consulted)
 * when nothing is staged or modified, so a dirty revert cannot pass off an
 * unreviewed commit.
 */
export function treeFingerprint(repo: string, source: "worktree" | "head", git: GitReader = treeGit): string | null {
	const base = deliveryMergeBase(repo, git);
	if (!base) return null;
	// Plumbing on both sides: no rename detection, colour or external diff, so
	// the same content prints the same patch from a tree or the working tree.
	const patch = git(source === "head" ? ["diff-tree", "-r", "-p", "--no-color", "--no-ext-diff", base, "HEAD"] : ["diff-index", "-p", "--no-color", "--no-ext-diff", base], repo);
	if (patch === null) return null;
	return `tree:${createHash("sha256").update(JSON.stringify([repo, patch.replace(/^index .*$/gm, "")])).digest("hex")}`;
}

/** Only committed changes: what a push sends is the whole delivery diff. */
function committedOnly(diff: ReviewDiff): boolean {
	return !/^(?:Staged vs HEAD|Unstaged vs index)\b/m.test(diff.text);
}

/**
 * A code-reviewer that could not start because no model it may use has a
 * credential here: the refusal from `chooseWorkerModel`, or a worker that died
 * on `No API key found`. Retrying cannot help, so delivery records that the
 * review was unavailable instead of blocking forever.
 */
const REVIEWER_UNAVAILABLE = /nothing else is configured to fall back to|no catalog mode is configured here|No API key found[^\n]*/i;

type ReviewResult = { agent?: string; exitCode?: number; stopReason?: string; errorMessage?: string; stderr?: string; midWork?: boolean; structuredError?: string; reviewFingerprint?: string; reviewDelta?: string; messages?: SingleResult["messages"] };

function reviewerUnavailable(result: ReviewResult): string | null {
	const text = `${result.errorMessage ?? ""}\n${result.stderr ?? ""}`;
	const match = REVIEWER_UNAVAILABLE.exec(text);
	if (!match) return null;
	const line = (text.split("\n").find((l) => l.includes(match[0])) ?? match[0]).trim().replace(/\s+/g, " ");
	return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** The note a background reviewer's completion carries when it stopped mid-work. */
const MID_WORK_NOTE = resultNotes({ midWork: true } as SingleResult).trim();

/** The job id in a background delegation's start receipt (`backgroundStartedMessage`). */
const JOB_ID = (() => {
	const [before, after] = backgroundStartedMessage("\0", "", "").split("\0");
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escape(before)}([^\\s${escape(after[0] ?? "`")}]+)${escape(after[0] ?? "`")}`);
})();

interface BackgroundReview { cwd: string; fingerprint: string | null; unstampable?: string | null }
interface BackgroundJob { output: string; status?: string; review?: BackgroundReview; reviewFingerprint?: string }

const resultText = (content: unknown) => Array.isArray(content) ? content.map((part) => typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "").join("\n") : "";

export function registerDeliveryReview(pi: ExtensionAPI, capture = captureDeliveryDiff, tree = treeFingerprint): void {
	const reviewed = new Set<string>();
	// Fingerprints stamped because no reviewer could run, with the reason.
	const unavailable = new Map<string, string>();
	const pending = new Map<string, { cwd: string; reviewTarget?: ReviewTarget; explicitModel: boolean; unstampable?: string | null }>();
	// Why a fingerprint is not covered: the last review per repo (for "stale after
	// commit X") and what became of background reviews per cwd.
	const lastReview = new Map<string, { fingerprint: string; head: string | null }>();
	const backgroundState = new Map<string, string>();
	// Background reviews by the tool call that dispatched them, until the start
	// receipt names their job; reviewer jobs by id, whichever arrives first.
	const dispatched = new Map<string, BackgroundReview>();
	const jobs = new Map<string, BackgroundJob>();
	// Notes owed to a delivery call's result: delivered on a "review unavailable"
	// record, or a chained commit whose result must be re-checked against reviews.
	const deliveryNotes = new Map<string, string>();
	// Delivery calls whose stamp was carried forward from a full review, by tool call.
	const carriedNotes = new Map<string, string[]>();
	const chainedCommits = new Map<string, string[]>();

	const stamp = (diff: ReviewDiff, source: "foreground" | "background" | "unavailable" | "carried" | "delta", reason?: string) => {
		const fingerprint = reviewFingerprint(diff);
		const head = headCommit(diff.repo);
		// A release review is bound to its origin endpoints, never to a tree.
		const treeKey = diff.scope === "explicit origin PR target" ? null : tree(diff.repo, "worktree");
		reviewed.add(fingerprint);
		if (treeKey) reviewed.add(treeKey);
		for (const key of treeKey ? [fingerprint, treeKey] : [fingerprint]) {
			if (reason) unavailable.set(key, reason);
			else unavailable.delete(key); // a real review supersedes "unavailable"
		}
		lastReview.set(diff.repo, { fingerprint, head });
		pi.appendEntry("delivery-review", { fingerprint, repo: diff.repo, head, ...(treeKey ? { tree: treeKey } : {}), ...(source !== "foreground" ? { source } : {}), ...(reason ? { unavailable: reason } : {}) });
	};

	/** The record covering this delivery diff (its evidence, or the tree it delivers), or null. */
	const coveredBy = (diff: ReviewDiff): string | null => {
		if (!stampableReview(diff)) return null;
		const fingerprint = reviewFingerprint(diff);
		if (reviewed.has(fingerprint)) return fingerprint;
		const treeKey = committedOnly(diff) ? tree(diff.repo, "head") : null;
		return treeKey && reviewed.has(treeKey) ? treeKey : null;
	};

	pi.on("session_start", (_event, ctx) => {
		reviewed.clear(); unavailable.clear(); pending.clear(); lastReview.clear(); backgroundState.clear(); dispatched.clear(); jobs.clear(); deliveryNotes.clear(); chainedCommits.clear();
		clearAnchors();
		for (const raw of ctx.sessionManager.getBranch()) {
			const anchorEntry = raw as { customType?: string; data?: { anchor?: ReviewAnchor; deltaOf?: string; repo?: string; dropped?: string } };
			if (anchorEntry.customType === "delivery-review-anchor") {
				if (anchorEntry.data?.anchor && typeof anchorEntry.data.anchor.repo === "string") setAnchor(anchorEntry.data.anchor);
				else if (typeof anchorEntry.data?.dropped === "string") dropAnchor(anchorEntry.data.dropped);
				else if (typeof anchorEntry.data?.deltaOf === "string" && typeof anchorEntry.data.repo === "string") markDeltaUsed(anchorEntry.data.repo, anchorEntry.data.deltaOf);
				continue;
			}
			const entry = raw as { customType?: string; data?: { fingerprint?: string; repo?: string; head?: string | null; tree?: string; unavailable?: string } };
			if (entry.customType !== "delivery-review" || typeof entry.data?.fingerprint !== "string") continue;
			const keys = [entry.data.fingerprint, ...(typeof entry.data.tree === "string" ? [entry.data.tree] : [])];
			for (const key of keys) {
				reviewed.add(key);
				if (typeof entry.data.unavailable === "string") unavailable.set(key, entry.data.unavailable);
				else unavailable.delete(key);
			}
			if (typeof entry.data.repo === "string") lastReview.set(entry.data.repo, { fingerprint: entry.data.fingerprint, head: entry.data.head ?? null });
		}
	});

	// A background code-reviewer counts once it FINISHES cleanly on the diff it
	// was dispatched against. Three fingerprints must agree: this side's capture
	// at dispatch, the worker's own evidence (carried on the finish event), and
	// this side's capture at completion. A change in between voids it, exactly as
	// a foreground review is voided, and a worker that could not capture its diff
	// (2 s budget) reviewed nothing this gate can vouch for.
	const settle = (id: string, job: BackgroundJob) => {
		const review = job.review;
		if (!review || job.status === undefined) return;
		jobs.delete(id);
		if (job.status !== "done" || job.output.includes(MID_WORK_NOTE)) { backgroundState.set(review.cwd, `finished without a complete review (${job.status})`); return; }
		if (!job.reviewFingerprint) {
			backgroundState.set(review.cwd, review.unstampable
				? `finished, but it reviewed a diff that could not be stamped (${review.unstampable.replace(/^This review cannot clear delivery: /, "").replace(/\. Fix that.*$/, "")})`
				: "finished, but the reviewer could not capture the diff it reviewed");
			return;
		}
		const diff = capture(review.cwd, "");
		if (!diff || !stampableReview(diff) || !review.fingerprint || job.reviewFingerprint !== review.fingerprint || reviewFingerprint(diff) !== review.fingerprint) { backgroundState.set(review.cwd, "finished, but the diff changed after it was dispatched (or cannot be stamped)"); return; }
		backgroundState.delete(review.cwd);
		stamp(diff, "background");
	};
	pi.events.on(BACKGROUND_JOB_CHANNEL, (payload) => {
		const event = payload as BackgroundJobEvent;
		if (event.action === "start") {
			if (event.kind !== "subagent" || !event.detail.startsWith("code-reviewer:")) return;
			if (!jobs.has(event.id)) jobs.set(event.id, { output: "" });
			if (jobs.size > 32) jobs.delete(jobs.keys().next().value as string);
			return;
		}
		const job = jobs.get(event.id);
		if (!job) return;
		if (event.action === "output") { job.output += event.chunk; return; }
		job.status = event.status;
		job.reviewFingerprint = event.reviewFingerprint;
		settle(event.id, job);
	});

	pi.on("tool_call", (event, ctx) => {
		if (process.env.PI_DELIVERY_REVIEW === "0") return;
		const input = event.input as Record<string, unknown>;
		const cwd = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
		if (event.toolName === "subagent" && input.agent === "code-reviewer") {
			if (input.background === true) {
				// What the worker captures: the task's named paths can select another
				// repo, and then the stamp below (taken for cwd) can never match.
				const diff = input.reviewTarget === undefined ? capture(cwd, typeof input.task === "string" ? input.task : "") : null;
				dispatched.set(event.toolCallId, { cwd, fingerprint: diff && stampableReview(diff) ? reviewFingerprint(diff) : null, unstampable: unstampableReviewNote(diff) });
				if (diff) withdrawDelta(diff.repo); // its capture must not take a foreground delta offer
				backgroundState.set(cwd, "is still running");
			} else if (input.reviewTarget === undefined || isReviewTarget(input.reviewTarget)) {
				// One capture serves the dispatch note and the delta offer below.
				const diff = input.reviewTarget === undefined ? capture(cwd, typeof input.task === "string" ? input.task : "") : null;
				pending.set(event.toolCallId, { cwd, reviewTarget: input.reviewTarget as ReviewTarget | undefined, explicitModel: typeof input.model === "string" && input.model.trim() !== "",
					unstampable: unstampableReviewNote(diff) });
				// Only a foreground delivery review may see just the delta (background settles on full fingerprints).
				if (diff && hasAnchors() && !backgroundState.has(cwd) && !backgroundState.has(diff.repo)) offerDelta(diff.repo);
			}
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "background_bash") return;
		const command = typeof input.command === "string" ? input.command : "";
		if (!deliveryCommand(command)) return;
		// An explicit per-call override is visible in the transcript. It is not
		// a claim of review or a check passing, just an acknowledged skip.
		if (/^\s*PI_DELIVERY_REVIEW=0\s/.test(command)) return;
		const hook = chainHookProblem(command, cwd);
		if (hook) return { block: true, reason: `Unsupported command shape: the chained leg \`${hook.leg}\` has ${hook.hook}, which can change bytes after review (or cannot be shown not to), so the later delivery leg \`${hook.later}\` cannot be reviewed by this preflight. Run \`${hook.leg}\` as its own command (a commit may keep its own push: \`git commit … && git push origin HEAD\`), then run \`${hook.later}\` standalone; it is checked against the resulting diff.` };
		let unavailableReason: string | undefined;
		for (const scan of scanDeliveryTargets(command, cwd)) {
			const target = scan.target;
			if (!target) return { block: true, reason: `Unsupported command shape: the leg \`${scan.leg ?? clip(command)}\` cannot be evaluated because ${scan.cause ?? "its target cannot be resolved to one reviewed repo"}. Run setup/mutation commands separately, then review and run a standalone \`git push origin HEAD\`, \`hive ship --no-pr\`, or \`gh pr create\` in the reviewed repo (without target overrides).` };
			const release = scan.reviewTarget ? captureReleaseDiff(target, scan.reviewTarget) : undefined;
			const diff = release ? release.diff : capture(target, "");
			if (diff && !scan.reviewTarget && !needsDeliveryReview(diff)) continue;
			const covered = diff && (scan.reviewTarget ? stampableReview(diff) && reviewed.has(reviewFingerprint(diff)) ? reviewFingerprint(diff) : null : coveredBy(diff));
			if (covered) { unavailableReason ??= unavailable.get(covered); continue; }
			const anchor = diff && !scan.reviewTarget ? anchorFor(diff.repo) : undefined;
			const delta = anchor && diff ? captureDelta(anchor, diff) : null;
			if (diff && anchor && delta?.kind) {
				stamp(diff, "carried");
				carriedNotes.set(event.toolCallId, [...(carriedNotes.get(event.toolCallId) ?? []),
					`Review carried forward in ${diff.repo}: the change since the full review ${short(anchor.fingerprint)} is ${delta.kind === "docs" ? "docs-only" : "at most five lines in one file"} (${delta.files.join(", ")}).`]);
				continue;
			}
			if (scan.reviewTarget) return { block: true, reason: `Explicit PR target requires a matching foreground release review. ${release?.reason ?? "No matching review for the current origin repository and base/head SHAs."} Run subagent({agent:"code-reviewer", task:"Review the release", cwd:${JSON.stringify(target)}, reviewTarget:${JSON.stringify(scan.reviewTarget)}}), then retry. This review does not grant deployment approval.` };
			carriedNotes.delete(event.toolCallId); // this call does not deliver
			const deltaNote = anchor && !anchor.deltaUsed && delta && delta.files.length > 0
				? `Since the full review ${short(anchor.fingerprint)}, ${delta.files.length} file(s) changed (${delta.files.slice(0, 5).join(", ")}${delta.files.length > 5 ? ", …" : ""}): a foreground code-reviewer now reviews ONLY that change, once; a later change needs a full review. `
				: "";
			const recovery = diff ? `Run a foreground subagent({agent:"code-reviewer", task:"Review the change", cwd:${JSON.stringify(target)}}), then retry.` :
				"Resolve the Git capture failure, then retry this standalone delivery. This refusal did not evaluate or discard completed review receipts.";
			return { block: true, reason: `${DELIVERY_REVIEW_GUIDANCE}\n${blockCause(diff, target, lastReview, backgroundState)}${deltaNote}${recovery}` };
		}
		if (unavailableReason) deliveryNotes.set(event.toolCallId, unavailableReason);
		// Only a foreground shell call's result follows the commit; a background
		// job's result arrives when it starts.
		const commits = event.toolName === "bash" ? committedThenDelivered(command, cwd) : [];
		if (commits.length > 0) chainedCommits.set(event.toolCallId, commits);
	});

	pi.on("tool_result", (event) => {
		const notes: string[] = [];
		const reason = deliveryNotes.get(event.toolCallId);
		deliveryNotes.delete(event.toolCallId);
		if (reason !== undefined && !event.isError) notes.push(`This delivery ran WITHOUT a code review: no reviewer model could run in this session (${reason}). Say so in the PR description and in your final report.`);
		const carried = carriedNotes.get(event.toolCallId);
		carriedNotes.delete(event.toolCallId);
		if (carried && !event.isError) notes.push(...carried);
		// A commit's hooks run after the preflight; if they changed the reviewed
		// code, the push that followed sent bytes no review covered. Say so now,
		// while the PR can still wait for a review of the new diff.
		const commits = chainedCommits.get(event.toolCallId);
		chainedCommits.delete(event.toolCallId);
		for (const target of commits ?? []) {
			const diff = event.isError ? null : capture(target, "");
			if (diff && needsDeliveryReview(diff) && !coveredBy(diff)) notes.push(`The commit in this command changed the code after its review (a commit hook rewrote it?): the delivered branch in ${diff.repo} now holds diff ${short(reviewFingerprint(diff))}, which no review covers. Run a code-reviewer on it before opening or updating the PR.`);
		}
		const background = dispatched.get(event.toolCallId);
		dispatched.delete(event.toolCallId);
		if (background) {
			if (background.unstampable && !event.isError) notes.push(background.unstampable);
			const id = event.isError ? undefined : JOB_ID.exec(resultText(event.content))?.[1];
			if (id === undefined) backgroundState.delete(background.cwd); // refused before it started: no job will come
			else {
				const job = jobs.get(id) ?? { output: "" };
				job.review = background;
				jobs.set(id, job);
				settle(id, job);
			}
		}
		const request = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (request) {
			const reviewNote = recordReview(request, event.isError === true, event.details);
			if (reviewNote) notes.push(reviewNote);
			else if (request.unstampable && !event.isError) notes.push(request.unstampable);
		}
		if (notes.length > 0) return { content: appendHint(event.content, notes.map((note) => `\n\n[harness] ${note}`).join("")) };
	});

	/** Stamp a finished foreground review (or a reviewer that could not run); returns a note for its result. */
	function recordReview(request: { cwd: string; reviewTarget?: ReviewTarget; explicitModel: boolean }, isError: boolean, details: unknown): string | null {
		const { cwd, reviewTarget } = request;
		const results = (details as { results?: ReviewResult[] } | undefined)?.results ?? [];
		const result = isError ? undefined : results.find((r) => r.agent === "code-reviewer" && r.exitCode === 0 && !r.errorMessage && !r.midWork && !r.structuredError && r.stopReason !== "error" && r.stopReason !== "aborted");
		if (!result) {
			// Not when the caller named a model: dropping `model` is the remedy then.
			const failed = results.find((r) => r.agent === "code-reviewer");
			const reason = failed && !reviewTarget && !request.explicitModel ? reviewerUnavailable(failed) : null;
			if (!reason) return null;
			const diff = capture(cwd, "");
			if (!diff || !stampableReview(diff)) return null;
			stamp(diff, "unavailable", reason);
			return `Review unavailable: no reviewer model can run in this session (${reason}). Recorded for diff ${short(reviewFingerprint(diff))}; delivering exactly this diff will proceed WITHOUT a review, and the delivery result will say so. State it in the PR description.`;
		}
		if (!result.reviewFingerprint) return null;
		const diff = reviewTarget ? captureReleaseDiff(cwd, reviewTarget).diff : capture(cwd, "");
		if (!diff || !stampableReview(diff)) return null;
		if (result.reviewDelta) {
			// A delta review covers the current diff only if the same delta, from the same full review, is still what is delivered.
			const anchor = anchorFor(diff.repo);
			const delta = anchor && anchor.fingerprint === result.reviewDelta ? captureDelta(anchor, diff) : null;
			if (!delta || delta.fingerprint !== result.reviewFingerprint) return null;
			stamp(diff, "delta");
			markDeltaUsed(diff.repo, result.reviewDelta);
			pi.appendEntry("delivery-review-anchor", { deltaOf: result.reviewDelta, repo: diff.repo });
			return null;
		}
		if (reviewFingerprint(diff) !== result.reviewFingerprint) return null;
		stamp(diff, "foreground");
		if (reviewTarget) return null;
		// Anchor first, then confirm the delivered diff is still the reviewed one: bytes changed in between are not "reviewed content".
		const anchor = captureAnchor(diff, result.messages ? getFinalOutput(result.messages) : "");
		const after = anchor ? capture(cwd, "") : null;
		if (anchor && after && reviewFingerprint(after) === anchor.fingerprint) { setAnchor(anchor); pi.appendEntry("delivery-review-anchor", { anchor }); }
		else { dropAnchor(diff.repo); pi.appendEntry("delivery-review-anchor", { dropped: diff.repo }); }
		return null;
	}
}

/** Why a captured diff cannot be stamped as reviewed, with the remedy for each cause; empty when it can. */
function unstampableCauses(diff: ReviewDiff): string[] {
	if (stampableReview(diff)) return [];
	const causes: string[] = [];
	if (diff.untracked.length > 0) causes.push(`untracked file(s) ${diff.untracked.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${diff.untracked.length > 5 ? ` and ${diff.untracked.length - 5} more` : ""} are not in the diff: \`git add\` them (or delete them) before the review`);
	if (diff.truncatedBytes > 0) causes.push(`the diff exceeds the capture budget (${diff.truncatedBytes} bytes not captured${diff.omitted?.length ? `; no or partial patch for ${diff.omitted.slice(0, 8).join(", ")}${diff.omitted.length > 8 ? ", ..." : ""}` : ""}) and a truncated review cannot be stamped: PI_DELIVERY_REVIEW=0 is the explicit override`);
	if (/^(?:Binary files|GIT binary patch)/m.test(diff.text)) causes.push("the diff contains binary changes that cannot be stamped: PI_DELIVERY_REVIEW=0 is the explicit override");
	return causes.length > 0 ? causes : ["the captured diff cannot be stamped"];
}

/**
 * The note a code-reviewer gets at dispatch when its diff cannot be stamped
 * (round-6/7 harness evals: pi+Sol started a background review while its new
 * test file was untracked; the review ran to completion, could never count,
 * and the push then asked for a second one). Saying so at dispatch costs
 * nothing and saves a whole review.
 */
function unstampableReviewNote(diff: ReviewDiff | null): string | null {
	if (!diff || stampableReview(diff)) return null;
	return `This review cannot clear delivery: ${unstampableCauses(diff).join("; ")}. Fix that and review again before pushing; the push guard accepts only a review of a stampable diff.`;
}

/** The one cause that applies to this refusal, with the fingerprints/files that prove it. */
function blockCause(diff: ReviewDiff | null, target: string, lastReview: Map<string, { fingerprint: string; head: string | null }>, backgroundState: Map<string, string>): string {
	if (!diff) return `Complete delivery diff unavailable: ${explainDeliveryDiffFailure(target)}. `;
	if (!stampableReview(diff)) return `Delivery diff is not stampable: ${unstampableCauses(diff).join("; ")}. `;
	const last = lastReview.get(diff.repo);
	const head = headCommit(diff.repo);
	const lines: string[] = [];
	if (last) lines.push(`A review exists for diff ${short(last.fingerprint)}${last.head ? ` (HEAD ${last.head} then)` : ""} but the diff is now ${short(reviewFingerprint(diff))}${head ? ` (HEAD ${head} now)` : ""}: it went stale: ${last.head && head && last.head !== head ? `HEAD moved from ${last.head} to ${head} since the review, and the delivered content differs from what was reviewed` : "a later edit or amend"}.`);
	const background = backgroundState.get(target) ?? backgroundState.get(diff.repo);
	if (background) lines.push(`A background code-reviewer for this repo ${background}; it counts only once it completes cleanly on this same diff (wait for its completion notice), or run a foreground review.`);
	if (lines.length === 0) lines.push("No code review has run for this diff fingerprint " + short(reviewFingerprint(diff)) + ".");
	return `Delivery diff has no matching completed review. ${lines.join(" ")} `;
}
