/**
 * term-title — make the terminal tab say which worktree this pane is.
 *
 * WHY THIS EXISTS, given pi already writes a title. It does:
 * `interactive-mode.js` sets `Pi - <session name> - <basename(cwd)>` (and
 * `Pi - <basename(cwd)>` before a name exists). Three things are wrong with
 * that string for the way this machine is used — a dozen tmux panes, most of
 * them in sibling gwq worktrees of two or three repos:
 *
 *  1. `basename(cwd)` is not the project. In the bare-repo + `__worktrees`
 *     layout a pane's cwd is `…/hive-pi__worktrees/feature-hiv-1883`, so the
 *     title says `feature-hiv-1883` and never names the repo; worse, a pane
 *     sitting in a subdirectory says `web`, `extensions`, `test` — the same
 *     handful of names in every repo, which is the exact collision the tab
 *     title is supposed to resolve.
 *  2. `Pi - ` is five wasted leading characters, and tmux truncates tab labels
 *     from the RIGHT. Every tab agreeing on its first five characters is the
 *     one thing a tab label must not do.
 *  3. The topic is last, so it is what truncation eats first.
 *
 * So: `<project>/<worktree> · <topic>`, project first, topic truncated.
 *
 * NOT a second title derivation. The topic is the SESSION NAME, which is
 * `auto-title.ts`'s `deriveTitle` output — read through `getSessionName()`
 * rather than re-derived from the prompt. That buys two things beyond not
 * duplicating the parser: a name the user set by hand shows up too, and this
 * extension has no ordering dependence on auto-title's `input` handler running
 * before its own (registration order is alphabetical today, which is not a
 * contract).
 *
 * THE ONE MECHANICAL CONSTRAINT: pi awaits handlers serially, so a slow handler
 * IS the agent loop. Everything below is synchronous string work over an
 * already-resident cwd — no fs, no git, no subprocess. The single timer is a
 * zero-delay re-apply at session start (see the handler), which does that same
 * string work one macrotask later. The project
 * label is parsed from the path rather than resolved with `git remote` (which
 * `hive-common/identity.ts` does, and correctly forbids from handlers) and
 * memoised on the cwd, so the steady-state cost of a handler is a compare plus
 * one ~30-byte write.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { configPathFor, readJSON } from "./hive-common/identity.ts";

/**
 * Terminals truncate anyway, and tmux's window list gives a tab far less than
 * this. The cap exists so the *topic* is what shrinks, at a width where the
 * project label is still fully visible in a normal `window-status` cell.
 */
const MAX_TITLE_LENGTH = 64;

/** Light on the eye, one column wide, and not a character shells like to quote. */
const SEPARATOR = " · ";

/**
 * Below this the topic is noise — `hive-pi/feature-hiv-1883 · te…` tells you
 * nothing the label did not — so it is dropped rather than truncated to a stub.
 */
const MIN_TOPIC_LENGTH = 8;

/** The `gwq` convention this machine standardised on, same as identity.ts. */
const WORKTREES_SUFFIX = "__worktrees";

interface TermTitleConfig {
	enabled: boolean;
}

/**
 * Defaults ON. This writes one OSC sequence to a terminal the user is already
 * looking at; it sends nothing off the machine and stores nothing, so the cost
 * of being wrong is a tab label somebody has to ignore.
 */
function loadConfig(): TermTitleConfig {
	const raw = readJSON<Partial<TermTitleConfig>>(configPathFor("term-title")) ?? {};
	return { enabled: raw.enabled !== false };
}

/**
 * projectLabelFor names the pane from its path alone — `hive-pi/feature-hiv-1883`.
 *
 * Walks UP looking for the `<project>__worktrees` marker and takes the segment
 * BELOW it as the worktree, so a pane parked in `…/feature-hiv-1883/extensions`
 * still reports the worktree rather than `extensions`. Searching from the
 * deepest segment first means a nested checkout resolves to the inner one,
 * which is the one the pane is actually working in.
 *
 * An ordinary clone has no marker and falls back to its basename, which for
 * `~/repos/matwork` is already the right answer.
 *
 * Pure string work on purpose: `resolveProject()` in hive-common answers the
 * same question far more accurately by shelling out to git, and is documented
 * as unsafe to call from a handler for exactly that reason.
 */
export function projectLabelFor(cwd: string): string {
	const segments = cwd.split(/[/\\]+/).filter(Boolean);
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i];
		if (segment.length <= WORKTREES_SUFFIX.length || !segment.endsWith(WORKTREES_SUFFIX)) continue;
		const project = segment.slice(0, -WORKTREES_SUFFIX.length);
		// Standing ON the worktrees root is a real state (it is where you pick a
		// worktree from), and there is no worktree to name yet.
		const worktree = i + 1 < segments.length ? segments[i + 1] : "";
		return worktree ? `${project}/${worktree}` : project;
	}
	return segments.length > 0 ? segments[segments.length - 1] : "";
}

/**
 * sanitizeTitleText makes a string safe to put inside an OSC payload.
 *
 * This is load-bearing, not hygiene theatre. pi's `terminal.setTitle` writes
 * `\x1b]0;${title}\x07` with NO escaping, and the session name it interpolates
 * comes from a user prompt by way of `deriveTitle` — whose only cleanup is a
 * `\s+` collapse, which does not touch `\x07` or `\x1b`. A prompt whose first
 * line contains a BEL therefore ENDS the OSC string early and the remainder is
 * written to the terminal as literal input; an ESC opens a fresh sequence.
 * Stripping C0 (BEL and ESC live there), DEL and C1 removes both.
 *
 * Written as a code-point scan rather than a character-class regex so this file
 * contains no control bytes of its own — a literal `\x07` inside a source
 * character class is invisible in review and turns the file binary to `grep`.
 */
export function sanitizeTitleText(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim();
}

/**
 * buildTerminalTitle composes the label and the topic within `maxLength`.
 *
 * The label never loses characters to the topic: it is the discriminator
 * between panes, and a title that truncates it has given up the only job it
 * had.
 */
export function buildTerminalTitle(
	project: string,
	topic: string | undefined,
	maxLength: number = MAX_TITLE_LENGTH,
): string {
	const label = sanitizeTitleText(project);
	const subject = sanitizeTitleText(topic ?? "");
	if (!subject) return truncate(label, maxLength);
	if (!label) return truncate(subject, maxLength);

	const room = maxLength - label.length - SEPARATOR.length;
	if (room < MIN_TOPIC_LENGTH) return truncate(label, maxLength);
	return `${label}${SEPARATOR}${truncate(subject, room)}`;
}

function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	if (limit <= 1) return value.slice(0, Math.max(0, limit));
	const head = value.slice(0, limit - 1); // reserve one character for the ellipsis
	// The head already ends on a word boundary when the character it stopped
	// before is a space. Falling through to the search below would cut back to
	// the PREVIOUS space and drop a word that fit exactly.
	if (value[limit - 1] === " ") return `${head.trimEnd()}…`;
	const boundary = head.lastIndexOf(" ");
	// Break on a word only when it keeps most of the budget. auto-title's
	// `boundary > 0` test would collapse a long first token to almost nothing,
	// which matters more here because the topic's budget is already whatever the
	// label left over.
	const kept = boundary > limit / 2 ? head.slice(0, boundary) : head;
	return `${kept.trimEnd()}…`;
}

export default function (pi: ExtensionAPI) {
	if (!loadConfig().enabled) return;

	// A worker has no terminal of its own and shares the parent's — agenda,
	// brief and subagent all spawn one with PI_AGENDA_WORKER=1 — so a title it
	// wrote would rename the pane its parent is displaying in.
	if (process.env.PI_AGENDA_WORKER === "1") return;

	// The guard the spec cares about most. `ui.setTitle` is already a no-op
	// without a UI (`runner.js` noOpUIContext) and in RPC mode it is a structured
	// `extension_ui_request` rather than escape bytes, so neither of those
	// actually corrupts a piped stream today — but "stdout is a terminal" is the
	// condition that is true exactly when an OSC write is meaningful, and
	// checking the thing we mean beats depending on two other implementations
	// staying harmless. Registering NO handler when it fails (narrate's
	// precedent) keeps a headless run free of even the property reads.
	if (!process.stdout.isTTY) return;

	let cachedCwd = "";
	let cachedLabel = "";
	const labelFor = (cwd: string): string => {
		if (cwd !== cachedCwd) {
			cachedCwd = cwd;
			cachedLabel = projectLabelFor(cwd);
		}
		return cachedLabel;
	};

	const apply = (topic: string | undefined, ctx: ExtensionContext): void => {
		ctx.ui.setTitle(buildTerminalTitle(labelFor(ctx.cwd), topic));
	};

	// The synchronous write here LOSES, always: `rebindCurrentSession()` calls
	// pi's own `updateTerminalTitle()` immediately after awaiting extension
	// binding (`interactive-mode.js:1496`), so it is overwritten before the
	// screen is drawn. Leaving it at that made the extension inert on exactly
	// the pane you are most likely to be squinting at — one that has started or
	// resumed and that nobody has typed into yet.
	//
	// So: re-apply from a zero-delay timer. Everything between our handler
	// returning and the clobber is microtasks — `bindExtensions` awaits this
	// emit (`agent-session.js:1761`), then `resources_discover` (no handler in
	// this package, so it returns before awaiting anything), then
	// `updateAvailableProviderCount()`, which is a SYNCHRONOUS function
	// (`interactive-mode.js:3869`) — so a macrotask lands after the clobber.
	//
	// Never worse than not having it: if some future handler on this path does
	// cross a macrotask boundary, the timer simply fires early, pi wins as it
	// does today, and `input` repairs it. `unref()` so a pending timer can
	// never hold the process open, and the body is guarded because a ctx whose
	// session was replaced under it throws on EVERY property access.
	pi.on("session_start", (_event, ctx) => {
		apply(readSessionName(ctx), ctx);
		setTimeout(() => {
			try {
				apply(readSessionName(ctx), ctx);
			} catch {
				// The session was replaced before the timer ran. Whatever replaced
				// it owns the pane title now.
			}
		}, 0).unref();
	});

	// The one event ordered in our favour: `agent-session.js` `setSessionName`
	// emits to the UI synchronously and to the extension runner afterwards, so pi
	// writes `Pi - …` and we replace it. This is the event that fires when
	// auto-title names a fresh session — the moment the tab first becomes worth
	// reading.
	pi.on("session_info_changed", (event, ctx) => {
		apply(event.name, ctx);
	});

	// The repair pass. pi clobbers the title from three other places — the
	// startup rebind above, `resetExtensionUI()` on an extension reload, and a
	// win32-only restore after the package-update check — none of which we can
	// order against. All three are followed by the user typing something, and a
	// re-apply on input costs one string compare and a short write. A timer would
	// be the alternative and a worse one: it would have to race
	// `updateAvailableProviderCount()` to land after the startup clobber.
	pi.on("input", (_event, ctx) => {
		apply(readSessionName(ctx), ctx);
	});
}

/** The session manager is absent on some ephemeral startup paths (see auto-title). */
function readSessionName(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionName();
	} catch {
		return undefined;
	}
}
