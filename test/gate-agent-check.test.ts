/**
 * quality_gate → the repo's `scripts/agent-check` (HIV-3818).
 *
 * Written against the CONTRACT, with fixture scripts standing in for a repo's
 * agent check: executable; exit 0 only if every step that ran passed; final
 * line `AGENT-CHECK: PASS|FAIL ran=… failed=… skipped=…`; `--no-tests` /
 * `--no-install`. The tool is driven end to end through its registration, the
 * way the agent calls it.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { contradiction, foldSummary, parseSummary } from "../extensions/gate/agentcheck.ts";
import { emptyProgress } from "../extensions/gate/stream.ts";
import type { GateProgress } from "../extensions/gate/stream.ts";

type Result = { content: Array<{ text: string }>; details: { hive_widget: { spec: GateProgress } } };
type Tool = {
	name: string;
	execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<Result>;
};

/** Calls to the buffered fallback — a streamed run must never reach it. */
let execCalls = 0;

async function gateTool(): Promise<Tool> {
	const tools = new Map<string, Tool>();
	const fakePi = {
		registerTool: (t: Tool) => tools.set(t.name, t),
		events: { emit: () => {} },
		exec: async () => {
			execCalls++;
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	const mod = await import("../extensions/gate/index.ts");
	(mod.default as unknown as (pi: typeof fakePi) => void)(fakePi);
	const tool = tools.get("quality_gate");
	if (!tool) throw new Error("quality_gate did not register");
	return tool;
}

async function executable(path: string, body: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
}

/** A git repository — discovery is bounded by the repo root. */
async function gitDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	execFileSync("git", ["init", "-q", dir]);
	return dir;
}

/** A repo with an agent check (and, optionally, a vendored gate beside it). */
async function repo(agentCheck: string, opts: { vendoredGate?: boolean } = {}): Promise<string> {
	const dir = await gitDir("agent-check-");
	await executable(join(dir, "scripts", "agent-check"), agentCheck);
	if (opts.vendoredGate) {
		await executable(
			join(dir, "vendor", "quality-gate", "quality-gate"),
			'echo "vendored gate ran: $*"\nprintf \'{\\n"passed": true, "checks": [{"name": "ruff", "status": "pass"}]}\\n\'',
		);
	}
	return dir;
}

async function call(dir: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Result> {
	const tool = await gateTool();
	return await tool.execute("t", { cwd: dir, ...params }, signal, undefined, { cwd: dir });
}

const text = (r: Result) => r.content[0].text;
const spec = (r: Result) => r.details.hive_widget.spec;

describe("parseSummary — the contract's final line, and only the final line", () => {
	it("reads step lists, with - for none", () => {
		expect(parseSummary("x\nAGENT-CHECK: FAIL ran=deps,gate,tests failed=tests skipped=-\r\n\n")).toEqual({
			verdict: "FAIL",
			ran: ["deps", "gate", "tests"],
			failed: ["tests"],
			skipped: [],
		});
	});

	it("does not accept a summary that is not the last line", () => {
		expect(parseSummary("AGENT-CHECK: PASS ran=gate failed=- skipped=-\nTraceback: boom\n")).toBeNull();
	});

	it("counts a failed step as run even when ran= forgets it — an explicit failure is never dropped", () => {
		expect(parseSummary("AGENT-CHECK: FAIL ran=- failed=scope skipped=-")).toMatchObject({ ran: ["scope"], failed: ["scope"] });
	});

	it("gives a killed run no verdict on the card, even after a FAIL summary", () => {
		const summary = parseSummary("AGENT-CHECK: FAIL ran=a failed=a skipped=-");
		expect(foldSummary(emptyProgress("verify", "x"), summary, { exitCode: null, signal: "SIGTERM" }).status).toBe("nosummary");
	});

	it("flags a summary that contradicts itself or its exit code", () => {
		const pass = { verdict: "PASS" as const, ran: ["gate"], failed: [], skipped: [] };
		expect(contradiction(pass, 0)).toBeNull();
		expect(contradiction(pass, 1)).toMatch(/says PASS but exited 1/);
		expect(contradiction({ ...pass, verdict: "FAIL" }, 1)).toMatch(/names no failed step/);
		expect(contradiction({ ...pass, skipped: ["gate"] }, 0)).toMatch(/both run and skipped \(gate\)/);
	});
});

describe("quality_gate runs the repo's agent check by default", () => {
	it("reports a pass, with every skipped step NOT RUN rather than passed", async () => {
		const dir = await repo('echo "[agent-check] ok gate"\necho "AGENT-CHECK: PASS ran=deps,gate,typecheck failed=- skipped=tests"\nexit 0');
		const result = await call(dir);
		expect(text(result)).toMatch(/^PASS — 3 step\(s\) in [\d.]+s: deps, gate, typecheck/);
		expect(text(result)).toContain("not run: tests — these steps made no claim about this code");
		expect(spec(result)).toMatchObject({
			status: "pass",
			mode: "verify",
			total: 4,
			failures: [],
			missing_tools: [{ tool: "tests", reason: "not run" }],
		});
		expect(spec(result).checks.map((c) => [c.name, c.outcome])).toEqual([
			["deps", "passed"],
			["gate", "passed"],
			["typecheck", "passed"],
			["tests", "advisory"],
		]);
	});

	it("passes --no-tests and --no-install through", async () => {
		const dir = await repo('echo "args: $*"\necho "AGENT-CHECK: PASS ran=gate failed=- skipped=tests,deps"');
		const result = await call(dir, { tests: false, install: false });
		expect(text(result)).toContain("args: --no-tests --no-install");
	});

	it("reports a failure with the failed and passed steps, keeping the END of long output", async () => {
		const dir = await repo(
			'i=1; while [ $i -le 500 ]; do echo "log line $i"; i=$((i+1)); done\n' +
				'echo "FAILED tests/test_x.py::test_y - assert 1 == 2"\n' +
				'echo "AGENT-CHECK: FAIL ran=gate,tests failed=tests skipped=-"\nexit 1',
		);
		const result = await call(dir);
		expect(text(result)).toMatch(/^FAIL — 1 of 2 step\(s\)/);
		expect(text(result)).toContain("failed: tests");
		expect(text(result)).toContain("passed: gate");
		expect(text(result)).toContain("earlier line(s) omitted");
		expect(text(result)).toContain("FAILED tests/test_x.py::test_y - assert 1 == 2");
		expect(text(result)).not.toContain("log line 1\n");
		expect(spec(result)).toMatchObject({ status: "fail", failures: ["tests"], exit_code: 1 });
	});

	it("reports a usage/merge-base failure (exit 2) as the FAIL it is", async () => {
		// The exact line pyERP's agent check prints for an unresolvable merge base.
		const dir = await repo('echo "cannot resolve merge base" >&2\necho "AGENT-CHECK: FAIL ran=- failed=scope skipped=-"\nexit 2');
		const result = await call(dir);
		expect(text(result)).toContain("failed: scope");
		expect(text(result)).toContain("cannot resolve merge base");
	});

	it("says NO VERDICT when the summary line is missing", async () => {
		const dir = await repo('echo "Traceback (most recent call last):"\necho "KeyError: x"\nexit 1');
		const result = await call(dir);
		expect(text(result)).toMatch(/^NO VERDICT — `scripts\/agent-check` exited 1 .* without its `AGENT-CHECK:` summary line/);
		expect(text(result)).toContain("KeyError: x");
		expect(spec(result).status).toBe("nosummary");
	});

	it("says NO VERDICT when the summary contradicts the exit code", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"\nexit 1');
		const result = await call(dir);
		expect(text(result)).toContain("contradicted its own contract: it says PASS but exited 1");
		expect(spec(result).status).toBe("nosummary");
	});

	it("does not call a run in which nothing ran a pass", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=- failed=- skipped=gate,tests"');
		const result = await call(dir);
		expect(text(result)).toMatch(/^NOTHING CHECKED/);
		expect(text(result)).toContain("not run: gate, tests");
		expect(spec(result).status).toBe("nosummary");
	});

	it("names vendored-gate knobs it ignored under an explicit mode verify", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"');
		const result = await call(dir, { mode: "verify", scope: "staged", only: "ruff" });
		expect(text(result)).toContain("note: scope, only do not apply to the repo's agent check");
	});

	it("speaks no quality-gate protocol to the script, and folds none from it", async () => {
		const dir = await repo(
			'echo "QG=${QG_SUBSTEPS:-unset}"\n' +
				'echo \'##hive:substep {"phase":"end","name":"ruff","outcome":"failed"}\'\n' +
				'echo "AGENT-CHECK: PASS ran=gate failed=- skipped=tests"',
		);
		const result = await call(dir);
		expect(text(result)).toContain("QG=unset");
		expect(spec(result).checks.map((c) => c.name)).toEqual(["gate", "tests"]);
	});

	it("reads the verdict from stdout even when stderr output lands after it", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"\nsleep 0.2\necho "late warning" >&2');
		const result = await call(dir);
		expect(text(result)).toMatch(/^PASS — 1 step/);
		expect(text(result)).not.toContain("AGENT-CHECK:");
	});

	it("does not run an agent check from an ENCLOSING repository", async () => {
		const outer = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"');
		const inner = join(outer, "nested");
		await mkdir(inner);
		execFileSync("git", ["init", "-q", inner]);
		const result = await call(inner, { mode: "verify" });
		expect(text(result)).toContain("there is none");
	});

	it("is terminated, not passed, when the call is aborted", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"\nsleep 30');
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const result = await call(dir, {}, controller.signal);
		expect(text(result)).toMatch(/^NO VERDICT — `scripts\/agent-check` was terminated/);
		expect(spec(result).status).toBe("nosummary");
	}, 15_000);

	it("settles an aborted call promptly even when a detached child holds the pipes", async () => {
		const dir = await repo("setsid sleep 8 &\nsleep 30");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const started = Date.now();
		const result = await call(dir, {}, controller.signal);
		expect(Date.now() - started).toBeLessThan(6_000);
		expect(text(result)).toMatch(/^NO VERDICT/);
	}, 20_000);
});

describe("the vendored gate stays reachable", () => {
	it("runs the vendored gate for mode quick, even with an agent check present", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"', { vendoredGate: true });
		const result = await call(dir, { mode: "quick" });
		expect(text(result)).toMatch(/^PASS — 1 check\(s\)/);
		expect(spec(result).mode).toBe("quick");
	});

	it("runs the vendored gate when any of its knobs is used (only, skip, scope, stopEarly)", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"', { vendoredGate: true });
		for (const knob of [{ only: "ruff" }, { skip: "gitleaks" }, { scope: "all" }, { stopEarly: true }]) {
			expect(spec(await call(dir, knob)).mode).toBe("quick");
		}
	});

	it("says when tests/install were ignored by the vendored gate", async () => {
		const dir = await repo('echo "AGENT-CHECK: PASS ran=gate failed=- skipped=-"', { vendoredGate: true });
		expect(text(await call(dir, { mode: "quick", tests: false }))).toContain('note: tests apply only to mode "verify"');
	});

	it("an aborted vendored gate is terminated once, not re-run through the buffered fallback", async () => {
		const dir = await gitDir("abort-gate-");
		await executable(join(dir, "vendor", "quality-gate", "quality-gate"), `echo run >> "${dir}/runs"\nsleep 30`);
		const controller = new AbortController();
		execCalls = 0;
		const pending = call(dir, { mode: "quick" }, controller.signal);
		// Abort once the gate has demonstrably started, not after a fixed 300ms:
		// on macOS the spawn had not reached its first line by then, so `runs`
		// never existed and the run-once assertion below had nothing to read.
		const deadline = Date.now() + 10_000;
		while (!existsSync(join(dir, "runs")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		controller.abort();
		const result = await pending;
		expect(execCalls).toBe(0);
		expect(text(result)).toMatch(/^NO VERDICT — the gate was terminated/);
		expect(await readFile(join(dir, "runs"), "utf8")).toBe("run\n");
	}, 15_000);

	it("refuses mode verify where the repo declares no agent check, saying what to use instead", async () => {
		const dir = await gitDir("no-agent-check-");
		const result = await call(dir, { mode: "verify" });
		expect(text(result)).toContain('mode "verify" runs the repo\'s own `scripts/agent-check`, and there is none');
	});
});
