/**
 * The pure logic behind the two pr-attachments nudges (HIV-3240).
 *
 * All of this is side-effect free and testable in isolation: whether a path
 * looks UI-visible, whether a shell command opens a PR/issue without attaching,
 * how a `gh --version` line parses, and the exact text each nudge injects. The
 * pi wiring lives in `index.ts`; the disk-backed ledger in `manifest.ts`.
 *
 * ## Why HINTS, never a block
 *
 * `guards-common/gh-body-guard.ts`'s header states the rule this extension
 * obeys: a guard that blocks a working command gets worked around. Attaching
 * screenshots is a nicety, not a correctness gate — blocking a PR because it
 * has no `--attach` would be actively harmful. Both nudges are injected
 * messages the agent is free to ignore.
 */

import { splitCommands } from "../guards-common/shell-split.ts";
import type { ScreenshotRecord } from "./manifest.ts";

/**
 * The globs that mark a file as UI-visible. Enumerated explicitly (HIV-3240)
 * rather than inferred, so the set is auditable and a test can pin each one.
 */
export const UI_GLOBS: readonly string[] = [
	"web/**",
	"frontend/**",
	"mobile/**",
	"apps/**",
	"**/*.tsx",
	"**/*.jsx",
	"**/*.vue",
	"**/*.svelte",
	"**/*.css",
	"**/*.scss",
	"**/templates/**/*.html",
	"**/*.stories.*",
];

/** Compile a glob (`*`, `**`, `?`) to an anchored regex over a POSIX-ish path. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					// `**/` matches zero or more leading directory segments.
					i++;
					re += "(?:.*/)?";
				} else {
					// `**` at the end (e.g. `web/**`) matches everything under it.
					re += ".*";
				}
			} else {
				// `*` matches within a path segment only.
				re += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			re += "[^/]";
			continue;
		}
		re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

const UI_MATCHERS = UI_GLOBS.map(globToRegExp);

/** Normalise a path for glob matching: strip `./`, backslashes, leading `/`. */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

/**
 * Does this file path look UI-visible?
 *
 * Matches the globs against the full normalised path AND against its basename,
 * so an absolute or worktree-prefixed path (`/home/.../web/App.tsx`) still
 * matches a `**`-anchored pattern.
 */
export function isUIVisiblePath(p: string | undefined): boolean {
	if (!p) return false;
	const norm = normalizePath(p);
	const base = norm.split("/").pop() ?? norm;
	return UI_MATCHERS.some((re) => re.test(norm) || re.test(base));
}

/**
 * `splitCommands` used to be defined here. It now lives in
 * `guards-common/shell-split.ts`, because `gh-body-guard.ts` needs the same
 * segmentation to attribute a `--body` to the command that actually owns it,
 * and guards-common is the directory both sides may import from.
 *
 * It is re-exported under its original name so `index.ts` and
 * `test/pr-attachments-logic.test.ts` — which pin the splitter's behaviour —
 * keep importing it from here.
 */
export { splitCommands };

/**
 * `gh (pr|issue) (create|edit|comment)` in a single segment, with optional
 * global flags (`--repo`, `--hostname`) between `gh` and the subcommand —
 * mirrors gh-body-guard's `invokesGhPRCreateOrEdit`.
 */
const GH_PR_ISSUE = /(^|[;&|(]|\s)gh(?:\s+--(?:repo|hostname)(?:=|\s+)\S+)*\s+(?:pr|issue)\s+(?:create|edit|comment)(?=\s|$)/;

/** Is `--attach` present as a flag in this text? */
function hasAttachFlag(segment: string): boolean {
	return /(^|\s)--attach(?=[=\s]|$)/.test(segment);
}

/**
 * The one segment that opens or edits a PR/issue without `--attach`, or null.
 *
 * Scans the compound command's segments and returns the FIRST offending gh
 * segment (trimmed). A segment that already has `--attach` is not offending —
 * that is exactly the well-formed call the nudge wants the agent to reach.
 */
export function ghAttachlessSegment(command: string | undefined): string | null {
	if (!command) return null;
	for (const segment of splitCommands(command)) {
		if (!GH_PR_ISSUE.test(segment)) continue;
		if (hasAttachFlag(segment)) continue;
		return segment.trim();
	}
	return null;
}

/**
 * A stable key for a gh command's SHAPE, so the PR nudge fires once per shape
 * rather than on every retry. Keyed on `gh <object> <verb>` plus the PR/issue
 * number when present — a retry of the same command has the same key, but a
 * `pr create` and a later `pr comment 5` are distinct shapes worth nudging.
 */
export function commandShapeKey(segment: string): string {
	const m = /gh(?:\s+--\S+(?:=\S+)?)*\s+(pr|issue)\s+(create|edit|comment)(?:\s+(\d+))?/.exec(segment);
	if (!m) return segment.trim();
	return `gh ${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ""}`;
}

/** Parsed gh semantic version. */
export interface GhVersion {
	major: number;
	minor: number;
	patch: number;
}

/** The minimum gh version whose `gh … --attach` flag exists (HIV-3240). */
export const MIN_ATTACH_VERSION: GhVersion = { major: 2, minor: 99, patch: 0 };

/**
 * Parse the version out of `gh --version` output.
 *
 * The first line is `gh version 2.99.0 (2026-08-21)`; a mise shim may prepend
 * an activation banner, so we scan for the first `gh version X.Y.Z` anywhere in
 * the text rather than trusting line 1. Returns null when no version is found.
 */
export function parseGhVersion(output: string | undefined): GhVersion | null {
	if (!output) return null;
	const m = /gh version\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Is `v` at least `min`? */
export function versionAtLeast(v: GhVersion | null, min: GhVersion = MIN_ATTACH_VERSION): boolean {
	if (!v) return false;
	if (v.major !== min.major) return v.major > min.major;
	if (v.minor !== min.minor) return v.minor > min.minor;
	return v.patch >= min.patch;
}

/** Shell-safe alt text: no backtick (the exact command-substitution bug). */
function safeAlt(text: string): string {
	return text.replace(/`/g, "'");
}

/**
 * The event-bus channel the browser/flows side raises when there is something to
 * screenshot this session \u2014 a dev server has been reported (the flows
 * extension's resource) or a browser page has been opened (browser_navigate,
 * the fallback the supervisor named). pi's event bus is shared across every
 * extension, so this is how the separate pr-attachments entrypoint learns a
 * state that lives in another extension's private closure.
 */
export const CAPTURABLE_CHANNEL = "pr-attachments.capturable";

/**
 * The one-time BLOCK on the first UI-file edit/write, when a screenshot is
 * possible and none has been taken yet.
 *
 * This is a BLOCK, not a hint, for a timing reason the supervisor caught: a
 * hint fires on the tool_RESULT, i.e. after the edit has already landed and
 * Vite HMR has repainted the dev server \u2014 at which point the `before` state is
 * gone. The only moment a `before` shot is still possible is BEFORE the edit
 * runs, which is exactly what a tool_call block preserves. Fired at most once
 * per session; the next edit runs normally.
 */
export function beforeBlockMessage(): string {
	return (
		"take browser_screenshot label:before now, then re-run this edit. " +
		"This edit touches a UI-visible file and would repaint the dev server (HMR) before you could capture the " +
		"before-state \u2014 so the `before` shot must be taken first. This block fires only once: after it, edits run " +
		"normally. Take the matching `after` shot once the change is up, then attach both to the PR. If this change " +
		"is not visible (types, logic, config), just re-run the edit \u2014 no screenshot needed."
	);
}

/**
 * The BEFORE HINT, used only when nothing is capturable (no dev server, no
 * page opened) \u2014 there is nothing to block for, but the reminder still helps.
 * Injected on the tool_result.
 */
export function beforeNudge(): string {
	return (
		"This edit touches a UI-visible file and no screenshot has been taken yet this session. " +
		"If the change is visible, stand up the dev server, take a `browser_screenshot` with label `before` and a " +
		"matching `after` once the change is up, and attach both to the PR. If this change is not visible (types, " +
		"logic, config), ignore this."
	);
}

/**
 * The `--attach` line for one record, e.g.
 *   --attach '/tmp/pi-browser-1/shot-1.png#before: <what this shows>'
 *
 * Single-quoted deliberately: the alt text is prose, and a double-quoted
 * backtick inside it is the command-substitution bug gh-body-guard exists for.
 */
export function attachArg(rec: ScreenshotRecord): string {
	const label = safeAlt(rec.label || "screenshot");
	return `--attach '${rec.path}#${label}: <what this shows>'`;
}

/**
 * The PR nudge: the attach syntax for every screenshot this session, when gh is
 * new enough. `tooOld` swaps in the fallback guidance.
 */
export function prNudge(records: readonly ScreenshotRecord[], opts: { tooOld: boolean; version: GhVersion | null }): string {
	const paths = records.map((r) => `  ${r.path}${r.label ? ` (${r.label})` : ""}`).join("\n");
	if (opts.tooOld) {
		const found = opts.version ? `${opts.version.major}.${opts.version.minor}.${opts.version.patch}` : "unknown";
		return (
			`This session has ${records.length} screenshot(s), but the gh here (${found}) predates 2.99.0, whose ` +
			`\`--attach\` flag uploads images. Post the PR without images and list the screenshot paths in your final ` +
			`message so a human can attach them:\n${paths}`
		);
	}
	const attaches = records.map((r) => `  ${attachArg(r)}`).join(" \\\n");
	return (
		`This session has ${records.length} screenshot(s) but this \`gh\` command has no \`--attach\`. gh 2.99+ can ` +
		`upload them: add one repeatable \`--attach '<file>#<alt text>'\` per image (single quotes \u2014 the alt text is ` +
		`prose, and a double-quoted backtick is a command-substitution bug). Pass the PR/issue body with ` +
		`\`--body-file\` so its markdown survives the shell:\n${attaches}\n\nScreenshots:\n${paths}`
	);
}
