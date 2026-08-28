/**
 * The rules for running a `bash` call in the directory it named.
 *
 * Pure, so every rule below is a unit test rather than a claim. The caller is
 * `pretty-tools.ts`, which registers the `bash` tool this harness ships and
 * declares `cwd` on its schema; this module decides what that means for the
 * command text, and what to do about the two spellings nothing declares.
 */

/** The tag that marks our sentence in a tool result, matching toolhints'. */
export const CWD_NOTE_TAG = "harness";

export interface BashCwdRepair {
	/** The command to run instead, or null when there is nothing to change. */
	command: string | null;
	/** The sentence to append to the result, or null when nothing needs saying. */
	note: string | null;
}

/**
 * POSIX single-quoting. A worktree path is attacker-free but not shell-free:
 * `~/.hive/scratch/…` is fine, a branch directory called `feature/it's-broken`
 * is not, and the failure mode of getting it wrong is a command that runs
 * somewhere else — which is the entire bug this file exists to fix.
 */
export function shellQuote(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The keys a caller might name a directory with, most authoritative first.
 *
 * `cwd` is the declared parameter. The other two are not declared by anything —
 * they are what the model reaches for when it is thinking of some other tool —
 * and seven of the thirty cwd papercuts in 2026-08-21..28 spelled it `workdir`,
 * got no rewrite and no warning, and read an answer about the session's
 * checkout as the truth (a `git cherry-pick` landed on `main-aac3a2f7`; a
 * `basedpyright` verified the wrong tree).
 */
const DIRECTORY_KEYS = ["cwd", "workdir", "dir"] as const;

function namedDirectory(input: Record<string, unknown>): { key: string; dir: string } | null {
	for (const key of DIRECTORY_KEYS) {
		const raw = input[key];
		if (typeof raw !== "string") continue;
		const dir = raw.trim();
		if (dir) return { key, dir };
	}
	return null;
}

/**
 * repairBashCwd decides where a `bash` call should run, and whether to say so.
 *
 * ## The declared key is honoured silently
 *
 * `cwd` is a parameter of this harness's `bash` tool, so running the command
 * there is the contract rather than a repair, and it earns no sentence. It is
 * also prefixed UNCONDITIONALLY — including onto a command that begins with
 * `cd`. That is what a working directory means: the command's own relative `cd
 * sub` has to resolve against it (`cd '<cwd>' && cd sub` → `<cwd>/sub`, which
 * is what was asked for; refusing would land in the session's checkout). An
 * absolute inner `cd` wins either way, so nothing is lost.
 *
 * ## A guessed key is honoured and reported
 *
 * `workdir`/`dir` are inferences about intent. The intent is unambiguous, so
 * refusing would spend a turn arriving at the command the caller already meant
 * — but a harness that silently fixes calls is the same class of bug as one
 * that silently breaks them, so the result says what happened and which
 * spelling to use next time.
 *
 * ## What it will not do
 *
 * - **Never prefix a GUESSED key onto a command that already begins with `cd`.**
 *   `cd a && cd b` lands in `a/b` when `b` is relative, and nothing declared
 *   that this argument was a directory. The stray key is still reported.
 * - **Never invent a directory.** A non-string, empty or whitespace value
 *   cannot be honoured and is left exactly as pi already treats it.
 * - **Never validate the path.** A missing directory makes `cd` fail loudly on
 *   the caller's own terms, which is the right outcome and a better error than
 *   any this file could compose.
 */
export function repairBashCwd(input: Record<string, unknown> | undefined): BashCwdRepair {
	const none: BashCwdRepair = { command: null, note: null };
	if (!input || typeof input !== "object") return none;

	const named = namedDirectory(input);
	if (!named) return none;

	const command = typeof input.command === "string" ? input.command : "";
	if (!command.trim()) return none;

	const quoted = shellQuote(named.dir);
	if (named.key === "cwd") return { command: `cd ${quoted} && ${command}`, note: null };

	const preamble =
		`\`bash\` takes the directory as \`cwd\`; you passed \`${named.key}\`, which nothing declares.`;

	// `cd` already at the head — including `cd x && cd y` and a leading
	// subshell — means the caller located the command themselves.
	if (/^\s*\(?\s*cd\s/.test(command)) {
		return {
			command: null,
			note:
				`${preamble} Your command already began with \`cd\`, so it ran where you intended — but ` +
				`pass the directory as \`cwd\` next time, or inline it (\`cd <dir> && …\`, \`git -C <dir> …\`).`,
		};
	}

	return {
		command: `cd ${quoted} && ${command}`,
		note:
			`${preamble} Rather than drop it, this harness ran your command as \`cd ${quoted} && …\`. ` +
			`Pass \`cwd\` next time: on a harness without this repair an undeclared key is ignored ` +
			`silently and the command runs in the session's checkout.`,
	};
}
