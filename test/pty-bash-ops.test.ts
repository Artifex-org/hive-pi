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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { gitDirOf } from "../extensions/background/indexlock.ts";
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

/**
 * Like `run`, but KEEPS the model sink when the command rejects.
 *
 * `run` throws the rejection away along with everything the command had
 * produced, which is precisely the material the post-mortem note lives in.
 */
async function runExpectingFailure(
	command: string,
	opts: Parameters<typeof run>[1] = {},
): Promise<{ error: Error | undefined; model: string }> {
	const chunks: Buffer[] = [];
	const ops = ptyBashOperations(opts);
	if (!ops) throw new Error("pty ops unavailable");
	let error: Error | undefined;
	try {
		await ops.exec(command, opts.cwd ?? process.cwd(), {
			onData: (c) => void chunks.push(c),
			timeout: opts.timeout,
			signal: opts.signal,
			env: opts.env,
		});
	} catch (e) {
		error = e as Error;
	}
	return { error, model: Buffer.concat(chunks).toString() };
}

/** The `[harness]` line out of a model buffer, or "" when there is none. */
function harnessNote(model: string): string {
	return model.split("\n").find((l) => l.includes("[harness]")) ?? "";
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

	/**
	 * WHAT A BARE TIMEOUT COSTS. Before this, a killed command returned its
	 * partial output plus `script`'s own unattributed "Session terminated,
	 * killing shell..." — nothing said which member of a chained command was
	 * still running, so the same probe got retried blind. Nine papercuts ask for
	 * this in those words ("does not reveal which subcommand was slow").
	 *
	 * The chain matters: `echo first` has ALREADY finished at the kill, and a
	 * note that merely echoed the command string back would name it too. The
	 * live /proc tree names only `sleep`.
	 */
	it("names the process still running when a timeout kills the command", async () => {
		const { error, model } = await runExpectingFailure("echo first; sleep 30", { timeout: 2 });
		// The sentinel is the negative control: the note must not have been
		// smuggled in by breaking the protocol pi's error formatting matches on.
		expect(error?.message).toBe("timeout:2");
		const note = harnessNote(model);
		expect(note).toContain("timed out");
		expect(note).toContain("sleep 30");
		// The part of the chain that already completed is not the culprit.
		expect(note).not.toContain("echo");
	}, 30_000);

	// An abort is the identical blindness, so it gets the identical answer.
	it("names the process still running when an abort cancels the command", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1_000);
		const { error, model } = await runExpectingFailure("echo first; sleep 30", { signal: ac.signal });
		expect(error?.message).toBe("aborted");
		const note = harnessNote(model);
		expect(note).toContain("cancelled");
		expect(note).toContain("sleep 30");
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
	 * `bash -c` explicitly, not a bare subshell: this test predates HIV-3086, when
	 * the shell under the pty was still `$SHELL` and so as likely to be zsh as
	 * anything else. `$$` inside an explicitly spawned bash is that bash's own pid
	 * whatever the outer shell is, so the check does not rest on the HIV-3086 fix.
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
 * THE TOOL IS CALLED `bash`, SO IT HAS TO SPEAK BASH. (HIV-3086)
 *
 * util-linux `script` runs its `-c` string through `$SHELL`, and the spawn used
 * to hand `$SHELL` straight through — its `"/bin/bash"` default was unreachable,
 * because no caller passes `shellPath` and the env is a spread of `process.env`.
 * So on a workstation whose login shell is zsh — which is every workstation in
 * this fleet — every foreground `bash` tool call was parsed by zsh. 63 distinct
 * agent sessions in seven days paid for that, the largest single pi-harness
 * cause in the papercut corpus.
 *
 * Each row below is one of the divergences the corpus actually recorded, and
 * each fails loudly under zsh: `status` is read-only there (the `(eval):N:`
 * fingerprint, counted 19 times), arrays index from 1, `mapfile` does not
 * exist, and an unmatched glob aborts the whole line instead of passing
 * through. Verified as a negative control by reverting the `SHELL:` line to
 * `opts.shellPath ?? env?.SHELL ?? "/bin/bash"`: all five rows failed.
 *
 * `SHELL` is pointed at zsh THROUGH THE ENV `exec` RECEIVES, which is where the
 * real value came from. The suite does not need zsh to be installed: after the
 * fix nothing consults the variable, so a host without zsh runs the same
 * assertions and gets the same answers.
 *
 * `ZDOTDIR` is aimed at an empty directory on purpose. This machine's own
 * `~/.zshenv` runs `unsetopt nomatch`, and zsh sources `$ZDOTDIR/.zshenv` even
 * for `-c` — so without the isolation the glob row would have PASSED under zsh
 * here and the negative control would have been one assertion weaker than it
 * looked, for reasons that live in a dotfile rather than in this repo.
 */
describe.runIf(canRunPty)("the command language when the login shell is zsh", () => {
	let zdotdir: string;

	beforeEach(() => {
		resetPtyAvailability();
		process.env.PI_PTY_BASH = "1";
		zdotdir = mkdtempSync(join(tmpdir(), "pty-zdotdir-"));
	});
	afterEach(() => {
		delete process.env.PI_PTY_BASH;
		resetPtyAvailability();
		rmSync(zdotdir, { recursive: true, force: true });
	});

	/** The environment a workstation launch really hands `exec`. */
	const zshEnv = (): NodeJS.ProcessEnv => ({
		...process.env,
		SHELL: "/usr/bin/zsh",
		ZDOTDIR: zdotdir,
	});

	it.each([
		{
			name: "assigns to $status, which zsh makes read-only",
			command: "true; status=$?; echo status=$status",
			expected: "status=0",
		},
		{
			name: "indexes an array from zero, not from one",
			command: "arr=(x y z); echo sub=${arr[1]}",
			expected: "sub=y",
		},
		{
			name: "has mapfile",
			command: "type mapfile",
			expected: "mapfile is a shell builtin",
		},
		{
			name: "leaves an unmatched glob alone instead of aborting the line",
			command: "echo /nonexistent-hiv3086-*; echo REACHED_END",
			expected: "REACHED_END",
		},
		{
			name: "identifies itself as bash",
			command: "echo BASH_VERSION=${BASH_VERSION:-none}",
			expected: /BASH_VERSION=\d/,
		},
	])("$name", async ({ command, expected }) => {
		const { model, exitCode } = await run(command, { env: zshEnv() });
		expect(model).toMatch(expected);
		// zsh does not merely answer differently — it aborts the line, so the
		// exit status is half the evidence.
		expect(exitCode).toBe(0);
	}, 25_000);

	/**
	 * The escape hatch survives the fix. pty mode exists so a person can attach
	 * to the pane, and someone who sets `shellPath` has said which shell they
	 * want to sit in front of; the resolution order must not overrule them.
	 *
	 * The stand-in shell is the trick `test/bash-shim.ts` already uses: `script`
	 * invokes `$SHELL -c <bootstrap>`, so the bootstrap is `$2`.
	 */
	it("still lets opts.shellPath overrule the resolution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pty-shellpath-"));
		const shell = join(dir, "marker-shell");
		try {
			writeFileSync(shell, '#!/bin/sh\necho SHELLPATH_HONORED\nexec /bin/sh -c "$2"\n');
			chmodSync(shell, 0o755);
			const { model, exitCode } = await run("echo BODY_RAN", { shellPath: shell, env: zshEnv() });
			expect(model).toContain("SHELLPATH_HONORED");
			expect(model).toContain("BODY_RAN");
			expect(exitCode).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 25_000);
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

/**
 * WHAT THE KILL LEFT BEHIND, AND WHERE.
 *
 * The post-mortem above names the processes that were still running. It said
 * nothing about the `index.lock` a killed `git commit` strands, and the static
 * `bash-foreground-timeout` hint only warns that one "may remain" — no path. So
 * the agent guesses: on 2026-09-02 it guessed `<cwd>/.git/index.lock`, which in
 * a WORKTREE is a file pointing elsewhere and so never exists — a path that can
 * only ever answer "no lock here", whatever the truth is.
 *
 * Hence the linked worktree here rather than a plain `git init`: in a plain repo
 * the wrong path and the right one are the same string, and a test built on one
 * could not tell them apart.
 */
describe.runIf(canRunPty && gitAvailable())("a killed command that stranded a git index lock", () => {
	let main: string;
	let worktree: string;

	beforeEach(() => {
		resetPtyAvailability();
		process.env.PI_PTY_BASH = "1";
		main = mkdtempSync(join(tmpdir(), "pty-lock-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Test");
		writeFileSync(join(main, "f.txt"), "one\n");
		git("add", "f.txt");
		git("commit", "-qm", "one");
		worktree = join(mkdtempSync(join(tmpdir(), "pty-lock-wt-")), "feature");
		git("worktree", "add", "-q", worktree, "-b", "feature");
	});

	afterEach(() => {
		delete process.env.PI_PTY_BASH;
		resetPtyAvailability();
		rmSync(main, { recursive: true, force: true });
		rmSync(join(worktree, ".."), { recursive: true, force: true });
	});

	it("names the real lock path when a timeout kills the command", async () => {
		const gitDir = gitDirOf(worktree)!;
		// The whole point: a linked worktree's index lives under the COMMON dir.
		expect(gitDir).toContain("worktrees");
		const lock = join(gitDir, "index.lock");
		writeFileSync(lock, "");

		const { error, model } = await runExpectingFailure("sleep 30", { cwd: worktree, timeout: 2 });
		// The sentinel is the built-in control, as in the post-mortem tests: the
		// note must not have arrived by breaking pi's error-formatting protocol.
		expect(error?.message).toBe("timeout:2");
		expect(model).toContain(lock);
		// A held lock is doing its job; the note has to say so, or it trades a
		// failed command for a corrupted index.
		expect(model).toContain("leave it alone");
	}, 30_000);

	// The common case, and the reason this is probed at `close` and not at the
	// kill: nearly every killed command leaves no lock at all, and a note that
	// fired anyway would be noise on every timeout.
	it("says nothing when the kill stranded no lock", async () => {
		const { error, model } = await runExpectingFailure("sleep 30", { cwd: worktree, timeout: 2 });
		expect(error?.message).toBe("timeout:2");
		expect(model).not.toContain("index.lock");
	}, 30_000);
});
