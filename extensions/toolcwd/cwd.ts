/**
 * The rules for honouring a `cwd` the `bash` tool does not have.
 *
 * Pure, so every rule below is a unit test rather than a claim.
 */

/** The tag that marks our sentence in a tool result, matching toolhints'. */
export const CWD_NOTE_TAG = "harness";

export interface BashCwdRepair {
	/** The command to run instead, or null when there is nothing to repair. */
	command: string | null;
	/** The sentence to append to the result, or null when nothing was changed. */
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
 * repairBashCwd decides what to do with a `cwd` argument on a `bash` call.
 *
 * ## Why honour it rather than refuse it
 *
 * The agents asked to be refused — "silently ignored the supplied `cwd` field
 * INSTEAD OF REJECTING IT" is how one of them put it — and refusing would be a
 * defensible fix. It is not the better one: the intent is unambiguous, so a
 * refusal spends a turn to arrive at the command the caller already meant. What
 * they were actually complaining about is the SILENCE, and that is fixable
 * without throwing the work away: run what they meant, then say so in the
 * result.
 *
 * ## What it will not do
 *
 * - **Never rewrite a command that already begins with `cd`.** The caller has
 *   said where to run; a second `cd` in front of it is at best redundant and at
 *   worst wrong (`cd a && cd b` lands in `a/b` when `b` is relative). The stray
 *   argument is still reported, because the caller should stop sending it.
 * - **Never invent a directory.** A non-string, empty or whitespace `cwd`
 *   cannot be honoured and is left exactly as pi already treats it.
 * - **Never validate the path.** A missing directory makes `cd` fail loudly on
 *   the caller's own terms, which is the right outcome and a better error than
 *   any this file could compose.
 */
export function repairBashCwd(input: Record<string, unknown> | undefined): BashCwdRepair {
	const none: BashCwdRepair = { command: null, note: null };
	if (!input || typeof input !== "object") return none;

	const raw = input.cwd;
	if (typeof raw !== "string") return none;
	const dir = raw.trim();
	if (!dir) return none;

	const command = typeof input.command === "string" ? input.command : "";
	if (!command.trim()) return none;

	// `cd` already at the head — including `cd x && cd y` and a leading
	// subshell — means the caller located the command themselves.
	if (/^\s*\(?\s*cd\s/.test(command)) {
		return {
			command: null,
			note:
				`\`bash\` has no \`cwd\` parameter, so the \`cwd\` you passed was dropped. Your command ` +
				`already began with \`cd\`, so it ran where you intended — but pass the directory inline ` +
				`(\`cd <dir> && …\`, or \`git -C <dir> …\`) rather than as an argument.`,
		};
	}

	return {
		command: `cd ${shellQuote(dir)} && ${command}`,
		note:
			`\`bash\` has no \`cwd\` parameter — unlike \`background_bash\`, which does. Rather than drop ` +
			`it, this harness ran your command as \`cd ${shellQuote(dir)} && …\`. Pass the directory ` +
			`inline next time (\`cd <dir> && …\`, or \`git -C <dir> …\`): on a harness without this ` +
			`repair the argument is ignored silently and the command runs in the session's checkout.`,
	};
}
