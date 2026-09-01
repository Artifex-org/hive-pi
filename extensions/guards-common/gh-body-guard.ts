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
 */

export type GhBodyVerdict = { kind: "allow" } | { kind: "block"; reason: string };

const ALLOW: GhBodyVerdict = { kind: "allow" };

/**
 * The flags that carry prose to GitHub.
 *
 * `-b` is `gh pr create`'s short `--body` (its `-B` is `--base`, which is why
 * this comparison is case-SENSITIVE). `--notes` is the release equivalent.
 */
const BODY_FLAGS = ["--body", "--notes", "-b", "-n"];
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

function invokesGhPRCreateOrEdit(command: string): boolean {
	return /(^|[;&|(]|\s)gh(?:\s+--(?:repo|hostname)(?:=|\s+)\S+)*\s+pr\s+(?:create|edit)(?=\s|$)/.test(command);
}

function isSerializedMarkdownBody(body: string): boolean {
	if (/[\r\n]/.test(body) || (body.match(/\\n/g)?.length ?? 0) < 2) return false;
	try {
		JSON.parse(body);
		return false;
	} catch {
		// A non-JSON body can still be a serialized Markdown document.
	}
	const normalized = body.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
	return normalized.split("\n").filter((line) => /^#{1,6}\s/.test(line.trim())).length >= 2;
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

export function doubleQuotedBodies(command: string): string[] {
	return quotedBodies(command, BODY_FLAGS, '"');
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
 */
export function ghBodyVerdict(command: string | undefined): GhBodyVerdict {
	if (!command || !invokesGh(command)) return ALLOW;
	const offending = doubleQuotedBodies(command).find(hasLiveBacktick);
	if (offending !== undefined) {
		return blockedBodyReason(
			command,
			"a markdown backtick inside DOUBLE quotes",
			"The shell runs backticked text as a command and splices the output into the body before gh sees it",
		);
	}
	if (invokesGhPRCreateOrEdit(command) && quotedPRBodies(command).some(isSerializedMarkdownBody)) {
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
