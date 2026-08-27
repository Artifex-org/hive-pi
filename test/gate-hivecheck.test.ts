import { describe, expect, it } from "vitest";
import {
	deckLines,
	deckSummary,
	fold,
	type HiveSubstep,
	type HiveTask,
	hiveCheckArgs,
	isTerminalRun,
	parseRunRef,
	renderReport,
	stepsFrom,
} from "../extensions/gate/hivecheck.ts";
import { hivePipelineDir, resolveCheckAuth, tailLines } from "../extensions/gate/hiverun.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI's actual output, copied from cmd/hive/check.go's own printf rather
 * than paraphrased — the whole value of this parser is that it reads what is
 * really written.
 */
const CLI_OUT = [
	"3 changed file(s) vs base",
	"running only: lint (+ deps)",
	"packed 214 files (1.2 MB), uploading…",
	"run #2481 started on your working tree (base 6f1aa065)",
	"http://198.51.100.10:31895/runs/6f1aa065-102d-42d2-b769-98d69691c380",
].join("\n");

const REF = { id: "6f1aa065-102d-42d2-b769-98d69691c380", number: 2481, url: "http://h/runs/6f1aa065-102d-42d2-b769-98d69691c380" };

function task(key: string, state: string, extra: Partial<HiveTask> = {}): HiveTask {
	return { key, state, id: `id-${key}`, ...extra };
}

function substep(taskKey: string, name: string, outcome: string, extra: Partial<HiveSubstep> = {}): HiveSubstep {
	return { task_key: taskKey, name, outcome, ...extra };
}

describe("stepsFrom", () => {
	it("defaults to lint — the fast, always-relevant step", () => {
		expect(stepsFrom(undefined)).toEqual(["lint"]);
		expect(stepsFrom("  ")).toEqual(["lint"]);
	});

	it("takes the caller's steps, trimmed", () => {
		expect(stepsFrom("lint, test-1 ,web-check")).toEqual(["lint", "test-1", "web-check"]);
	});
});

describe("hiveCheckArgs", () => {
	// --no-wait is load-bearing: the CLI's own wait loop and ours would be two
	// consumers of one run, and only one of them can own the abort.
	it("asks for the steps and declines the CLI's wait loop", () => {
		expect(hiveCheckArgs(["lint", "test-1"])).toEqual(["check", "--step", "lint,test-1", "--no-wait"]);
	});
});

describe("parseRunRef", () => {
	it("reads the id, the number and the link out of the CLI's own lines", () => {
		expect(parseRunRef(CLI_OUT)).toEqual({
			id: "6f1aa065-102d-42d2-b769-98d69691c380",
			number: 2481,
			url: "http://198.51.100.10:31895/runs/6f1aa065-102d-42d2-b769-98d69691c380",
		});
	});

	// A refusal creates no run, and the caller must print the CLI's words rather
	// than a parse error — so "nothing here" has to be distinguishable.
	it("returns null when the CLI created no run", () => {
		expect(
			parseRunRef('refusing to dispatch the whole pipeline: pass --step to run individual steps'),
		).toBeNull();
	});

	// MEASURED against the live server, and the reason a bare-UUID fallback was
	// removed: a rejected dispatch answers with problem+json carrying a
	// `request_id` UUID. Adopting that as a run id made the tool poll a run that
	// does not exist — it never reaches a terminal state, so a refusal that
	// should be instant sat at "running" until the 45-minute ceiling.
	it("does not mistake a rejection's request_id for a run", () => {
		const rejected = [
			"packed 3560 files (7.4 MB), uploading…",
			"5 changed file(s) vs base",
			"running only: lint (+ deps)",
			'hive: POST /api/v1/runs: 400 Bad Request: {"type":"https://hive.dev/errors/bad_request",' +
				'"code":"bad_request","title":"Bad Request","status":400,"detail":"unknown step \\"lint\\"; ' +
				'available steps: file-length, loc, web-check","request_id":"ede6a0c9-cb8e-4f3e-a7b5-478d71183e92",' +
				'"retryable":false}',
		].join("\n");
		expect(parseRunRef(rejected)).toBeNull();
	});
});

describe("fold", () => {
	const base = { steps: ["lint"], ref: REF };

	it("counts STEPS in the meter and lists CHECKS as rows", () => {
		const p = fold({
			...base,
			run: { state: "running" },
			tasks: [task("lint", "running"), task("test-1", "queued")],
			substeps: [substep("lint", "ruff", "passed", { duration_ms: 412 }), substep("lint", "mypy", "failed")],
		});
		expect(p.total).toBe(2);
		expect(p.done).toBe(0);
		expect(p.status).toBe("running");
		expect(p.running).toEqual(["lint"]);
		expect(p.checks).toEqual([
			{ name: "ruff", group: "lint", outcome: "passed", duration_ms: 412, message: undefined },
			{ name: "mypy", group: "lint", outcome: "failed", duration_ms: undefined, message: undefined },
		]);
		// Qualified by the step: forty rows from three shards are otherwise one
		// undifferentiated list.
		expect(p.failures).toEqual(["lint › mypy"]);
	});

	it("represents a step that reported no checks by itself, but only once it is over", () => {
		const running = fold({ ...base, run: { state: "running" }, tasks: [task("test-1", "running")], substeps: [] });
		expect(running.checks).toEqual([]);

		const done = fold({
			...base,
			run: { state: "succeeded" },
			tasks: [task("test-1", "succeeded", { started_at: "2026-08-15T10:00:00Z", finished_at: "2026-08-15T10:02:00Z" })],
			substeps: [],
		});
		expect(done.checks).toEqual([
			{ name: "test-1", group: "test-1", outcome: "passed", duration_ms: 120_000, message: undefined },
		]);
	});

	// The failure this whole widget family exists to prevent: a green row over a
	// check that never ran.
	it("calls a skipped step advisory, never passed", () => {
		const p = fold({ ...base, run: { state: "succeeded" }, tasks: [task("web-check", "skipped")], substeps: [] });
		expect(p.checks[0].outcome).toBe("advisory");
		expect(p.checks[0].message).toMatch(/made no claim/);
		expect(p.advisories).toEqual(["web-check"]);
	});

	// The emitters report a warning as outcome "passed" with the truth in the
	// message, because a red substep inside a green step reads as a broken UI.
	it("recovers an advisory from the message the emitter hides it in", () => {
		const p = fold({
			...base,
			run: { state: "succeeded" },
			tasks: [task("lint", "succeeded")],
			substeps: [substep("lint", "oxlint", "passed", { message: "advisory finding (non-blocking)" })],
		});
		expect(p.checks[0].outcome).toBe("advisory");
		expect(p.advisories).toEqual(["lint › oxlint"]);
		expect(p.failures).toEqual([]);
	});

	it("treats an outcome this build does not know as an error, not a pass", () => {
		const p = fold({
			...base,
			run: { state: "failed" },
			tasks: [task("lint", "failed")],
			substeps: [substep("lint", "future-check", "quarantined")],
		});
		expect(p.checks[0].outcome).toBe("error");
		expect(p.failures).toEqual(["lint › future-check"]);
	});

	// A cancelled run reached NO verdict. Drawing a red one would claim the code
	// was checked and found wanting; drawing a green one is worse.
	it("maps a canceled run to nosummary rather than fail", () => {
		const p = fold({ ...base, run: { state: "canceled" }, tasks: [task("lint", "canceled")], substeps: [] });
		expect(p.status).toBe("nosummary");
	});

	// MEASURED: a check sat behind a PR gate for 15 minutes reading
	// `running · 0/2` — a claim that work was happening on this code when the run
	// had not started at all.
	it("says queued, not running, while the run waits for a fleet slot", () => {
		const p = fold({ ...base, run: { state: "queued" }, tasks: [task("lint", "pending"), task("test-1", "pending")], substeps: [] });
		expect(p.status).toBe("running");
		expect(p.run_state).toBe("queued");
		expect(deckSummary(p)).toContain("queued");
		expect(renderReport(p)).toContain("QUEUED");
		expect(renderReport(p)).toContain("waiting for a fleet slot");
	});

	// MEASURED on run #3262: Hive marks a run `running` the moment it is
	// admitted, and its only task sat `ready` for eleven minutes. Reading the
	// run's own word would have called that "running" — work happening on this
	// code — so the tasks are what decide.
	it("still says queued when the RUN says running but no task has started", () => {
		const p = fold({ ...base, run: { state: "running" }, tasks: [task("loc", "ready")], substeps: [] });
		expect(deckSummary(p)).toContain("queued");
		expect(renderReport(p)).toContain("QUEUED");
	});

	it("stops saying queued the moment a step is on a node", () => {
		const p = fold({ ...base, run: { state: "running" }, tasks: [task("lint", "running")], substeps: [] });
		expect(deckSummary(p)).toContain("running");
		expect(renderReport(p)).toContain("STILL RUNNING");
	});

	it("reports no denominator before the tasks exist", () => {
		const p = fold({ ...base, run: { state: "queued" }, tasks: [], substeps: [] });
		expect(p.total).toBeUndefined();
		expect(p.status).toBe("running");
	});

	// The fold is a SNAPSHOT: a task retried after a node failure moves backwards,
	// and an accumulating fold would then show the same check twice with two
	// different verdicts.
	it("is a snapshot, so a retried step does not leave a stale row behind", () => {
		const first = fold({
			...base,
			run: { state: "running" },
			tasks: [task("lint", "failed")],
			substeps: [substep("lint", "ruff", "failed")],
		});
		expect(first.failures).toEqual(["lint › ruff"]);
		const second = fold({
			...base,
			run: { state: "succeeded" },
			tasks: [task("lint", "succeeded")],
			substeps: [substep("lint", "ruff", "passed")],
		});
		expect(second.failures).toEqual([]);
		expect(second.checks).toHaveLength(1);
	});

	it("carries the run link and never claims a missing tool it cannot know about", () => {
		const p = fold({ ...base, run: { state: "succeeded", number: 2481 }, tasks: [task("lint", "succeeded")], substeps: [] });
		expect(p.url).toBe(REF.url);
		expect(p.run_number).toBe(2481);
		expect(p.missing_tools).toEqual([]);
	});

	// The id, not just the number: run numbers are per-pipeline, so a client that
	// wants to FOLLOW this run (Hive's transcript card does, when the follow here
	// gave up mid-flight) cannot resolve `#2481` on its own.
	it("carries the run id a reader can follow the run with", () => {
		const p = fold({ ...base, run: { state: "running" }, tasks: [task("lint", "running")], substeps: [] });
		expect(p.run_id).toBe(REF.id);
	});
});

describe("renderReport", () => {
	const spec = (over: Partial<ReturnType<typeof fold>>) => ({
		...fold({ run: { state: "succeeded" }, tasks: [], substeps: [], steps: ["lint"], ref: REF }),
		...over,
	});

	it("states the verdict, the failing names and where to read the rest", () => {
		const text = renderReport(spec({ status: "fail", total: 2, done: 2, failures: ["lint › mypy"], duration_ms: 45_000 }));
		expect(text).toContain("FAIL — 1 failing of 2 step(s)");
		expect(text).toContain("failed: lint › mypy");
		expect(text).toContain(`run: ${REF.url}`);
	});

	// MEASURED on Aurora run #8984: 91 checks across 18 steps, 2 failing. The
	// first wording read "2 failing of 18 step(s), 91 check(s)", which says two
	// STEPS failed — a different fact, and the wrong one to act on.
	it("counts failures against checks, not steps, when the steps reported checks", () => {
		const text = renderReport(
			spec({
				status: "fail",
				total: 18,
				done: 18,
				checks: Array.from({ length: 91 }, (_, i) => ({ name: `c${i}`, group: "lint", outcome: "passed" as const })),
				failures: ["lint › basedpyright", "lint › Dead exports"],
			}),
		);
		expect(text).toContain("FAIL — 2 of 91 check(s) across 18 step(s)");
	});

	// One red step blocks every downstream one, so a real run listed fifteen
	// advisories all reading "blocked by failed dependency: lint".
	it("caps the name lists and says how many it held back", () => {
		const text = renderReport(spec({ status: "fail", advisories: Array.from({ length: 15 }, (_, i) => `step-${i}`) }));
		expect(text).toContain("(+5 more)");
		expect(text).toContain("step-9");
		expect(text).not.toContain("step-10,");
	});

	// "Canceled" must never read as a result. This is the sentence that stops an
	// agent concluding its code is clean because nothing was red.
	it("says a canceled run proved nothing", () => {
		const text = renderReport(spec({ status: "nosummary", total: 4, done: 1 }));
		expect(text).toContain("NO VERDICT");
		expect(text).toMatch(/Nothing here says this code is clean/);
	});

	it("appends the failing step's log tail when there is one", () => {
		const text = renderReport(spec({ status: "fail", failures: ["test-1"] }), { logs: [{ task: "test-1", tail: "FAIL x_test.go:12" }] });
		expect(text).toContain("── test-1 ──");
		expect(text).toContain("FAIL x_test.go:12");
	});
});

describe("deck", () => {
	it("summarises to one line and draws a meter with a real denominator", () => {
		const p = fold({
			run: { state: "running" },
			tasks: [task("lint", "succeeded"), task("test-1", "running")],
			substeps: [substep("lint", "ruff", "failed")],
			steps: ["lint", "test-1"],
			ref: REF,
		});
		// `running`, not `FAIL`: the run has reached no verdict. The ✗1 is the
		// already-landed red, which is the number worth interrupting for.
		expect(deckSummary(p)).toBe("gate lint,test-1 · 1/2 · running ✗1");
		const lines = deckLines(p);
		expect(lines[0]).toMatch(/^[▍░]{12} 1\/2$/);
		expect(lines).toContain("✗ lint › ruff");
		expect(lines).toContain("… test-1");
	});

	it("omits the meter rather than inventing a denominator", () => {
		const p = fold({ run: { state: "queued" }, tasks: [], substeps: [], steps: ["lint"], ref: REF });
		expect(deckLines(p)).toEqual([]);
	});
});

describe("isTerminalRun", () => {
	it("knows which states stop the follow", () => {
		expect(isTerminalRun("running")).toBe(false);
		expect(isTerminalRun("queued")).toBe(false);
		for (const s of ["succeeded", "failed", "canceled", "error", "timed_out"]) expect(isTerminalRun(s)).toBe(true);
	});
});

describe("hivePipelineDir", () => {
	it("finds the .hive of an ANCESTOR, not only of the cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "gate-hive-"));
		mkdirSync(join(root, ".hive"));
		mkdirSync(join(root, "internal", "api"), { recursive: true });
		expect(await hivePipelineDir(join(root, "internal", "api"))).toBe(`${root}/.hive`);
	});

	it("declines a directory with no pipeline anywhere above it", async () => {
		const root = mkdtempSync(join(tmpdir(), "gate-nohive-"));
		expect(await hivePipelineDir(root)).toBeNull();
	});
});

describe("resolveCheckAuth", () => {
	// The CLI we just spawned authenticated with these, so the run exists on THAT
	// server. Following a different one 404s a check that is running fine.
	it("prefers the environment the CLI itself used, and strips the trailing slash", () => {
		const prevURL = process.env.HIVE_URL;
		const prevToken = process.env.HIVE_TOKEN;
		try {
			process.env.HIVE_URL = "http://hive.example/";
			process.env.HIVE_TOKEN = "tok";
			expect(resolveCheckAuth()).toEqual({ url: "http://hive.example", token: "tok" });
		} finally {
			if (prevURL === undefined) delete process.env.HIVE_URL;
			else process.env.HIVE_URL = prevURL;
			if (prevToken === undefined) delete process.env.HIVE_TOKEN;
			else process.env.HIVE_TOKEN = prevToken;
		}
	});
});

describe("tailLines", () => {
	// The END, because a step prints its way to the failure — a head truncation
	// drops exactly the line being looked for.
	it("keeps the end and says how much it dropped", () => {
		const out = tailLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), 3);
		expect(out.split("\n")[0]).toContain("7 earlier line(s) omitted");
		expect(out).toContain("line 9");
		expect(out).not.toContain("line 5");
	});

	it("leaves a short log alone", () => {
		expect(tailLines("a\nb", 40)).toBe("a\nb");
	});
});
