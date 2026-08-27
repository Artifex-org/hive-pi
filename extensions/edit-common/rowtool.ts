/**
 * The row-script `edit` override — parser and applier, wired to real files.
 *
 * ./rowscript.ts holds the format and the measurement that justifies it
 * (`~/.pi/agent/scripts/measure-edit-failures.py`, 247 sessions: 7.3% of the
 * orchestrator's edits fail, and 82.0% of those failures are anchor-class —
 * 6.0% of all 2,343 edits, each a wasted round trip on a paid model).
 * ./apply.ts holds the resolution rules and is deliberately filesystem-free.
 * This module is the only part that touches a disk, and it is small on purpose:
 * read, apply in memory, write once, render the failure.
 *
 * ## WHO GETS THIS TOOL, AND WHY THAT IS A LOADER FACT RATHER THAN A FLAG
 *
 * The ticket asked for "a built-in tool override scoped to worker roles", and
 * the naive reading — `registerTool({ name: "edit" })` from an extension —
 * would have been wrong twice over. Both were checked against pi 0.8x's own
 * sources, not assumed:
 *
 *   1. `pretty-tools.ts` ALREADY registers `edit` (its renderer plus the
 *      HIV-1562 diagnosis). pi resolves duplicate names FIRST-REGISTRATION-WINS
 *      (`core/extensions/runner.js` → `getAllRegisteredTools`) over raw
 *      `fs.readdirSync` order (`core/extensions/loader.js` →
 *      `discoverExtensionsInDir`). A second `edit` in the interactive session is
 *      therefore a coin flip decided by inode ordering — exactly the
 *      nondeterminism filerank refused to ship.
 *   2. The orchestrator's model is post-trained on its native edit format, and
 *      the measured win here is a WORKER win. Changing the orchestrator's edit
 *      format globally is the one outcome that must not happen by accident.
 *
 * So the scope is the LOADER, not an env sniff. `discoverExtensionsInDir` picks
 * up `extensions/*.ts` and `extensions/<dir>/index.ts` and does not recurse;
 * `edit-common/` has no `index.ts` and no `package.json` manifest. This file is
 * consequently invisible to auto-discovery and reachable ONLY through an
 * explicit `-e <path>` — which is precisely how a subagent worker is spawned
 * (`subagent/worker.ts`: `--no-extensions` plus an allowlist of `-e` paths).
 * In that process `pretty-tools` is not loaded, so there is no name race, and
 * `_refreshToolRegistry` (core/agent-session.js) applies extension tools OVER
 * the built-ins by name — the override lands cleanly.
 *
 * If someone does `-e` this into an interactive session anyway, nothing breaks
 * and nothing changes: pretty-tools is discovered first far more often than
 * not, first-registration-wins, and this one silently loses. Say it here so it
 * is not rediscovered as a bug.
 *
 * A role's `tools:` frontmatter line is NOT a second gate. It becomes `--tools`,
 * which pi turns into `_allowedToolNames` — a NAME filter over the merged
 * registry. It can deny `edit`; it cannot choose which definition owns the name.
 * Every role that already grants `edit` gets whichever `edit` is loaded, so no
 * `agents/*.md` change is needed or wanted.
 *
 * ## THE GATE
 *
 * Opt-in, default OFF (`raw.enabled === true`), read in the factory so a
 * disabled install registers NOTHING — narrate's reasoning, and it is stronger
 * here: this replaces the edit tool. Landing the code, and even adding this
 * path to `WORKER_EXTENSIONS`, changes nothing until
 * `~/.pi/agent/hive-telemetry/rowtool.config.json` says `{"enabled": true}`.
 *
 * There is no README in this directory to document that in — this file is the
 * documentation, deliberately, because the flag and its reasoning should not be
 * one `git mv` apart.
 *
 * ## WRITES
 *
 * NOT `atomicWrite` from hive-common/identity.ts, despite that being the house
 * convention for config: it mkdirs `~/.pi/agent/hive-telemetry` on every call
 * and chmods the result 0600. Both are correct for a credential file and wrong
 * for source, which must keep its mode, its inode (watchers and hardlinks hang
 * off it) and its owner. A plain truncating `writeFileSync` on the existing
 * path preserves all three; a write-tmp-and-rename would break all three.
 *
 * Registered through `registerGuardedTool`, not `pi.registerTool`. Guards are
 * not inherited — `guards-bridge` enforces on tool NAME and is itself stripped
 * by `--no-extensions`, so in a worker this wrapper is the ONLY worktree guard
 * that exists (see guards-common/capability.ts, which measured a worker-shaped
 * pi writing freely into a `.worktree-guard` checkout). The paths are derived
 * from the script's `[file]` headers rather than passed as a parameter, so the
 * declaration is `writesResolved`.
 *
 * KNOWN BLIND SPOT: `test/tool-capability.test.ts` globs `extensions/*.ts` and
 * `extensions/<dir>/index.ts`, so this file is outside its conformance sweep. The
 * capability above is declared anyway — the guard is what protects the worker,
 * not the test — but the test cannot see it, and that is worth knowing before
 * someone assumes it did.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGuardedTool } from "../guards-common/capability.ts";
import { configPathFor, readJSON } from "../hive-common/identity.ts";
import { applyScript, describeFailure, type ApplyResult, type OperationRef } from "./apply.ts";
import { parseRowScript, type ParsedScript } from "./rowscript.ts";

/** The built-in this replaces. Named once so the override is greppable. */
export const TOOL_NAME = "edit";

/**
 * Per-file read cap: 8 MB.
 *
 * The applier is line-based and holds every file of the payload in memory at
 * once, and this runs on the agent loop. 8 MB is far past any source file a
 * model can usefully anchor in and far short of the size where reading it is
 * the session's problem. A file over the cap is reported, not silently skipped:
 * a skip would reach `applyScript` as FILE_MISSING and blame the path.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface RowToolConfig {
	enabled: boolean;
}

/**
 * Opt-in, default OFF — the opposite of narrate and filerank, and for a reason
 * neither of them has: those two add a nudge and reorder a list. This one
 * changes the format every edit in the session is written in. Get the default
 * wrong and every session in every repo loses working edits, so absence of a
 * config means absence of the tool.
 */
export function loadRowToolConfig(): RowToolConfig {
	const raw = readJSON<Partial<RowToolConfig>>(configPathFor("rowtool")) ?? {};
	return { enabled: raw.enabled === true };
}

/**
 * The `[file]` headers of a script, in order, exactly as written.
 *
 * For the guard wrapper, which needs the targets BEFORE `execute` runs. A
 * script that does not parse returns nothing to guard — `execute` refuses it at
 * the parse step anyway, and inventing paths out of a broken script is how a
 * guard ends up judging something that was never going to be written.
 */
export function scriptPaths(script: string): string[] {
	const parsed = parseRowScript(script);
	return parsed.ok ? parsed.files.map((file) => file.path) : [];
}

export type RowToolOutcome =
	| { ok: false; text: string }
	| { ok: true; text: string; files: Map<string, string> };

/** `@REPLACE` etc., for an error message that names what the model wrote. */
function opLabel(op: OperationRef): string {
	switch (op.kind) {
		case "replace":
			return "@REPLACE";
		case "delete":
			return "@DEL";
		case "insert-before":
			return "@INS.BEFORE";
		case "insert-after":
			return "@INS.AFTER";
		case "insert-at":
			return "@INS.PRE/@INS.POST";
	}
}

/**
 * Everything except the filesystem: apply a parsed script to file contents and
 * render the reply the model reads.
 *
 * `contents` is keyed by the LITERAL header path, never a resolved one — the
 * script's own spelling is what every error message quotes back, and two keys
 * for one file is how a `[./src/a.ts]` header silently misses `src/a.ts`.
 *
 * ALL-OR-NOTHING ACROSS THE WHOLE PAYLOAD, which is stronger than the applier's
 * per-file guarantee and is the caller's call to make — apply.ts says so in as
 * many words ("a caller that wants a script to land atomically across files
 * should check `ok` before writing anything"). It is free here because every
 * operation is resolved in memory before a single byte is written, and it is
 * right because a multi-file edit script is one plan: half a plan is not a
 * smaller plan, it is a repo in a state nobody designed.
 */
export function runParsedScript(
	parsed: ParsedScript,
	contents: Map<string, string>,
	readErrors: ReadonlyMap<string, string> = new Map(),
): RowToolOutcome {
	const result = applyScript(contents, parsed);
	if (result.ok) return { ok: true, text: successText(result), files: result.files };
	return { ok: false, text: failureText(result, contents, readErrors) };
}

/** Parse and apply in one call. The tests' entry point, and execute's inner half. */
export function runRowScript(script: string, contents: Map<string, string>): RowToolOutcome {
	const parsed = parseRowScript(script);
	if (!parsed.ok) return { ok: false, text: parseErrorText(parsed) };
	return runParsedScript(parsed, contents);
}

/**
 * A parse fault as the sentence the model reads.
 *
 * The parser never throws — a stack trace is for a human and this reply goes to
 * a model — so the fault always arrives as a line number and a complaint. Line
 * 0 means "the script as a whole", which has no line to point at.
 */
function parseErrorText(fault: { line: number; message: string }): string {
	const where = fault.line > 0 ? ` (script line ${fault.line})` : "";
	return `Could not parse the edit script${where}: ${fault.message}\n\nNothing was written.`;
}

function successText(result: ApplyResult): string {
	const lines = result.outcomes.map((outcome) => {
		const count = outcome.operations.length;
		const at = outcome.operations
			.map((entry) => (entry.status === "ok" ? entry.at : 0))
			.filter((line) => line > 0)
			.sort((a, b) => a - b)[0];
		return `  ${outcome.path}: ${count} operation${count === 1 ? "" : "s"}${at ? `, first change at line ${at}` : ""}`;
	});
	return [`Applied ${result.outcomes.length} file${result.outcomes.length === 1 ? "" : "s"}.`, ...lines].join("\n");
}

/**
 * Every failure in one reply, and the statement that nothing landed.
 *
 * The applier resolves every operation even after one has failed, precisely so
 * this list can be complete: peeling faults off one round trip at a time is the
 * cost the whole format exists to remove. `describeFailure` is handed the file's
 * CONTENT, which is what routes an ANCHOR_MISS through diagnose.ts — the model
 * gets the bytes of the region it nearly matched instead of "please provide
 * more context", the difference between a correction and a repeated guess.
 */
function failureText(
	result: ApplyResult,
	contents: Map<string, string>,
	readErrors: ReadonlyMap<string, string>,
): string {
	const parts: string[] = [];
	for (const outcome of result.outcomes) {
		if (outcome.ok) continue;
		if (outcome.failure) {
			// A file we could not READ is absent from the map and reaches the
			// applier as FILE_MISSING, whose advice ("check the path") is wrong when
			// the real cause was a permission error or a size cap. One code path,
			// one extra clause.
			const why = readErrors.get(outcome.path);
			parts.push(`[${outcome.path}] ${describeFailure(outcome.path, outcome.failure)}${why ? ` (${why})` : ""}`);
			continue;
		}
		for (const entry of outcome.operations) {
			if (entry.status === "ok") continue;
			const where = `operation ${entry.op.index + 1} (${opLabel(entry.op)}, script line ${entry.op.scriptLine})`;
			parts.push(`[${outcome.path}] ${where}: ${describeFailure(outcome.path, entry.failure, contents.get(outcome.path))}`);
		}
	}
	return [
		`The edit script did not apply. NOTHING was written — not even the files whose operations resolved, because ` +
			`an edit script is one plan and half a plan is not a smaller plan.`,
		"",
		...parts,
	].join("\n");
}

/**
 * Two different header spellings that are one file on disk.
 *
 * The parser merges repeated headers by exact STRING equality, which is right
 * for it — it has no cwd and no filesystem. `[a.ts]` and `[./a.ts]` therefore
 * survive as two sections, and everything downstream treats them as two files:
 * both resolve against the ORIGINAL content, both produce a result, and the
 * write loop writes the same path twice. The second write wins and the first
 * section's edits are gone, under a reply that says "Applied 2 files."
 *
 * That is a lost update wearing a success, which is the one failure shape this
 * package refuses everywhere else — a miss costs a round trip the model can see,
 * a silent misapply costs a file nobody checks. So it is refused here, where the
 * cwd exists and the collision is visible, and refused rather than merged:
 * merging two sections would change what "two operations overlap" means, and
 * that rule lives in apply.ts.
 *
 * Returns the message, or null when every header names a distinct file.
 */
function aliasedHeaders(parsed: ParsedScript, cwd: string): string | null {
	const byTarget = new Map<string, string[]>();
	for (const file of parsed.files) {
		const target = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
		const spellings = byTarget.get(target);
		if (spellings) spellings.push(file.path);
		else byTarget.set(target, [file.path]);
	}
	const collisions = [...byTarget.entries()].filter(([, spellings]) => spellings.length > 1);
	if (collisions.length === 0) return null;
	return [
		`Different file headers in this script name the SAME file, so one section's edits would silently ` +
			`overwrite the other's. NOTHING was written.`,
		"",
		...collisions.map(([target, spellings]) => `  ${spellings.map((path) => `[${path}]`).join(" and ")} all resolve to ${target}`),
		"",
		`Write one section per file — repeating the IDENTICAL header is fine and merges, because every operation ` +
			`resolves against the file as it arrived.`,
	].join("\n");
}

/**
 * Read every file the script names, keyed by the header's own spelling.
 *
 * A file that does not decode and re-encode to the same bytes is reported as an
 * error rather than read. The applier is a string pipeline — decode in, encode
 * out — so a byte that is not valid UTF-8 comes back as U+FFFD and is written
 * over the original on lines the script never mentioned. The anchor still
 * matches and every check downstream still passes, so this read is the only
 * place a lossy rewrite can be seen coming.
 */
function readTargets(
	parsed: ParsedScript,
	cwd: string,
): { contents: Map<string, string>; errors: Map<string, string> } {
	const contents = new Map<string, string>();
	const errors = new Map<string, string>();
	for (const file of parsed.files) {
		const target = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
		try {
			const raw = readFileSync(target);
			if (raw.byteLength > MAX_FILE_BYTES) {
				errors.set(file.path, `${raw.byteLength} bytes, over the ${MAX_FILE_BYTES}-byte edit cap`);
				continue;
			}
			const text = raw.toString("utf8");
			if (!Buffer.from(text, "utf8").equals(raw)) {
				errors.set(file.path, "not valid UTF-8 — refusing to rewrite it, which would corrupt the undecodable bytes");
				continue;
			}
			contents.set(file.path, text);
		} catch (err) {
			errors.set(file.path, err instanceof Error ? err.message : String(err));
		}
	}
	return { contents, errors };
}

const TOOL_DESCRIPTION = [
	"Edit files with a row-oriented edit script. One call carries many operations across many files, and",
	"NOTHING is written unless every operation resolves — so a failed call leaves the tree untouched.",
	"",
	"FORMAT. A `[path]` header opens a file section; @-operations follow it. Inside an operation every line",
	"starts with exactly one marker and the rest of the line is a verbatim file line:",
	"  ' '  context — must be present in the file, and is kept",
	"  '-'  must be present. REMOVED by @REPLACE and @DEL; matched and KEPT by @INS.BEFORE/@INS.AFTER",
	"  '+'  inserted",
	"A file line that itself begins with a marker is written with the marker doubled: `++x` inserts `+x`,",
	"`--x` removes `-x`. Nothing else is escaped — `+@decorator` inserts `@decorator`.",
	"",
	"OPERATIONS.",
	"  @REPLACE       rows as above; a line reading `@@` starts another hunk in the same file",
	"  @DEL           delete the `-` rows",
	"  @INS.BEFORE    insert the `+` rows immediately above the `-` anchor rows",
	"  @INS.AFTER     insert the `+` rows immediately below the `-` anchor rows",
	"  @INS.PRE <n>   insert the `+` rows before 1-based line n (takes only `+` rows)",
	"  @INS.POST <n>  insert the `+` rows after 1-based line n (takes only `+` rows)",
	"",
	"RULES. Rows match WHOLE lines — trailing whitespace is ignored, interior whitespace is not, and a",
	"fragment of a line never matches. An anchor found 0 times or 2+ times is REFUSED, never guessed: add a",
	"context row that differs between the candidates to break a tie, and do not resend an anchor that just",
	"failed. Line numbers are the file as you last read it; several line-addressed inserts in one call do",
	"not shift each other. @INS.PRE/@INS.POST are the escape hatch when an anchor cannot be made unique —",
	"a line number cannot be 'not found'.",
	"",
	"EXAMPLE.",
	"[src/server.ts]",
	"@REPLACE",
	" export function start(port: number) {",
	'-  console.log("starting");',
	'+  logger.info({ port }, "starting");',
	"   listen(port);",
	"@@",
	"-const DEFAULT_PORT = 8080;",
	"+const DEFAULT_PORT = 3000;",
	"@INS.PRE 1",
	'+import { logger } from "./logger.ts";',
	"[src/logger.ts]",
	"@INS.AFTER",
	'-export const level = "info";',
	"+export const pretty = true;",
].join("\n");

/**
 * Register the override. Separate from the factory so a test can drive the gate
 * and the tool without going through extension loading.
 *
 * Returns whether anything was registered, so "disabled registers nothing" is
 * assertable at the call site as well as by inspecting the registry.
 */
export function registerRowTool(pi: Pick<ExtensionAPI, "registerTool">, config: RowToolConfig): boolean {
	if (!config.enabled) return false;

	registerGuardedTool(pi, {
		// Derived, not a parameter: the model names its targets inside the script,
		// so there is no path argument for the wrapper to read. Relative headers
		// are resolved against the same cwd `execute` writes to, or the guard would
		// judge a different file than the one that lands.
		capability: {
			writesResolved: (params, cwd) => {
				const script = params.script;
				if (typeof script !== "string") return [];
				const base = cwd ?? process.cwd();
				return scriptPaths(script).map((path) => (isAbsolute(path) ? path : resolve(base, path)));
			},
		},
		name: TOOL_NAME,
		label: "Edit",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			script: Type.String({
				description:
					"The row edit script: `[path]` headers, @-operations, and rows each carrying one leading marker " +
					"(' ' context, '-' match, '+' insert). See the tool description for the operations and the example.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const parsed = parseRowScript(params.script);
			if (!parsed.ok) return reply(parseErrorText(parsed), true);

			const cwd = ctx?.cwd ?? process.cwd();
			// Before anything is read: two headers resolving to one file cannot be
			// applied as written, and finding that out after the first write would be
			// finding it out too late.
			const aliased = aliasedHeaders(parsed, cwd);
			if (aliased) return reply(aliased, true);

			const { contents, errors } = readTargets(parsed, cwd);
			const outcome = runParsedScript(parsed, contents, errors);
			if (!outcome.ok) return reply(outcome.text, true);

			// Everything resolved, so this loop is the first thing that touches a
			// disk. A write that throws here is an environment fault (a read-only
			// mount, a full disk), not a bad script — and it is the one path that
			// CAN leave the payload half-applied, so it says exactly which files
			// landed rather than reporting a clean failure that is not one.
			const landed: string[] = [];
			for (const [path, content] of outcome.files) {
				const target = isAbsolute(path) ? path : resolve(cwd, path);
				try {
					writeFileSync(target, content);
					landed.push(path);
				} catch (err) {
					const why = err instanceof Error ? err.message : String(err);
					return reply(
						`Failed to write ${path}: ${why}\n\n` +
							`${landed.length} of ${outcome.files.size} file(s) had already been written` +
							`${landed.length ? `: ${landed.join(", ")}` : ""}. The rest were not.`,
						true,
					);
				}
			}
			return reply(outcome.text);
		},
	});
	return true;
}

function reply(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export default function (pi: ExtensionAPI) {
	// Read in the factory, so a disabled install registers NOTHING — not a tool
	// that refuses, not a command that explains. A tool the model can see is a
	// tool it spends tokens deciding about on every request, and an `edit` that
	// exists but refuses is worse than an `edit` that is pi's own.
	registerRowTool(pi, loadRowToolConfig());
}
