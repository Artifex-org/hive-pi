/**
 * These tests spawn real processes on a real pty. That is the point: every
 * claim this module makes is about what happens across a boundary a pure test
 * cannot see — whether `tty` reports a terminal, whether closing stdin delivers
 * EOF, whether a process group actually dies. The commands are `echo`/`read`/
 * `sleep`, so the suite costs a couple of seconds.
 *
 * `PI_PTY_BASH=1` is set per test rather than globally: `ptyAvailable()` reading
 * the environment IS part of the contract.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ptyAvailable, ptyBashOperations, resetPtyAvailability } from "../extensions/pty-exec/ops.ts";
import { realBashAvailable } from "./require-tools.ts";
import { ensureBash } from "./bash-shim.ts";

ensureBash();

function scriptAvailable(): boolean {
	try {
		// util-linux script; the BSD one takes different flags.
		return process.platform === "linux" && require("node:fs").existsSync("/usr/bin/script");
	} catch {
		return false;
	}
}

const canRunPty = realBashAvailable() && scriptAvailable();

/** Collect the MODEL sink for one command. */
async function run(
	command: string,
	opts: Parameters<typeof ptyBashOperations>[0] & {
		timeout?: number;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
	} = {},
) {
	const chunks: Buffer[] = [];
	const raw: Buffer[] = [];
	const ops = ptyBashOperations({ ...opts, onRaw: (c) => void raw.push(c) });
	if (!ops) throw new Error("pty ops unavailable");
	const result = await ops.exec(command, process.cwd(), {
		onData: (c) => void chunks.push(c),
		timeout: opts.timeout,
		signal: opts.signal,
		env: opts.env,
	});
	return {
		exitCode: result.exitCode,
		model: Buffer.concat(chunks).toString(),
		raw: Buffer.concat(raw).toString(),
	};
}

describe("ptyAvailable", () => {
	beforeEach(() => resetPtyAvailability());
	afterEach(() => {
		delete process.env.PI_PTY_BASH;
		delete process.env.HIVE_TERMINAL_SURFACE_DIR;
		resetPtyAvailability();
	});

	// The opt-in is what keeps PTY mode off the cloud lane, whose images may not
	// carry util-linux at all.
	it("stays off without an opt-in", () => {
		expect(ptyAvailable({ PATH: process.env.PATH })).toBe(false);
	});

	it("turns on for either opt-in", () => {
		if (!canRunPty) return;
		expect(ptyAvailable({ PATH: process.env.PATH, PI_PTY_BASH: "1" })).toBe(true);
		expect(ptyAvailable({ PATH: process.env.PATH, HIVE_TERMINAL_SURFACE_DIR: "/x" })).toBe(true);
	});

	it("stays off when script is not on PATH", () => {
		expect(ptyAvailable({ PATH: "/nonexistent", PI_PTY_BASH: "1" })).toBe(false);
	});

	// One broken environment must cost one command, not every command.
	it("latches off for the session after a spawn failure", async () => {
		process.env.PI_PTY_BASH = "1";
		if (!canRunPty) return;
		const ops = ptyBashOperations({
			// A spawn that always errors, standing in for a missing binary.
			spawnFn: (() => {
				const { EventEmitter } = require("node:events") as typeof import("node:events");
				const fake = new EventEmitter();
				setImmediate(() => fake.emit("error", new Error("ENOENT")));
				return fake as never;
			}) as never,
		});
		await expect(ops!.exec("true", process.cwd(), { onData: () => {} })).rejects.toThrow("pty-unavailable");
		expect(ptyAvailable({ PATH: process.env.PATH, PI_PTY_BASH: "1" })).toBe(false);
	});
});

describe.runIf(canRunPty)("a command running on a real pty", () => {
	beforeEach(() => {
		resetPtyAvailability();
		process.env.PI_PTY_BASH = "1";
	});
	afterEach(() => {
		delete process.env.PI_PTY_BASH;
		resetPtyAvailability();
	});

	// The whole point: the thing today's backend cannot do.
	it("gives the command a controlling terminal", async () => {
		const { model, exitCode } = await run('test -t 0 && echo IS_TTY; tty');
		expect(exitCode).toBe(0);
		expect(model).toContain("IS_TTY");
		expect(model).toMatch(/\/dev\/pts\/\d+/);
	});

	// Measured: without the stty in the bootstrap the pty comes up 0x0, which
	// breaks tput, less and every progress bar.
	it("sets a usable geometry rather than 0x0", async () => {
		const { model } = await run("stty size", { rows: 24, cols: 100 });
		expect(model).toContain("24 100");
	});

	/**
	 * A terminal with no TERM is half a terminal — `tput` fails outright and
	 * curses tools degrade. CI caught this: its environment has no TERM at all,
	 * which is also what an agent launched from a service manager inherits, so
	 * the local pass was the accident and the CI failure was the truth.
	 */
	it("names a terminal type even when the environment has none", async () => {
		const { model } = await run("echo TERM=$TERM; echo COLS=$(tput cols)", {
			rows: 24,
			cols: 100,
			// The CI environment, reproduced deliberately.
			env: { ...process.env, TERM: undefined } as NodeJS.ProcessEnv,
		});
		expect(model).toMatch(/TERM=\S/);
		expect(model).toContain("COLS=100");
		expect(model).not.toContain("No value for $TERM");
	});

	it("does not override a TERM the operator set", async () => {
		const { model } = await run("echo TERM=$TERM", {
			env: { ...process.env, TERM: "vt100" } as NodeJS.ProcessEnv,
		});
		expect(model).toContain("TERM=vt100");
	});

	it("propagates a non-zero exit status", async () => {
		expect((await run("exit 3")).exitCode).toBe(3);
	});

	// The model must not pay for escape codes it cannot read, and the raw sink
	// must keep them so a viewer can render the real thing.
	it("splits the sinks: clean text to the model, raw bytes to the human", async () => {
		const { model, raw } = await run(`printf 'a\\r\\x1b[2Kb\\n'`);
		expect(model).toBe("b\n");
		expect(model).not.toContain("\x1b");
		expect(raw).toContain("\x1b[2K");
	});

	// `script` takes ~3s to give up on its shell after the group is signalled, so
	// two sequential real runs need well over vitest's 5s default.
	it("keeps the sentinel strings pi's error formatting depends on", async () => {
		await expect(run("sleep 30", { timeout: 1 })).rejects.toThrow("timeout:1");

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 300);
		await expect(run("sleep 30", { signal: ac.signal })).rejects.toThrow("aborted");
	}, 30_000);

	// The regression PTY mode creates: stdin never EOFs on its own, so a bare
	// `cat` would hang forever without this.
	it("closes stdin when a command blocks with nobody attached", async () => {
		const started = Date.now();
		const { model, exitCode } = await run("cat", { eofAfterBlockedMs: 1_000 });
		expect(exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(20_000);
		// The model is told WHY its command ended.
		expect(model).toContain("[harness]");
		expect(model).toContain("sent EOF");
    }, 25_000);

	// A human at the terminal owns the session; never yank stdin from under them.
	it("does not auto-close stdin while a human holds the terminal", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 4_000);
		await expect(
			run("cat", { eofAfterBlockedMs: 1_000, hasHuman: () => true, signal: ac.signal }),
		).rejects.toThrow("aborted");
	}, 25_000);

	it("kills the whole process group on abort, not just the shell", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 500);
		const started = Date.now();
		await expect(run("sleep 30 & sleep 30", { signal: ac.signal })).rejects.toThrow("aborted");
		// If only the direct child died we would wait out the full 30s.
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 25_000);

	// The command text must not be visible to another local user via ps.
	it("passes the command through the environment, not argv", async () => {
		const marker = `SECRET_${Date.now()}`;
		const { model } = await run(`echo ${marker}; ps -o args= -p $PPID`);
		expect(model).toContain(marker);
		// $PPID is `script`, whose argv holds the bootstrap and not the command.
		expect(model).toContain("script");
		const psLine = model.split("\n").find((l) => l.includes("script")) ?? "";
		expect(psLine).not.toContain(marker);
	});
});
