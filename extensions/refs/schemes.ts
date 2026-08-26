/**
 * Reference schemes — `conflict://`, `pr://`, `issue://` (HIV-1566).
 *
 * oh-my-pi resolves internal schemes through its filesystem-shaped tools, so
 * `read pr://1428` works like `read src/foo.ts`. The appeal is not the syntax,
 * it is technique #4: the model reaches for a read reflexively, and a scheme is
 * available at the moment of use, whereas "run `gh pr view --json …`" lives in
 * a README nothing consults.
 *
 * We could not take the shape wholesale. pi's `getAllTools()` returns
 * `ToolInfo` — name, description, parameters, sourceInfo — with **no
 * `execute`**, so an extension cannot capture the built-in `read` and delegate
 * non-scheme paths to it. Overriding `read` would mean reimplementing it
 * (offsets, images, notebooks, PDFs, line numbering) and shipping a worse copy.
 * So this is additive: one `read_ref` tool, plus a hint appended to a failed
 * `read` when the path looks like a scheme — the guidance lands in the tool
 * RESULT, which is the placement that works.
 *
 * `conflict://` is the one that earns its place. The others are thin wrappers
 * over `gh`, which the CLI-first rule says are marginal; they are here because
 * a scheme is only reflexive if it is uniform.
 *
 * Everything here is read-only, and every resolver shells out to the same
 * command a human would run.
 */

export type Scheme = "conflict" | "pr" | "issue";

export const SCHEMES: Scheme[] = ["conflict", "pr", "issue"];

/** Anything with a `<word>://` prefix, so an unknown scheme gets a real error
 *  rather than being treated as a relative path that happens to contain a colon. */
const SCHEME_SHAPED = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

export interface ParsedRef {
	scheme: Scheme;
	target: string;
}

export type ParseResult =
	| { kind: "ref"; ref: ParsedRef }
	| { kind: "not-a-ref" }
	| { kind: "unknown-scheme"; scheme: string };

export function parseRef(raw: string): ParseResult {
	const match = SCHEME_SHAPED.exec(raw.trim());
	if (!match) return { kind: "not-a-ref" };
	const scheme = match[1].toLowerCase();
	const target = match[2].trim();
	if (!SCHEMES.includes(scheme as Scheme)) return { kind: "unknown-scheme", scheme };
	return { kind: "ref", ref: { scheme: scheme as Scheme, target } };
}

/** True for a path a `read` should never have been given — used to decide
 *  whether a failed read deserves the hint. */
export function looksLikeRef(raw: unknown): boolean {
	return typeof raw === "string" && SCHEME_SHAPED.test(raw.trim());
}

export function hintForFailedRead(path: string): string {
	const parsed = parseRef(path);
	if (parsed.kind === "unknown-scheme") {
		return (
			`\n\nNote: \`${path}\` looks like a URL scheme, but \`${parsed.scheme}://\` is not one this harness resolves. ` +
			`Supported: ${SCHEMES.map((s) => `${s}://`).join(", ")} via the \`read_ref\` tool.`
		);
	}
	return (
		`\n\nNote: \`${path}\` is a reference, not a file path — \`read\` cannot open it. ` +
		"Use the `read_ref` tool for it."
	);
}

/**
 * The command a scheme resolves to.
 *
 * Kept as data (argv arrays, never a shell string) so the resolver is testable
 * without running anything, and so a target can never be concatenated into a
 * shell. `gh` and `git` are invoked directly — no shell, no interpolation.
 */
export type RefCommand = {
	command: string;
	args: string[];
	/**
	 * Run here instead of the session's cwd. Only `conflict://` with an ABSOLUTE
	 * target sets it: the conflicted index is a property of the file's own
	 * worktree, and the session's cwd is frequently a different one — agents
	 * work in a second worktree while `bash` runs in the first, so the three
	 * `git show :N:` probes all failed with "is in the index, but not at stage
	 * 1" against a tree where the file was never conflicted (three sessions,
	 * 2026-08-19..21).
	 */
	cwd?: string;
};

export type ResolveResult = { kind: "command"; commands: RefCommand[] } | { kind: "error"; message: string };

export function commandsFor(ref: ParsedRef): ResolveResult {
	switch (ref.scheme) {
		case "pr": {
			const number = ref.target.replace(/^#/, "");
			if (!/^\d+$/.test(number)) {
				return { kind: "error", message: `pr:// takes a PR number, got "${ref.target}" (e.g. pr://1428).` };
			}
			return {
				kind: "command",
				commands: [
					{
						command: "gh",
						args: ["pr", "view", number, "--json", "number,title,state,author,body,files,additions,deletions"],
					},
				],
			};
		}
		case "issue": {
			const key = ref.target.replace(/^#/, "");
			if (/^\d+$/.test(key)) {
				return {
					kind: "command",
					commands: [{ command: "gh", args: ["issue", "view", key, "--json", "number,title,state,author,body"] }],
				};
			}
			// A Linear key is deliberately NOT resolved here. The obvious
			// implementation shells out to a `linear` CLI — which does not exist on
			// this machine, so it would have shipped as a documented path that dies
			// on "command not found". Linear is reached through its MCP server, which
			// a shell-out tool cannot call; naming that is more useful than failing.
			if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) {
				return {
					kind: "error",
					message:
						`issue:// does not resolve Linear keys — there is no Linear CLI on this machine. ` +
						`For ${key.toUpperCase()}, use the Linear MCP tool (\`get_issue\`). ` +
						`issue:// handles GitHub issue numbers, e.g. issue://1428.`,
				};
			}
			return {
				kind: "error",
				message: `issue:// takes a GitHub issue number, got "${ref.target}" (e.g. issue://1428).`,
			};
		}
		case "conflict": {
			if (!ref.target) {
				return {
					kind: "error",
					message: "conflict:// takes a path, e.g. conflict://src/foo.ts. Use `git diff --name-only --diff-filter=U` to list them.",
				};
			}
			// The three stages git keeps for an unmerged path. Reading them
			// separately is the whole point: the working-tree file is the version
			// with the <<<<<<< markers in it, which is what the model would
			// otherwise be hand-parsing.
			//
			// An absolute target resolves against the FILE'S repository, not the
			// session's cwd: run from the file's directory with a `./`-relative
			// pathspec (`:N:./name` is cwd-relative by git's own rules, where the
			// bare form is root-relative). This is what makes a conflict in a
			// second worktree readable at all — see RefCommand.cwd.
			if (ref.target.startsWith("/")) {
				const cut = ref.target.lastIndexOf("/");
				const dir = cut === 0 ? "/" : ref.target.slice(0, cut);
				const name = ref.target.slice(cut + 1);
				if (!name) {
					return { kind: "error", message: `conflict:// takes a file path, got the directory "${ref.target}".` };
				}
				return {
					kind: "command",
					commands: [1, 2, 3].map((stage) => ({
						command: "git",
						args: ["show", `:${stage}:./${name}`],
						cwd: dir,
					})),
				};
			}
			return {
				kind: "command",
				commands: [
					{ command: "git", args: ["show", `:1:${ref.target}`] },
					{ command: "git", args: ["show", `:2:${ref.target}`] },
					{ command: "git", args: ["show", `:3:${ref.target}`] },
				],
			};
		}
	}
}

/** Section headers for `conflict://`'s three stages, in command order. */
export const CONFLICT_STAGES = ["base (common ancestor)", "ours (current branch)", "theirs (incoming)"] as const;

export function renderConflict(target: string, outputs: { ok: boolean; text: string }[]): string {
	const parts = [`Merge conflict: ${target}`, ""];
	for (let i = 0; i < CONFLICT_STAGES.length; i++) {
		const stage = CONFLICT_STAGES[i];
		const output = outputs[i];
		if (!output?.ok) {
			// A missing stage is meaningful, not an error: no :1: means the file
			// was added on both sides, no :2: means deleted-by-us, and so on.
			parts.push(`## ${stage}\n\n(absent — this side has no version of the file)`, "");
			continue;
		}
		parts.push(`## ${stage}\n\n\`\`\`\n${output.text.trimEnd()}\n\`\`\``, "");
	}
	return parts.join("\n");
}
