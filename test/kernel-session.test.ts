/**
 * The kernel subprocess, running for real.
 *
 * These tests spawn actual interpreters, and that is the point: every claim this
 * feature makes is about what happens ACROSS the process boundary the pure fold
 * cannot see — that a variable survives a second tool call, that a provider key
 * does NOT survive the spawn, that an overrunning cell is interrupted without
 * losing the namespace, and that nothing is left running when the session ends.
 * A pure test cannot fail on any of those, and those are the ones that would
 * ship broken.
 *
 * The cells are `sum(range(10))` and `sleep`, so the suite costs about a second.
 *
 * WHY THE PYTHON PROBE IS NOT FATAL. `test/require-tools.ts` makes a missing
 * `git`/`bash` fail rather than skip under `PI_HOUSE_REQUIRE_TOOLS=1`, because a
 * skipped suite reads as a passing one. That reasoning applies here too, but the
 * CI image's promise covers git and bash only — making python fatal would red
 * every PR's gate on an image that never agreed to provide it. The honest
 * position is a local probe now and a note in the report that the image and
 * `require-tools.ts` should grow a `pythonAvailable()` (both are outside this
 * change's file set).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import { python3Available } from "./require-tools.ts";
import kernelExtension from "../extensions/kernel/index.ts";
import {
	CANCEL_GRACE_MS,
	Kernel,
	KernelPool,
	MANAGED_VENV,
	VERSION_PROBE,
	allowedEnv,
	installHint,
	kernelKey,
	resolveInterpreter,
	usablePython,
	type Interpreter,
} from "../extensions/kernel/session.ts";

const RUNNER = join(import.meta.dirname, "..", "extensions", "kernel", "runner.py");

// Shared with the other tool-gated suites (HIV-1238): on a developer machine
// without python3 these blocks skip, but wherever PI_HOUSE_REQUIRE_TOOLS=1 is
// set — which .hive/main.star sets on the test step — a missing interpreter
// THROWS instead of silently dropping every real-subprocess test here. A skip
// reads as a pass, and these are the tests covering reaping and the env
// allowlist.
const PY = python3Available();
const INTERPRETER: Interpreter = { path: "python3", origin: "system" };

/** Kernels created by a test, torn down after it. */
const live: Array<{ dispose(): void }> = [];

function makeKernel(env: NodeJS.ProcessEnv = allowedEnv(process.env)): Kernel {
	const kernel = new Kernel(INTERPRETER, process.cwd(), RUNNER, env);
	live.push(kernel);
	return kernel;
}

afterEach(() => {
	while (live.length) live.pop()?.dispose();
});

/** Wait until `predicate` holds, or fail. Never a bare sleep. */
async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`condition never held within ${timeoutMs}ms: ${what}`);
}

describe("the environment allowlist", () => {
	it("passes the named variables and the three prefixes, and NOTHING else", () => {
		const env = allowedEnv({
			PATH: "/usr/bin",
			HOME: "/home/x",
			LANG: "en_US.UTF-8",
			LC_ALL: "C",
			XDG_CACHE_HOME: "/cache",
			VIRTUAL_ENV: "/venv",
			PYTHONPATH: "/lib",
			PI_ARTIFACT_DIR: "/artifacts",
			ANTHROPIC_API_KEY: "sk-should-not-be-here",
			OPENAI_API_KEY: "sk-nor-this",
			AWS_SECRET_ACCESS_KEY: "nope",
			GH_TOKEN: "gho_nope",
		});
		expect(Object.keys(env).sort()).toEqual([
			"HOME",
			"LANG",
			"LC_ALL",
			"PATH",
			"PI_ARTIFACT_DIR",
			"PYTHONPATH",
			"VIRTUAL_ENV",
			"XDG_CACHE_HOME",
		]);
	});

	it("is an ALLOWlist, so a credential invented tomorrow is excluded by default", () => {
		// The whole reason this is not a denylist. A denylist is wrong in the
		// direction of leaking a key nobody had thought to name; an allowlist is
		// wrong in the direction of a cell not seeing a variable, which is a
		// message the model can act on.
		const env = allowedEnv({ SOME_FUTURE_PROVIDER_TOKEN: "secret", PATH: "/usr/bin" });
		expect(env.SOME_FUTURE_PROVIDER_TOKEN).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
	});
});

describe("interpreter resolution", () => {
	// The probe is injected, so the ORDER is pinned on any machine — including
	// one with no Python at all, where this is the only thing that can be tested.
	const anyPython = () => true;

	it("prefers an explicit override, then the active venv, then the managed venv", () => {
		expect(resolveInterpreter({ PI_KERNEL_PYTHON: "/opt/py" }, "/home/x", anyPython)).toEqual({
			path: "/opt/py",
			origin: "PI_KERNEL_PYTHON",
		});
		// The venv branches require the file to exist, so with an empty home the
		// order falls through to the system interpreter — which is the behaviour
		// the smoke test depends on.
		expect(resolveInterpreter({}, "/nonexistent-home", anyPython)?.origin).toBe("system");
	});

	it("returns null rather than a broken interpreter when nothing satisfies the version", () => {
		// The failure this prevents: spawning something that dies on the first
		// f-string, several seconds later, with a message about syntax.
		expect(resolveInterpreter({ PI_KERNEL_PYTHON: "/opt/py2" }, "/home/x", () => false)).toBeNull();
	});

	it.runIf(PY)("the REAL probe accepts the machine's own python3", () => {
		// The test that would have caught the only bug this extension shipped.
		// `VERSION_PROBE` was first built with JSON.stringify(MIN_PYTHON), which
		// is `[3,10]` — a Python LIST. `sys.version_info >= [3, 10]` raises
		// TypeError, so the probe exited non-zero and EVERY interpreter was
		// rejected as too old, on a box running 3.14. tsc was clean and every
		// resolution test above passed, because they all inject a fake probe.
		// Only executing the real thing can fail on it.
		expect(usablePython("python3")).toBe(true);
		expect(usablePython("/definitely/not/a/python")).toBe(false);
		// And the program is a tuple comparison, not a list one.
		expect(VERSION_PROBE).toContain("(3, 10)");
	});

	it("names the installer and every candidate it looked at when it gives up", () => {
		// Shaped like devservices' installHint for its measured reason: a bare
		// "not found" leaves the agent with no next move, and three sessions
		// abandoned their task rather than recovering (HIV-1966).
		const hint = installHint("/home/x");
		expect(hint).toContain("install-kernel-venv");
		expect(hint).toContain(MANAGED_VENV);
		expect(hint).toContain("PI_KERNEL_PYTHON");
	});
});

describe("kernel identity", () => {
	it("treats `/repo` and `/repo/` as ONE kernel", () => {
		// Two kernels for one directory is a silent, expensive bug: the variable
		// you set is in the other namespace and nothing says so.
		expect(kernelKey("s1", "/repo", "python3")).toBe(kernelKey("s1", "/repo/", "python3"));
	});

	it("separates sessions, directories and interpreters", () => {
		expect(kernelKey("s1", "/repo", "python3")).not.toBe(kernelKey("s2", "/repo", "python3"));
		expect(kernelKey("s1", "/repo", "python3")).not.toBe(kernelKey("s1", "/other", "python3"));
		// Switching venvs must not silently keep the old site-packages.
		expect(kernelKey("s1", "/repo", "python3")).not.toBe(kernelKey("s1", "/repo", "/venv/bin/python"));
	});
});

describe.runIf(PY)("a real interpreter", () => {
	it("keeps variables across separate executions — the whole feature", async () => {
		const kernel = makeKernel();
		const first = await kernel.execute("x = sum(range(10))\nprint(x)", 20);
		expect(first.spawned).toBe(true);
		expect(first.exec.status).toBe("ok");
		expect(first.exec.stdout).toContain("45");

		// A SECOND tool call, into the same process. If this fails the extension
		// is an expensive way to run `python -c`.
		const second = await kernel.execute("print(x * 2)", 20);
		expect(second.spawned).toBe(false);
		expect(second.exec.stdout).toContain("90");
		expect(second.exec.count).toBe(2);
	});

	it("returns the value of a trailing expression without being asked to print it", async () => {
		const kernel = makeKernel();
		const out = await kernel.execute("21 * 2", 20);
		expect(out.exec.result).toBe("42");
	});

	it("reports a raising cell as `error` and keeps the kernel alive", async () => {
		// An exception is the code's verdict, not the kernel's death. Losing the
		// namespace on every typo would make the feature useless.
		const kernel = makeKernel();
		await kernel.execute("keep = 7", 20);
		const boom = await kernel.execute("1 / 0", 20);
		expect(boom.exec.status).toBe("error");
		expect(boom.exec.error).toContain("ZeroDivisionError");
		// And this file's own frames are not in the traceback the model reads.
		expect(boom.exec.error).not.toContain("runner.py");

		const after = await kernel.execute("print(keep)", 20);
		expect(after.exec.stdout).toContain("7");
	});

	it("does NOT hand the cell a provider key", async () => {
		// The reason the env is an allowlist. This is the assertion that would
		// have to fail for a leak to ship.
		const kernel = makeKernel(allowedEnv({ ...process.env, ANTHROPIC_API_KEY: "sk-leaked" }));
		const out = await kernel.execute(
			"import os; print('KEY=' + str(os.environ.get('ANTHROPIC_API_KEY'))); print('PATH_OK=' + str(bool(os.environ.get('PATH'))))",
			20,
		);
		expect(out.exec.stdout).toContain("KEY=None");
		expect(out.exec.stdout).toContain("PATH_OK=True");
	});

	it("survives a subprocess writing raw bytes into the frame stream", async () => {
		// The measured hole in the transport (see protocol.ts): a child inherits
		// fd 1. The kernel must degrade to "that was output", not stop answering.
		const kernel = makeKernel();
		const out = await kernel.execute(
			"import subprocess, sys; subprocess.run([sys.executable, '-c', 'print(\"raw-from-child\")'])",
			20,
		);
		expect(out.exec.done).toBe(true);
		expect(out.exec.stdout).toContain("raw-from-child");
		// And the very next call still works, which is the part that matters.
		const after = await kernel.execute("print('still here')", 20);
		expect(after.exec.stdout).toContain("still here");
	});

	it("interrupts an overrunning cell, keeps what it printed, and keeps the namespace", async () => {
		// Three claims in one, because they are one behaviour: SIGINT becomes a
		// KeyboardInterrupt the runner catches, so the process lives. Killing it
		// instead would throw away variables the cell had already set — which is
		// usually most of the reason the call was made.
		const kernel = makeKernel();
		const out = await kernel.execute(
			"import time\nbefore_timeout = 'set'\nprint('printed first', flush=True)\ntime.sleep(30)",
			1,
		);
		expect(out.exec.status).toBe("cancelled");
		expect(out.exec.stdout).toContain("printed first");

		const after = await kernel.execute("print(before_timeout)", 20);
		expect(after.spawned).toBe(false);
		expect(after.exec.stdout).toContain("set");
	});

	it("refuses a SECOND concurrent cell rather than garbling both", async () => {
		// Without the guard the first call's frames fold into the second as stray
		// output and the first resolves only on its own timeout — two plausible,
		// wrong answers. `executionMode: "sequential"` asks pi not to do this;
		// this pins that the kernel does not depend on being asked nicely.
		const kernel = makeKernel();
		const slow = kernel.execute("import time; time.sleep(2)", 20);
		const second = await kernel.execute("print('me too')", 20);
		expect(second.exec.status).toBe("error");
		expect(second.exec.error).toContain("already running");
		await slow;
	});

	it("runs the %cd magic, and it persists like everything else", async () => {
		const kernel = makeKernel();
		const moved = await kernel.execute("%cd /tmp", 20);
		expect(moved.exec.stdout).toContain("/tmp");
		const after = await kernel.execute("import os; print(os.getcwd())", 20);
		expect(after.exec.stdout).toContain("/tmp");
	});

	it("reports `crashed`, not `error`, when the interpreter dies mid-cell", async () => {
		// These call for opposite next moves — recompute everything, versus fix
		// one line — so the statuses stay apart.
		const kernel = makeKernel();
		const out = await kernel.execute("import os; os._exit(1)", 20);
		expect(out.exec.status).toBe("crashed");
		// And the pool's next call gets a fresh process rather than a dead handle.
		const after = await kernel.execute("print('fresh')", 20);
		expect(after.spawned).toBe(true);
		expect(after.exec.stdout).toContain("fresh");
	});

	it("`reset` discards the namespace; without it the namespace persists", async () => {
		const pool = new KernelPool(RUNNER, () => allowedEnv(process.env));
		live.push({ dispose: () => pool.disposeAll() });
		const key = kernelKey("s1", process.cwd(), "python3");

		await pool.acquire(key, INTERPRETER, process.cwd()).execute("marker = 'original'", 20);
		const kept = await pool.acquire(key, INTERPRETER, process.cwd()).execute("print(marker)", 20);
		expect(kept.exec.stdout).toContain("original");

		const reset = await pool.acquire(key, INTERPRETER, process.cwd(), true).execute("print(marker)", 20);
		expect(reset.spawned).toBe(true);
		expect(reset.exec.error).toContain("NameError");
		expect(pool.size).toBe(1);
	});
});

describe.runIf(PY)("reaping", () => {
	it("kills the whole process GROUP on disposal, not just the interpreter", async () => {
		// The orphan is the thing being tested: a cell that starts `sleep 30`
		// leaves a grandchild which survives a naive kill of the interpreter
		// alone, and that is how a feature like this quietly accumulates stray
		// processes — a measured defect in this house (agent sidecars OOMing a pod
		// hours after the run that spawned them).
		//
		// The two mistakes that made `background`'s equivalent test vacuous TWICE
		// are avoided explicitly:
		//
		//   1. A FRESH pid-file path per run. The old test reused one fixed path
		//      and deleted it only at the end, so a leftover file made it read a
		//      stale pid whose process was long dead; `kill(pid, 0)` threw at once
		//      and it reported success without reaping anything.
		//   2. A deadline BELOW the SIGKILL sweep. The old one was generous, so
		//      with the group kill sabotaged the grandchild still died eventually
		//      for unrelated reasons and that counted as a pass.
		const pidFile = join(tmpdir(), `hive-pi-kernel-${process.pid}-${Date.now()}.pid`);
		rmSync(pidFile, { force: true });

		const kernel = makeKernel();
		await kernel.execute(
			`import subprocess\n` +
				`child = subprocess.Popen(['sleep', '30'])\n` +
				`open(${JSON.stringify(pidFile)}, 'w').write(str(child.pid))\n`,
			20,
		);

		await until(() => existsSync(pidFile), 5_000, "the cell wrote the grandchild's pid");
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isFinite(grandchild)).toBe(true);
		expect(grandchild).toBeGreaterThan(0);

		// Alive BEFORE we reap, or "it is gone afterwards" proves nothing at all.
		expect(() => process.kill(grandchild, 0)).not.toThrow();

		kernel.dispose();

		// This deadline is what makes the test DISCRIMINATE. A SIGTERM to the
		// group kills `sleep` in a few tens of milliseconds; killing only the
		// interpreter leaves it running until the SIGKILL sweep at
		// CANCEL_GRACE_MS, so anything comfortably below that separates the two.
		expect(CANCEL_GRACE_MS).toBeGreaterThan(1_200);
		await until(
			() => {
				try {
					process.kill(grandchild, 0);
					return false; // still alive
				} catch {
					return true; // gone
				}
			},
			1_200,
			"the grandchild was reaped with the group",
		);
		rmSync(pidFile, { force: true });
	});

	it("the EXTENSION reaps on session_shutdown — the wiring, not just the method", async () => {
		// Everything above calls `dispose()` directly, which means deleting
		// `pi.on("session_shutdown", …)` from index.ts leaves every one of them
		// green. That is the vacuous-coverage shape this repo keeps writing tests
		// against, so the event is driven through the real handler here.
		//
		// It matters beyond tidiness: closing the pipe on exit does make a
		// well-behaved runner quit, but it does NOT reap the grandchildren of a
		// wedged cell. The group kill behind this event is the only thing that
		// does, and a kernel is spawned detached precisely so nothing else can.
		const pidFile = join(tmpdir(), `hive-pi-kernel-shutdown-${process.pid}-${Date.now()}.pid`);
		rmSync(pidFile, { force: true });

		const pi = createFakePi();
		kernelExtension(pi.api);
		const tool = pi.tools.find((entry) => entry.name === "kernel");
		expect(tool).toBeDefined();
		const execute = (tool!.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;

		await execute(
			"call-1",
			{
				code:
					`import subprocess\n` +
					`child = subprocess.Popen(['sleep', '30'])\n` +
					`open(${JSON.stringify(pidFile)}, 'w').write(str(child.pid))\n`,
				timeout_seconds: 20,
			},
			undefined,
			undefined,
			{ mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "s1" } },
		);

		await until(() => existsSync(pidFile), 5_000, "the cell wrote the grandchild's pid");
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		expect(() => process.kill(grandchild, 0)).not.toThrow();

		await pi.emit({ type: "session_shutdown" }, { mode: "tui" });

		await until(
			() => {
				try {
					process.kill(grandchild, 0);
					return false;
				} catch {
					return true;
				}
			},
			1_200,
			"session_shutdown reaped the kernel's process group",
		);
		rmSync(pidFile, { force: true });
	});

	it("disposeAll empties the pool, so session_shutdown leaves nothing behind", async () => {
		const pool = new KernelPool(RUNNER, () => allowedEnv(process.env));
		await pool.acquire("a", INTERPRETER, process.cwd()).execute("pass", 20);
		await pool.acquire("b", INTERPRETER, process.cwd()).execute("pass", 20);
		expect(pool.size).toBe(2);
		pool.disposeAll();
		expect(pool.size).toBe(0);
	});
});
