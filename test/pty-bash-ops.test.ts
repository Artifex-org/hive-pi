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

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ptyAvailable, ptyBashOperations, resetPtyAvailability } from "../extensions/pty-exec/ops.ts";
import { gitAvailable, realBashAvailable } from "./require-tools.ts";
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
		/** Where the command runs. The session's own checkout by default. */
		cwd?: string;
	} = {},
) {
	const chunks: Buffer[] = [];
	const raw: Buffer[] = [];
	const ops = ptyBashOperations({ ...opts, onRaw: (c) => void raw.push(c) });
	if (!ops) throw new Error("pty ops unavailable");
	const result = await ops.exec(command, opts.cwd ?? process.cwd(), {
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

/** Resolves true once `pid` is gone, or false when the budget runs out. */
async function gone(pid: number, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 200));
	}
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
		// The model is told WHY its command ended — and WHICH process was reading,
		// so "why did my command end early" is answerable from the transcript
		// alone rather than by re-running it (HIV-2950).
		expect(model).toContain("[harness]");
		expect(model).toContain("sent EOF");
		expect(model).toMatch(/pid \d+ \(cat\) was reading stdin/);
    }, 25_000);

	// A human at the terminal owns the session; never yank stdin from under them.
	it("does not auto-close stdin while a human holds the terminal", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 4_000);
		await expect(
			run("cat", { eofAfterBlockedMs: 1_000, hasHuman: () => true, signal: ac.signal }),
		).rejects.toThrow("aborted");
	}, 25_000);

	// Weaker than its old name ("kills the whole process group") claimed: `sleep`
	// dies to the pty hangup, so this passes with or without a working group
	// kill. It still earns its place as the timing check — see the next test for
	// the one that can actually see the group.
	it("returns promptly on abort instead of waiting the command out", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 500);
		const started = Date.now();
		await expect(run("sleep 30 & sleep 30", { signal: ac.signal })).rejects.toThrow("aborted");
		// If only the direct child died we would wait out the full 30s.
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 25_000);

	/**
	 * THE TEST ABOVE IS NOT ENOUGH, and believing it was cost P0408.
	 *
	 * `sleep` dies to the pty HANGUP that follows `script` exiting, so that case
	 * passes whether or not the group kill lands. `script` calls setsid() for its
	 * child, so the command runs in a DIFFERENT session and process group from
	 * `script` itself and `kill(-scriptPid)` never reaches it. Measured: script
	 * pid/pgid/sid 1158825, the shell under the pty 1158826/1158826/1158826.
	 *
	 * A grandchild that traps HUP and TERM — a pre-commit hook chain, which is
	 * exactly what P0408 was — therefore survives the tool call. An orphaned
	 * `quality-gate --changed` was still alive twelve minutes later, holding the
	 * worktree's `index.lock` and failing every retry.
	 *
	 * `bash -c` explicitly, not a bare subshell: the shell under the pty is
	 * `$SHELL`, which on a workstation is as likely to be zsh, and `$$` inside an
	 * explicitly spawned bash is that bash's own pid whatever the outer shell is.
	 */
	it("kills a child that ignores HUP and TERM", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pty-orphan-"));
		const pidFile = join(dir, "child.pid");
		try {
			const ac = new AbortController();
			setTimeout(() => ac.abort(), 1_500);
			await expect(
				run(`bash -c 'trap "" HUP TERM; echo $$ > ${pidFile}; sleep 30' & sleep 30`, {
					signal: ac.signal,
				}),
			).rejects.toThrow("aborted");

			const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
			expect(Number.isInteger(pid)).toBe(true);
			// SIGTERM is ignored by construction, so only the SIGKILL that follows
			// KILL_GRACE_MS can end it. Generous, but bounded: today it never dies.
			await expect(gone(pid, 10_000)).resolves.toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 40_000);

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

/**
 * THE LARGEST PAPERCUT CLASS THIS FEATURE CREATED, and one the stall detector
 * cannot even see.
 *
 * With a real tty on stdout `git diff|show|log|blame` invokes `less`, and
 * `less` reads its keyboard from `/dev/tty` — not from fd 0. So StdinWatch's
 * proven tier (a read-family syscall with arg0 === 0) never fires, no
 * `[harness]` note is emitted, and the command sits at one screenful of output
 * until the caller's timeout kills it. That is the signature in the corpus:
 * "printed a partial diff, then killed at 30s", 57 of 179 papercuts over seven
 * days and ZERO of them before 2026-08-26, the day pty mode landed.
 *
 * Measured on the real spawn shape: `git diff` on a 400-line diff hung past 8s
 * having emitted 1107 bytes — exactly one screenful; with `GIT_PAGER=cat` the
 * identical spawn returned 9786 bytes and exit 0 in 21ms.
 */
describe.runIf(canRunPty && gitAvailable())("git output under a pty", () => {
	const TAIL = "TAIL_MARKER_LAST_LINE";
	let repo: string;

	/**
	 * The machine's own git config and pager environment are held out on
	 * purpose. A developer with `PAGER=cat` exported — or `core.pager` set in
	 * `~/.gitconfig` — would otherwise watch this pass before the fix and learn
	 * nothing. A service-managed agent, which is every workstation launch,
	 * inherits neither, and that is the environment being reproduced.
	 */
	const isolated: NodeJS.ProcessEnv = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_PAGER: undefined,
		PAGER: undefined,
		LESS: undefined,
	};

	beforeEach(() => {
		resetPtyAvailability();
		process.env.PI_PTY_BASH = "1";
		repo = mkdtempSync(join(tmpdir(), "pty-pager-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore", env: isolated });
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Test");
		const body = (tag: string) =>
			`${Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")} ${tag}`).join("\n")}\n`;
		writeFileSync(join(repo, "f.txt"), body("before"));
		git("add", "f.txt");
		git("commit", "-qm", "one");
		// 200 changed lines is 400 diff rows against a 50-row terminal, so a
		// pager stops after the first screenful.
		writeFileSync(join(repo, "f.txt"), `${body("after")}${TAIL}\n`);
	});

	afterEach(() => {
		delete process.env.PI_PTY_BASH;
		resetPtyAvailability();
		rmSync(repo, { recursive: true, force: true });
	});

	it("does not hand a long diff to a pager", async () => {
		const { exitCode, model } = await run("git diff", { cwd: repo, env: isolated, timeout: 20 });
		expect(exitCode).toBe(0);
		// The LAST line, not the first: one screenful arrives either way.
		expect(model).toContain(TAIL);
	}, 45_000);

	// The other half of the rule. pty-exec exists so a human at the terminal can
	// answer `gh auth login`; someone who set a pager meant to read through it.
	it("does not override a pager the environment already names", async () => {
		const { model } = await run("echo PAGER=$PAGER GIT_PAGER=$GIT_PAGER", {
			cwd: repo,
			env: { ...isolated, PAGER: "more", GIT_PAGER: "delta" },
		});
		expect(model).toContain("PAGER=more GIT_PAGER=delta");
	}, 25_000);
});
