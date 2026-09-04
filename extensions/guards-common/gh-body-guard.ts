/**
 * The `gh --body` guard: markdown backticks the shell eats before gh sees them.
 *
 * `gh pr create --body "… `PromptEditor` …"` is not a quoting nit. Inside DOUBLE
 * quotes a backtick pair is command substitution, so the shell RUNS the words
 * the author meant to render as code and splices the output — usually empty,
 * often an error on stderr — into the body in their place. `gh` then posts that
 * body and exits 0. Nothing fails. The PR description is simply missing the
 * text, and whoever wrote it has already moved on.
 *
 * Four papercuts in two days (2026-08-17/18) are this exact command, and one of
 * them printed a `command not found` where a code span should have been. It
 * recurs because every one of those bodies is model-written markdown, and code
 * spans are what markdown about code is made of.
 *
 * WHY BLOCK RATHER THAN HINT. A hint fires on the RESULT, and this result is a
 * success: exit 0, a PR url, no error. There is nothing for a result-matcher to
 * match on. The only moment the corruption is visible is before the shell runs.
 *
 * WHAT IT DOES NOT BLOCK — the guard is narrow on purpose, because a guard that
 * blocks working commands gets worked around:
 *
 *   - single-quoted bodies: `--body '… `x` …'` — no expansion, correct as written
 *   - `--body-file` and `-F`: the remediation itself
 *   - `--body "$(cat file)"` and quoted heredocs: `$( … )` spans are removed
 *     before the check, so a substitution the author clearly meant is left alone
 *   - a backslash-escaped `\`` inside the quotes: already literal
 *
 * THE SAME TRAP, ON `--attach` (HIV-3240). gh 2.99's `--attach '<file>#<alt>'`
 * carries free-text alt after the `#`, and that alt is prose exactly like a
 * body — a double-quoted backtick in it is run by the shell before gh sees it.
 * `--attach` is in `BODY_FLAGS` for the backtick check for that reason. It is
 * NOT added to the serialized-Markdown check: an attach value is a path plus a
 * short caption, never a multi-heading document.
 */

import { splitCommands } from "./shell-split.ts";

export type GhBodyVerdict = { kind: "allow" } | { kind: "block"; reason: string };

const ALLOW: GhBodyVerdict = { kind: "allow" };

/**
 * The flags that carry prose to GitHub.
 *
 * `-b` is `gh pr create`'s short `--body` (its `-B` is `--base`, which is why
 * this comparison is case-SENSITIVE). `--notes` is the release equivalent.
 */
const BODY_FLAGS = ["--body", "--notes", "--attach", "-b"];

/**
 * `-n` is `gh release create`'s short `--notes`, and NOTHING else in gh.
 *
 * It used to sit in `BODY_FLAGS` unconditionally, which made it the single
 * greediest token here: `-n` is `grep`'s line numbers, `head`/`tail`'s count,
 * `sed`'s quiet, `xargs`'s batch size. Per-segment attribution fixes the common
 * case (`gh pr list && grep -n "…"` is now two segments and only the first is
 * gh's), but a `$( … )` is deliberately NOT split, so a foreign `-n` inside a
 * substitution still sits in the gh segment. Scoping the flag to the one verb
 * that owns it removes that whole class rather than one instance of it.
 */
const RELEASE_NOTE_FLAGS = ["-n"];
const PR_BODY_FLAGS = ["--body", "-b"];

/**
 * Does this command invoke `gh` at all?
 *
 * Word-bounded so `light` and `./gh-helper.sh` do not qualify. Anything else
 * with a `--body` flag — `curl`, a project script — is not this failure: gh is
 * the tool whose body is markdown by convention.
 */
function invokesGh(command: string): boolean {
	return /(^|[;&|(]|\s)gh(\s|$)/.test(command);
}

// The global flags gh accepts BEFORE its verb, in both spellings. `-R` is here
// and not only `--repo` because dropping it is a silent hole rather than a
// cosmetic gap: these detectors decide whether a segment's `--body`/`-n` is
// scanned at all, so a form they fail to recognise is one this guard ALLOWS.
// `gh -R owner/repo release create v1 -n "notes `date`"` is a real command —
// gh parses `-R` there — and without this alternative its notes would reach the
// shell unexamined.
const GH_GLOBAL_FLAG = String.raw`(?:\s+(?:--(?:repo|hostname)|-R)(?:=|\s+)\S+)*`;

function invokesGhPRCreateOrEdit(command: string): boolean {
	return new RegExp(String.raw`(^|[;&|(]|\s)gh${GH_GLOBAL_FLAG}\s+pr\s+(?:create|edit)(?=\s|$)`).test(command);
}

/** `gh release create|edit` — the only gh verb whose `-n` means `--notes`. */
function invokesGhReleaseCreateOrEdit(command: string): boolean {
	return new RegExp(String.raw`(^|[;&|(]|\s)gh${GH_GLOBAL_FLAG}\s+release\s+(?:create|edit)(?=\s|$)`).test(command);
}

function decodedSerializedMarkdown(body: string): { text: string; newlineCount: number } {
	let text = "";
	let newlineCount = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") {
			text += body[i];
			continue;
		}
		let slashCount = 1;
		while (body[i + slashCount] === "\\") slashCount++;
		const next = body[i + slashCount];
		const following = body.slice(i + slashCount);
		if (slashCount % 2 === 1 && (next === "n" || following.startsWith("r\\n"))) {
			text += "\\".repeat((slashCount - 1) / 2) + "\n";
			newlineCount++;
			i += slashCount + (next === "n" ? 0 : 2);
			continue;
		}
		text += body.slice(i, i + slashCount);
		i += slashCount - 1;
	}
	return { text, newlineCount };
}

function isSerializedMarkdownBody(body: string): boolean {
	if (/[\r\n]/.test(body)) return false;
	try {
		JSON.parse(body);
		return false;
	} catch {
		// A non-JSON body can still be a serialized Markdown document.
	}
	const decoded = decodedSerializedMarkdown(body);
	return decoded.newlineCount >= 2 && decoded.text.split("\n").filter((line) => /^#{1,6}\s/.test(line.trim())).length >= 2;
}

/**
 * The double-quoted value that follows a body flag, or null.
 *
 * Returns the RAW span between the quotes, backslash escapes intact — the
 * caller decides what counts as dangerous. Scanning stops at the first
 * unescaped closing quote, which is where the shell stops too.
 */
function quotedBodies(command: string, flags: string[], quotes: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < command.length; i++) {
		const flag = flags.find(
			(f) =>
				command.startsWith(f, i) &&
				(i === 0 || /\s/.test(command[i - 1])) &&
				// `--body-file` starts with `--body`; a flag ends at whitespace or `=`.
				/[\s=]/.test(command[i + f.length] ?? " "),
		);
		if (!flag) continue;
		let j = i + flag.length;
		if (command[j] === "=") j++;
		while (j < command.length && /\s/.test(command[j])) j++;
		const quote = command[j];
		if (!quote || !quotes.includes(quote)) continue;
		j++;
		let value = "";
		for (; j < command.length; j++) {
			const ch = command[j];
			if (quote === '"' && ch === "\\") {
				value += ch + (command[j + 1] ?? "");
				j++;
				continue;
			}
			if (ch === quote) break;
			value += ch;
		}
		out.push(value);
		i = j;
	}
	return out;
}

/**
 * Every double-quoted body value in ONE command segment.
 *
 * Takes a segment rather than a whole chain — see `ghBodyVerdict`. It still
 * behaves identically on a single, uncompounded command, which is what its
 * tests pin.
 */
export function doubleQuotedBodies(segment: string): string[] {
	const flags = invokesGhReleaseCreateOrEdit(segment) ? [...BODY_FLAGS, ...RELEASE_NOTE_FLAGS] : BODY_FLAGS;
	return quotedBodies(segment, flags, '"');
}

function quotedPRBodies(command: string): string[] {
	return quotedBodies(command, PR_BODY_FLAGS, "\"'");
}

/** Remove balanced `$( … )` spans — a substitution the author asked for. */
function stripCommandSubstitutions(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "$" && value[i + 1] === "(") {
			let depth = 1;
			i += 2;
			for (; i < value.length && depth > 0; i++) {
				if (value[i] === "(") depth++;
				else if (value[i] === ")") depth--;
			}
			i--;
			continue;
		}
		out += value[i];
	}
	return out;
}

/** Is there a backtick the shell would act on? Escaped ones are already literal. */
export function hasLiveBacktick(value: string): boolean {
	const bare = stripCommandSubstitutions(value);
	for (let i = 0; i < bare.length; i++) {
		if (bare[i] === "\\") {
			i++;
			continue;
		}
		if (bare[i] === "`") return true;
	}
	return false;
}

/**
 * Decide whether a shell command would have its `gh` body eaten by the shell.
 *
 * Fails OPEN on everything it does not recognise, like every other guard here:
 * its job is one known-bad shape, and a guard that blocks when unsure makes the
 * shell unusable.
 *
 * PER-SEGMENT ATTRIBUTION, WHOLE-COMMAND REFUSAL. Those are two different
 * questions and they had been answered by the same string. The refusal is and
 * stays whole-command — the tool runs ONE shell string, so a guard genuinely
 * cannot run two thirds of a chain, and `blockedBodyReason` says so. But
 * deciding WHOSE body this is has to be per-segment, and it was not: `invokesGh`
 * only needed the token `gh` somewhere in the chain, and the body scan then swept
 * the entire string. So a body belonging to a different command in the chain was
 * refused and reported as "this gh PR inline body" —
 *
 *   gh pr view 5 && ./notify.sh --body "see `x`"    → notify.sh's body, not gh's
 *   gh pr list && grep -n "`date`" file             → grep's -n read as --notes
 *
 * — and the agent, told its PR body was wrong, went looking at a PR body that
 * was never in the command. ~28 agent sessions in 7 days hit this shape.
 *
 * DIRECTION OF RISK, stated because narrowing a guard always has one. Scanning
 * less can only turn blocks into ALLOWS: no command that works today starts
 * being refused. The residual is the reverse — a genuine gh body can now sit in
 * a segment this scan skips, wherever `splitCommands` breaks the string where
 * the shell would not. The concrete one: it treats a lone `&` as a separator,
 * so a redirect splits a segment, and `gh pr create 2>&1 --body "…`x`…"` leaves
 * the body in a segment with no `gh` token. Rare — a redirect after the body is
 * the normal ordering — and not fixed here, because the splitter is shared with
 * pr-attachments and changing its separators is a different change with its own
 * tests. It is the same fail-open posture declared at the top of this comment,
 * and it is the right way round: this guard exists to save a PR description,
 * and it must never cost a push.
 */
export function ghBodyVerdict(command: string | undefined): GhBodyVerdict {
	if (!command || !invokesGh(command)) return ALLOW;
	const segments = splitCommands(command);
	if (segments.filter(invokesGh).some((segment) => doubleQuotedBodies(segment).some(hasLiveBacktick))) {
		return blockedBodyReason(
			command,
			"a markdown backtick inside DOUBLE quotes",
			"The shell runs backticked text as a command and splices the output into the body before gh sees it",
		);
	}
	if (
		segments
			.filter(invokesGhPRCreateOrEdit)
			.some((segment) => quotedPRBodies(segment).some(isSerializedMarkdownBody))
	) {
		return blockedBodyReason(
			command,
			"literal \\n separators instead of Markdown line breaks",
			"The shell preserves those two characters, so GitHub stores one long line instead of the Markdown document you wrote",
		);
	}
	return ALLOW;
}

function blockedBodyReason(command: string, problem: string, consequence: string): GhBodyVerdict {
	// A COMPOUND command is refused whole, and the caller has to be told that.
	//
	// The first agent to hit this guard (2026-08-18, 25 minutes after it shipped)
	// had written `git commit … && git push … && gh pr create --body "…"`. The
	// block was correct — a guard cannot run two thirds of a command — but the
	// message talked only about the PR body, so the agent read it as "your PR
	// body is wrong" and lost the commit and the push with it. Naming the
	// consequence is the difference between a rule and a trap.
	const compound = /&&|\|\||;/.test(command);

	return {
		kind: "block",
		reason: [
			`BLOCKED: this gh PR inline body contains ${problem}.`,
			"",
			`${consequence}. GitHub still exits 0, so the damage is otherwise silent.`,
			"",
			"Write the body to a file and pass it instead — the body then reaches GitHub byte",
			"for byte, and it is the only form that survives a body of any length:",
			"",
			"  gh pr create --title '…' --body-file /tmp/pr-body.md",
			"",
			"(Single quotes also stop the expansion, but they break on the first apostrophe in",
			"the prose, which is why --body-file is the remediation.)",
			...(compound
				? [
						"",
						"NOTE: this refused the WHOLE command, including the steps before `gh` — a guard",
						"cannot run two thirds of a chain. Nothing in it ran. Re-run the earlier steps on",
						"their own (they were never the problem), then create the PR with --body-file.",
					]
				: []),
		].join("\n"),
	};
}
