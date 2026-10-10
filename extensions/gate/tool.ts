/**
 * The quality gate, harness-neutral — `quality_gate`'s whole behaviour.
 *
 * Lifted out of `index.ts` so the pi tool and the Claude adapter's MCP
 * `quality_gate` run the same discovery (scripts/agent-check, the vendored
 * gate, a Hive pipeline), the same streaming runner and ceilings, and the same
 * rendering. The two things that were pi's arrive as a `GateHost`: where the
 * live progress section is painted, and the buffered fallback runner pi
 * provides as `pi.exec`.
 */

import { access, constants, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import { AGENT_CHECK_PATH, agentCheckArgs, foldSummary, parseSummary, renderVerify } from "./agentcheck.ts";
import { ancestors, gateArgs, gateCandidates, render, selectorMatchedNothing, splitReport, stripAnsi } from "./gate.ts";
import { consume, emptyProgress, finish, type GateProgress, widgetEnvelope } from "./stream.ts";
import { recoveryFor, renderReport, stepsFrom } from "./hivecheck.ts";
import { dispatch, dispatchUnconfirmed, failedTaskLogs, follow, hivePipelineDir, resolveCheckAuth } from "./hiverun.ts";
import { isGateTaskKey } from "../hive-common/gate-tasks.ts";
import { GIT_NO_OPTIONAL_LOCKS, repoRoot } from "../hive-common/git.ts";

/** What the gate needs from the harness running it. */
export interface GateHost {
	/**
	 * Start the host's existing watch job: its completion wake, and on pi also an
	 * early notice for the first failed test/lint task (background/watch-run.ts)
	 * other than the `reported` ones this result already names.
	 */
	watchRun?(run: string, cwd: string, reported?: string[]): Promise<{ text: string; isError?: boolean }>;

	/** Paint (or, with null, clear) the live progress section. Cosmetic: must not throw. */
	publishDeck(progress: GateProgress | null): void;
	/** Run a command buffered, killing it at `timeout` ms — pi's `exec` contract. */
	exec(
		command: string,
		args: string[],
		options: { signal?: AbortSignal; timeout: number; cwd: string },
	): Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>;
}

export interface QualityGateParams {
	mode?: "verify" | "quick" | "standard" | "thorough";
	tests?: boolean;
	install?: boolean;
	scope?: "changed" | "staged" | "all";
	only?: string;
	stopEarly?: boolean;
	skip?: string;
	cwd?: string;
	project?: string;
}

export type GateUpdate = (u: { content: { type: "text"; text: string }[]; details: unknown }) => void;

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
	// A repo's agent check runs the tests CI selects, after bootstrapping
	// dependencies a fresh worktree lacks — thorough-sized, not quick-sized.
	verify: 1_800_000,
};
const TIMEOUT_BUFFERED = 300_000;
/** After we kill a run, how long its output may keep draining before we stop waiting on the pipes. */
const PIPE_GRACE_MS = 2_000;
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
	return await firstRunnable(gateCandidates(ancestors(cwd)));
}

/**
 * The repo's declared agent check (`scripts/agent-check`), nearest first, under
 * the same "must be a runnable FILE" rule as the gate.
 */
export async function findAgentCheck(cwd: string): Promise<string | null> {
	// Bounded by the repository, as the Hive pipeline lookup is: an agent check
	// in an ENCLOSING repo verifies that repo's tree, not this one (a nested
	// clone, a vendored checkout with its own gate), and its verdict would be
	// about the wrong code.
	const root = repoRoot(cwd);
	if (!root) return null;
	const dirs = ancestors(cwd).filter((dir) => dir === root || dir.startsWith(`${root}/`));
	return await firstRunnable(dirs.map((dir) => `${dir.replace(/\/$/, "")}/${AGENT_CHECK_PATH}`));
}

async function firstRunnable(candidates: string[]): Promise<string | null> {
	for (const path of candidates) {
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
			const child = spawn("git", [GIT_NO_OPTIONAL_LOCKS, "status", "--porcelain"], { cwd, signal });
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
	/** stdout alone, for readers whose contract is stdout's final line. */
	stdout?: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	streamed?: boolean;
	elapsedMs?: number;
	/** Set only when the ceiling below is what did the killing. */
	ceilingMs?: number;
}

/**
 * How a streamed run's output is read while it runs.
 *
 * The vendored gate speaks quality-gate's `##hive:substep` protocol when
 * `QG_SUBSTEPS=1` is set, and `consume` folds it into per-check rows. An agent
 * check speaks no protocol beyond its final line, so it gets no marker and a
 * fold that only marks the output as new — the live view is its output tail.
 * Setting the marker there would make its NESTED quality gate's markers fold
 * into rows (and its banner into the meter's denominator) for checks that are
 * only one of the agent check's steps.
 */
interface StreamProtocol {
	substeps: boolean;
	fold(progress: GateProgress, line: string): { changed: boolean; hide: boolean };
}

const QUALITY_GATE_PROTOCOL: StreamProtocol = { substeps: true, fold: consume };
const PLAIN_OUTPUT: StreamProtocol = { substeps: false, fold: () => ({ changed: true, hide: false }) };

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
	protocol: StreamProtocol = QUALITY_GATE_PROTOCOL,
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
		const child = spawn("env", [...(protocol.substeps ? ["QG_SUBSTEPS=1"] : []), gate, ...args], { cwd, signal, detached: true });
		const startedAt = Date.now();
		const progress = emptyProgress(mode, scope);
		const shown: string[] = [];
		let pending = "";
		let raw = "";
		let stdoutOnly = "";
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
				const { changed, hide } = protocol.fold(progress, line);
				// Protocol markers are stripped from what the MODEL reads: leaving
				// them in teaches it that `##hive:substep` is output.
				if (!hide) shown.push(line);
				if (changed) dirty = true;
			}
			flush(false);
		};

		child.stdout?.on("data", (buf: Buffer) => {
			stdoutOnly += buf.toString();
			onData(buf);
		});
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

		// `close` waits for the PIPES, not the process. A descendant that left
		// the process group (`setsid`, a daemon, a test runner's
		// `start_new_session`) keeps them open after the kill, so an aborted or
		// ceiling-killed run would never settle — measured: `setsid sleep 8 &`
		// held an aborted call for 8 s, and a daemon holds it forever. Once WE
		// ended the run, give its output a moment to drain, then let go of the
		// pipes so `close` can fire.
		child.on("exit", () => {
			if (!signal?.aborted && !hitCeiling) return;
			setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, PIPE_GRACE_MS).unref();
		});

		child.on("error", (err) => {
			// An abort arrives here too — the spawn `signal` option reports it as
			// an AbortError — and it is NOT a failure to spawn. Rejecting sent
			// the caller to its buffered fallback, which ran the whole gate AGAIN
			// for a call that had just been cancelled. `close` follows with the
			// signal, and that is the honest report: terminated, no verdict.
			if (signal?.aborted && err.name === "AbortError") return;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code, killedBy) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (pending) {
				const { hide } = protocol.fold(progress, pending);
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
				stdout: stdoutOnly,
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
 * The gate for a repo that gates through Hive.
 *
 * Same tool, same widget envelope, different runner: `hive check` dispatches the
 * repo's real pipeline against the uncommitted working tree, and the run's steps
 * and substeps are folded into the spec the vendored path produces. Everything
 * an agent sees — the meter, the per-check rows, the failed list — is therefore
 * identical in both repos, which is the point: one thing to learn to read.
 */
async function runHiveCheck(
	host: GateHost,
	params: { only?: string; mode?: string; scope?: string; skip?: string; stopEarly?: boolean; project?: string; tests?: boolean; install?: boolean },
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void,
) {
	const steps = stepsFrom(params.only);
	// The vendored gate's knobs have no counterpart in a pipeline, and silently
	// ignoring one is how `mode:"thorough"` comes to mean "lint only" without
	// anybody being told. Named, once, in the report the model reads.
	const ignored = ["mode", "scope", "skip", "stopEarly", "tests", "install"].filter(
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
		run = await dispatch(steps, cwd, signal, { project: params.project });
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
				run = await dispatch(recovered.steps, cwd, signal, { project: params.project });
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
		// "Created no run" is a CLAIM, and only some of these outcomes support it.
		//
		// The CLI classifies its own exits (hive cmd/hive/exitcode.go, HIV-664)
		// and reserves 4 for "the result was never confirmed" — a create-run POST
		// whose response was lost after the body was delivered, so the server was
		// very likely already evaluating the pipeline. Its own comment on that
		// code reads: "1 is worse still: it asserts a verdict nobody has." This
		// branch was asserting exactly that, one layer up, for every exit alike.
		//
		// Measured 2026-09-05..07, 88 papercuts across two developers: 77 MB
		// uploaded, `context deadline exceeded`, and then `NO VERDICT — created
		// no run`. One agent caught the contradiction unaided — "A timeout is
		// indeterminate, not proof no run was created; checking list_runs before
		// any retry" — and another recorded that the false certainty had already
		// steered it wrong. Both had to reconcile by hand what the exit code
		// already told them.
		//
		// A signal kill is the same class and was worse: the dispatch timeout
		// SIGKILLs the CLI mid-upload, and this path used to read that as exit 0.
		if (dispatchUnconfirmed(run)) {
			const how = run.signal
				? `the dispatch was killed (${run.signal}) before the CLI could report`
				: run.code === 1
					? "the CLI's request timed out awaiting the server's answer (an older `hive` build reports that as exit 1 — run `hive version`; the node updates it from the server)"
					: "the CLI could not confirm the result (exit 4)";
			return text(
				`NO VERDICT — ${how}. A run MAY have been created: the snapshot upload had already been ` +
					`delivered, so the server may be evaluating it now.\n\n` +
					`Do NOT re-dispatch blind — that risks a second run of the same gate on a shared queue. ` +
					`Reconcile first:\n` +
					`  hive runs --project <project> --branch <branch>\n` +
					`If a run is listed for your branch, watch it: hive watch <run>. If none is, re-run the check.` +
					`\n\n${run.out.trim()}`,
			);
		}
		// Everything else IS a definite answer, and the CLI's own words are the
		// useful ones: an unknown step name comes back with the pipeline's ACTUAL
		// step list, which nothing here could reconstruct. Reported verbatim,
		// marked "no verdict" so it is never mistaken for a pass.
		// Echoed in the repeated form the CLI documents: the comma-joined
		// spelling is valid too, but reads as one step named "a,b" (HIV-3322).
		return text(
			`NO VERDICT — \`hive check ${steps.map((s) => `--step ${s}`).join(" ")}\` created no run (exit ${run.code}):\n\n${run.out.trim()}`,
		);
	}

	const emit = (p: GateProgress) => {
		host.publishDeck(p);
		onUpdate?.({
			content: [{ type: "text", text: renderReport(p) }],
			details: widgetEnvelope(p),
		});
	};

	try {
		const { progress, tasks, timedOut, stillQueued, failedTask } = await follow(auth, run.ref, ranSteps, signal, emit);
		if (signal?.aborted || timedOut || failedTask) {
			// A red shard is what the agent acts on; the rest of the run is still
			// going, and its verdict — which alone decides whether this failure
			// counts — comes from the watch started below. Not on an abort: the
			// caller is gone, so the watch's own notice is how it hears of this.
			const failedFirst = failedTask && !signal?.aborted
				? `TASK FAILED — \`${failedTask}\` failed while other tasks are still running. Diagnose it now; ` +
					`the run's verdict follows from the watch below (a failure the trunk baseline masks does not fail the run).\n\n` +
					`${renderReport(progress, { logs: await failedTaskLogs(auth, tasks) })}\n\n`
				: "";
			// Every failed test/lint task that report shows — allow_failure ones
			// included — is not news to the watch; with no report, nothing is.
			const reported = failedFirst
				? tasks.filter((t) => (t.state === "failed" || t.state === "timed_out") && isGateTaskKey(t.key)).map((t) => t.key)
				: [];
			// Never cancel fleet work: even a queued snapshot can start between
			// this read and a cancel request. Watching it preserves the verdict.
			let watch: { text: string; isError?: boolean };
			try {
				watch = host.watchRun
					? await host.watchRun(run.ref.id, cwd, reported)
					: { text: "This host has no background watcher.", isError: true };
			} catch (error) {
				watch = { text: `Background watch could not start: ${String(error)}`, isError: true };
			}
			const where = progress.url ?? run.ref.id;
			const text_ = withNote(
				failedFirst + `NO VERDICT YET — ${signal?.aborted ? "the call was aborted" : failedFirst ? "the run continues until its last task ends" : stillQueued ? "all unfinished tasks are waiting for admission" : "the bounded foreground follow ended"}. ` +
				`Run ${run.ref.id} is NOT cancelled: ${where}. Do not re-dispatch the gate.\n\n` + watch.text +
				(watch.isError ? `\nNo background watch was started. Use hive_watch_run on ${run.ref.id} or check it with get_run.` : ""),
			);
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
		host.publishDeck(null);
	}
}

/** The deck's scope label for a verify run: the script chooses its own scope, and "changed" would claim one. */
const VERIFY_SCOPE = "repo-defined";

/**
 * The repo's agent check (`mode:"verify"`), through the same streaming,
 * ceiling, abort and deck as the vendored gate; read by the contract in
 * agentcheck.ts.
 */
async function runAgentCheck(
	host: GateHost,
	agentCheck: string,
	params: { tests?: boolean; install?: boolean; scope?: string; only?: string; skip?: string; stopEarly?: boolean; project?: string },
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void,
) {
	const args = agentCheckArgs(params);
	const command = [relative(cwd, agentCheck) || agentCheck, ...args].join(" ");
	// The vendored gate's knobs mean nothing to a repo's own script, and
	// dropping one silently is how `scope:"staged"` comes to mean "whatever the
	// script decides" without anybody being told.
	const ignored = (["scope", "stopEarly", "only", "skip", "project"] as const).filter((k) => params[k] !== undefined);
	let run: GateRun;
	try {
		run = await streamGate(agentCheck, args, cwd, signal, "verify", VERIFY_SCOPE, onUpdate, (p) => host.publishDeck(p), PLAIN_OUTPUT);
	} catch {
		// Same fallback as the vendored path: progress unavailable must not make
		// the check unavailable. Buffered, so the shorter ceiling.
		const res = await host.exec(agentCheck, args, { signal, timeout: TIMEOUT_BUFFERED, cwd });
		run = {
			out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
			stdout: res.stdout ?? "",
			// `killed` without an abort is the buffered ceiling: no exit code, and
			// the ceiling advice ("tests:false") is what to say.
			code: res.killed ? null : (res.code ?? null),
			signal: null,
			ceilingMs: res.killed && !signal?.aborted ? TIMEOUT_BUFFERED : undefined,
		};
	} finally {
		host.publishDeck(null);
	}
	const out = stripAnsi(run.out);
	const stdout = stripAnsi(run.stdout ?? run.out);
	const summary = parseSummary(stdout);
	return {
		content: [
			{
				type: "text" as const,
				text: renderVerify({ output: out, stdout }, {
					command,
					exitCode: run.code,
					signal: run.signal,
					elapsedMs: run.elapsedMs,
					ceilingMs: run.ceilingMs,
					maxLines: MAX_LINES,
					ignored: [...ignored],
				}),
			},
		],
		details: widgetEnvelope(
			foldSummary(emptyProgress("verify", VERIFY_SCOPE), summary, { exitCode: run.code, signal: run.signal, elapsedMs: run.elapsedMs }),
		),
	};
}

/** One `quality_gate` call. `sessionCwd` is where the gate runs unless `params.cwd` says otherwise. */
export async function runQualityGate(
	host: GateHost,
	params: QualityGateParams,
	sessionCwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: GateUpdate,
) {
	// `sessionCwd` is the caller's, read off its context before any await.
	// Defaulting to process.cwd() is what let a subagent find one repo's
	// gate and run it against another repo's tree.
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
	// The repo's ONE agent check, when it declares one, unless the caller
	// asked for the vendored gate — by mode, or by naming checks with
	// `only`/`skip`, which are the vendored gate's vocabulary. See the
	// README's "One agent check" for why this is the default.
	const agentCheck = await findAgentCheck(cwd);
	// Every vendored-gate knob selects the vendored gate: `scope:"all"` asks
	// for a lint of every file, not for a 30-minute test run.
	const asksForVendoredGate = (["only", "skip", "scope", "stopEarly"] as const).some((k) => params[k] !== undefined);
	if (params.mode === "verify" || (params.mode === undefined && agentCheck && !asksForVendoredGate)) {
		if (!agentCheck) {
			return text(
				`mode "verify" runs the repo's own \`${AGENT_CHECK_PATH}\`, and there is none in ${cwd} or above it. ` +
					'Nothing was checked. Use mode "quick" (or omit mode) for the vendored gate.',
			);
		}
		return await runAgentCheck(host, agentCheck, params, cwd, signal, onUpdate);
	}
	const gate = await findGate(cwd);
	if (!gate) {
		// A Hive-gated repo is not a repo without a gate — it is a repo
		// whose gate runs on the fleet. Telling the agent to shell out to
		// `hive check` (what this branch used to do) is what left the most
		// important verification path rendering as a silent bash call for
		// twenty minutes; now the tool runs it and reports it (HIV-1929).
		if (await hivePipelineDir(cwd)) return await runHiveCheck(host, params, cwd, signal, onUpdate);
		// Naming the alternative matters: an agent told only "not found"
		// concludes the repo has no gate and ships unchecked.
		return text(
			"No quality gate found in this repo (looked for scripts/agent-check, vendor/quality-gate/quality-gate, " +
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
		run = await streamGate(gate, args, cwd, signal, mode, scope, onUpdate, (p) => host.publishDeck(p));
	} catch {
		// Sandboxed, or otherwise unable to spawn — the HIV-1170 EROFS
		// class. Fall back to the buffered path: the tool must never become
		// UNAVAILABLE because progress is unavailable. The shorter ceiling
		// applies here, because without progress a long limit is just a
		// long silence.
		// In the checkout being gated, like the streaming path — not wherever
		// this process happens to be.
		const res = await host.exec(gate, args, { signal, timeout: TIMEOUT_BUFFERED, cwd });
		// Same rule as the streaming path: a missing code means the run
		// did not exit, and substituting 0 would claim it did. A run the
		// buffered CEILING killed is reported as one (no exit code, the
		// ceiling named), never as a clean exit. This path cannot say WHICH
		// signal, so it reports the absence and lets render word it without one.
		run = {
			out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
			code: res.killed ? null : (res.code ?? null),
			signal: null,
			ceilingMs: res.killed && !signal?.aborted ? TIMEOUT_BUFFERED : undefined,
		};
	} finally {
		// The deck shows what is HAPPENING. A finished verdict lives in the
		// transcript card, and leaving it pinned would push live sections
		// off the band for the rest of the session.
		host.publishDeck(null);
	}

	const { text: diagnostics, result } = splitReport(run.out);
	// A zero-check "pass" for a NAMED selector, in a repo that also gates
	// through Hive: the caller almost certainly wrote pipeline STEP names
	// (`lint`, `test-backend`, …) — the vocabulary this repo's docs teach —
	// not vendored check names. Re-dispatch as the hive check they were
	// asking for, and say so, instead of reporting NOTHING CHECKED and
	// leaving them to shell out to `hive check --step` by hand (HIV-3077).
	if (selectorMatchedNothing(params.only, result) && (await hivePipelineDir(cwd))) {
		const hive = await runHiveCheck(host, params, cwd, signal, onUpdate);
		const first = hive.content?.[0];
		if (first?.type === "text") {
			// Lead with what IS happening, not with what missed.
			//
			// This used to open on "matched no checks in the vendored gate",
			// and agents read that opening as a failure and the dispatch as a
			// recovery from it — filing it as "first said the names matched no
			// vendored checks, then re-dispatched". Nothing failed: these are
			// step names, this repo gates through Hive, and sending them to the
			// fleet is the whole design (HIV-3077). Said in that order it needs
			// no interpretation.
			const named = stepsFrom(params.only);
			first.text =
				`\`${named.join("\`, \`")}\` ${named.length === 1 ? "is a Hive pipeline step" : "are Hive pipeline steps"}, ` +
				`not vendored gate checks — this repo gates through Hive, so the gate ran them on the fleet:\n` +
				`  hive check ${named.map((s) => `--step ${s}`).join(" ")}\n` +
				`The verdict below is that run's.\n\n` +
				first.text;
		}
		return hive;
	}
	const progress = finish(emptyProgress(mode, scope), result, run.code);
	// `tests`/`install` belong to the repo's agent check; here they would
	// otherwise vanish, and `tests:false` would read as honoured.
	const verifyOnly = (["tests", "install"] as const).filter((k) => params[k] !== undefined);
	const verifyNote = verifyOnly.length
		? `\nnote: ${verifyOnly.join(", ")} apply only to mode "verify" (a repo's scripts/agent-check) and were ignored by the vendored gate.`
		: "";
	return {
		content: [
			{
				type: "text" as const,
				text:
					render(diagnostics, result, {
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
				}) + verifyNote,
			},
		],
		// The SAME envelope type the live updates carried, so the browser
		// widget receives a fresher spec rather than switching kind.
		details: widgetEnvelope(progress),
	};
}
