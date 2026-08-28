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

import { access, constants, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ancestors, gateArgs, gateCandidates, render, splitReport } from "./gate.ts";
import { consume, emptyProgress, finish, type GateProgress, widgetEnvelope } from "./stream.ts";
import {
	deckLines,
	deckSummary,
	fold,
	recoveryFor,
	renderReport,
	stepsFrom,
} from "./hivecheck.ts";
import { cancelRun, dispatch, failedTaskLogs, follow, hivePipelineDir, QUEUED_FOLLOW_MINUTES, resolveCheckAuth } from "./hiverun.ts";
import { DECK_SECTION_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

/**
 * Timeout, scaled by mode — and only when progress is actually flowing.
 *
 * A flat 300s was below the MEASURED p50 of thorough mode (902s at 37 checks;
 * max 1128s), so `mode:"thorough"` was routinely killed and surfaced as a
 * broken tool. But a long ceiling is only safe while the caller can see it
 * working: if streaming fell back, a 30-minute limit is a 30-minute silent
 * hold, which is worse than an early honest failure. So the long ceilings apply
 * to the streaming path only.
 */
const TIMEOUT_STREAMING: Record<string, number> = {
	quick: 300_000,
	standard: 600_000,
	thorough: 1_800_000,
};
const TIMEOUT_BUFFERED = 300_000;
const MAX_LINES = 200;
/** A network hop per 100ms of bash output is 10x too fast; 1 Hz is plenty. */
const UPDATE_INTERVAL_MS = 1000;

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }], details: {} };
}

/**
 * findGate picks the nearest candidate that is actually RUNNABLE.
 *
 * `access(path, X_OK)` is not enough on its own, and the gap is not academic.
 * On a directory, the execute bit means *searchable*, so `access` resolves for
 * any `drwxr-xr-x` — and one of the candidate names, plain `quality-gate`, is
 * the name of the gate's own CHECKOUT. An agent working in `~/repos/<repo>/…`
 * walks its ancestors up to `~/repos`, finds the `~/repos/quality-gate` clone
 * sitting there, and hands a directory to `spawn`, which fails as
 * `env: '/home/dev/repos/quality-gate': Permission denied` (exit 126).
 *
 * That is not a hypothetical: it is 7 of 93 entries in the papercut log for
 * 2026-08-15/16, every one of them an agent in a `hive__worktrees/` checkout
 * that reported the gate as unrunnable and shipped without it. Hive vendors no
 * gate of its own, so the walk always reached `~/repos` and always matched.
 *
 * So the candidate must also be a regular FILE. A directory that happens to be
 * named like the gate is not the gate, and skipping it lets the search continue
 * to a real one (or report an honest "no gate found" the agent can act on)
 * instead of dying on exec.
 */
export async function findGate(cwd: string): Promise<string | null> {
	for (const path of gateCandidates(ancestors(cwd))) {
		try {
			await access(path, constants.X_OK);
			// Follows symlinks deliberately: a gate is often a symlink into a
			// vendored checkout, and that is still a runnable file.
			if (!(await stat(path)).isFile()) continue;
			return path;
		} catch {
			/* not here */
		}
	}
	return null;
}

/**
 * How many paths `git status --porcelain` reports in `cwd`, or undefined.
 *
 * Called ONLY when the gate checked nothing, because that is the only branch
 * that reads it — a dirty tree there means the scope was wrong, not the
 * directory (see uncommittedAdvice). Running it on every gate invocation would
 * spend a subprocess to answer a question nobody asked.
 *
 * Undefined on ANY failure — not a git repo, git missing, a timeout. The
 * message falls back to its previous wording when the count is unknown, so a
 * diagnostic that cannot answer must not invent one; guessing "0" here would
 * silently restore exactly the wrong advice this exists to remove.
 */
export async function uncommittedCount(cwd: string, signal?: AbortSignal): Promise<number | undefined> {
	// An empty cwd is not "here" — it is "I do not know where". `spawn` would
	// inherit the PROCESS's directory and count a tree the caller never named,
	// and this extension already carries the scar from that default: gating the
	// session cwd instead of the requested checkout is what produced the silent
	// "Nothing to check" this function exists to explain. Unknown, not local.
	if (!cwd.trim()) return undefined;
	return await new Promise((resolve) => {
		let out = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (v: number | undefined) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(v);
		};
		try {
			// spawn THROWS for some bad cwds rather than emitting `error` — a cwd
			// that is a file gives a synchronous ENOTDIR, which would escape this
			// promise entirely and turn a diagnostic into the failure it was
			// explaining. `error` alone does not cover it; both paths are needed.
			const child = spawn("git", ["status", "--porcelain"], { cwd, signal });
			// A bounded wait: this runs on a path the agent is already waiting on,
			// and `git status` on a very large tree is not worth stalling the answer.
			timer = setTimeout(() => {
				child.kill();
				done(undefined);
			}, 5000);
			child.stdout?.on("data", (b: Buffer) => {
				out += b.toString();
			});
			child.on("error", () => done(undefined));
			child.on("close", (code) => {
				if (code !== 0) return done(undefined);
				done(out.split("\n").filter((l) => l.trim() !== "").length);
			});
		} catch {
			done(undefined);
		}
	});
}

/**
 * What one gate invocation is known to have done.
 *
 * `code` and `signal` are BOTH nullable and exactly one of them is set: the
 * kernel reports an exit code for a process that exited and a signal for one
 * that was killed. Collapsing that into a single number is the whole of
 * HIV-2687 — it is how "we killed it at 300s" came to read as "exit 0".
 */
interface GateRun {
	out: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	streamed?: boolean;
	elapsedMs?: number;
	/** Set only when the ceiling below is what did the killing. */
	ceilingMs?: number;
}

/**
 * Run the gate, forwarding progress as it arrives.
 *
 * `pi.exec` cannot do this for two independent reasons: it has no `env` field
 * (so `QG_SUBSTEPS=1` cannot be injected) and it buffers to completion (no
 * chunk callback). Hence spawn — with `env` passed through argv so no shell is
 * involved and the value stays data.
 */
async function streamGate(
	gate: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	mode: string,
	scope: string,
	onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void,
	onProgress?: (p: GateProgress) => void,
): Promise<GateRun> {
	return await new Promise((resolve, reject) => {
		// `env` via the env(1) binary rather than the spawn option: the marker
		// flag then rides in argv, which keeps it visible in any process listing
		// and avoids inheriting a mutated environment into the child's children.
		//
		// `detached` makes the child a process-GROUP leader, which is the only
		// way to end the whole gate. `child.kill` signals the bash wrapper and
		// nothing else, so a killed run left basedpyright and tsgo running —
		// and those orphans go on holding `.git/index.lock`, which breaks the
		// NEXT commit in that worktree with "File exists" (HIV-2687).
		const child = spawn("env", [`QG_SUBSTEPS=1`, gate, ...args], { cwd, signal, detached: true });
		const startedAt = Date.now();
		const progress = emptyProgress(mode, scope);
		const shown: string[] = [];
		let pending = "";
		let raw = "";
		let dirty = false;
		let lastSent = 0;

		const flush = (force: boolean) => {
			if (!dirty || !onUpdate) return;
			const now = Date.now();
			if (!force && now - lastSent < UPDATE_INTERVAL_MS) return;
			lastSent = now;
			dirty = false;
			// The TUI gets the same reading as the browser card, off the same fold
			// (HIV-1929) — a local session watching its own gate should not have to
			// open a web page to see which check is red.
			onProgress?.(progress);
			onUpdate({
				content: [{ type: "text", text: shown.slice(-40).join("\n") }],
				details: widgetEnvelope(progress),
			});
		};

		const onData = (buf: Buffer) => {
			raw += buf.toString();
			pending += buf.toString();
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const { changed, hide } = consume(progress, line);
				// Protocol markers are stripped from what the MODEL reads: leaving
				// them in teaches it that `##hive:substep` is output.
				if (!hide) shown.push(line);
				if (changed) dirty = true;
			}
			flush(false);
		};

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		/** Signal the whole gate, not just the wrapper that spawned it. */
		const killTree = (sig: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, sig);
				else child.kill(sig);
			} catch {
				// Already gone, or never became a group leader — the direct
				// signal is still worth trying, and a kill that cannot land
				// must not take the run's report down with it.
				try {
					child.kill(sig);
				} catch {
					/* nothing left to signal */
				}
			}
		};

		const ceiling = TIMEOUT_STREAMING[mode] ?? TIMEOUT_BUFFERED;
		let hitCeiling = false;
		const timer = setTimeout(() => {
			hitCeiling = true;
			killTree("SIGKILL");
		}, ceiling);
		// The spawn `signal` option aborts the LEADER only, which under
		// `detached` leaves the gate's own children behind. Same tree, same
		// treatment.
		const onAbort = () => killTree("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code, killedBy) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (pending) {
				const { hide } = consume(progress, pending);
				if (!hide) shown.push(pending);
			}
			flush(true);
			// `code` is NULL whenever the child died from a signal, and that null
			// is the only evidence the run was killed. The old `?? 0` erased it,
			// so a terminated gate arrived downstream wearing the exit code of a
			// clean short-circuit and was reported as an empty scope. Carry both
			// facts through untouched and let render decide what they mean.
			resolve({
				out: raw,
				code,
				signal: killedBy,
				streamed: true,
				elapsedMs: Date.now() - startedAt,
				ceilingMs: hitCeiling ? ceiling : undefined,
			});
		});
	});
}

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

/**
 * The gate for a repo that gates through Hive.
 *
 * Same tool, same widget envelope, different runner: `hive check` dispatches the
 * repo's real pipeline against the uncommitted working tree, and the run's steps
 * and substeps are folded into the spec the vendored path produces. Everything
 * an agent sees — the meter, the per-check rows, the failed list — is therefore
 * identical in both repos, which is the point: one thing to learn to read.
 */
async function runHiveCheck(
	pi: ExtensionAPI,
	params: { only?: string; mode?: string; scope?: string; skip?: string; stopEarly?: boolean },
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void,
) {
	const steps = stepsFrom(params.only);
	// The vendored gate's knobs have no counterpart in a pipeline, and silently
	// ignoring one is how `mode:"thorough"` comes to mean "lint only" without
	// anybody being told. Named, once, in the report the model reads.
	const ignored = ["mode", "scope", "skip", "stopEarly"].filter(
		(k) => (params as Record<string, unknown>)[k] !== undefined,
	);
	let note = ignored.length
		? `note: ${ignored.join(", ")} do not apply to a Hive gate — the steps are named with \`only\` (ran: ${steps.join(", ")}).`
		: "";
	// `note` is read at REPORT time, below, so a line appended by the pruned-step
	// recovery still reaches the model — the verdict it is about to read is not
	// for the steps it asked for, and saying so is the whole point.
	const withNote = (body: string) => (note ? `${body}\n${note}` : body);
	const auth = resolveCheckAuth();
	if (!auth) {
		// Name what is missing. "Could not run the gate" sends an agent looking
		// for a defect in its own diff; this sends it to two environment
		// variables it can check in one command.
		return text(
			"This repo gates through Hive (`hive check`), but no Hive credential is configured: " +
				"set HIVE_URL and HIVE_TOKEN, or run /hive-login. Nothing was checked.",
		);
	}

	let run;
	try {
		run = await dispatch(steps, cwd, signal);
	} catch (err) {
		return text(
			`This repo gates through Hive, but the \`hive\` CLI could not be started (${err instanceof Error ? err.name : "error"}). ` +
				"Nothing was checked — install/rebuild the CLI, or run the repo's own gate command from its AGENTS.md.",
		);
	}
	// A PRUNED step is not a refusal to act on — it is the plan telling us this
	// diff did not need that step, and naming the ones it did need. Retry once
	// with those, or the caller is told "nothing was checked" about a diff Hive
	// was perfectly willing to check. See prunedStepSurvivors for the measured
	// case (6 agents on 2026-08-17, every one shipping unverified).
	let ranSteps = steps;
	let recovered: { steps: string[]; why: "pruned" | "absent" } | null = null;
	if (!run.ref) {
		recovered = recoveryFor(params.only, run.out);
		if (recovered) {
			try {
				run = await dispatch(recovered.steps, cwd, signal);
				ranSteps = recovered.steps;
			} catch {
				/* fall through to the verbatim refusal below */
			}
		}
	}
	if (recovered && run.ref) {
		// SAY IT. The verdict below is not for the steps that were asked for, and
		// an agent reading a green report has to know which question it answers —
		// otherwise this trades "nothing was checked" for "something was checked
		// and you assumed it was the thing you wanted", which is worse.
		const line =
			recovered.why === "pruned"
				? `note: \`${steps.join(", ")}\` was pruned from this run's plan — this diff does not touch what it reads — ` +
					`so the gate ran the steps that did apply: ${ranSteps.join(", ")}.`
				: `note: this repo's pipeline has no \`${steps.join(", ")}\` step (that is quality_gate's default, not something you asked for), ` +
					`so the gate ran this run's plan instead: ${ranSteps.join(", ")}. Pass \`only\` to choose.`;
		note = note ? `${note}\n${line}` : line;
	}
	if (!run.ref) {
		// The CLI refused, and its refusal is the useful text: an unknown step
		// name comes back with the pipeline's ACTUAL step list, which nothing here
		// could reconstruct. Reported verbatim, marked as "no verdict" so it is
		// never mistaken for a pass.
		return text(`NO VERDICT — \`hive check --step ${steps.join(",")}\` created no run (exit ${run.code}):\n\n${run.out.trim()}`);
	}

	const emit = (p: GateProgress) => {
		publishDeck(pi, p);
		onUpdate?.({
			content: [{ type: "text", text: renderReport(p) }],
			details: widgetEnvelope(p),
		});
	};

	try {
		const { progress, tasks, timedOut, stillQueued } = await follow(auth, run.ref, steps, signal, emit);
		if (signal?.aborted || timedOut) {
			// An abandoned run would otherwise hold fleet capacity producing a
			// verdict nobody will read — EXCEPT one that never started, which is
			// holding nothing. Cancelling that one only guarantees the work is
			// never done, and the caller has to re-pack and re-upload a snapshot
			// to ask the same question again.
			if (!stillQueued) cancelRun(auth, run.ref.id);
			const where = progress.url ?? run.ref.id;
			const text_ = stillQueued
				? `NO VERDICT — the run is STILL QUEUED after ${Math.round(QUEUED_FOLLOW_MINUTES)} minutes and has not started; nothing has been checked. ` +
					`It is NOT cancelled and is still waiting for a fleet slot at ${where}. ` +
					`Do not re-run the gate — that would queue a second copy behind this one. ` +
					`Watch it instead (\`hive watch ${run.ref.id}\` in the background) or check back later; ` +
					`\`fleet_status\` says how busy the fleet is.`
				: `NO VERDICT — ${timedOut ? "the follow timed out" : "the call was aborted"} while the run was still going. It is still at ${where} (cancel requested).`;
			return {
				content: [{ type: "text" as const, text: text_ }],
				details: widgetEnvelope({ ...progress, status: "nosummary" }),
			};
		}
		const logs = progress.status === "fail" ? await failedTaskLogs(auth, tasks) : [];
		return {
			content: [{ type: "text" as const, text: withNote(renderReport(progress, { logs })) }],
			details: widgetEnvelope(progress),
		};
	} finally {
		publishDeck(pi, null);
	}
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
			"BEFORE claiming work is done; `quick` mode is lint-only and fast enough to run " +
			"repeatedly. Reports which checks failed, the findings, and — importantly — any " +
			"check that could not run because its tool is missing. " +
			"In a repo that gates through Hive (hive, Aurora, Borealis-Ops) it runs `hive check` " +
			"on the fleet against your uncommitted working tree instead — same report, same live " +
			"progress — so reach for this rather than shelling out to `hive check` yourself.",
		parameters: Type.Object({
			mode: Type.Optional(
				StringEnum(["quick", "standard", "thorough"] as const, {
					description: "quick = lint only (default, fast); standard = + tests for changed files; thorough = everything",
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
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			// Read from ctx BEFORE the first await — it goes stale on resume, fork
			// and reload. Defaulting to process.cwd() is what let a subagent find
			// one repo's gate and run it against another repo's tree.
			const sessionCwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			// WHERE the gate runs is a real parameter, because the session's cwd is
			// regularly not where the work is. A launched agent's own worktree is
			// read-only under the sandbox, so it moves to a second checkout under
			// ~/.hive/scratch/<session>/ — and the gate, pinned to the session cwd,
			// then examined a tree with no changes in it and answered "Nothing to
			// check". That is the worst possible shape: not an error, just a gate
			// that quietly verified nothing, on the one call an agent makes to find
			// out whether its work is sound.
			let cwd = sessionCwd;
			if (params.cwd?.trim()) {
				const requested = resolve(sessionCwd, params.cwd.trim());
				let ok = false;
				try {
					ok = (await stat(requested)).isDirectory();
				} catch {
					ok = false;
				}
				if (!ok) {
					// Refuse rather than fall back. Silently gating the session cwd
					// after being told to gate somewhere else reproduces the exact
					// bug this parameter exists to fix, and hides it better.
					return text(
						`cwd ${requested} is not a directory, so there is nothing to gate there. ` +
							`Pass an existing checkout, or omit cwd to gate the session's own (${sessionCwd}).`,
					);
				}
				cwd = requested;
			}
			const gate = await findGate(cwd);
			if (!gate) {
				// A Hive-gated repo is not a repo without a gate — it is a repo
				// whose gate runs on the fleet. Telling the agent to shell out to
				// `hive check` (what this branch used to do) is what left the most
				// important verification path rendering as a silent bash call for
				// twenty minutes; now the tool runs it and reports it (HIV-1929).
				if (await hivePipelineDir(cwd)) return await runHiveCheck(pi, params, cwd, signal, onUpdate);
				// Naming the alternative matters: an agent told only "not found"
				// concludes the repo has no gate and ships unchecked.
				return text(
					"No quality gate found in this repo (looked for vendor/quality-gate/quality-gate, " +
						"scripts/quality-gate and quality-gate, and a .hive/ pipeline, from the cwd upwards).\n" +
						"This repo may gate differently, so check its CLAUDE.md/AGENTS.md before assuming " +
						"there is nothing to run.",
				);
			}

			const mode = params.mode ?? "quick";
			const scope = params.scope ?? "changed";
			const args = gateArgs({
				mode,
				scope,
				only: params.only,
				skip: params.skip,
				stopEarly: params.stopEarly ?? false,
			});

			let run: GateRun;
			try {
				run = await streamGate(gate, args, cwd, signal, mode, scope, onUpdate, (p) => publishDeck(pi, p));
			} catch {
				// Sandboxed, or otherwise unable to spawn — the HIV-1170 EROFS
				// class. Fall back to the buffered path: the tool must never become
				// UNAVAILABLE because progress is unavailable. The shorter ceiling
				// applies here, because without progress a long limit is just a
				// long silence.
				const res = await pi.exec(gate, args, { signal, timeout: TIMEOUT_BUFFERED });
				// Same rule as the streaming path: a missing code means the run
				// did not exit, and substituting 0 would claim it did. This path
				// cannot say WHICH signal, so it reports the absence and lets
				// render word it without one.
				run = { out: `${res.stdout ?? ""}${res.stderr ?? ""}`, code: res.code ?? null, signal: null };
			} finally {
				// The deck shows what is HAPPENING. A finished verdict lives in the
				// transcript card, and leaving it pinned would push live sections
				// off the band for the rest of the session.
				publishDeck(pi, null);
			}

			const { text: diagnostics, result } = splitReport(run.out);
			const progress = finish(emptyProgress(mode, scope), result, run.code);
			return {
				content: [
					{
						type: "text" as const,
						text: render(diagnostics, result, {
							command: `${gate} ${args.join(" ")}`,
							exitCode: run.code,
							maxLines: MAX_LINES,
							cwd,
							scope,
							mode,
							signal: run.signal,
							elapsedMs: run.elapsedMs,
							ceilingMs: run.ceilingMs,
							// Only asked for when the gate checked nothing: that is the
							// one branch whose message depends on the answer. A run that
							// was KILLED never got as far as a scope, so the count would
							// only feed advice about the wrong thing.
							uncommitted:
								!result && run.code === 0 && !run.signal ? await uncommittedCount(cwd, signal) : undefined,
							// Only read in the zero-check branch, where a selector that
							// matched nothing is the likeliest explanation.
							selector: params.only,
						}),
					},
				],
				// The SAME envelope type the live updates carried, so the browser
				// widget receives a fresher spec rather than switching kind.
				details: widgetEnvelope(progress),
			};
		},
	});
}
