/**
 * settings — registry, view, and the drift guard.
 *
 * The drift guard is the important one. A central registry that points at a
 * renamed config key shows a stale value and writes to a file nobody reads,
 * which is worse than having no settings page: it looks authoritative and is
 * wrong. These tests read the real extension sources on disk, so the registry
 * cannot silently rot.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setKittyProtocolActive } from "@earendil-works/pi-tui";

import {
	GROUP_ORDER,
	SETTINGS,
	groupRows,
	navigationOrder,
	readSetting,
	writeSetting,
	type SettingRow,
	type SettingSpec,
} from "../extensions/settings/registry.ts";
import { matchRow, parseArgs, routeSettingsKey } from "../extensions/settings/index.ts";
import {
	PLAIN_SETTINGS_STYLE,
	moveCursor,
	renderSettingsLines,
	switchLabel,
} from "../extensions/settings/view.ts";

const EXT = join(import.meta.dirname, "..", "extensions");

function rowsFrom(values: Partial<Record<string, boolean>> = {}): SettingRow[] {
	return SETTINGS.map((spec) => ({ spec, value: values[spec.config] ?? false }));
}

function specFor(config: string): SettingSpec {
	const spec = SETTINGS.find((entry) => entry.config === config);
	if (!spec) throw new Error(`no spec for ${config}`);
	return spec;
}

/**
 * Every source file belonging to an extension, concatenated.
 *
 * Reading only `index.ts` is not enough and the first run of this test proved
 * it: hive-telemetry's loader lives in `identity.ts` while `index.ts` contains
 * `enabled:` in a WRITER (`writeConfig({ enabled: true })`). A search that
 * stops at the first file containing the key finds the wrong one. So: read them
 * all, and let the expression match decide.
 */
function sourcesOf(spec: SettingSpec): string {
	const flat = join(EXT, `${spec.source}.ts`);
	if (existsSync(flat)) return readFileSync(flat, "utf8");
	const dir = join(EXT, spec.source);
	if (!existsSync(dir)) throw new Error(`no source found for ${spec.source}`);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => readFileSync(join(dir, name), "utf8"))
		.join("\n");
}

describe("registry drift guard", () => {
	it("every entry points at an extension that exists on disk", () => {
		for (const spec of SETTINGS) {
			const dir = join(EXT, spec.source);
			const flat = join(EXT, `${spec.source}.ts`);
			expect(existsSync(dir) || existsSync(flat), `${spec.source} missing`).toBe(true);
		}
	});

	it("declared mode matches the literal `enabled:` expression in each extension", () => {
		for (const spec of SETTINGS) {
			const source = sourcesOf(spec);
			// Match the READER, not a writer. `=== true` / `!== false` are the two
			// conventions in this package; anything else means the extension
			// changed shape and this registry entry needs re-reading by a human.
			const optIn = new RegExp(`${spec.key}:\\s*\\w+\\??\\.?${spec.key} === true`).test(source);
			const optOut = new RegExp(`${spec.key}:\\s*\\w+\\??\\.?${spec.key} !== false`).test(source);
			expect(optIn || optOut, `${spec.source}: no recognisable enabled expression`).toBe(true);
			expect(optIn && optOut, `${spec.source}: both conventions present — ambiguous`).toBe(false);
			expect(optIn ? "opt-in" : "opt-out", `${spec.source} mode`).toBe(spec.mode);
		}
	});

	it("config ids are unique — two entries writing one key would fight", () => {
		const seen = SETTINGS.map((spec) => `${spec.config}.${spec.key}`);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("every group in the registry is declared in GROUP_ORDER", () => {
		for (const spec of SETTINGS) expect(GROUP_ORDER).toContain(spec.group);
	});

	/**
	 * Every setting is classified, by hand, into exactly one of these two lists.
	 *
	 * The classification is the whole mechanism. The first version of this guard
	 * looped over a hardcoded `["compaction", "hive-telemetry", "hive-remote"]`
	 * and its comment claimed "if a fourth is ever added without a warning, this
	 * fails rather than shipping quietly" — which was false, and is the exact
	 * shape of guard that reads as safety and provides none: a new setting that
	 * ships conversation data to a vendor would simply not be in the list, and
	 * every assertion would still pass.
	 *
	 * Requiring membership in one list or the other makes adding a setting cost
	 * a deliberate answer to "does this leave the machine?", which is the
	 * decision the guard was always supposed to force.
	 */
	/**
	 * THE CRITERION, written down because the lists are otherwise arbitrary and
	 * the first setting that made a model call (`btw`) exposed that the rule had
	 * never been stated:
	 *
	 * **Off-machine = introduces a destination or a retention the conversation
	 * does not already have.**
	 *
	 * Not "makes a network call", and not "sends text to a vendor" — by those
	 * readings every turn of every session qualifies and the distinction stops
	 * meaning anything. `compaction` is off-machine even though it talks to the
	 * provider already in use, because `store: true` adds *retention* that was
	 * not there. `hive-telemetry` and `hive-remote` add a *destination*.
	 *
	 * `btw` sends a transcript excerpt to the same provider already receiving
	 * the whole conversation, under the same credentials, with no retention
	 * change, and only when a human types the command. New destination: none.
	 * New retention: none. So: local-only — and if that reasoning ever stops
	 * holding (a different provider for side questions, say), it moves.
	 */
	const OFF_MACHINE = ["compaction", "hive-telemetry", "hive-remote"];
	const LOCAL_ONLY = ["filerank", "papercuts", "narrate", "term-title", "skill-scope", "rowtool", "btw"];

	it("every registered setting is classified off-machine or local-only", () => {
		const classified = new Set([...OFF_MACHINE, ...LOCAL_ONLY]);
		const unclassified = SETTINGS.map((spec) => spec.config).filter((config) => !classified.has(config));
		expect(
			unclassified,
			"a new setting must be declared off-machine or local-only in test/settings.test.ts before it can ship",
		).toEqual([]);
	});

	it("the two lists are disjoint and name only real settings", () => {
		expect(OFF_MACHINE.filter((config) => LOCAL_ONLY.includes(config))).toEqual([]);
		// `specFor` throws on an unknown config, so this also catches a list entry
		// left behind after a setting was removed from the registry.
		for (const config of [...OFF_MACHINE, ...LOCAL_ONLY]) expect(specFor(config).config).toBe(config);
	});

	it("anything that leaves the machine carries a warning", () => {
		for (const config of OFF_MACHINE) {
			expect(specFor(config).warning, `${config} needs a warning`).toBeTruthy();
		}
	});

	it("everything that sends data off the machine is opt-in", () => {
		for (const config of OFF_MACHINE) {
			expect(specFor(config).mode, `${config} must default OFF`).toBe("opt-in");
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Key routing — the half of the overlay a render test cannot reach            */
/* -------------------------------------------------------------------------- */

/**
 * The overlay shipped with raw byte comparisons (`data === "\u001b"`, `"\u001b[A"`,
 * `" "`, `"\r"`) and no test at all, and it was broken on every terminal that
 * speaks the Kitty keyboard protocol — which is the one this workstation uses.
 * Arrows kept working because they keep their legacy encoding; esc, q, space,
 * enter and j/k did not, so `/toggles` opened a modal with no way out.
 *
 * Hence: both encodings, asserted explicitly. `setKittyProtocolActive` is
 * MODULE-GLOBAL state inside pi-tui, so it is restored after every test — a
 * leaked `true` would silently change how sibling suites parse input.
 */
describe("routeSettingsKey", () => {
	// Spelled as an escape, never as a raw 0x1b byte. The shipped `handleInput`
	// embedded literal ESC bytes in its string literals, where they are
	// invisible in a diff, in a review and in most editors — which is part of
	// why nobody noticed the comparisons were against the wrong encoding.
	const ESC = String.fromCharCode(0x1b); // never a raw 0x1b byte in source

	afterEach(() => setKittyProtocolActive(false));

	describe("legacy encoding (no Kitty protocol)", () => {
		it.each([
			["escape", ESC, "close"],
			["q", "q", "close"],
			["up arrow", `${ESC}[A`, "up"],
			["k", "k", "up"],
			["down arrow", `${ESC}[B`, "down"],
			["j", "j", "down"],
			["space", " ", "toggle"],
			["carriage return", "\r", "toggle"],
			["line feed", "\n", "toggle"],
		])("%s", (_label, data, action) => {
			expect(routeSettingsKey(data)).toBe(action);
		});
	});

	describe("Kitty CSI-u encoding — what pi actually negotiates here", () => {
		// Every one of these returned null before the fix, which is why the page
		// could not be closed. The codepoints are the keys' own: 27 esc, 32
		// space, 13 enter, 113 q, 107 k, 106 j.
		it.each([
			["escape", `${ESC}[27u`, "close"],
			["q", `${ESC}[113u`, "close"],
			["space", `${ESC}[32u`, "toggle"],
			["enter", `${ESC}[13u`, "toggle"],
			["k", `${ESC}[107u`, "up"],
			["j", `${ESC}[106u`, "down"],
		])("%s", (_label, data, action) => {
			setKittyProtocolActive(true);
			expect(routeSettingsKey(data)).toBe(action);
		});

		it("arrows keep their legacy form under the protocol", () => {
			setKittyProtocolActive(true);
			expect(routeSettingsKey(`${ESC}[A`)).toBe("up");
			expect(routeSettingsKey(`${ESC}[B`)).toBe("down");
		});
	});

	it("there is always a way out of the overlay, in both encodings", () => {
		// The property that matters most: an overlay you cannot close is worse
		// than one that does nothing, because it takes the session with it.
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const closers = kitty ? [`${ESC}[27u`, `${ESC}[113u`] : [ESC, "q"];
			for (const data of closers) expect(routeSettingsKey(data), `kitty=${kitty} ${JSON.stringify(data)}`).toBe("close");
		}
	});

	it("ignores keys that are not ours rather than acting on them", () => {
		for (const data of ["x", "\t", `${ESC}[C`, `${ESC}[D`, ""]) {
			expect(routeSettingsKey(data), JSON.stringify(data)).toBeNull();
		}
	});
});

describe("readSetting honours each extension's own convention", () => {
	const optOut = specFor("narrate");
	const optIn = specFor("compaction");

	it("absent config: opt-out reads ON, opt-in reads OFF", () => {
		expect(readSetting(null, optOut)).toBe(true);
		expect(readSetting(null, optIn)).toBe(false);
	});

	it("empty config object behaves like an absent file", () => {
		expect(readSetting({}, optOut)).toBe(true);
		expect(readSetting({}, optIn)).toBe(false);
	});

	it("a literal value wins under both conventions", () => {
		expect(readSetting({ enabled: false }, optOut)).toBe(false);
		expect(readSetting({ enabled: true }, optIn)).toBe(true);
	});

	it("a non-boolean does not read as ON for an opt-in setting", () => {
		// The damaging direction: a typo must never turn telemetry on.
		expect(readSetting({ enabled: "yes" }, optIn)).toBe(false);
		expect(readSetting({ enabled: 1 }, optIn)).toBe(false);
	});
});

describe("writeSetting", () => {
	it("preserves unknown keys — these files are hand-editable", () => {
		const spec = specFor("papercuts");
		const next = writeSetting({ path: "/tmp/x.md", maxEntries: 20 }, spec, false);
		expect(next).toEqual({ path: "/tmp/x.md", maxEntries: 20, enabled: false });
	});

	it("writes a literal boolean rather than deleting the key", () => {
		const spec = specFor("narrate");
		expect(writeSetting({}, spec, true)).toEqual({ enabled: true });
		expect(writeSetting({}, spec, false)).toEqual({ enabled: false });
	});

	it("round-trips through readSetting under both conventions", () => {
		for (const config of ["narrate", "compaction"]) {
			const spec = specFor(config);
			for (const value of [true, false]) {
				expect(readSetting(writeSetting(null, spec, value), spec)).toBe(value);
			}
		}
	});

	it("does not mutate its input", () => {
		const spec = specFor("narrate");
		const raw = { enabled: true, other: 1 };
		writeSetting(raw, spec, false);
		expect(raw).toEqual({ enabled: true, other: 1 });
	});
});

describe("navigation order matches visual order", () => {
	it("flattens groups in GROUP_ORDER, not registry order", () => {
		const order = navigationOrder(rowsFrom());
		const groups = order.map((row) => row.spec.group);
		const sorted = [...groups].sort(
			(a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
		);
		expect(groups).toEqual(sorted);
	});

	it("includes every registered row exactly once", () => {
		expect(navigationOrder(rowsFrom())).toHaveLength(SETTINGS.length);
	});

	it("groupRows drops empty groups", () => {
		const only = [{ spec: specFor("narrate"), value: true }];
		const grouped = groupRows(only);
		expect(grouped).toHaveLength(1);
		expect(grouped[0].group).toBe("session");
	});
});

describe("moveCursor wraps in both directions", () => {
	it("wraps forward past the end", () => {
		expect(moveCursor(4, 1, 5)).toBe(0);
	});
	it("wraps backward past zero", () => {
		expect(moveCursor(0, -1, 5)).toBe(4);
	});
	it("survives an empty list rather than returning -1", () => {
		expect(moveCursor(0, -1, 0)).toBe(0);
	});
});

describe("render", () => {
	it("shows a warning even when the setting is OFF", () => {
		// The whole point: you must be able to read the consequence BEFORE
		// enabling, not discover it afterwards.
		const rows = rowsFrom({ compaction: false });
		const text = renderSettingsLines({ rows, cursor: 0 }, PLAIN_SETTINGS_STYLE, 80).join("\n");
		expect(text).toContain("store:true");
	});

	it("shows a hint only when the setting is ON", () => {
		const off = renderSettingsLines({ rows: rowsFrom({ compaction: false }), cursor: 0 }, PLAIN_SETTINGS_STYLE, 80).join("\n");
		const on = renderSettingsLines({ rows: rowsFrom({ compaction: true }), cursor: 0 }, PLAIN_SETTINGS_STYLE, 80).join("\n");
		expect(off).not.toContain("inert on openai-codex");
		expect(on).toContain("inert on openai-codex");
	});

	it("switch labels are the same width so the column cannot jitter", () => {
		expect(switchLabel(true)).toHaveLength(switchLabel(false).length);
	});

	it("marks exactly one row as selected", () => {
		const lines = renderSettingsLines({ rows: rowsFrom(), cursor: 2 }, PLAIN_SETTINGS_STYLE, 80);
		expect(lines.filter((line) => line.startsWith("›"))).toHaveLength(1);
	});

	it("the selected row is the one navigationOrder puts at the cursor", () => {
		const rows = rowsFrom();
		const target = navigationOrder(rows)[3];
		const lines = renderSettingsLines({ rows, cursor: 3 }, PLAIN_SETTINGS_STYLE, 80);
		const selected = lines.find((line) => line.startsWith("›"));
		expect(selected).toContain(target.spec.label);
	});

	it("surfaces a save error rather than showing a value that did not stick", () => {
		const text = renderSettingsLines(
			{ rows: rowsFrom(), cursor: 0, error: "EACCES" },
			PLAIN_SETTINGS_STYLE,
			80,
		).join("\n");
		expect(text).toContain("could not save: EACCES");
	});

	it("renders an empty registry without throwing", () => {
		expect(() => renderSettingsLines({ rows: [], cursor: 0 }, PLAIN_SETTINGS_STYLE, 80)).not.toThrow();
	});

	it("does not run off a narrow terminal", () => {
		const lines = renderSettingsLines({ rows: rowsFrom(), cursor: 0 }, PLAIN_SETTINGS_STYLE, 20);
		expect(lines.every((line) => line.length < 200)).toBe(true);
	});
});

describe("parseArgs", () => {
	it("returns null for no arguments so the overlay opens", () => {
		expect(parseArgs("")).toBeNull();
		expect(parseArgs("   ")).toBeNull();
	});

	it("splits a trailing on/off from the name", () => {
		expect(parseArgs("compaction on")).toEqual({ name: "compaction", value: true });
		expect(parseArgs("hive telemetry off")).toEqual({ name: "hive telemetry", value: false });
	});

	it("treats a bare name as a query, not a toggle", () => {
		expect(parseArgs("compaction")).toEqual({ name: "compaction", value: null });
	});

	it("is case-insensitive about on/off", () => {
		expect(parseArgs("narrate OFF")).toEqual({ name: "narrate", value: false });
	});
});

describe("matchRow", () => {
	const rows = rowsFrom();

	it("matches an exact config id", () => {
		expect(matchRow(rows, "term-title")).toMatchObject({ spec: { config: "term-title" } });
	});

	it("matches a label prefix", () => {
		expect(matchRow(rows, "papercut")).toMatchObject({ spec: { config: "papercuts" } });
	});

	it("reports ambiguity rather than guessing", () => {
		// "hive" prefixes both hive-telemetry and hive-remote. Picking one would
		// be the difference between reporting metrics and accepting steering.
		expect(matchRow(rows, "hive")).toBe("ambiguous");
	});

	it("prefers an exact config id over a prefix collision", () => {
		expect(matchRow(rows, "hive-remote")).toMatchObject({ spec: { config: "hive-remote" } });
	});

	it("returns null for no match and for empty input", () => {
		expect(matchRow(rows, "nonsense")).toBeNull();
		expect(matchRow(rows, "  ")).toBeNull();
	});
});

/**
 * No extension command may take a name pi already owns.
 *
 * A builtin always wins, and the loss is total but nearly silent: the
 * conflicting command is dropped from autocomplete and typing its name runs
 * pi's builtin instead. The extension-vs-extension rescue (a suffixed
 * `invocationName`) does not apply — `runner.js` assigns one only when two
 * EXTENSIONS claim a name. `/settings` shipped like that: unreachable, and
 * announced by one warning line among a screenful of startup output.
 *
 * The builtin list is read from the installed pi rather than copied here, so a
 * new builtin in a future version fails this test instead of silently
 * swallowing one of our commands.
 */
describe("extension command names", () => {
	const PI_DIST = join(
		import.meta.dirname,
		"..",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
	);

	function builtinSlashCommands(): Set<string> {
		const source = readFileSync(join(PI_DIST, "core", "slash-commands.js"), "utf8");
		const names = [...source.matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map((match) => match[1]);
		// A parse that finds nothing would make this test vacuously green — the
		// exact failure mode it exists to prevent.
		expect(names.length).toBeGreaterThan(5);
		return new Set(names);
	}

	function registeredCommands(): { name: string; file: string }[] {
		const found: { name: string; file: string }[] = [];
		for (const entry of readdirSync(EXT, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const file = join(EXT, entry.name, "index.ts");
			if (!existsSync(file)) continue;
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
				found.push({ name: match[1], file: `${entry.name}/index.ts` });
			}
		}
		return found;
	}

	it("registers commands", () => {
		// Guards the scan itself: a refactor that moves registration out of
		// index.ts would otherwise leave the collision check testing nothing.
		expect(registeredCommands().length).toBeGreaterThan(5);
	});

	it("never collides with a pi builtin", () => {
		const builtins = builtinSlashCommands();
		const collisions = registeredCommands()
			.filter((command) => builtins.has(command.name))
			.map((command) => `/${command.name} (${command.file})`);
		expect(collisions).toEqual([]);
	});
});
