/**
 * The row-script `edit` override, actually run.
 *
 * ./rowscript.test.ts and ./apply.test.ts already grade the parser and the
 * applier as pure functions. Nothing here re-tests them. What is untested until
 * this file exists is the WIRING, which is where the two failures that matter
 * live:
 *
 *   - the gate. This tool replaces `edit`. If it registers when it should not,
 *     every session that loads it loses the edit format its model was trained
 *     on. "Disabled registers nothing" is therefore not a nicety, it is the
 *     property that makes landing the code safe.
 *   - "nothing was written". The applier is filesystem-free by design, so the
 *     all-or-nothing promise is made HERE, by the caller, and can only be
 *     verified by reading the disk back after a failure.
 *
 * So the tool is registered through the real factory, called through the real
 * registered definition (guard wrapper included), and every assertion about
 * what did or did not land reads the files off disk.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createFakePi } from "./fake-pi.ts";
import { gitAvailable } from "./require-tools.ts";
import rowtoolExtension, { TOOL_NAME, loadRowToolConfig, runRowScript, scriptPaths } from "../extensions/edit-common/rowtool.ts";

const realHome = process.env.HOME;
afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
});

interface Booted {
	pi: ReturnType<typeof createFakePi>;
	/** Call the registered tool exactly as pi would, guard wrapper included. */
	call: (script: string) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
	read: (name: string) => string;
	write: (name: string, content: string) => void;
	work: string;
}

/**
 * HOME is redirected before the factory runs — `loadRowToolConfig` resolves
 * under `homedir()`, and a suite that wrote the developer's real
 * `~/.pi/agent/hive-telemetry/rowtool.config.json` would be switching their
 * edit tool over as a side effect of running the tests.
 *
 * `work` is a separate temp directory and is the tool's cwd, so relative header
 * paths resolve there. It is outside any git repo, which is what keeps the
 * worktree guard out of the way: `decide()` returns ALLOW when it cannot locate
 * a repo, so these tests grade the tool rather than the guard.
 */
function boot(config?: { enabled: boolean }, workDir?: string): Booted {
	const home = mkdtempSync(join(tmpdir(), "rowtool-home-"));
	const stateDir = join(home, ".pi", "agent", "hive-telemetry");
	mkdirSync(stateDir, { recursive: true });
	if (config) writeFileSync(join(stateDir, "rowtool.config.json"), JSON.stringify(config));
	process.env.HOME = home;

	const work = workDir ?? mkdtempSync(join(tmpdir(), "rowtool-work-"));

	const pi = createFakePi();
	rowtoolExtension(pi.api);

	const ctx = { cwd: work, ui: { notify: () => {} } } as unknown as ExtensionContext;
	const call = async (script: string) => {
		const tool = pi.tools.find((candidate) => candidate.name === TOOL_NAME);
		if (!tool) throw new Error(`${TOOL_NAME} was not registered`);
		const execute = tool.definition.execute as (
			id: string,
			params: unknown,
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
		return execute("call-1", { script }, undefined, undefined, ctx);
	};

	return {
		pi,
		call,
		read: (name: string) => readFileSync(join(work, name), "utf8"),
		write: (name: string, content: string) => writeFileSync(join(work, name), content),
		work,
	};
}

function textOf(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

const SERVER = ["import { listen } from './net.ts';", "", "const PORT = 8080;", "", "export function start() {", "  listen(PORT);", "}", ""].join("\n");

describe("the gate", () => {
	it("registers nothing at all when there is no config", () => {
		// Default OFF is the whole safety argument. Absent config is the common
		// case — every machine that pulls this branch — and it must be inert.
		const { pi } = boot();
		expect(pi.tools.map((tool) => tool.name)).toEqual([]);
	});

	it("registers nothing when the config says false", () => {
		const { pi } = boot({ enabled: false });
		expect(pi.tools.map((tool) => tool.name)).toEqual([]);
	});

	it("reads the flag opt-in: an unrelated key does not switch it on", () => {
		const home = mkdtempSync(join(tmpdir(), "rowtool-home-"));
		const stateDir = join(home, ".pi", "agent", "hive-telemetry");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "rowtool.config.json"), JSON.stringify({ verbose: true }));
		process.env.HOME = home;
		expect(loadRowToolConfig().enabled).toBe(false);
	});

	it("overrides `edit` rather than adding a second tool", () => {
		// P3: a tool that competes with an existing typed tool is called zero
		// times. The name IS the delivery mechanism, so it is asserted.
		const { pi } = boot({ enabled: true });
		expect(pi.tools.map((tool) => tool.name)).toEqual(["edit"]);
	});
});

describe("the scoping mechanism this design depends on", () => {
	it("has no index.ts in edit-common, which is what keeps it out of auto-discovery", () => {
		// pi's `discoverExtensionsInDir` loads `extensions/*.ts` and
		// `extensions/<dir>/index.ts` and does not recurse. An index.ts here would
		// make this file auto-discovered in every interactive session, where
		// pretty-tools already owns `edit` — a first-registration-wins coin flip,
		// and a global change to the edit format. The absence is load-bearing.
		const dir = join(import.meta.dirname, "..", "extensions", "edit-common");
		expect(existsSync(join(dir, "index.ts"))).toBe(false);
		expect(existsSync(join(dir, "index.js"))).toBe(false);
		expect(existsSync(join(dir, "package.json"))).toBe(false);
	});
});

describe("a successful multi-operation apply", () => {
	it("applies several operations across several files and writes them all", async () => {
		const { call, read, write } = boot({ enabled: true });
		write("server.ts", SERVER);
		write("logger.ts", "export const level = 'info';\n");

		const result = await call(
			[
				"[server.ts]",
				"@REPLACE",
				" export function start() {",
				"-  listen(PORT);",
				"+  logger.info({ port: PORT }, 'starting');",
				"+  listen(PORT);",
				"@@",
				"-const PORT = 8080;",
				"+const PORT = 3000;",
				"@INS.PRE 1",
				"+import { logger } from './logger.ts';",
				"[logger.ts]",
				"@INS.AFTER",
				"-export const level = 'info';",
				"+export const pretty = true;",
			].join("\n"),
		);

		expect(result.isError).toBeUndefined();
		expect(read("server.ts")).toBe(
			[
				"import { logger } from './logger.ts';",
				"import { listen } from './net.ts';",
				"",
				"const PORT = 3000;",
				"",
				"export function start() {",
				"  logger.info({ port: PORT }, 'starting');",
				"  listen(PORT);",
				"}",
				"",
			].join("\n"),
		);
		expect(read("logger.ts")).toBe("export const level = 'info';\nexport const pretty = true;\n");
		// The reply names both files, so the model can see what it changed without
		// re-reading them.
		expect(textOf(result)).toContain("server.ts");
		expect(textOf(result)).toContain("logger.ts");
	});

	it("does not shift its own line-addressed inserts", async () => {
		// The classic applier bug, and the reason @INS.PRE is usable as the escape
		// hatch for a missed anchor at all. Resolution happens in ORIGINAL
		// coordinates; two inserts in one payload must both mean what they said.
		const { call, read, write } = boot({ enabled: true });
		write("a.txt", "one\ntwo\nthree\n");
		const result = await call(["[a.txt]", "@INS.PRE 1", "+zero", "@INS.POST 3", "+four"].join("\n"));
		expect(result.isError).toBeUndefined();
		expect(read("a.txt")).toBe("zero\none\ntwo\nthree\nfour\n");
	});
});

describe("a missed anchor", () => {
	it("refuses, writes nothing, and quotes the bytes the anchor nearly matched", async () => {
		const { call, read, write } = boot({ enabled: true });
		write("server.ts", SERVER);

		const result = await call(["[server.ts]", "@REPLACE", "-const PORT = 8081;", "+const PORT = 3000;"].join("\n"));

		expect(result.isError).toBe(true);
		// The whole point of routing through diagnose.ts: the model is handed the
		// real line instead of "please provide more context", which is what turns
		// its retry into a correction rather than the same guess again.
		const text = textOf(result);
		expect(text).toContain("--- begin ---");
		expect(text).toContain("const PORT = 8080;");
		expect(text).toContain("Do not re-send the anchor you just used.");
		expect(read("server.ts")).toBe(SERVER);
	});

	it("names the operation and its line in the script", async () => {
		const { call, write } = boot({ enabled: true });
		write("server.ts", SERVER);
		const result = await call(["[server.ts]", "@DEL", "-nowhere in this file at all"].join("\n"));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("@DEL");
		expect(textOf(result)).toContain("script line 2");
	});
});

describe("an ambiguous anchor", () => {
	it("refuses with the duplicate line numbers rather than editing the first one", async () => {
		const { call, read, write } = boot({ enabled: true });
		const content = "a();\nmarker;\nb();\nmarker;\nc();\n";
		write("dup.ts", content);

		const result = await call(["[dup.ts]", "@REPLACE", "-marker;", "+MARKER;"].join("\n"));

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("occurs 2 times");
		expect(text).toContain("lines 2, 4");
		expect(read("dup.ts")).toBe(content);
	});

	it("applies once a context row breaks the tie", async () => {
		// The remedy the refusal recommends has to actually work, or the advice is
		// a dead end. Context widens the match; it never moves what is changed.
		const { call, read, write } = boot({ enabled: true });
		write("dup.ts", "a();\nmarker;\nb();\nmarker;\nc();\n");
		const result = await call(["[dup.ts]", "@REPLACE", " a();", "-marker;", "+MARKER;"].join("\n"));
		expect(result.isError).toBeUndefined();
		expect(read("dup.ts")).toBe("a();\nMARKER;\nb();\nmarker;\nc();\n");
	});
});

describe("malformed input", () => {
	it("returns a usable error instead of throwing", async () => {
		const { call } = boot({ enabled: true });
		// A row with no marker: the single most likely mistake, because it is what
		// a model does when it forgets the format and pastes raw file text.
		const result = await call(["[a.ts]", "@REPLACE", "const x = 1;"].join("\n"));
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("script line 3");
		expect(text).toContain("Nothing was written.");
	});

	it("rejects an empty script by naming what a script starts with", async () => {
		const { call } = boot({ enabled: true });
		const result = await call("");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("[path/to/file]");
	});

	it("rejects a line-addressed insert with no line number", async () => {
		const { call } = boot({ enabled: true });
		const result = await call(["[a.ts]", "@INS.PRE", "+x"].join("\n"));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("@INS.PRE");
	});

	it("says the path is wrong when the file is not there, and does not create it", async () => {
		const { call, work } = boot({ enabled: true });
		const result = await call(["[missing.ts]", "@INS.PRE 1", "+x"].join("\n"));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("missing.ts");
		expect(existsSync(join(work, "missing.ts"))).toBe(false);
	});
});

describe("all-or-nothing across the whole payload", () => {
	it("writes nothing when one file of two fails", async () => {
		// Stronger than the applier's per-file guarantee, and the caller's call to
		// make: every operation is resolved in memory before a byte is written, so
		// atomicity across files costs nothing. An edit script is one plan.
		const { call, read, write } = boot({ enabled: true });
		write("good.ts", "keep me\n");
		write("bad.ts", "other content\n");

		const result = await call(
			["[good.ts]", "@REPLACE", "-keep me", "+changed", "[bad.ts]", "@REPLACE", "-not present", "+nope"].join("\n"),
		);

		expect(result.isError).toBe(true);
		expect(read("good.ts")).toBe("keep me\n");
		expect(read("bad.ts")).toBe("other content\n");
		expect(textOf(result)).toContain("NOTHING was written");
		// Without this the assertion above is satisfied by good.ts ALSO having
		// failed, which would grade nothing. Only failures are listed, so good.ts
		// being absent from the report is the proof that it resolved and was
		// deliberately not written.
		expect(textOf(result)).not.toContain("good.ts");
		expect(textOf(result)).toContain("bad.ts");
	});

	it("reports every failure in one reply rather than one per round trip", async () => {
		const { call, write } = boot({ enabled: true });
		write("a.ts", "alpha\nbeta\n");
		const result = await call(
			["[a.ts]", "@REPLACE", "-missing one", "+x", "@REPLACE", "-missing two", "+y"].join("\n"),
		);
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("operation 1");
		expect(text).toContain("operation 2");
	});
});

describe("two headers that name one file", () => {
	it("refuses rather than letting the second section silently overwrite the first", async () => {
		// `[a.ts]` and `[./a.ts]` are two DISTINCT strings, so the parser keeps them
		// as two sections (it merges only on exact spelling) — but they are one file
		// on disk. Both sections resolve against the ORIGINAL content, and the write
		// loop then writes the same path twice, so the first section's edits are
		// gone and the reply says "Applied 2 files." That is a success-shaped lost
		// update, which is the one class this whole module refuses everywhere else.
		const { call, read, write } = boot({ enabled: true });
		write("a.ts", "one\ntwo\n");

		const result = await call(
			["[a.ts]", "@REPLACE", "-one", "+ONE", "[./a.ts]", "@REPLACE", "-two", "+TWO"].join("\n"),
		);

		expect(result.isError).toBe(true);
		expect(read("a.ts")).toBe("one\ntwo\n");
		// Both spellings are named, because the model wrote two headers and has to
		// be told which two to merge.
		const text = textOf(result);
		expect(text).toContain("[a.ts]");
		expect(text).toContain("[./a.ts]");
	});

	it("still merges two sections written with the identical spelling", async () => {
		// The parser already merges these into one section, so they are one file
		// with two operations and must keep working. Without this, the refusal above
		// could be implemented as "two headers is an error" and nobody would notice.
		const { call, read, write } = boot({ enabled: true });
		write("a.ts", "one\ntwo\n");
		const result = await call(["[a.ts]", "@REPLACE", "-one", "+ONE", "[a.ts]", "@REPLACE", "-two", "+TWO"].join("\n"));
		expect(result.isError).toBeUndefined();
		expect(read("a.ts")).toBe("ONE\nTWO\n");
	});
});

describe("a file that is not valid UTF-8", () => {
	it("is refused rather than rewritten lossily", async () => {
		// The applier is a string pipeline, so the file is decoded on the way in and
		// re-encoded on the way out. A latin-1 byte survives neither: it decodes to
		// U+FFFD and is written back as EF BF BD, corrupting bytes on lines the
		// script never mentioned. The anchor matches perfectly, so nothing else in
		// the pipeline can notice — the read is the only place this is visible.
		const { call, work } = boot({ enabled: true });
		const raw = Buffer.concat([
			Buffer.from("const label = '", "utf8"),
			Buffer.from([0xe4]), // latin-1 'ä'
			Buffer.from("';\nconst x = 1;\n", "utf8"),
		]);
		writeFileSync(join(work, "latin1.ts"), raw);

		const result = await call(["[latin1.ts]", "@REPLACE", "-const x = 1;", "+const x = 2;"].join("\n"));

		expect(result.isError).toBe(true);
		expect(readFileSync(join(work, "latin1.ts")).equals(raw), "the file must be byte-identical").toBe(true);
		expect(textOf(result)).toContain("UTF-8");
	});
});

describe.runIf(gitAvailable())("the worktree guard, which in a worker is the only one there is", () => {
	/** A repo that has opted into the guard, the way a protected checkout does. */
	function guardedRepo(): string {
		const root = mkdtempSync(join(tmpdir(), "rowtool-guarded-"));
		execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
			cwd: root,
			stdio: "ignore",
		});
		writeFileSync(join(root, ".worktree-guard"), "");
		return root;
	}

	it("refuses the call and writes nothing when the target is a guarded checkout", async () => {
		// `--no-extensions` strips guards-bridge, so in a worker `registerGuardedTool`
		// is the ONLY thing standing between this tool and a protected worktree. That
		// makes the wiring — not just the resolver — the thing worth grading: swapping
		// `registerGuardedTool` for `pi.registerTool` would leave every other test in
		// this file green.
		const { call, read, write } = boot({ enabled: true }, guardedRepo());
		write("guarded.ts", "keep me\n");

		const result = await call(["[guarded.ts]", "@REPLACE", "-keep me", "+changed"].join("\n"));

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("BLOCKED");
		expect(read("guarded.ts")).toBe("keep me\n");
	});
});

describe("what the guard is told this call will write", () => {
	it("derives the targets from the script's headers", () => {
		// `capability.writesResolved` has no path parameter to read — the model
		// names its targets inside the payload. If this drifts from what execute
		// writes, the only worktree guard a worker has is judging a different file
		// than the one that lands.
		expect(scriptPaths(["[one.ts]", "@DEL", "-x", "[two.ts]", "@DEL", "-y"].join("\n"))).toEqual(["one.ts", "two.ts"]);
	});

	it("guards nothing for a script that does not parse", () => {
		expect(scriptPaths("not a script")).toEqual([]);
	});
});

describe("the filesystem-free core", () => {
	it("applies against supplied contents without touching a disk", () => {
		const outcome = runRowScript("[x.ts]\n@REPLACE\n-a\n+b\n", new Map([["x.ts", "a\n"]]));
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.files.get("x.ts")).toBe("b\n");
	});

	it("keys contents by the header's own spelling, so a path is never quietly renamed", () => {
		const outcome = runRowScript("[./x.ts]\n@REPLACE\n-a\n+b\n", new Map([["x.ts", "a\n"]]));
		expect(outcome.ok).toBe(false);
		expect(outcome.text).toContain("./x.ts");
	});
});
