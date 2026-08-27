/**
 * Two halves. The pure one: what string ends up between `ESC ] 0 ;` and the
 * BEL. The wiring one: which events re-apply it, which guards register nothing,
 * and whether the deferred re-apply actually outlives pi's startup clobber.
 *
 * `fake-pi.ts` mints a ctx whose `ui` has no `setTitle` — real pi's always does
 * (`interactive-mode.js:1861` wires it to `ui.terminal.setTitle`). Rather than
 * change the shared harness, the wiring block registers its OWN handler for
 * each event BEFORE the extension. fake-pi runs handlers serially in
 * registration order because pi does, so that handler installs a recorder onto
 * the very ctx object the extension is about to be handed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import termTitleExtension, {
	buildTerminalTitle,
	projectLabelFor,
	sanitizeTitleText,
} from "../extensions/term-title.ts";

const BEL = String.fromCharCode(0x07);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9b);

describe("projectLabelFor", () => {
	it("names the project and the worktree from a gwq worktree path", () => {
		expect(projectLabelFor("/home/dev/repos/hive-pi__worktrees/feature-hiv-1883")).toBe("hive-pi/feature-hiv-1883");
	});

	it("still names the worktree from a subdirectory of it", () => {
		// The whole point: `basename(cwd)` here is "extensions", which is the name
		// every repo shares and the reason pi's own title does not discriminate.
		expect(projectLabelFor("/home/dev/repos/hive-pi__worktrees/feature-hiv-1883/extensions/hive-common")).toBe(
			"hive-pi/feature-hiv-1883",
		);
	});

	it("reports the project alone when standing on the worktrees root", () => {
		expect(projectLabelFor("/home/dev/repos/Aurora__worktrees")).toBe("Aurora");
		expect(projectLabelFor("/home/dev/repos/Aurora__worktrees/")).toBe("Aurora");
	});

	it("falls back to the basename for an ordinary clone", () => {
		expect(projectLabelFor("/home/dev/repos/matwork")).toBe("matwork");
		expect(projectLabelFor("/home/dev/repos/matwork/apps/api")).toBe("api");
	});

	it("resolves the innermost worktree when one is nested inside another", () => {
		expect(projectLabelFor("/repos/outer__worktrees/a/repos/inner__worktrees/b/src")).toBe("inner/b");
	});

	it("does not treat a bare '__worktrees' segment as a project", () => {
		expect(projectLabelFor("/home/dev/__worktrees/thing")).toBe("thing");
	});

	it("survives degenerate paths", () => {
		expect(projectLabelFor("")).toBe("");
		expect(projectLabelFor("/")).toBe("");
	});

	it("handles a Windows-style separator", () => {
		expect(projectLabelFor("C:\\repos\\hive-pi__worktrees\\feature-x")).toBe("hive-pi/feature-x");
	});
});

describe("sanitizeTitleText", () => {
	it("strips the BEL that would terminate the OSC string early", () => {
		// pi's terminal.setTitle writes `ESC ] 0 ; <title> BEL` with no escaping,
		// so a BEL inside the title ends the sequence and the rest is dumped into
		// the terminal as literal text.
		expect(sanitizeTitleText(`fix${BEL}rm -rf ~`)).toBe("fix rm -rf ~");
	});

	it("strips ESC, DEL and C1 so no new sequence can be opened", () => {
		expect(sanitizeTitleText(`a${ESC}[31mb`)).toBe("a [31mb");
		expect(sanitizeTitleText(`a${DEL}b${C1}c`)).toBe("a b c");
	});

	it("collapses newlines and tabs and trims", () => {
		expect(sanitizeTitleText("  fix\tthe\n\nflaky test  ")).toBe("fix the flaky test");
	});

	it("keeps the non-ASCII characters titles legitimately contain", () => {
		expect(sanitizeTitleText("Prüfen · résumé …")).toBe("Prüfen · résumé …");
	});
});

describe("buildTerminalTitle", () => {
	it("puts the project first and the topic second", () => {
		expect(buildTerminalTitle("hive-pi/feature-hiv-1883", "terminal tab title")).toBe(
			"hive-pi/feature-hiv-1883 · terminal tab title",
		);
	});

	it("is the project alone before a session has a name", () => {
		expect(buildTerminalTitle("hive-pi/feature-hiv-1883", undefined)).toBe("hive-pi/feature-hiv-1883");
		expect(buildTerminalTitle("hive-pi/feature-hiv-1883", "")).toBe("hive-pi/feature-hiv-1883");
	});

	it("is the topic alone when the path yields no label", () => {
		expect(buildTerminalTitle("", "some topic")).toBe("some topic");
	});

	it("truncates the topic and never the project label", () => {
		const label = "hive-pi/feature-hiv-1883";
		const title = buildTerminalTitle(label, "implement the terminal tab title extension end to end", 48);

		expect(title.startsWith(`${label} · `)).toBe(true);
		expect(title.length).toBeLessThanOrEqual(48);
		expect(title.endsWith("…")).toBe(true);
	});

	it("breaks a truncated topic on a word boundary when that keeps most of the budget", () => {
		expect(buildTerminalTitle("proj", "alpha beta gamma delta epsilon", 24)).toBe("proj · alpha beta gamma…");
	});

	it("does not collapse to a stub when the first token is long", () => {
		// A word-boundary-only rule (auto-title's `boundary > 0`) would cut this to
		// "a…" because the only space is at index 1.
		expect(buildTerminalTitle("proj", "a supercalifragilistic-token", 20)).toBe("proj · a supercalif…");
	});

	it("drops the topic entirely when too little room is left for it to mean anything", () => {
		const label = "hive-pi/feature-hiv-1883";
		expect(buildTerminalTitle(label, "terminal tab title", label.length + 6)).toBe(label);
	});

	it("truncates the label itself only as a last resort", () => {
		const title = buildTerminalTitle("hive-pi/a-very-long-worktree-name-indeed", undefined, 20);
		expect(title.length).toBeLessThanOrEqual(20);
		expect(title.endsWith("…")).toBe(true);
	});

	it("respects the default cap", () => {
		const title = buildTerminalTitle("hive-pi/feature-hiv-1883", "x".repeat(200));
		expect(title.length).toBeLessThanOrEqual(64);
	});

	it("never emits a control character, whatever the inputs", () => {
		const title = buildTerminalTitle(`proj${BEL}ect`, `topic${ESC}]0;pwned${BEL}`);
		expect(/[\p{Cc}]/u.test(title)).toBe(false);
	});
});

/**
 * The wiring, with $HOME pointed at a scratch directory (filerank's idiom) so
 * the machine's real `term-title.config.json` cannot decide the outcome.
 */
describe("extension wiring", () => {
	const WORKTREE = "/home/dev/repos/hive-pi__worktrees/feature-hiv-1883";

	let home: string;
	let realHome: string | undefined;
	let realIsTTY = false;
	let realWorker: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "term-title-home-"));
		realHome = process.env.HOME;
		process.env.HOME = home;
		realWorker = process.env.PI_AGENDA_WORKER;
		delete process.env.PI_AGENDA_WORKER;
		// vitest's stdout is a pipe, so without this the extension correctly
		// registers nothing and every wiring assertion below would pass vacuously.
		realIsTTY = process.stdout.isTTY;
		process.stdout.isTTY = true;
	});

	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		if (realWorker === undefined) delete process.env.PI_AGENDA_WORKER;
		else process.env.PI_AGENDA_WORKER = realWorker;
		process.stdout.isTTY = realIsTTY;
		rmSync(home, { recursive: true, force: true });
	});

	function writeConfig(config: Record<string, unknown>): void {
		// configPathFor("term-title") → ~/.pi/agent/hive-telemetry/term-title.config.json
		const dir = join(home, ".pi", "agent", "hive-telemetry");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "term-title.config.json"), JSON.stringify(config));
	}

	/**
	 * Install a `ui.setTitle` recorder — and optionally a session name — onto
	 * whatever ctx the next emit mints. Must be called BEFORE the extension is
	 * registered; that ordering is the whole mechanism.
	 *
	 * Leaving `sessionName` out is not a gap: fake-pi's session manager has no
	 * `getSessionName`, so the extension's call throws, which is exactly the
	 * ephemeral-startup path its try/catch exists for.
	 */
	function recordTitlesOf(pi: FakePi, sessionName?: string): string[] {
		const titles: string[] = [];
		const install = (ctx: { ui: { setTitle: (t: string) => void }; sessionManager: { getSessionName?: () => string | undefined } }) => {
			ctx.ui.setTitle = (title: string) => {
				titles.push(title);
			};
			if (sessionName !== undefined) ctx.sessionManager.getSessionName = () => sessionName;
		};
		pi.api.on("session_start", (_event, ctx) => install(ctx));
		pi.api.on("session_info_changed", (_event, ctx) => install(ctx));
		pi.api.on("input", (_event, ctx) => install(ctx));
		return titles;
	}

	/** One macrotask, which is where the deferred startup re-apply lives. */
	const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

	it("registers exactly the events it re-applies on", () => {
		const pi = createFakePi();
		termTitleExtension(pi.api);
		expect([...pi.handlers.keys()].sort()).toEqual(["input", "session_info_changed", "session_start"]);
	});

	it("registers NOTHING when disabled — not a no-op handler", () => {
		writeConfig({ enabled: false });

		const pi = createFakePi();
		termTitleExtension(pi.api);
		expect(pi.handlers.size).toBe(0);
	});

	// The spec's named hazard: escape bytes into a stdout that is not a terminal.
	it("registers NOTHING when stdout is not a terminal", () => {
		process.stdout.isTTY = false;

		const pi = createFakePi();
		termTitleExtension(pi.api);
		expect(pi.handlers.size).toBe(0);
	});

	// A worker shares its parent's pane; a title it wrote would rename the tab
	// the human is watching.
	it("registers NOTHING in an agenda worker", () => {
		process.env.PI_AGENDA_WORKER = "1";

		const pi = createFakePi();
		termTitleExtension(pi.api);
		expect(pi.handlers.size).toBe(0);
	});

	it("writes project, worktree and topic when the session gets a name", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi);
		termTitleExtension(pi.api);

		await pi.emit({ type: "session_info_changed", name: "fix the flaky drift test" }, { cwd: WORKTREE });

		expect(titles).toEqual(["hive-pi/feature-hiv-1883 · fix the flaky drift test"]);
	});

	it("writes the project alone while the session manager cannot supply a name", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi);
		termTitleExtension(pi.api);

		await pi.emit({ type: "input", text: "hello", source: "interactive" }, { cwd: WORKTREE });

		expect(titles).toEqual(["hive-pi/feature-hiv-1883"]);
	});

	it("reads a hand-set name off the session manager on input", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi, "renamed by hand");
		termTitleExtension(pi.api);

		await pi.emit({ type: "input", text: "hello", source: "interactive" }, { cwd: WORKTREE });

		expect(titles).toEqual(["hive-pi/feature-hiv-1883 · renamed by hand"]);
	});

	// End to end, because pi's setTitle interpolates straight into the OSC
	// payload: a BEL in a prompt would otherwise terminate the sequence and dump
	// the rest into the terminal as literal input.
	it("neutralises a BEL that reached the session name", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi);
		termTitleExtension(pi.api);

		await pi.emit({ type: "session_info_changed", name: `oops${BEL}echo pwned` }, { cwd: WORKTREE });

		expect(titles).toEqual(["hive-pi/feature-hiv-1883 · oops echo pwned"]);
		expect(/[\p{Cc}]/u.test(titles[0])).toBe(false);
	});

	// THE ONE THAT MAKES THE EXTENSION VISIBLE. pi's own updateTerminalTitle()
	// runs a few microtasks after session_start returns and overwrites the
	// synchronous write; without the deferred re-apply a pane nobody has typed
	// into keeps pi's title for as long as it stays idle.
	it("re-applies on a later macrotask, after pi's startup clobber", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi, "resumed session");
		termTitleExtension(pi.api);

		await pi.emit({ type: "session_start", reason: "resume" }, { cwd: WORKTREE });
		expect(titles).toEqual(["hive-pi/feature-hiv-1883 · resumed session"]);

		await nextMacrotask();
		expect(titles).toEqual([
			"hive-pi/feature-hiv-1883 · resumed session",
			"hive-pi/feature-hiv-1883 · resumed session",
		]);
	});

	it("drops the deferred re-apply when the session was replaced under it", async () => {
		const pi = createFakePi();
		const titles = recordTitlesOf(pi, "doomed session");
		termTitleExtension(pi.api);

		await pi.emit({ type: "session_start", reason: "startup" }, { cwd: WORKTREE });
		pi.staleCurrentCtx();

		await nextMacrotask();
		expect(titles).toEqual(["hive-pi/feature-hiv-1883 · doomed session"]);
	});
});
