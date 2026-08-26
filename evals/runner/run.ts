#!/usr/bin/env node
/**
 * The eval runner: one clean container per trial (HIV-1035).
 *
 *   npm run eval -- --reps 3
 *   npm run eval -- --only edit-anchor-near-miss --reps 5
 *   npm run eval -- --arm diagnosis-off --env PI_HOUSE_EDIT_DIAGNOSIS=0
 *
 * WHY A CONTAINER, beyond isolation: the eval method forbids unattended runs on
 * the Codex subscription — subscription OAuth is interactive use, and a batch
 * of eval trials is not. A container that receives ONLY `OPENROUTER_API_KEY`
 * cannot violate that rule even if the runner is wrong, because no OAuth
 * credential exists inside it. `assertOpenRouterModel` is the second belt: it
 * refuses a model spec that is not OpenRouter's before spending anything.
 *
 * VALIDITY LIMIT, recorded rather than hidden: production's orchestrator is
 * `gpt-5.6-sol` via the Codex provider, which is exactly what cannot be used
 * here. Evals therefore measure harness effects on OpenRouter models. That is a
 * real gap between what is measured and what is run — it is printed on every
 * report so a reader cannot mistake one for the other.
 *
 * Everything foldable lives in `metrics.ts`/`report.ts` and is unit-tested.
 * This file is the part that cannot be: docker, the filesystem, and argv.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinnedPiVersion } from "../../extensions/hive-common/piVersion.ts";
import { parseRun } from "./metrics.ts";
import { compare, compareEfficiency, renderSummary, summarise, type Trial } from "./report.ts";
import { loadCorpus, selectTasks, type Task } from "./task.ts";

/** The image the workstation's pi is pinned to. Same family as hive-pi CI. */
const IMAGE = "node:22.19.0";
/**
 * The pin from package.json, printed on every report and installed in every
 * container. Read rather than restated: the comment here used to promise it was
 * "kept in step with package.json's pi dependency" by hand, which is the same
 * promise hive-telemetry's copy broke for two releases (HIV-1627). An eval whose
 * arms disagree about which pi they ran is not a measurement.
 */
const PI_VERSION = pinnedPiVersion();
const DEFAULT_MODEL = "openrouter/deepseek/deepseek-v4-flash";
/** A sweep aborts rather than quietly spending past this. */
const DEFAULT_MAX_COST_USD = 5;

/** The repo root, mounted into the container so the harness under test is present. */
const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * hive-pi's own git SHA, stamped on every report.
 *
 * The moment arms can differ by repo CONTENT rather than only by model, "arm:
 * baseline" stops identifying anything on its own — the same label a commit
 * later is a different measurement. `-dirty` matters more than the SHA: an arm
 * measured against uncommitted edits is not reproducible by anyone, including
 * the person who ran it, and that has to be visible in the artefact rather than
 * remembered.
 */
/**
 * Whether two artefacts are COMPARABLE — deliberately not the same question as
 * whether they are identical.
 *
 * Three states, not two. A run predating HIV-1629 carries no `harness` key at
 * all, and that is **not** the same as `enabled: false` — it is *unknown*.
 * Collapsing it to false would state as fact something nobody recorded, on the
 * exact axis the comparison is trying to control for; collapsing it to true
 * would be worse.
 *
 * The REVISION is deliberately excluded. Comparability is about whether the
 * harness was present at all; two arms that differ by revision are the normal,
 * intended experiment — that IS the harness change being measured.
 */
export function harnessMode(harness?: { enabled: boolean; revision: string | null }): "unknown" | "none" | "installed" {
	if (harness === undefined) return "unknown";
	return harness.enabled ? "installed" : "none";
}

/** The full human-readable identity, revision included — for context lines, never for the confound check. */
export function harnessLabel(harness?: { enabled: boolean; revision: string | null }): string {
	if (harness === undefined) return "unknown (predates HIV-1629)";
	return harness.enabled ? `hive-pi @ ${harness.revision}` : "none (bare pi)";
}

export function harnessRevision(): string {
	const run = (args: string[]) => spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).stdout?.trim() ?? "";
	const sha = run(["rev-parse", "--short", "HEAD"]);
	if (!sha) return "unknown";
	return run(["status", "--porcelain"]) ? `${sha}-dirty` : sha;
}

export function assertOpenRouterModel(model: string): void {
	if (!model.startsWith("openrouter/")) {
		throw new Error(
			`refusing to run evals on "${model}". Unattended runs must use the OpenRouter API key — a subscription ` +
				`OAuth credential is for interactive use, and a batch of trials is not. Pass an openrouter/* model.`,
		);
	}
}

export function resolveOpenRouterKey(): string {
	const direct = process.env.OPENROUTER_API_KEY?.trim();
	if (direct) return direct;
	// The workstation stores it as a resolver command rather than a literal, so
	// the key is never at rest in a config file. Same command pi itself runs.
	const res = spawnSync("bash", ["-lc", 'set -a; source "$HOME/.secrets"; set +a; printf %s "$OPENROUTER_API_KEY"'], {
		encoding: "utf8",
	});
	const key = (res.stdout ?? "").trim();
	if (!key) throw new Error("no OPENROUTER_API_KEY in the environment and none resolvable from ~/.secrets");
	return key;
}

export interface RunOptions {
	model: string;
	arm: string;
	env: Record<string, string>;
	reps: number;
	includeTest: boolean;
	only: string[];
	maxCostUsd: number;
	/**
	 * Whether hive-pi itself is installed in the container.
	 *
	 * DEFAULT ON, and `--no-harness` is the explicit opt-out. Off was the only
	 * behaviour until HIV-1629 and it silently made every harness A/B a
	 * no-op — so the safe default is the one where a harness change is actually
	 * in the measured surface, and measuring bare pi is the thing you have to ask
	 * for by name.
	 */
	harness: boolean;
	/**
	 * A context file (`AGENTS.md`) written into the task's working directory.
	 *
	 * The second half of "harness content", and the half `pi install` does not
	 * carry: per `workstation/README.md`, pi has no package resource type for the
	 * system context file — it is read from `~/.pi/agent/` and the cwd, and
	 * nowhere else. pi's own resolver takes `AGENTS.md` from the working
	 * directory (`core/resource-loader.js`), and the working directory in a trial
	 * IS the fixture — so this is the lever that makes "a PR touching AGENTS.md"
	 * measurable, which is exactly what HIV-1629 asks for and what nothing could
	 * do before.
	 */
	contextFile: string | null;
}

/**
 * The shell run inside the container for one trial.
 *
 * Built as a string on purpose — it is a container entrypoint, not a command
 * assembled from user input, and every interpolation below is either a repo
 * constant or a task field that the corpus loader has already validated.
 */
export function containerScript(task: Task, model: string, harness: boolean): string {
	const tools = task.tools?.length ? ` --tools ${task.tools.join(",")}` : "";
	// THE CONTAINER BOUNDS ITSELF. `spawnSync`'s `timeout` cannot do it.
	//
	// spawnSync kills the docker CLI on timeout, but the container inherits the
	// stdout pipe — so spawnSync does not RETURN until the container exits, and
	// the container is precisely what is stuck. The runner then blocks forever on
	// a call it believes has a deadline, and the reap that would free it lives
	// after the call that never returns. Measured: a trial sat 57 minutes past a
	// 6-minute timeout, and the sweep only resumed when the container was killed
	// by hand from outside.
	//
	// `timeout -k` inside the container is the only bound that does not depend on
	// the thing being bounded. Slightly under the host deadline so the container
	// dies first and the host timeout stays a backstop rather than the mechanism.
	const innerSeconds = Math.max(30, Math.floor(task.timeoutMs / 1000) - 20);
	return [
		"set -o pipefail",
		`npm i -g @earendil-works/pi-coding-agent@${PI_VERSION} >/dev/null 2>&1 || { echo '__EVAL_INSTALL_FAILED__'; exit 90; }`,
		// INSTALL THE HARNESS UNDER TEST.
		//
		// Without this the container holds bare pi and the task fixture, and
		// NOTHING of hive-pi is present — no extensions, no AGENTS.md, no skills.
		// Every `--env PI_HOUSE_*` arm was therefore inert: the variable arrived,
		// and the extension that would read it was not installed. Two arms
		// differing only by a harness change produced identical containers, so
		// `compare()` returned `inconclusive` by construction — which reads as
		// "no regression" rather than "not measured" (HIV-1629).
		//
		// A failure here is fatal rather than a warning. An eval that silently
		// measures bare pi while its report says "harness" is worse than no eval.
		harness ? "pi install /hive-pi >/dev/null 2>&1 || { echo '__EVAL_HARNESS_FAILED__'; exit 91; }" : "",
		"cd /work",
		// stdout is the event stream the runner parses; the grader's own output is
		// kept out of it so a chatty grader cannot be mistaken for agent events.
		`timeout -k 10 ${innerSeconds} pi -p --mode json --no-session --model ${model}${tools} "$(cat /eval/prompt.txt)" > /eval/events.jsonl 2>/eval/stderr.txt; __rc=$?`,
		// `timeout` exits 124 when it fires. SAY SO, rather than letting the grader
		// run on a half-finished workspace: that would score an infrastructure
		// timeout as a task FAILURE, and a harness change that merely slowed
		// things down would then read as one that broke correctness.
		'[ "$__rc" = "124" ] && echo __EVAL_AGENT_TIMEOUT__',
		"echo __EVAL_AGENT_DONE__",
		"bash /eval/grade.sh >/eval/grade.log 2>&1; echo \"__EVAL_GRADE__$?\"",
		// The container runs as root (npm -g needs it), so everything it wrote is
		// root-owned. Without this the host cannot delete its own temp dir, and the
		// runner dies in `finally` AFTER a paid trial has already succeeded.
		'chown -R "${EVAL_UID:-0}:${EVAL_GID:-0}" /eval /work 2>/dev/null || true',
		"cat /eval/events.jsonl",
	]
		.filter(Boolean)
		.join("\n");
}

export function runTrial(task: Task, options: RunOptions): Trial {
	const stage = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
	const started = Date.now();
	try {
		cpSync(join(task.dir, "fixture"), join(stage, "work"), { recursive: true });
		cpSync(join(task.dir, "grade.sh"), join(stage, "grade.sh"));
		writeFileSync(join(stage, "prompt.txt"), task.prompt, "utf8");
		// Into /work, because that is pi's cwd in the container and where its
		// resolver looks. Copied per trial rather than mounted: a task fixture that
		// ships its own AGENTS.md would otherwise silently win or lose depending on
		// mount order, and this must be the one that decides.
		if (options.contextFile) cpSync(options.contextFile, join(stage, "work", "AGENTS.md"));

		// NAMED so the container can be killed when the client is.
		//
		// `spawnSync`'s timeout kills the docker CLI, not the container it started.
		// A trial that hit `task.timeoutMs` therefore left a container running
		// forever: still burning CPU, still calling OpenRouter on our key, and
		// stealing cores from every subsequent trial in the sweep — so it corrupts
		// the very numbers the timeout exists to protect. Observed live at 43
		// minutes past its own deadline, on 100% of a core, during the HIV-1629
		// control run.
		const containerName = `eval-${task.id}-${process.pid}-${started}`;
		const args = [
			"run",
			"--rm",
			"--name",
			containerName,
			"--network",
			"bridge",
			"-v",
			`${join(stage, "work")}:/work`,
			"-v",
			`${stage}:/eval`,
			"-e",
			`OPENROUTER_API_KEY=${resolveOpenRouterKey()}`,
			"-e",
			`EVAL_UID=${process.getuid?.() ?? 0}`,
			"-e",
			`EVAL_GID=${process.getgid?.() ?? 0}`,
		];
		// Read-only: the harness is the thing being MEASURED, and a trial that can
		// edit it is not a trial of it. `pi install` copies what it needs, so ro is
		// sufficient — verified in-container before this was written.
		if (options.harness) args.push("-v", `${REPO_ROOT}:/hive-pi:ro`);
		for (const [key, value] of Object.entries(options.env)) args.push("-e", `${key}=${value}`);
		args.push(IMAGE, "bash", "-lc", containerScript(task, options.model, options.harness));

		const res = spawnSync("docker", args, { encoding: "utf8", timeout: task.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
		const stdout = res.stdout ?? "";
		const wallMs = Date.now() - started;

		// Unconditional, not only on timeout: `maxBuffer` overflow and a killed
		// parent orphan the container the same way, and `docker kill` on an
		// already-gone container is a no-op that costs a few milliseconds. Best
		// effort by design — failing to reap must never fail an otherwise good
		// trial, but it must also never be silent about a container it could not
		// reach, or this bug returns wearing a different hat.
		if (res.error || res.signal) {
			const reap = spawnSync("docker", ["kill", containerName], { encoding: "utf8" });
			if (reap.status !== 0 && !(reap.stderr ?? "").includes("No such container")) {
				console.error(`  WARNING: could not reap container ${containerName} — it may still be running and spending.`);
			}
		}

		const harnessFailed = stdout.includes("__EVAL_HARNESS_FAILED__");
		if (res.error || stdout.includes("__EVAL_INSTALL_FAILED__") || harnessFailed) {
			return {
				taskId: task.id,
				arm: options.arm,
				passed: false,
				exitCode: -1,
				metrics: parseRun(stdout),
				wallMs,
				// Errored, never "failed": a harness that did not install is
				// infrastructure noise, and letting it count as a task failure would
				// make a broken mount look exactly like a harness regression — the
				// one confusion this whole change exists to remove.
				error: res.error
					? `container: ${res.error.message}`
					: harnessFailed
						? "hive-pi failed to install inside the container — the harness under test was NOT present"
						: "pi install failed inside the container",
			};
		}

		if (stdout.includes("__EVAL_AGENT_TIMEOUT__")) {
			return {
				taskId: task.id,
				arm: options.arm,
				passed: false,
				exitCode: -1,
				metrics: parseRun(stdout),
				wallMs,
				error: `agent exceeded its ${Math.round(task.timeoutMs / 1000)}s budget — no verdict`,
			};
		}

		const graded = /__EVAL_GRADE__(\d+)/.exec(stdout);
		if (!graded) {
			// No grader verdict means the trial did not complete — a timeout, or the
			// agent never settled. Recorded as errored, NOT as a failure: counting
			// it as a failure would let infrastructure noise read as a regression.
			return {
				taskId: task.id,
				arm: options.arm,
				passed: false,
				exitCode: -1,
				metrics: parseRun(stdout),
				wallMs,
				error: `no grader verdict (timeout at ${task.timeoutMs}ms, or the agent never settled)`,
			};
		}
		const exitCode = Number(graded[1]);
		return { taskId: task.id, arm: options.arm, passed: exitCode === 0, exitCode, metrics: parseRun(stdout), wallMs };
	} finally {
		// NEVER FATAL. `force: true` covers a missing path, not `EACCES`.
		//
		// The container runs as root and the in-container `chown` is what hands the
		// staged files back to the host — so any container that dies before
		// reaching it (killed, OOM, timeout) leaves a root-owned directory the
		// host cannot delete. An uncaught throw HERE killed a sweep outright,
		// mid-arm, after ~25 paid trials had already succeeded and while their
		// results existed only in memory. Losing measured data to a failed
		// `rm /tmp/...` is the worst possible trade.
		try {
			rmSync(stage, { recursive: true, force: true });
		} catch (err) {
			console.error(`  WARNING: could not remove ${stage} (${(err as Error).message}) — root-owned leftovers from a killed container.`);
		}
	}
}

export function parseArgs(argv: readonly string[]): RunOptions {
	const options: RunOptions = {
		model: DEFAULT_MODEL,
		arm: "baseline",
		env: {},
		reps: 3,
		includeTest: false,
		only: [],
		maxCostUsd: DEFAULT_MAX_COST_USD,
		harness: true,
		contextFile: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--model") options.model = value ?? options.model, i++;
		else if (flag === "--arm") options.arm = value ?? options.arm, i++;
		else if (flag === "--reps") options.reps = Math.max(1, Number(value) || 1), i++;
		else if (flag === "--only") options.only.push(...(value ?? "").split(",").filter(Boolean)), i++;
		else if (flag === "--max-cost") options.maxCostUsd = Number(value) || DEFAULT_MAX_COST_USD, i++;
		else if (flag === "--test") options.includeTest = true;
		else if (flag === "--no-harness") options.harness = false;
		else if (flag === "--context") (options.contextFile = value ?? null), i++;
		else if (flag === "--env") {
			const [key, ...rest] = (value ?? "").split("=");
			if (key) options.env[key] = rest.join("=");
			i++;
		}
	}
	return options;
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	assertOpenRouterModel(options.model);

	const corpus = loadCorpus(join(import.meta.dirname, "..", "tasks"));
	const tasks = selectTasks(corpus, { includeTest: options.includeTest, only: options.only });
	if (tasks.length === 0) {
		console.error("no tasks selected. The held-out split needs --test; check --only spelling.");
		process.exit(1);
	}

	console.log(
		`eval: ${tasks.length} task(s) x ${options.reps} rep(s) = ${tasks.length * options.reps} trials\n` +
			`  model ${options.model} · pi ${PI_VERSION} · image ${IMAGE} · arm "${options.arm}"\n` +
			`  harness ${options.harness ? `hive-pi @ ${harnessRevision()}` : "NONE — bare pi, harness changes are NOT measured"}\n` +
			`  ${options.includeTest ? "INCLUDING THE HELD-OUT SPLIT — this is a milestone measurement" : "dev split only"}\n` +
			`  NOTE: production's orchestrator (gpt-5.6-sol) is Codex-only and cannot be measured here.\n`,
	);

	const trials: Trial[] = [];
	let spent = 0;
	for (const task of tasks) {
		for (let rep = 0; rep < options.reps; rep++) {
			if (spent >= options.maxCostUsd) {
				console.error(`\nABORTING: spent $${spent.toFixed(4)}, at the --max-cost ceiling of $${options.maxCostUsd}.`);
				break;
			}
			const trial = runTrial(task, options);
			trials.push(trial);
			spent += trial.metrics.costUsd;
			const mark = trial.error ? "ERR " : trial.passed ? "PASS" : "FAIL";
			console.log(
				`  ${mark}  ${task.id} #${rep + 1}  ${trial.metrics.turns}t ${trial.metrics.toolCalls}tc ` +
					`${trial.metrics.totalTokens.toLocaleString()}tok $${trial.metrics.costUsd.toFixed(4)} ` +
					`${(trial.wallMs / 1000).toFixed(1)}s${trial.error ? `  (${trial.error})` : ""}`,
			);
		}
	}

	const summary = summarise(trials, options.arm);
	console.log(`\n${renderSummary(summary)}`);
	// The revision goes in the ARTEFACT, not only in the console line above: the
	// console scrolls away and the JSON is what a comparison is run against a week
	// later. Without it "baseline" identifies nothing once arms can differ by repo
	// content.
	const harness = { enabled: options.harness, revision: options.harness ? harnessRevision() : null };
	writeFileSync(
		join(process.cwd(), `eval-${options.arm}.json`),
		JSON.stringify({ options, harness, trials, summary }, null, 2),
	);
	console.log(`\nwrote eval-${options.arm}.json — compare two arms with: npm run eval:compare -- a.json b.json`);
}

function compareMain(): void {
	const [basePath, candPath] = process.argv.slice(2);
	if (!basePath || !candPath) {
		console.error("usage: npm run eval:compare -- <baseline.json> <candidate.json>");
		process.exit(1);
	}
	// `readFileSync`, not `require("node:fs")` — this file is ESM, so the original
	// threw `ReferenceError: require is not defined in ES module scope` on every
	// invocation. `npm run eval:compare` had therefore NEVER produced a verdict
	// from the CLI: `compare()` is well unit-tested, and the one path that puts a
	// number in front of a human crashed before reading its first file.
	const read = (path: string) =>
		JSON.parse(readFileSync(path, "utf8")) as {
			trials: Trial[];
			options: RunOptions;
			harness?: { enabled: boolean; revision: string | null };
		};
	const base = read(basePath);
	const cand = read(candPath);

	// PROVENANCE, always — this is context, and differing revisions are the
	// normal case: a harness A/B is two revisions by definition.
	console.log(`harness: baseline ${harnessLabel(base.harness)} · candidate ${harnessLabel(cand.harness)}\n`);

	// CONFOUND CHECK, on comparability ONLY.
	//
	// Gated on `harnessMode`, not on the full label. Warning whenever the
	// REVISIONS differ would fire on every legitimate harness A/B — the case this
	// tooling exists to serve — and its advice ("re-run one side") would destroy
	// the experiment rather than protect it. A check that cries wolf on the happy
	// path is worse than no check: it trains the reader to skip the banner that
	// matters. What is genuinely not comparable is a harness-present arm against
	// a bare-pi one, or against an arm whose harness state nobody recorded.
	if (harnessMode(base.harness) !== harnessMode(cand.harness)) {
		console.log(
			`⚠ NOT COMPARABLE — baseline harness is "${harnessMode(base.harness)}", candidate is "${harnessMode(cand.harness)}".`,
		);
		console.log("  Any delta below confounds the harness's PRESENCE with whatever the arm is named for. Re-run one side.\n");
	}

	const result = compare(summarise(base.trials, base.options.arm), summarise(cand.trials, cand.options.arm));
	console.log(`${renderSummary(result.baseline)}\n\n${renderSummary(result.candidate)}\n`);
	console.log(`PASS RATE: ${result.verdict.toUpperCase()}\n  ${result.reason}`);
	// Once pass rate saturates — which it does on the current corpus — this is
	// where the remaining signal lives, and the method counts a cost/turn
	// regression at equal pass rate as a real regression.
	for (const metric of ["turns", "tokens", "cost"] as const) {
		const efficiency = compareEfficiency(base.trials, cand.trials, metric);
		console.log(
			`${metric.toUpperCase().padEnd(7)}: ${efficiency.verdict.toUpperCase()} — ` +
				`${efficiency.baselineMean.toFixed(metric === "cost" ? 4 : 1)} → ${efficiency.candidateMean.toFixed(metric === "cost" ? 4 : 1)}\n  ${efficiency.reason}`,
		);
	}
}

/**
 * Only run when this file IS the program.
 *
 * Without this guard, `import { parseArgs } from "./run.ts"` executes `main()`.
 * That is not theoretical: the first version of the unit suite imported this
 * module, and the import spawned live containers and spent real money before
 * a single assertion ran. A CLI that executes on import is a landmine for every
 * future test and every future importer.
 */
function isEntryPoint(): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	if (process.env.EVAL_MODE === "compare") compareMain();
	else main();
}
