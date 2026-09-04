/**
 * Run an agent's shell command on a real terminal.
 *
 * WHY. pi's local backend spawns with `stdio: [ignore, pipe, pipe]` and
 * `detached: true` — no pty, no stdin, no controlling terminal. Its own shipped
 * example says the consequence: "If the agent runs an interactive command, it
 * will fail." An ssh passphrase, `gh auth login`, `npm login` or `git rebase -i`
 * either fails for want of a tty or blocks until someone notices.
 *
 * WHY `script(1)` AND NOT node-pty. hive-pi carries zero native runtime
 * dependencies, and `cmd/factory-exec/piext/` — where these extensions are
 * vendored for the cloud lane — has no `dependencies` block at all and no build
 * toolchain. A native module has nowhere to land there. util-linux `script` is
 * present wherever the agent runs, and `-e` propagates the child's exit status,
 * which the tool contract depends on.
 *
 * MEASURED INSIDE A REAL LAUNCH SANDBOX (2026-08-26), because every one of these
 * was a genuine open question:
 *
 *   - a pty allocates: `/dev/pts/0`, `test -t 0` passes. srt's bwrap passes
 *     `--dev /dev`, and `--new-session` denies /dev/tty but NOT allocation.
 *   - it comes up `rows 0; columns 0`, which breaks `tput`, `less` and every
 *     progress bar — hence the `stty` in the bootstrap below.
 *   - closing our end of stdin DOES deliver EOF (see `endInput`).
 *   - the sandbox has its OWN devpts namespace, so the recorded pts path is
 *     meaningless on the host. Resize must be applied from in here.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

import { AnsiStripper, normalizeCRLF } from "./ansi.ts";
import { RepaintCollapser } from "./repaint.ts";
import {
	StdinWatch,
	describeLiveTree,
	describeVerdict,
	readTree,
	realProcReader,
	type BlockedVerdict,
} from "./stdinWatch.ts";

/**
 * pi's `BashOperations`, restated structurally.
 *
 * Imported as a type from the peer dependency would be cleaner, but this module
 * is also vendored into an image that typechecks a fixed file list with
 * `--types node` and no pi package present. One interface is cheaper than a
 * build-graph exception.
 */
export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			/** SECONDS, not milliseconds — pi multiplies by 1000 on the way in. */
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface PtyBashOptions {
	shellPath?: string;
	rows?: number;
	cols?: number;
	/** The human sink: RAW bytes, escapes and repaints intact, for a live viewer. */
	onRaw?: (chunk: Buffer) => void;
	/** Fires on a blocked/quiet transition so the caller can decorate its render. */
	onBlocked?: (v: BlockedVerdict) => void;
	/** True while a human holds the terminal; suppresses the auto-EOF below. */
	hasHuman?: () => boolean;
	/**
	 * Hand the caller a writer for this command's stdin, and take back a cleanup
	 * to call when it ends.
	 *
	 * This is how a human's keystrokes reach the pty. The writer is scoped to one
	 * command deliberately: a keystroke that arrived after the command exited must
	 * not leak into the next one.
	 */
	attachInput?: (write: (data: Buffer) => void) => () => void;
	/** Applied to this command's own pts — see the note on resize in the bridge. */
	onGeometry?: (apply: (rows: number, cols: number) => void) => () => void;
	/** Milliseconds after a PROVEN block before stdin is closed. null disables. */
	eofAfterBlockedMs?: number | null;
	/** Test seam. */
	spawnFn?: typeof spawn;
}

const DEFAULT_ROWS = 50;
const DEFAULT_COLS = 200;
const DEFAULT_EOF_AFTER_BLOCKED_MS = 10_000;
const KILL_GRACE_MS = 2_000;

/**
 * The command travels in the ENVIRONMENT, never in argv.
 *
 * `eval "$X"` inside `$SHELL -c` parses X once as a command line, so `set -e`,
 * functions, heredocs and exit codes behave exactly as they do today. But the
 * text never reaches argv, so it cannot be mangled by a quoting layer and does
 * not show up in `ps` — which the current local backend does expose.
 *
 * `stty` runs INSIDE the pty on its own controlling terminal, so geometry is set
 * without anyone needing to know the pts path. Measured: without it the pty
 * comes up 0x0. `tty > $PI_PTY_TTY` records the path for in-sandbox resize only.
 *
 * `echo $$ > $PI_PTY_PID` records THIS SHELL's pid, and it is the only way to
 * kill what the command actually started — see `killTree`. A brace group, not a
 * subshell, so `$$` is the shell itself and not something forked from it.
 */
const BOOTSTRAP =
	'{ tty > "$PI_PTY_TTY"; echo $$ > "$PI_PTY_PID"; stty rows "$PI_PTY_ROWS" cols "$PI_PTY_COLS"; } 2>/dev/null; eval "$PI_PTY_COMMAND"';

/**
 * The pts path the bootstrap recorded, or "" before the shell has written it.
 *
 * Meaningful only INSIDE the sandbox: the sandbox mounts its own devpts, so this
 * same string names a different device on the host.
 */
function readTTYPath(file: string): string {
	try {
		const p = readFileSync(file, "utf8").trim();
		return p.startsWith("/dev/pts/") ? p : "";
	} catch {
		return "";
	}
}

/** Resolve a bare name against PATH without spawning anything. */
function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const path = env.PATH ?? "";
	return path
		.split(delimiter)
		.some((dir) => dir !== "" && existsSync(join(dir, name)));
}

/**
 * Which shell interprets the agent's command line. (HIV-3086)
 *
 * WHY THIS IS NOT `$SHELL`. util-linux `script` hands its `-c` string to
 * whatever `$SHELL` names, so the tool the model knows as `bash` was parsed and
 * run by the operator's LOGIN shell — zsh on every workstation in this fleet.
 * The spawn below did already carry a `"/bin/bash"` default, but it was dead
 * code twice over: no caller passes `shellPath` (see `extensions/pretty-tools.ts`),
 * and the env handed to `exec` is a spread of `process.env`, so `env.SHELL` was
 * always set and always won.
 *
 * That is not a dialect quibble. The tool is NAMED bash and prompted as bash,
 * so the model writes bash at it, and the papercut corpus counted 63 distinct
 * agent sessions in seven days losing turns to the divergence — the largest
 * single pi-harness cause in it. Reproduced with this exact spawn shape,
 * varying only `SHELL`: `SHELL=/usr/bin/zsh` gave
 * `(eval):1: read-only variable: status`, exit 1, and nothing after the
 * assignment ran; `SHELL=/bin/bash` gave the whole line and exit 0. What breaks:
 *
 *   - `status=$?` — `status` is READ-ONLY in zsh, so the assignment aborts the
 *     line. That `(eval):N:` prefix is the fingerprint, counted 19 times.
 *   - a lowercase `path=` assignment — zsh TIES `path`/`cdpath`/`fpath` to
 *     `PATH`, so one ordinary variable name silently WIPES PATH and every later
 *     command dies `command not found` naming a binary that is not the problem.
 *   - `mapfile`, `PIPESTATUS` and `<( )` are missing or spelled differently.
 *   - an unmatched glob aborts the whole line instead of passing through.
 *   - `$VAR` is not word-split, so `cmd $FLAGS` passes ONE argument.
 *
 * The order deliberately mirrors pi's own `getShellConfig()` — explicit path,
 * then `/bin/bash`, then bash on PATH, then a POSIX last resort — because pty
 * mode is a REPLACEMENT for pi's local backend, not an addition to it. If the
 * two resolved differently the same command would speak a different language
 * depending on whether a terminal surface happened to be published, which is a
 * worse bug than the one being fixed: it would be intermittent.
 *
 * MEASURED (util-linux 2.42.2): `script` execs the shell with `execvp`, so the
 * bare `"bash"` branch really does get a PATH search —
 * `PATH=/usr/bin SHELL=bash script -qec 'echo $0; echo hi' /dev/null` printed
 * `bash` then `hi`, exit 0, with no directory named. It stays the THIRD choice
 * all the same: an absolute path cannot be shadowed by a PATH entry.
 *
 * THE ACCEPTED COST, stated plainly. `$SHELL` is inherited by everything the
 * command starts, so a TUI that shells out — an editor's `:!`, a pager's shell
 * escape — now gets bash instead of the operator's zsh. That is the trade we
 * are making: the agent's own commands are the contract this tool advertises,
 * an interactive detour taken by a program the agent launched is not.
 * `opts.shellPath` is left as the escape hatch for anyone who wants the
 * human-attach pane to keep their own shell.
 */
function bashShell(env: NodeJS.ProcessEnv | undefined, shellPath?: string): string {
	if (shellPath) return shellPath;
	if (existsSync("/bin/bash")) return "/bin/bash";
	if (onPath("bash", env ?? process.env)) return "bash";
	// No bash anywhere — pi lands on a bare `sh` here. Prefer a shell the
	// environment actually names, because with no bash present there is no
	// longer a stock backend to stay consistent WITH, and `$SHELL` at least
	// names something known to exist on this host.
	return env?.SHELL ?? "/bin/sh";
}

/**
 * Latched off for the session once a spawn fails, so one broken environment
 * costs one command rather than every command.
 */
let ptyDisabled = false;

/** Marks PTY mode unusable for the rest of the session. Exported for tests. */
export function disablePty(): void {
	ptyDisabled = true;
}

export function resetPtyAvailability(): void {
	ptyDisabled = false;
}

/**
 * Is a pty-backed shell usable here?
 *
 * The opt-in is deliberate and it is what keeps this off the cloud lane: PTY
 * mode ships WITH human attach, so the terminal-surface directory is the natural
 * switch. `PI_PTY_BASH=1` is the manual override for local work.
 */
export function ptyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (ptyDisabled) return false;
	// macOS needs `allowPty` in the srt profile, which hive does not set today.
	if (process.platform !== "linux") return false;
	if (!env.HIVE_TERMINAL_SURFACE_DIR && env.PI_PTY_BASH !== "1") return false;
	return onPath("script", env);
}

/**
 * The pid the bootstrap recorded for the shell under the pty, or undefined.
 *
 * The guard is not decoration. A truncated or garbage file that parsed to 1
 * would make the `kill(-pid)` below `kill(-1)` — SIGTERM to every process this
 * user owns, from one unlucky write. Anything that is not a plausible pid is
 * treated as "not recorded yet", which costs nothing: the script group is still
 * signalled.
 */
function readShellPid(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 1 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * SIGTERM everything this command owns, then SIGKILL what survives.
 *
 * TWO SESSIONS, AND THE SECOND ONE IS THE POINT. util-linux `script` calls
 * setsid() for its child, so the command runs in a DIFFERENT session and
 * process group from `script` itself — measured: script pid/pgid/sid all
 * 1158825, the shell beneath the pty all 1158826. Signalling `-scriptPid`
 * therefore reaches `script` alone, and the shell dies of the HANGUP that
 * follows the pty closing. That looks identical to a working group kill right
 * up until a grandchild traps HUP.
 *
 * A pre-commit hook chain does exactly that. P0408: an orphaned
 * `vendor/quality-gate/quality-gate --changed` was still running twelve minutes
 * after its tool call returned, holding the worktree's `index.lock` and failing
 * every retry the agent made.
 */
function killTree(scriptPid: number | undefined, pidFile: string): void {
	// Read ONCE, here: `cleanup` unlinks the file when the command closes, which
	// is well before the SIGKILL timer below fires.
	const shellPid = readShellPid(pidFile);
	// The command's own session first — the shell is what owns the work.
	const targets = [shellPid, scriptPid].filter((p): p is number => p !== undefined && p > 1);
	if (targets.length === 0) return;
	const send = (sig: NodeJS.Signals) => {
		for (const pid of targets) {
			try {
				// Negative pid = that pid's whole process group.
				process.kill(-pid, sig);
			} catch {
				try {
					process.kill(pid, sig);
				} catch {
					/* already gone */
				}
			}
		}
	};
	send("SIGTERM");
	const t = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
	t.unref?.();
}

/**
 * Per-command file names, unique within the process.
 *
 * A counter and not just `Date.now()`: pi runs a tool batch concurrently, two
 * commands can start in the same millisecond, and a shared pid file would aim
 * one command's kill at the other command's process group.
 */
let commandSeq = 0;

/**
 * Build a pty-backed `BashOperations`, or null when one is not usable here.
 *
 * The caller falls back to pi's own local backend on null, so this never fails
 * a tool call — it only declines to handle one.
 */
export function ptyBashOperations(opts: PtyBashOptions = {}): BashOperations | null {
	if (!ptyAvailable()) return null;
	const spawnFn = opts.spawnFn ?? spawn;

	return {
		exec: (command, cwd, { onData, signal, timeout, env }) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				const rows = opts.rows ?? DEFAULT_ROWS;
				const cols = opts.cols ?? DEFAULT_COLS;
				const base = join(process.env.TMPDIR ?? "/tmp", `pi-pty-${process.pid}-${Date.now()}-${++commandSeq}`);
				const ttyFile = `${base}.tty`;
				const pidFile = `${base}.pid`;

				const child = spawnFn("script", ["-qfec", BOOTSTRAP, "/dev/null"], {
					cwd,
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...(env ?? process.env),
						// `script` runs its command through $SHELL, so this single line
						// decides which LANGUAGE the tool named `bash` actually speaks.
						// It is resolved, never inherited — see `bashShell` above for the
						// 63 sessions that paid for the difference.
						SHELL: bashShell(env, opts.shellPath),
						// A terminal with no TERM is half a terminal: `tput` fails
						// outright ("No value for $TERM and no -T specified"), and
						// less/vim/curses degrade. Nothing needed one before, because
						// there was no pty to describe — an agent launched from a
						// service manager inherits no TERM at all, which is exactly
						// what CI reproduced. Only defaulted, never overridden: an
						// operator who set one meant it.
						TERM: env?.TERM ?? process.env.TERM ?? "xterm-256color",
						// THE COST OF A REAL TERMINAL, AND ITS PRICE TAG. With a tty on
						// stdout `git diff|show|log|blame` invokes `less`, and `less`
						// reads its keyboard from /dev/tty rather than fd 0 — so the
						// stall detector's proven tier (a read on fd 0) never fires, no
						// `[harness]` note is emitted, and the command sits at one
						// screenful until the caller's timeout kills it. 57 of 179
						// papercuts in a seven-day window, and ZERO of them dated before
						// the day pty mode shipped. Measured: `git diff` on a 400-line
						// diff hung past 8s having emitted 1107 bytes; with GIT_PAGER=cat
						// the identical spawn returned all 9786 bytes and exit 0 in 21ms.
						//
						// Defaulted, never overridden, exactly like TERM above — and read
						// only from the env pi hands us, with NO `process.env` fallback:
						// a pager that reached the agent's environment was put there by a
						// person, and pty mode exists so a person can use one. An agent
						// launched from a service manager inherits none, which is every
						// workstation launch and is where the hang lived.
						//
						// GIT_TERMINAL_PROMPT is deliberately NOT set: an ssh passphrase
						// or `gh auth login` reaching a human is the whole feature.
						GIT_PAGER: env?.GIT_PAGER ?? "cat",
						PAGER: env?.PAGER ?? "cat",
						// Belt and braces for anything that execs `less` directly: quit
						// if it fits on one screen, do not clear it away afterwards.
						LESS: env?.LESS ?? "FRX",
						PI_PTY_COMMAND: command,
						PI_PTY_TTY: ttyFile,
						PI_PTY_PID: pidFile,
						PI_PTY_ROWS: String(rows),
						PI_PTY_COLS: String(cols),
					},
				});

				// A `script` that is missing or unrunnable must not fail the command:
				// latch PTY mode off and let the caller retry on the stock backend.
				let spawnFailed = false;

				// ---- the two sinks -------------------------------------------------
				// The model gets stripped, collapsed, LF-normalized text; a human gets
				// the raw bytes. One tee, because a viewer needs the escapes the model
				// must not pay for.
				const stripper = new AnsiStripper();
				const collapser = new RepaintCollapser((chunk) => onData(chunk));
				const toModel = (chunk: Buffer) => collapser.write(normalizeCRLF(stripper.write(chunk)));

				let eofTimer: NodeJS.Timeout | undefined;
				// Pagers already asked to quit, by pid. A pager gets the keystroke a
				// person would send first and the signal only if it ignores it: `q`
				// lets it exit cleanly, leaving what it had already drawn in the
				// transcript, where SIGTERM takes that away too.
				const nudgedPagers = new Set<number>();
				const watch = new StdinWatch(
					child.pid ?? 0,
					realProcReader(),
					(verdict) => {
						opts.onBlocked?.(verdict);
						// A PAGER CANNOT BE WAITED OUT, so this branch acts where the
						// others report. Nothing in a tool call can press a key, so
						// `less` holds the command — and with it the turn, and with the
						// turn every steer queued behind it — until a human notices.
						// Measured 2026-08-29: 25 minutes on one `git diff --stat`,
						// released within a second of ending the pager (HIV-3053).
						//
						// Closing stdin, which releases the read-blocked case below,
						// does nothing here: a pager on a tty ignores EOF.
						if (verdict.kind === "pager") {
							// A human at the pane owns the session and may be reading
							// that pager on purpose — the same rule the EOF path follows.
							if (opts.hasHuman?.()) return;
							if (nudgedPagers.has(verdict.pid)) {
								onData(Buffer.from(`\n[harness] pid ${verdict.pid} (${verdict.comm}) ignored q; sent SIGTERM.\n`));
								try {
									process.kill(verdict.pid, "SIGTERM");
								} catch {
									/* it exited between the poll and here */
								}
								nudgedPagers.delete(verdict.pid);
								return;
							}
							nudgedPagers.add(verdict.pid);
							onData(
								Buffer.from(
									`\n[harness] pid ${verdict.pid} (${verdict.comm}) is waiting for a keypress and nothing here can type; sent q. Re-run it non-interactively (git --no-pager …, PAGER=cat).\n`,
								),
							);
							try {
								child.stdin?.write("q");
							} catch {
								/* already closed; the next verdict escalates to SIGTERM */
							}
							return;
						}
						if (verdict.kind !== "blocked") {
							if (eofTimer) clearTimeout(eofTimer);
							eofTimer = undefined;
							return;
						}
						// THE HANG CLASS THIS FEATURE CREATES, AND ITS FIX. Under a pty
						// stdin never reaches EOF on its own, so a bare `cat` — instant
						// today — would block forever. Measured: closing our end of
						// `script`'s stdin delivers EOF (a `\x04` write is unnecessary,
						// depends on canonical mode, and would appear as typed input in
						// the raw human stream).
						const after = opts.eofAfterBlockedMs === undefined
							? DEFAULT_EOF_AFTER_BLOCKED_MS
							: opts.eofAfterBlockedMs;
						if (after === null || eofTimer) return;
						eofTimer = setTimeout(() => {
							// A human at the terminal owns the session; never yank stdin
							// out from under someone who is typing.
							if (opts.hasHuman?.()) return;
							// NAME THE READER. The verdict already carries the pid, comm
							// and fd0 that proved the block, and without them "sent EOF"
							// is a fact about the harness rather than about the command:
							// HIV-2950 was filed believing the harness injects EOF into
							// commands that never asked for input, which the proven tier
							// cannot do. One nested clause makes the transcript answer
							// the question the ticket had to guess at.
							onData(
								Buffer.from(
									`\n[harness] no input was available; sent EOF after ${Math.round(after / 1000)}s ` +
										`(pid ${verdict.pid} (${verdict.comm}) was reading stdin on ${verdict.fd0}).\n`,
								),
							);
							try {
								child.stdin?.end();
							} catch {
								/* already closed */
							}
						}, after);
						eofTimer.unref?.();
					},
					{},
				);

				const absorb = (chunk: Buffer) => {
					watch.noteOutput();
					opts.onRaw?.(chunk);
					toModel(chunk);
				};
				child.stdout?.on("data", absorb);
				// Under a pty both streams are the slave, so stderr normally sees
				// nothing — wire it anyway for `script`'s own diagnostics.
				child.stderr?.on("data", absorb);
				child.stdin?.on("error", () => {
					/* the child closed it first; not our problem */
				});

				if (child.pid) watch.start();

				// A human's keystrokes, and their window size. Both are scoped to
				// this command: the detach functions run in `cleanup` so input that
				// arrives after it exits cannot leak into the next command.
				const detachInput = opts.attachInput?.((data) => {
					try {
						child.stdin?.write(data);
					} catch {
						/* the child closed stdin, or it is already gone */
					}
					// Typing IS output for the purposes of the stall detector: the
					// human answered, so the command is no longer waiting on nobody.
					watch.noteOutput();
				});
				const detachGeometry = opts.onGeometry?.((r, c) => {
					// From INSIDE the sandbox, against this pty's own device. The
					// sandbox has its own devpts namespace, so the same path on the
					// host is a different terminal and a resize there silently
					// succeeds against the wrong one.
					try {
						spawnFn("stty", ["-F", ttyFile ? readTTYPath(ttyFile) : "", "rows", String(r), "cols", String(c)], {
							stdio: "ignore",
						}).unref?.();
					} catch {
						/* geometry is a nicety; never fail a command over it */
					}
				});

				// ---- abort and timeout, preserving pi's sentinels -------------------
				let timedOut = false;
				/**
				 * WHAT WAS STILL RUNNING, read at the kill and delivered at the close.
				 *
				 * A bare timeout says only that N seconds elapsed. The corpus asks the
				 * next question 9 times in as many words — "does not reveal which
				 * subcommand was slow" — and /proc answers it: at the moment of the
				 * kill the stalled member of a chained command is sitting right there
				 * in the tree we are about to destroy. Read BEFORE `killTree`, because
				 * afterwards there is nothing to read.
				 *
				 * Wrapped whole. A throw in here would escape the timer callback and
				 * lose the kill itself, which costs far more than the diagnosis: an
				 * unreadable /proc (the setuid bwrap frame already is one) must degrade
				 * to "could not tell", never to a surviving process.
				 */
				let postMortem: string | undefined;
				const capturePostMortem = (what: string) => {
					if (postMortem !== undefined) return;
					let live: string | null = null;
					try {
						if (child.pid) {
							live = describeLiveTree(readTree(child.pid, realProcReader()), {
								rootPid: child.pid,
								shellPid: readShellPid(pidFile),
							});
						}
					} catch {
						/* stays null — see above */
					}
					postMortem =
						`\n[harness] ${what}; the output above is everything it had produced. ` +
						`${live ?? "Nothing was left in its process tree to name"}.\n`;
				};

				const timer =
					timeout && timeout > 0
						? setTimeout(() => {
								timedOut = true;
								capturePostMortem(`timed out after ${timeout}s and was killed`);
								killTree(child.pid, pidFile);
							}, timeout * 1000)
						: undefined;
				timer?.unref?.();

				const onAbort = () => {
					capturePostMortem("was cancelled and killed");
					killTree(child.pid, pidFile);
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const cleanup = () => {
					watch.stop();
					if (timer) clearTimeout(timer);
					if (eofTimer) clearTimeout(eofTimer);
					signal?.removeEventListener("abort", onAbort);
					detachInput?.();
					detachGeometry?.();
					// Both scratch files are this command's alone.
					for (const file of [ttyFile, pidFile]) {
						try {
							unlinkSync(file);
						} catch {
							/* never written, or already gone */
						}
					}
				};

				child.on("error", () => {
					// ENOENT on `script`, or an unrunnable binary.
					spawnFailed = true;
					cleanup();
					disablePty();
					reject(new Error("pty-unavailable"));
				});

				child.on("close", (code) => {
					if (spawnFailed) return;
					cleanup();
					// Flush what never got a closing newline: for a command killed
					// mid-run that final frame is the whole post-mortem.
					stripper.close();
					collapser.close();

					// AFTER the flush, and straight through `onData` rather than the
					// collapser: the note is the last word on a severed command, and a
					// repaint collapser could otherwise eat or reorder it. pi's bash
					// tool prepends this whole accumulated snapshot to its own
					// "Command timed out after N seconds", so the note rides along with
					// no change to pi core and no new protocol.
					if (postMortem !== undefined) onData(Buffer.from(postMortem));

					// These two strings are the protocol with pi's error formatting.
					// Anything else here would render as an unexplained failure.
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
						return;
					}
					resolve({ exitCode: code });
				});
			}),
	};
}

/** The `[harness]` note for a blocked verdict, or null while working. */
export function blockedNote(v: BlockedVerdict): string | null {
	const detail = describeVerdict(v);
	return detail ? `[harness] ${detail}` : null;
}
