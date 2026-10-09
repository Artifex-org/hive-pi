/**
 * gate — run the house quality gate on the work in progress.
 *
 * This is the half of pi-lens worth keeping that pi-lens got wrong. It offered
 * `lsp_diagnostics`: a language server's opinion, which is a DIFFERENT set of
 * rules from the one that decides whether a PR merges. An agent that satisfies
 * the language server and fails `ruff`, `basedpyright` or the 750-line
 * file-length gate has learned nothing, twice.
 *
 * So the diagnostics an agent gets here are the REAL gate — the same checks the
 * pre-commit hook and CI run, discovered from the repo rather than assumed, so
 * a repo that pins a vendored version gets that version's rules.
 *
 * `quick` by default: lint only, no test suites, a <5s target. The agent is
 * meant to run this constantly, and a tool that takes a minute gets called
 * once at the end, which is exactly when the findings are most expensive.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import type { GateProgress } from "./stream.ts";
import { deckLines, deckSummary } from "./hivecheck.ts";
import { runQualityGate, type GateHost } from "./tool.ts";
import { DECK_SECTION_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

// The gate itself lives in tool.ts (shared with the Claude adapter); re-exported
// for the callers and tests that import it from here.
export { findAgentCheck, findGate, uncommittedCount } from "./tool.ts";

/**
 * publishDeck puts the gate on the pinned TUI widget while it runs.
 *
 * Cosmetic by definition — a widget that cannot draw must never fail a check —
 * so every emit is wrapped. `live` keeps the deck repainting on its own 1 s
 * cadence, which is what makes the meter move between polls rather than only on
 * the ticks that happened to change a row. Cleared when the call ends: a
 * finished gate is history, and history belongs in the transcript.
 */
function publishDeck(pi: ExtensionAPI, progress: GateProgress | null): void {
	try {
		pi.events.emit(DECK_SECTION_CHANNEL, {
			section: "gate",
			state:
				progress === null
					? null
					: {
							kind: "lines",
							summary: deckSummary(progress),
							lines: deckLines(progress),
							...(progress.status === "running" ? { live: true } : {}),
						},
		} satisfies DeckSectionEvent);
	} catch {
		/* no bus, or nothing listening */
	}
}

/** pi's half of the gate's host: the deck bus and `pi.exec`. */
function piGateHost(pi: ExtensionAPI, ctx: ExtensionToolContext): GateHost {
	return {
		publishDeck: (progress) => publishDeck(pi, progress),
		watchRun: async (run) => {
			const result = await ctx.executeTool("hive_watch_run", {
				run, what: "waiting for the quality gate verdict", timeout_seconds: 14_400,
			});
			return {
				text: result.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
				isError: result.isError,
			};
		},
		exec: async (command, args, options) => {
			const res = await pi.exec(command, args, options);
			return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.code ?? null, killed: res.killed === true };
		},
	};
}

export default function (pi: ExtensionAPI) {
	registerGuardedTool(pi, {
		capability: { executes: true }, // spawns the repo quality gate (`env … <gate>`), or the `hive` CLI
		name: "quality_gate",
		label: "Quality gate",
		description:
			"Run the repository's real quality gate on your changes — the same checks the " +
			"pre-commit hook and CI run (ruff, oxlint, typescript, basedpyright, gitleaks, " +
			"file-length, and whatever else this repo configures). Use it AFTER edits and " +
			"BEFORE claiming work is done. When the repo declares `scripts/agent-check` (its one " +
			"verification command: deps bootstrap, quick gate, type-check, the tests CI would " +
			"select), the default is mode `verify`, which runs that and reports each step as " +
			"passed, failed or NOT RUN; pass `tests:false` for the fast steps only. Otherwise, and " +
			"with mode `quick`, it runs the vendored gate — lint-only and fast enough to run " +
			"repeatedly. Reports which checks failed, the findings, and — importantly — any " +
			"check that did not run. " +
			"In a repo that gates through Hive (hive, Aurora, Borealis-Ops) it runs `hive check` " +
			"on the fleet against your uncommitted working tree instead — same report, same live " +
			"progress. Slow runs hand off to hive_watch_run after at most two minutes; you get one completion wake. So reach for this rather than shelling out to `hive check` yourself.",
		parameters: Type.Object({
			mode: Type.Optional(
				StringEnum(["verify", "quick", "standard", "thorough"] as const, {
					description:
						"verify = the repo's scripts/agent-check (the default when the repo has one and neither " +
						"`only` nor `skip` is given); quick = vendored gate, lint only (the default otherwise, fast); " +
						"standard = + tests for changed files; thorough = everything",
				}),
			),
			tests: Type.Optional(
				Type.Boolean({
					description:
						"verify only: false passes --no-tests (deps, gate and type-check, no test suites). " +
						"Skipped steps are reported as not run, never as passed.",
				}),
			),
			install: Type.Optional(
				Type.Boolean({
					description: "verify only: false passes --no-install (report missing dependencies, install nothing).",
				}),
			),
			scope: Type.Optional(
				StringEnum(["changed", "staged", "all"] as const, {
					description: "changed = vs merge base (default); staged = pre-commit set; all = lint every file",
				}),
			),
			only: Type.Optional(
				Type.String({
					description:
						"Comma-separated check names to run exclusively, e.g. oxlint,ruff_lint. NARROWS THE " +
						"MODE'S PRESET rather than overriding it: a check outside the current mode selects " +
						"nothing and the gate runs zero checks — `typescript`, `basedpyright`, `mypy` and " +
						"`vitest` need mode \"standard\" or above, so they select nothing under the default " +
						"`quick`. Prefer `skip` when you mean 'everything but'. " +
						"On the Hive path these are STEP names instead (`lint`, `test-1`, `web-check`); " +
						"default `lint`, and an unknown one comes back with the pipeline's own step list.",
				}),
			),
			stopEarly: Type.Optional(
				Type.Boolean({
					description:
						"Stop at the first failing check. Default false: all findings at once is worth more " +
						"than a few seconds, because fixing them one round trip at a time is the expensive part.",
				}),
			),
			skip: Type.Optional(Type.String({ description: "Comma-separated check names to skip" })),
			cwd: Type.Optional(
				Type.String({
					description:
						"Directory to gate. Defaults to the session's own — pass this when your work is in " +
						"a DIFFERENT checkout than the one the session started in (a second worktree, or a " +
						"clone under ~/.hive/scratch/), or the gate examines the wrong tree and reports " +
						"nothing to check.",
				}),
			),
			project: Type.Optional(
				Type.String({
					description:
						"Hive path only: the Hive project to check against, passed as `hive check --project`. Omit it " +
						"and the CLI derives the project from the origin remote; pass it when that fails " +
						"(\"cannot derive the project from the origin remote\") — a fork, a mirror, a renamed repo.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			// Read from ctx BEFORE the first await — it goes stale on resume, fork
			// and reload.
			const sessionCwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			return runQualityGate(piGateHost(pi, ctx), params, sessionCwd, signal, onUpdate);
		},
	});
}
