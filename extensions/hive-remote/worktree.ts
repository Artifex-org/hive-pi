/**
 * hive-remote — the working tree: what this agent has changed, and how far
 * along that change is.
 *
 * The Hive detail pane could already say what an agent's work BECAME, once a
 * pull request existed: GitHub lists the files and the gate says what it thought
 * of them. Before that point it said nothing at all — and "twenty minutes in,
 * nothing pushed" is the state an attached agent spends most of its life in.
 * Only the client is standing in the worktree, so only the client can answer.
 *
 * WHY THIS RIDES THE CONTROL CHANNEL AND NOT hive-telemetry — the same boundary
 * status.ts states: telemetry's payload.ts is the audited "review one file and
 * you have reviewed what leaves the machine" surface, and it is deliberately
 * metric-only. File PATHS are prose about a person's machine. Here consent is
 * the existence of a conversation, which is separately opt-in and already
 * sending the transcript that names these same files.
 *
 * The PARSERS in this file are pure and take git's output as a string. The
 * subprocesses live in `collectWorktree`, which is blocking and must therefore
 * only ever be called from a detached timer — never from an event handler, which
 * pi awaits serially and which therefore IS the agent loop.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Mirrors internal/api/agent_worktree.go's closed state set. Hive drops an
 *  entry whose state it does not recognise, so the two must agree. */
export type WorktreeFileState = "committed" | "staged" | "unstaged" | "both" | "untracked" | "conflicted";

export interface WorktreeFile {
	path: string;
	state: WorktreeFileState;
	/** Omitted, never zeroed, when git reported no line counts (a binary file,
	 *  an untracked one). +0/−0 claims a measurement nobody made. */
	additions?: number;
	deletions?: number;
}

export interface WorktreePayload {
	/** The absolute directory this exact reading was measured from. It travels
	 * with the branch and files so a delayed report can never be paired with a
	 * newer conversation path from a different checkout. */
	path: string;
	/**
	 * The LOCAL branch, from porcelain's own header — not reconstructed from
	 * `upstream`, which names a different branch until the first push.
	 *
	 * Hive's rail derived the branch it asks every question about by stripping
	 * the remote off `upstream`, on the premise that the upstream names the
	 * branch the agent moved to. That holds only AFTER a push. A worktree cut
	 * from trunk tracks trunk — `## main-2abaeee9...origin/main [behind 45]` —
	 * so the rail asked about `main` and showed TRUNK's runs, commits, factory
	 * work and files. Six of seven live sessions, measured (HIV-2255).
	 *
	 * "" for a detached HEAD, which has no branch to name.
	 */
	branch: string;
	upstream: string;
	/** null means "no upstream, so there is no answer" — which must never be
	 *  sent as the 0 that means "in step with it", i.e. delivered. */
	ahead: number | null;
	behind: number | null;
	files: WorktreeFile[];
	truncated: boolean;
	/** Sandbox placeholders dropped from `files` — reported, never silently
	 *  removed, on the same terms as `truncated`. */
	masked: number;
}

/** The launch config srt is started with. Its presence in the checkout is what
 *  says THIS worktree is a sandboxed launch, and therefore that masks exist. */
const SANDBOX_CONFIG = ".hive-sandbox.json";

/**
 * Is this untracked entry a sandbox mask rather than the agent's work?
 *
 * `srt` neutralizes project-local config it will not let the agent read by
 * writing **empty, read-only placeholders into the checkout** — `.bashrc`,
 * `.zshrc`, `.profile`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.ripgreprc`,
 * `.idea`, `.vscode`, `.claude/…`. They are untracked, they are not the
 * agent's, and they made the Hive panel's changed-file list eleven rows of
 * scaffolding on a session that had changed nothing.
 *
 * The test is MEASURED, not a name list: a mask is a regular file of zero bytes
 * whose mode is 0444. A name list is the obvious implementation and it rots the
 * moment srt masks one more file — this cannot, because 0-byte-and-read-only is
 * a property of what a mask IS. An editor, a build or an agent creates 0644
 * files; nothing in normal work produces a read-only empty one.
 *
 * It is self-limiting twice over: it runs only when `.hive-sandbox.json` is
 * present (an unsandboxed session is untouched), and only on untracked entries
 * (a tracked file that happens to be empty and read-only is real work and stays).
 */
export function isSandboxMask(cwd: string, path: string): boolean {
	if (path === SANDBOX_CONFIG) return true;
	try {
		const st = statSync(join(cwd, path));
		return st.isFile() && st.size === 0 && (st.mode & 0o777) === 0o444;
	} catch {
		// Raced with a delete, or unreadable. Not-a-mask is the safe answer: it
		// keeps a row that may be real rather than hiding one that is.
		return false;
	}
}

/** Hive's cap (MaxAgentWorktreeFiles). Mirrored here because THIS side owns the
 *  data: a client that sends more has its list silently clipped server-side, and
 *  clipping it here means we also set `truncated` honestly. */
export const MAX_WORKTREE_FILES = 200;

/** git is a subprocess on the agent loop's thread; a repo that hangs must not
 *  take the session with it. */
const GIT_TIMEOUT_MS = 5_000;

interface BranchInfo {
	/** The local branch. "" when git named no branch (detached HEAD). */
	branch: string;
	upstream: string;
	ahead: number | null;
	behind: number | null;
}

/**
 * Parses porcelain v1's `## ` header line.
 *
 * Four shapes in the wild, and three of them are not "branch...upstream":
 *
 *   ## feat/x...origin/feat/x [ahead 2, behind 1]
 *   ## feat/x...origin/feat/x [gone]   — the upstream was deleted
 *   ## feat/x                          — never pushed
 *   ## HEAD (no branch)                — detached, mid-rebase, mid-bisect
 *
 * The last two and `[gone]` all yield null/null. An upstream that EXISTS with no
 * bracket means "in step", which is a real 0/0 — the one case where zero is the
 * measurement rather than the absence of one.
 *
 * The LOCAL branch comes from the same line and is reported separately, because
 * the two halves disagree far more often than they agree: every worktree cut
 * from trunk and not yet pushed reads `## <mine>...origin/main`. Deriving one
 * from the other is what HIV-2255 is.
 *
 * `## HEAD (no branch)` yields "" rather than "HEAD": there is no branch, and a
 * literal "HEAD" would be queried as if there were.
 */
export function parseBranchLine(line: string): BranchInfo {
	const body = line.startsWith("## ") ? line.slice(3) : "";
	const bracket = body.indexOf(" [");
	const head = bracket >= 0 ? body.slice(0, bracket) : body;
	const track = bracket >= 0 ? body.slice(bracket + 2).replace(/]$/, "") : "";

	const sep = head.indexOf("...");
	// No `...` is the never-pushed shape, where the whole head IS the branch —
	// the case that most needs reporting, since it has no upstream to fall back
	// on. `localBranch` filters the detached spelling out of both paths.
	if (sep < 0) return { branch: localBranch(head), upstream: "", ahead: null, behind: null };
	const branch = localBranch(head.slice(0, sep));
	const upstream = head.slice(sep + 3);
	// `gone` is not a divergence, it is the loss of the thing divergence is
	// measured against. Reporting 0/0 there would render as delivered.
	if (/\bgone\b/.test(track)) return { branch, upstream, ahead: null, behind: null };

	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	return {
		branch,
		upstream,
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
	};
}

/**
 * The head half of the porcelain line, reduced to a branch name or "".
 *
 * Detached HEAD spells itself `HEAD (no branch)`, and mid-rebase/mid-bisect add
 * their own parenthetical. Anything with a space is git narrating a state, not
 * naming a branch — a branch name cannot contain one (git-check-ref-format).
 */
function localBranch(head: string): string {
	const s = head.trim();
	if (!s || s.includes(" ") || s === "HEAD") return "";
	return s.slice(0, MAX_BRANCH_LENGTH);
}

/** Hive stores the branch in a `char_length(branch) <= 255` column. Clipped here
 *  so an absurd ref name is shortened rather than rejected whole. */
const MAX_BRANCH_LENGTH = 255;

/**
 * Classifies one porcelain XY status code.
 *
 * `both` — staged AND unstaged changes to one file — is kept rather than
 * flattened because it is the state an agent gets stuck in: half of a file
 * staged, the rest not, and a commit that would ship only half the fix.
 */
export function classifyStatusCode(x: string, y: string): WorktreeFileState {
	if (x === "?" || y === "?") return "untracked";
	// git's own definition of unmerged: either side is U, or the pair is DD/AA.
	if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) return "conflicted";
	const staged = x !== " " && x !== "";
	const unstaged = y !== " " && y !== "";
	if (staged && unstaged) return "both";
	if (staged) return "staged";
	return "unstaged";
}

/**
 * Parses `git status --porcelain=v1 -b -z --untracked-files=all`.
 *
 * -z rather than the default, and that is not a style choice: without it git
 * QUOTES any path containing a space, a quote or a non-ASCII byte, so a
 * perfectly ordinary `docs/my notes.md` arrives as `"docs/my notes.md"` and a
 * German filename arrives as octal escapes. Unquoting that correctly is a
 * parser; NUL separation removes the need for one.
 *
 * A rename entry carries TWO paths — the new one in the record, the original in
 * the field that follows it — so the loop consumes that extra field. Missing it
 * would file the original path as its own bogus entry with a two-character
 * status read off the middle of a path.
 */
export function parseStatus(out: string): { branch: BranchInfo; files: WorktreeFile[] } {
	const parts = out.split("\0");
	let branch: BranchInfo = { branch: "", upstream: "", ahead: null, behind: null };
	const files: WorktreeFile[] = [];

	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) continue;
		if (entry.startsWith("## ")) {
			branch = parseBranchLine(entry);
			continue;
		}
		if (entry.length < 4) continue;
		const x = entry[0];
		const y = entry[1];
		const path = entry.slice(3);
		if (x === "R" || x === "C" || y === "R" || y === "C") i++; // the original path
		if (!path) continue;
		files.push({ path, state: classifyStatusCode(x, y) });
	}
	return { branch, files };
}

/**
 * Parses `git diff --numstat -z`.
 *
 * Binary files report `-` for both counts. Left ABSENT rather than coerced to 0:
 * "a binary file changed" and "a text file changed by nothing" are different
 * facts, and only one of them is worth a +0/−0 in the panel.
 */
export function parseNumstat(out: string): Map<string, { additions?: number; deletions?: number }> {
	const churn = new Map<string, { additions?: number; deletions?: number }>();
	for (const record of out.split("\0")) {
		if (!record) continue;
		const fields = record.split("\t");
		if (fields.length < 3) continue;
		const [add, del, ...rest] = fields;
		const path = rest.join("\t");
		if (!path) continue;
		const entry: { additions?: number; deletions?: number } = {};
		if (/^\d+$/.test(add)) entry.additions = Number(add);
		if (/^\d+$/.test(del)) entry.deletions = Number(del);
		churn.set(path, entry);
	}
	return churn;
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			timeout: GIT_TIMEOUT_MS,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// Not a repo, a git that is not installed, a tree mid-index-lock. All of
		// them mean "no reading", which the panel renders honestly.
		return null;
	}
}

/**
 * git, for the diff invocations whose SUCCESS is a non-zero exit.
 *
 * `git diff --no-index` exits 1 when its two inputs differ — which is precisely
 * the case that produced output worth having. The ordinary helper above reads
 * any non-zero exit as "no reading", so it would discard every diff it was asked
 * for and keep only the empty ones. Exit 1 with stdout is a result here; 2 and
 * above (a real git error) stays null.
 */
function gitDiffOutput(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			timeout: GIT_TIMEOUT_MS,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (err) {
		const e = err as { status?: number; stdout?: string };
		if (e.status === 1 && typeof e.stdout === "string") return e.stdout;
		return null;
	}
}

/**
 * Reads the tree. BLOCKING — three subprocesses — so call it only from a
 * detached timer.
 *
 * Returns null when the directory is not a git repository, which is the normal
 * case for a session started in a scratch dir and must not be reported as an
 * empty (i.e. clean) tree.
 */
export function collectWorktree(cwd: string): WorktreePayload | null {
	const status = git(cwd, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]);
	if (status === null) return null;

	const { branch, files: reported } = parseStatus(status);

	// Sandbox masks out, before anything measures or sorts them: they are not
	// this agent's work, and counting their churn would let scaffolding order
	// the list. Only when this launch IS sandboxed — the config's presence is
	// the proof, and without it every file here is the agent's.
	const sandboxed = isSandboxMask(cwd, SANDBOX_CONFIG);
	const files = sandboxed
		? reported.filter((f) => !(f.state === "untracked" && isSandboxMask(cwd, f.path)))
		: reported;
	const masked = reported.length - files.length;

	// Working-tree churn: everything the tree has that HEAD does not, staged and
	// unstaged together. --no-renames so a rename shows as an add plus a delete
	// with real line counts, rather than as one record whose numbers describe a
	// path pair this panel does not render.
	const treeChurn = parseNumstat(git(cwd, ["diff", "--numstat", "-z", "--no-renames", "HEAD"]) ?? "");
	for (const file of files) {
		const churn = treeChurn.get(file.path);
		if (churn) Object.assign(file, churn);
	}

	// Committed here and not upstream. Three dots: what THIS branch's commits
	// changed, measured from where it left the upstream — two dots would also
	// report everything the upstream gained meanwhile as though this agent had
	// undone it.
	if (branch.upstream) {
		const committed = parseNumstat(
			git(cwd, ["diff", "--numstat", "-z", "--no-renames", `${branch.upstream}...HEAD`]) ?? "",
		);
		const inTree = new Set(files.map((f) => f.path));
		for (const [path, churn] of committed) {
			// A file that is BOTH committed and dirty keeps its dirty state: the
			// question the panel answers is "what is left to do with this file",
			// and "it is committed" is the wrong answer for a file with unstaged
			// edits sitting on top of that commit.
			if (inTree.has(path)) continue;
			files.push({ path, state: "committed", ...churn });
		}
	}

	// Churn order, matching the server's: the panel renders a prefix, and a
	// truncated alphabetical list is a list of whatever starts with "a".
	files.sort((a, b) => {
		const ca = (a.additions ?? 0) + (a.deletions ?? 0);
		const cb = (b.additions ?? 0) + (b.deletions ?? 0);
		return cb - ca || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	});

	return {
		path: cwd,
		branch: branch.branch,
		upstream: branch.upstream,
		ahead: branch.ahead,
		behind: branch.behind,
		files: files.slice(0, MAX_WORKTREE_FILES),
		truncated: files.length > MAX_WORKTREE_FILES,
		masked,
	};
}

/** Hive's own cap (maxAgentPatchBytes). Mirrored here for the same reason
 *  MAX_WORKTREE_FILES is: the server silently clips a larger body, and clipping
 *  it here means we can also set `truncated` honestly. */
export const MAX_PATCH_BYTES = 1 << 20;

/** One file's diff, as the answer to a `worktree_diff` request. */
export interface WorktreePatch {
	path: string;
	patch: string;
	/** Why the patch is empty, when it is. Never left to the reader to guess. */
	reason?: string;
	truncated?: boolean;
}

/**
 * Read ONE file's working-tree diff (HIV-1421, wired up in HIV-1769).
 *
 * The server has no copy of unpushed work — the worktree report carries paths
 * and counts, never content — so the only way to show a reader what an agent has
 * actually written before it is pushed is to ask the machine it is written on.
 * This answers that question.
 *
 * BLOCKING (subprocesses), so call it from a detached timer, never from an event
 * handler. Never throws: every failure becomes a `reason`, because a viewer that
 * renders nothing and says nothing is indistinguishable from a file with no
 * changes — the one confusion this whole surface exists to avoid.
 *
 * ## What it will not answer
 *
 * A sandbox mask (see isSandboxMask) is refused rather than diffed. Those files
 * are srt's scaffolding, not the agent's work, and they are excluded from the
 * file list for the same reason — answering for one would put content in the
 * browser that the list deliberately never mentioned.
 *
 * The path is checked to be one git itself reports for the tree. `--` already
 * stops a leading dash from being read as a flag, and pathspec magic (`:(glob)`)
 * cannot survive the equality test, so a path the operator did not get from the
 * file list gets no answer at all.
 */
export function collectPatch(cwd: string, path: string, known?: (p: string) => boolean): WorktreePatch {
	if (path === "" || path.includes("\0")) return { path, patch: "", reason: "not a path this session can read" };
	if (known && !known(path)) {
		return { path, patch: "", reason: "not a file this session reported as changed" };
	}
	if (isSandboxMask(cwd, SANDBOX_CONFIG) && isSandboxMask(cwd, path)) {
		return { path, patch: "", reason: "sandbox scaffolding, not this agent's work" };
	}

	// Staged and unstaged together, against HEAD: the same span the file list's
	// churn numbers describe, so the diff a reader opens is the diff they were
	// counting. --no-renames keeps a rename as an add plus a delete, matching the
	// list rather than describing a path pair it never showed.
	let patch = git(cwd, ["diff", "--no-renames", "HEAD", "--", path]);
	if (patch === null) return { path, patch: "", reason: "git could not read this tree" };

	// An untracked file has no HEAD side, so `git diff HEAD` says nothing about
	// it — and "nothing" would render as "unchanged" for a file the list showed
	// as new. --no-index against /dev/null produces the add-everything diff.
	//
	// GATED ON THE FILE ACTUALLY BEING UNTRACKED, which the first version was
	// not: an unchanged TRACKED file also diffs to nothing, so it fell through
	// and came back rendered as if every line had just been added. `ls-files`
	// prints the path only when git is tracking it.
	//
	// The retry needs gitDiffOutput rather than git(): --no-index exits 1 BY
	// DESIGN when the two inputs differ, i.e. in exactly the case that produced a
	// diff worth showing, and the ordinary helper reads any non-zero exit as "no
	// reading".
	if (patch.trim() === "" && (git(cwd, ["ls-files", "--", path]) ?? "").trim() === "") {
		const added = gitDiffOutput(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
		if (added !== null && added.trim() !== "") patch = added;
	}
	if (patch.trim() === "") {
		return { path, patch: "", reason: "no changes against HEAD" };
	}

	if (patch.length > MAX_PATCH_BYTES) {
		return { path, patch: patch.slice(0, MAX_PATCH_BYTES), truncated: true };
	}
	return { path, patch };
}
