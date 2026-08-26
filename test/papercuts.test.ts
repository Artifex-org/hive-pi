import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFakePi } from "./fake-pi.ts";
import { gitAvailable } from "./require-tools.ts";
import papercutsExtension, { type PapercutDetails } from "../extensions/papercuts/index.ts";
import {
	capEntries,
	formatEntry,
	normalizeSeverity,
	parseEntries,
	renderEntry,
	toEntry,
	type Entry,
	type PapercutInput,
} from "../extensions/papercuts/papercuts.ts";

/**
 * The log is only worth writing if it can be read back. Everything here is the
 * round trip or a way of breaking it — a format that loses the friction text, or
 * a parser that throws on a hand-edited file, turns a friction log into a file
 * nobody trusts, which is the same as no log at all.
 */

const META = { at: "2026-08-15T09:12:04.113Z", cwd: "/home/dev/repos/hive-pi" };

/** The property the whole format exists to hold: what was stored comes back. */
function roundTrip(input: PapercutInput, meta = META): { stored: Entry; recovered: Entry[] } {
	return { stored: toEntry(input, meta), recovered: parseEntries(formatEntry(input, meta)) };
}

describe("round trip", () => {
	it("recovers every field of a full entry", () => {
		const { stored, recovered } = roundTrip({
			friction: "`hive check` refused with 'pass --step … or --full'",
			context: "running the gate on my uncommitted tree",
			severity: "moderate",
		});
		expect(recovered).toEqual([stored]);
	});

	it("recovers an entry with no context", () => {
		const { stored, recovered } = roundTrip({ friction: "the README's config path is wrong" });
		expect(recovered).toEqual([stored]);
		expect(recovered[0].context).toBeUndefined();
	});

	// A pasted stack trace or a multi-line command is often the most useful thing
	// in an entry, so the body must survive its own newlines.
	it("keeps a multi-line body, blank interior lines included", () => {
		const friction = "Traceback:\n\n  File 'x.py', line 3\n    boom\nValueError";
		const { stored, recovered } = roundTrip({ friction, severity: "blocking" });
		expect(recovered).toEqual([stored]);
		expect(recovered[0].friction).toBe(friction);
	});

	// This is what the blockquote body earns. Friction ABOUT markdown is
	// completely ordinary — "the `## Config` section is wrong" — and an unquoted
	// body would let that line open a second entry, splitting one record in two.
	it("survives a body containing something that looks like an entry heading", () => {
		const friction = "## 2026-01-01T00:00:00.000Z · blocking\nis what the doc told me to paste";
		const { stored, recovered } = roundTrip({ friction });
		expect(recovered).toHaveLength(1);
		expect(recovered).toEqual([stored]);
	});

	it("keeps entries separate and in order", () => {
		const log =
			formatEntry({ friction: "first" }, META) +
			formatEntry({ friction: "second", severity: "blocking" }, { ...META, at: "2026-08-15T10:00:00.000Z" });
		expect(parseEntries(log).map((entry) => entry.friction)).toEqual(["first", "second"]);
		expect(parseEntries(log).map((entry) => entry.severity)).toEqual(["minor", "blocking"]);
	});

	// The round trip is defined against what was STORED, not against the raw
	// input — so the normalization has to be visible and pinned, not implicit.
	it("normalizes on the way in, once", () => {
		const stored = toEntry(
			{ friction: "  spaced out  \n", context: "two\nlines  of  context" },
			{ at: META.at, cwd: `${META.cwd}  ` },
		);
		expect(stored.friction).toBe("spaced out");
		expect(stored.context).toBe("two lines of context");
		expect(stored.cwd).toBe(META.cwd);
		expect(parseEntries(renderEntry(stored))).toEqual([stored]);
	});

	// The heading is WHITESPACE-DELIMITED, so a timestamp containing a space
	// renders a heading the parser cannot match and the entry disappears on the
	// way back out — silently, which is the worst way for a log to lose a record.
	// The harness always supplies an ISO string, but the round trip is a property
	// of `toEntry`, not of its luckiest caller.
	it("survives a timestamp that is not whitespace-free", () => {
		const { stored, recovered } = roundTrip({ friction: "x" }, { at: "2026-08-15 09:12", cwd: META.cwd });
		expect(stored.at).not.toContain(" ");
		expect(recovered).toEqual([stored]);
	});
});

describe("severity", () => {
	// The default has to be the LOW one: a tool whose omitted field means
	// "blocking" teaches the model to deliberate before every call, and that
	// deliberation is the tax that stops the call being made.
	it("defaults to minor", () => {
		expect(normalizeSeverity(undefined)).toBe("minor");
		expect(toEntry({ friction: "x" }, META).severity).toBe("minor");
		expect(parseEntries(formatEntry({ friction: "x" }, META))[0].severity).toBe("minor");
	});

	it("rejects anything that is not one of the three", () => {
		expect(normalizeSeverity("catastrophic")).toBe("minor");
		expect(normalizeSeverity(3)).toBe("minor");
		expect(normalizeSeverity(null)).toBe("minor");
		expect(normalizeSeverity("blocking")).toBe("blocking");
	});
});

describe("capping", () => {
	const log = (count: number, from = 0) =>
		Array.from({ length: count }, (_, i) =>
			formatEntry(
				{ friction: `entry ${from + i}` },
				{ ...META, at: new Date(Date.UTC(2026, 0, 1, 0, 0, from + i)).toISOString() },
			),
		).join("");

	it("keeps the most recent entries and drops the oldest", () => {
		const capped = capEntries(log(10), 3);
		expect(parseEntries(capped).map((entry) => entry.friction)).toEqual(["entry 7", "entry 8", "entry 9"]);
	});

	it("leaves a file under the cap byte-for-byte alone", () => {
		const under = log(3);
		expect(capEntries(under, 500)).toBe(under);
	});

	// The preamble is where the file says what wrote it. Losing that on the 501st
	// entry would be a surprise to whoever opens the file next.
	it("preserves the header above the first entry", () => {
		const capped = capEntries(`# papercuts\n\nwritten by the papercut tool\n\n${log(5)}`, 2);
		expect(capped.startsWith("# papercuts\n\nwritten by the papercut tool\n\n")).toBe(true);
		expect(parseEntries(capped).map((entry) => entry.friction)).toEqual(["entry 3", "entry 4"]);
	});

	// Capping works on text rather than on parsed entries precisely so that
	// content it does not understand rides through untouched.
	it("carries hand-written content inside a kept block through unchanged", () => {
		const withNote = `${log(2)}## 2026-03-01T00:00:00.000Z · blocking\n- cwd: /tmp\n> real\n\n<!-- a human wrote this -->\n\n`;
		expect(capEntries(withNote, 1)).toContain("<!-- a human wrote this -->");
	});

	it("empties the log when asked for nothing", () => {
		expect(capEntries(log(4), 0)).toBe("");
	});

	// A cap that is not a whole number is not a count of entries. Truncating it
	// keeps `starts[…]` an integer index; the alternative was a fractional index
	// yielding `undefined`, i.e. no cap at all.
	it("treats a fractional cap as the whole number below it", () => {
		expect(parseEntries(capEntries(log(10), 2.9)).map((entry) => entry.friction)).toEqual([
			"entry 8",
			"entry 9",
		]);
	});

	// NaN loses every comparison, so the unguarded version fell through to
	// `starts[NaN]` → `lines.slice(undefined)` → the WHOLE file re-emitted under a
	// second copy of its own preamble. An uncomputable cap must leave the log
	// alone, not corrupt it and not empty it.
	it("leaves the file alone when the cap is not a number at all", () => {
		const withHeader = `# papercuts\n\n${log(4)}`;
		expect(capEntries(withHeader, Number.NaN)).toBe(withHeader);
		expect(capEntries(withHeader, Number.POSITIVE_INFINITY)).toBe(withHeader);
	});
});

describe("malformed content", () => {
	// This file is grepped, opened and edited by hand, so broken content is the
	// steady state, not an error case. A parser that threw would take the log
	// down with the first stray line.
	const junk = [
		"",
		"not markdown at all",
		"## not-an-entry-heading",
		"## 2026-08-15T09:00:00.000Z · catastrophic",
		"- cwd:",
		"> orphaned body with no heading",
		"<<<<<<< HEAD",
		"## 2026-08-15T09:00:00.000Z ·",
		"#",
		"- context: dangling",
	];

	for (const content of junk) {
		it(`does not throw on ${JSON.stringify(content)}`, () => {
			expect(() => parseEntries(content)).not.toThrow();
		});
	}

	it("does not throw on a truncated entry, and still recovers what is there", () => {
		const halfWritten = "## 2026-08-15T09:12:04.113Z · blocking\n- cwd: /tmp\n> the process died mid";
		const entries = parseEntries(halfWritten);
		expect(entries).toHaveLength(1);
		expect(entries[0].friction).toBe("the process died mid");
	});

	it("recovers a heading whose body never arrived", () => {
		const entries = parseEntries("## 2026-08-15T09:12:04.113Z · minor\n");
		// Kept rather than dropped: something really was logged at that moment,
		// and a parser that hides it hides the fact that the write failed.
		expect(entries).toEqual([{ at: "2026-08-15T09:12:04.113Z", severity: "minor", cwd: "", friction: "" }]);
	});

	it("skips junk between two good entries and keeps both", () => {
		const log = `${formatEntry({ friction: "before" }, META)}garbage line\n\n${formatEntry(
			{ friction: "after" },
			{ ...META, at: "2026-08-15T11:00:00.000Z" },
		)}`;
		expect(parseEntries(log).map((entry) => entry.friction)).toEqual(["before", "after"]);
	});

	it("returns nothing for an empty file rather than a placeholder entry", () => {
		expect(parseEntries("")).toEqual([]);
		expect(parseEntries("\n\n\n")).toEqual([]);
	});
});

/**
 * The pure fold above is only half of it. The three bugs `test/fake-pi.ts` was
 * written for all lived in the wiring — a handler registered behind an
 * `if (!enabled) return`, a file deleted on failure — and none of them were
 * reachable from a pure test. So the tool is actually RUN here: registered,
 * called, and the file read back off disk.
 *
 * HOME is redirected to a temp directory before the factory runs, which is what
 * `test/tool-capability.test.ts` does and for the same reason: `loadConfig`
 * resolves both the config and the default log path under `homedir()`, and a
 * suite that wrote to the developer's real `~/.pi/agent/papercuts.md` would be
 * appending junk to a log they are supposed to trust.
 */

const realHome = process.env.HOME;
afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
});

function boot(config?: Partial<{ enabled: boolean; path: string; maxEntries: number }>) {
	const home = mkdtempSync(join(tmpdir(), "papercuts-"));
	const stateDir = join(home, ".pi", "agent", "hive-telemetry");
	mkdirSync(stateDir, { recursive: true });
	const logPath = join(home, "log", "papercuts.md");
	if (config) {
		writeFileSync(join(stateDir, "papercuts.config.json"), JSON.stringify({ path: logPath, ...config }));
	}
	process.env.HOME = home;

	const pi = createFakePi();
	papercutsExtension(pi.api);

	const ctx = { cwd: "/home/dev/repos/hive-pi", ui: { notify: () => {} } } as unknown as ExtensionContext;
	const call = async (params: Record<string, unknown>) => {
		const tool = pi.tools.find((candidate) => candidate.name === "papercut");
		if (!tool) throw new Error("papercut tool was not registered");
		const execute = tool.definition.execute as (
			id: string,
			params: unknown,
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ text?: string }>; details?: unknown; isError?: boolean }>;
		return execute("call-1", params, undefined, undefined, ctx);
	};
	const read = () => {
		try {
			return readFileSync(logPath, "utf8");
		} catch {
			return "";
		}
	};
	return { pi, call, read, logPath, home };
}

describe("the tool, actually run", () => {
	it("appends an entry that parses back to what it reported", async () => {
		const { call, read } = boot({});
		const result = await call({ friction: "`npm run check` is whole-project", severity: "moderate" });
		const details = result.details as PapercutDetails;

		expect(details.v).toBe(1);
		expect(details.type).toBe("papercut");
		expect(details.entry.friction).toBe("`npm run check` is whole-project");
		expect(details.entry.cwd).toBe("/home/dev/repos/hive-pi");
		// The transcript copy and the file copy must be the same record — the
		// container case relies on the first standing in for the second.
		expect(parseEntries(read())).toEqual([details.entry]);
	});

	it("appends rather than replacing, and keeps the file's header", async () => {
		const { call, read } = boot({});
		await call({ friction: "first" });
		await call({ friction: "second" });
		expect(read().startsWith("# papercuts\n")).toBe(true);
		expect(parseEntries(read()).map((entry) => entry.friction)).toEqual(["first", "second"]);
	});

	it("caps the file on disk", async () => {
		const { call, read } = boot({ maxEntries: 10 });
		for (let i = 0; i < 14; i++) await call({ friction: `entry ${i}` });
		const entries = parseEntries(read());
		expect(entries).toHaveLength(10);
		expect(entries[0].friction).toBe("entry 4");
		expect(entries[9].friction).toBe("entry 13");
	});

	// A logging aside must never become the agent's problem. An unwritable log
	// still returns a successful result, because `details` already carried the
	// entry into the transcript.
	it("does not fail the call when the log cannot be written", async () => {
		const { call } = boot({ path: "/proc/version/nope/papercuts.md" });
		const result = await call({ friction: "the disk is not having it" });
		const details = result.details as PapercutDetails;
		expect(details.entry.friction).toBe("the disk is not having it");
		expect(result.content[0].text).toContain("could not be written");
		// Recorded, not swallowed. A consumer reading these out of a transcript
		// has to be able to tell which entries are ALSO on disk somewhere — and
		// the transcript line must not claim a write that did not happen.
		expect(details.writeError).toBeTruthy();
	});

	it("says nothing about a write error when the write worked", async () => {
		const { call } = boot({});
		const result = await call({ friction: "fine" });
		expect((result.details as PapercutDetails).writeError).toBeUndefined();
		expect((result.details as PapercutDetails).capError).toBeUndefined();
	});

	// The two failures say OPPOSITE things about where the entry is, so a failed
	// trim must never be reported as a failed write. It was, in the first
	// version: the entry landed on disk and every surface — the tool text, the
	// transcript line, and any consumer partitioning transcript-only entries from
	// on-disk ones — denied the write that had just succeeded.
	//
	// A directory where the trim's tmp file goes is a real, deterministic EISDIR:
	// the append still lands, only the rewrite fails.
	it("reports a failed trim as a trim, not as a lost entry", async () => {
		const { call, read, logPath } = boot({ maxEntries: 10 });
		mkdirSync(`${logPath}.tmp`, { recursive: true });

		let result = await call({ friction: "under the cap" });
		expect((result.details as PapercutDetails).capError).toBeUndefined();

		// The 11th entry is the first that has to be trimmed away.
		for (let i = 1; i < 11; i++) result = await call({ friction: `entry ${i}` });
		const details = result.details as PapercutDetails;

		expect(details.capError).toBeTruthy();
		expect(details.writeError, "the entry reached the disk — nothing may claim otherwise").toBeUndefined();
		expect(result.content[0].text).toContain("on disk");
		expect(result.content[0].text).not.toContain("could not be written");
		// Over its cap rather than wrong: the append is never rolled back.
		expect(parseEntries(read())).toHaveLength(11);
	});

	// Registering a no-op is worse than registering nothing: a tool the model can
	// SEE is one it spends tokens deciding about on every request.
	it("registers nothing at all when disabled", () => {
		const { pi } = boot({ enabled: false });
		expect(pi.tools).toEqual([]);
		expect(pi.commands.size).toBe(0);
		expect(pi.handlers.size).toBe(0);
	});

	// The whole extension is off the handler path — that is what lets the
	// read-cap-rewrite be synchronous without touching the agent loop.
	it("subscribes to no lifecycle events even when enabled", () => {
		const { pi } = boot({});
		expect(pi.handlers.size).toBe(0);
		expect(pi.commands.has("papercuts")).toBe(true);
	});

	it("declares what it writes, so the capability gate can see it", () => {
		const { pi, logPath } = boot({});
		const capability = pi.tools[0].definition.capability as {
			writesResolved?: (params: Record<string, unknown>, cwd: string | undefined) => string[];
		};
		expect(capability.writesResolved?.({}, undefined)).toEqual([logPath]);
	});
});

/**
 * The transcript line is the only place a human sees what happened, and it is
 * the surface that was wrong: it claimed "logged to <path>" on a failed write,
 * and later denied a write that had succeeded. Four states, four lines, asserted
 * against the real `pi-tui` render rather than against the string that goes in.
 */
describe("what the transcript line says", () => {
	const THEME = { fg: (_color: string, text: string) => text };

	function line(details: unknown): string {
		const { pi } = boot({});
		const render = pi.tools[0].definition.renderResult as (
			result: { details: unknown },
			options: undefined,
			theme: typeof THEME,
		) => { render(width: number): string[] };
		return render({ details }, undefined, THEME).render(200).join(" ");
	}

	const entry = { at: META.at, severity: "moderate" as const, cwd: META.cwd, friction: "x" };

	it("says refused when the guard blocked the call before it ran", () => {
		// What the guard wrapper returns: `details: {}`, so there is no entry.
		expect(line({})).toContain("refused");
	});

	it("says the entry is transcript-only when the append failed", () => {
		const rendered = line({ v: 1, type: "papercut", entry, writeError: "EACCES" });
		expect(rendered).toContain("log write failed");
		expect(rendered).toContain("transcript");
	});

	it("still says logged when only the trim failed", () => {
		const rendered = line({ v: 1, type: "papercut", entry, capError: "EISDIR" });
		expect(rendered).toContain("logged to");
		expect(rendered).toContain("cap not applied");
		expect(rendered, "the entry IS on disk").not.toContain("write failed");
	});

	it("says logged, and nothing else, on the happy path", () => {
		const rendered = line({ v: 1, type: "papercut", entry });
		expect(rendered).toContain("logged to");
		expect(rendered).not.toContain("failed");
	});
});

/**
 * The reason this tool declares `writesResolved` at all.
 *
 * `path` is user-configurable, so the log can be pointed at a protected
 * worktree — and `registerGuardedTool`'s wrapper is what refuses. Without this
 * the declaration is a claim about a mechanism nothing exercises: the capability
 * test only checks that a declaration EXISTS.
 */
describe.runIf(gitAvailable())("a log path inside a protected worktree", () => {
	it("is refused, and nothing is written", async () => {
		const guarded = mkdtempSync(join(tmpdir(), "papercuts-guarded-"));
		execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
			cwd: guarded,
			stdio: "ignore",
		});
		writeFileSync(join(guarded, ".worktree-guard"), "");
		const logPath = join(guarded, "papercuts.md");

		const { call } = boot({ path: logPath });
		const result = await call({ friction: "this must not land in a protected checkout" });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({});
		expect(existsSync(logPath), "a refused call must not have created the file").toBe(false);
	});
});

describe("/papercuts", () => {
	it("shows the most recent entries, newest last", async () => {
		const { pi, call } = boot({});
		for (let i = 0; i < 12; i++) await call({ friction: `entry ${i}`, severity: "blocking" });
		await pi.runCommand("papercuts");
		const shown = pi.notifications[0].message;
		// Default is 10, so the two oldest are off the bottom of the view but
		// still in the file — the command is a peek, not the record.
		expect(shown).toContain("10 of 12 papercuts");
		expect(shown).not.toContain("entry 1\n");
		expect(shown).toContain("entry 11");
	});

	it("takes a count", async () => {
		const { pi, call } = boot({});
		for (let i = 0; i < 5; i++) await call({ friction: `entry ${i}` });
		await pi.runCommand("papercuts", "2");
		expect(pi.notifications[0].message).toContain("2 of 5 papercuts");
	});

	it("says so when nothing has been logged, instead of showing an empty list", async () => {
		const { pi } = boot({});
		await pi.runCommand("papercuts");
		expect(pi.notifications[0].message).toContain("No papercuts logged yet");
	});
});
