/**
 * Tell the operator when an agent's command is blocked waiting for input.
 *
 * THE PROBLEM. pi's bash tool has no default timeout, so a command that reads
 * stdin blocks until someone notices. Nothing says so: `onUpdate` fires only
 * when output arrives, which is exactly never for a blocked command, and tool
 * events reach Hive only when the tool ENDS. A stalled `ssh` passphrase prompt
 * and a twenty-minute `go build` are, from outside, the same picture.
 *
 * THE SIGNAL, measured on a launch-shaped srt sandbox (2026-08-26):
 *
 *   case                    state  /proc/<pid>/syscall  fd/0
 *   blocked reading stdin    S     0 0x0  ← read(fd 0)  /dev/pts/N
 *   busy compute             R     —                    /dev/null
 *   sleep 60                 S     ≠ 0                   /dev/null
 *
 * Syscall 0 is `read` on x86_64 and arg0 is the fd, so `0 0x0` is literally
 * "blocked reading fd 0". Walking the tree from the srt pid, exactly ONE of ten
 * processes matched — the command leaf. Every piece of sandbox scaffolding was
 * excluded by syscall number: epoll (281), poll (7), wait4 (61), pselect6 (270).
 *
 * `wchan` is NOT usable — `/proc/self/wchan` reads `0` on this kernel. It is the
 * obvious first guess and it does not work.
 *
 * TWO TIERS, DELIBERATELY UNEQUAL IN CONFIDENCE. `blocked` is a claim and needs
 * proof; `quiet` is a question and says so. `poll`/`select` are excluded from
 * the proven tier ON PURPOSE: their fd set lives behind a pointer in arg1 that
 * /proc does not dereference, so a poller may be waiting on a socket. Two srt
 * processes sit in poll permanently — claiming those are blocked on stdin is the
 * false positive this must never ship.
 */

/** One process, as /proc describes it. */
export interface ProcSnapshot {
	pid: number;
	/** `comm` — /proc/<pid>/stat field 2, without its parentheses. */
	comm: string;
	/** Run state — /proc/<pid>/stat field 3: R S D Z T I. */
	state: string;
	/** /proc/<pid>/syscall field 1, or null when running (the file reads "running"). */
	syscall: number | null;
	/** /proc/<pid>/syscall field 2 — for a read, the fd. */
	arg0: number | null;
	/** readlink /proc/<pid>/fd/0, or null when unreadable. */
	fd0: string | null;
	/**
	 * /proc/<pid>/cmdline, NUL-joined with spaces — the actual argv, which is
	 * what tells `sleep 30` apart from `sleep 3000`. Optional so every existing
	 * fixture stays valid, and null whenever /proc would not say.
	 */
	cmdline?: string | null;
	children: number[];
}

export interface ProcReader {
	/** null when the process is gone or unreadable — never throws. */
	read(pid: number): ProcSnapshot | null;
}

export type BlockedVerdict =
	| { kind: "working" }
	| { kind: "quiet"; quietMs: number }
	| { kind: "blocked"; quietMs: number; pid: number; comm: string; fd0: string };

/**
 * Read-family syscall numbers per architecture, from the kernel's own headers
 * (`asm/unistd_64.h` for x86_64, `asm-generic/unistd.h` for arm64).
 *
 * `splice` IS IN THIS LIST, and leaving it out is not a theoretical gap: GNU
 * `cat` blocks in `splice(0, …)`, not `read`. Measured across the tools that
 * actually matter here —
 *
 *   cat            splice (275 on x64)      ← the one the auto-EOF exists for
 *   bash `read`    read
 *   head/sort/wc   read
 *   python input() read
 *
 * — so a table without splice is silently blind to the single most common
 * accidental-hang command. Every entry takes the fd in arg0, which is what makes
 * the `arg0 === 0` check meaningful for all of them.
 *
 * Numbers are per-ABI, so an unrecognised architecture degrades to the `quiet`
 * tier rather than guessing: calling some unrelated syscall "blocked on stdin"
 * is the failure mode that would train everyone to ignore this signal.
 */
const READ_SYSCALLS: Partial<Record<string, readonly number[]>> = {
	x64: [0, 17, 19, 275, 295], // read, pread64, readv, splice, preadv
	arm64: [63, 67, 65, 76, 69], // read, pread64, readv, splice, preadv
};

/** Defaults, tuned to the two tiers' different burdens of proof. */
export const PROVEN_AFTER_MS = 5_000;
export const QUIET_AFTER_MS = 120_000;
const TICK_MS = 2_000;
const RENOTIFY_MS = 30_000;
/** A runaway fork bomb must not turn the detector into the problem. */
const MAX_TREE = 256;

/**
 * An argv is attacker-adjacent text on its way into the transcript.
 *
 * A command is free to embed ANSI, a newline, or a megabyte of base64 in its own
 * argv, and all three would scribble on the note that quotes it. Control bytes
 * become spaces (so a fake `[harness]` line cannot be forged on a line of its
 * own) and the whole thing is capped.
 */
const MAX_CMDLINE = 200;
export function sanitizeCmdline(s: string): string {
	// eslint-disable-next-line no-control-regex
	const clean = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return clean.length > MAX_CMDLINE ? `${clean.slice(0, MAX_CMDLINE)}…` : clean;
}

/** Parse one process from /proc. Never throws; returns null when unreadable. */
export function realProcReader(): ProcReader {
	// Imported lazily so this module stays importable (and unit-testable) on a
	// platform with no /proc at all.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs") as typeof import("node:fs");

	return {
		read(pid: number): ProcSnapshot | null {
			let comm = "";
			let state = "";
			try {
				const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
				// comm can contain spaces and parentheses, so split on the LAST ')'.
				const close = stat.lastIndexOf(")");
				const open = stat.indexOf("(");
				if (open < 0 || close < open) return null;
				comm = stat.slice(open + 1, close);
				state = stat.slice(close + 2).split(" ")[0] ?? "";
			} catch {
				return null;
			}

			let syscall: number | null = null;
			let arg0: number | null = null;
			try {
				// "running" for a process on-CPU; otherwise "<nr> <arg0> <arg1> …".
				// Unreadable for a process we cannot ptrace — measured on the setuid
				// bwrap in a real sandbox tree, which degrades to not-blocked.
				const parts = fs.readFileSync(`/proc/${pid}/syscall`, "utf8").trim().split(/\s+/);
				const nr = Number.parseInt(parts[0] ?? "", 10);
				if (Number.isFinite(nr)) {
					syscall = nr;
					arg0 = Number.parseInt(parts[1] ?? "", 16);
					if (!Number.isFinite(arg0)) arg0 = null;
				}
			} catch {
				/* stays null */
			}

			let fd0: string | null = null;
			try {
				fd0 = fs.readlinkSync(`/proc/${pid}/fd/0`);
			} catch {
				/* stays null */
			}

			let cmdline: string | null = null;
			try {
				// argv, NUL-separated, usually with a trailing NUL. A kernel thread
				// has an EMPTY cmdline, which must read as "no argv" and not as "".
				const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
				const joined = raw.split("\0").filter((s) => s !== "").join(" ");
				cmdline = joined === "" ? null : sanitizeCmdline(joined);
			} catch {
				/* stays null */
			}

			let children: number[] = [];
			try {
				children = fs
					.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
					.trim()
					.split(/\s+/)
					.map((s) => Number.parseInt(s, 10))
					.filter((n) => Number.isFinite(n));
			} catch {
				/* no children, or unreadable */
			}

			return { pid, comm, state, syscall, arg0, fd0, cmdline, children };
		},
	};
}

/** Breadth-first walk of a process and its descendants, bounded. */
export function readTree(root: number, reader: ProcReader, cap = MAX_TREE): ProcSnapshot[] {
	const out: ProcSnapshot[] = [];
	const seen = new Set<number>();
	const stack = [root];
	while (stack.length > 0 && out.length < cap) {
		const pid = stack.pop()!;
		if (seen.has(pid)) continue;
		seen.add(pid);
		const snap = reader.read(pid);
		if (!snap) continue;
		out.push(snap);
		stack.push(...snap.children);
	}
	return out;
}

/** Is this fd 0 a place a human could actually type into? */
function readableStdin(fd0: string | null): boolean {
	if (!fd0) return false;
	// A pty under PTY mode; a pipe under the stock ops (where a hung read is
	// still worth reporting even though EOF normally arrives at once).
	return fd0.startsWith("/dev/pts/") || fd0.startsWith("pipe:");
}

/**
 * Classify a process tree. PURE — the whole detector is testable from fixtures
 * with no processes at all, which is why `ProcReader` is the only impure seam.
 */
export function classify(
	tree: readonly ProcSnapshot[],
	quietMs: number,
	arch: string = process.arch,
	opts: { provenAfterMs?: number; quietAfterMs?: number } = {},
): BlockedVerdict {
	const provenAfter = opts.provenAfterMs ?? PROVEN_AFTER_MS;
	const quietAfter = opts.quietAfterMs ?? QUIET_AFTER_MS;

	if (tree.length === 0) return { kind: "working" };
	if (quietMs < provenAfter) return { kind: "working" };

	const reads = READ_SYSCALLS[arch];
	if (reads) {
		for (const p of tree) {
			if (
				p.state === "S" &&
				p.syscall !== null &&
				reads.includes(p.syscall) &&
				p.arg0 === 0 &&
				readableStdin(p.fd0)
			) {
				return { kind: "blocked", quietMs, pid: p.pid, comm: p.comm, fd0: p.fd0! };
			}
		}
	}

	// The weak tier. A single running or uninterruptible process anywhere in the
	// tree means work is happening — which is what keeps a long silent compile
	// from ever reaching even this.
	if (quietMs >= quietAfter && tree.every((p) => p.state === "S" || p.state === "I")) {
		return { kind: "quiet", quietMs };
	}
	return { kind: "working" };
}

/** Human-readable one-liner for the `[harness]` note. */
export function describeVerdict(v: BlockedVerdict): string | null {
	const secs = (ms: number) => Math.round(ms / 1000);
	if (v.kind === "blocked") {
		return `no output for ${secs(v.quietMs)}s — pid ${v.pid} (${v.comm}) is blocked reading stdin on ${v.fd0}.`;
	}
	if (v.kind === "quiet") {
		return `no output for ${secs(v.quietMs)}s and nothing in this command's process tree is running. Waiting on input, or on the network?`;
	}
	return null;
}

/**
 * The two frames that are ALWAYS there and are never the answer.
 *
 * `script` is the root we spawned; beneath it sits the bootstrap `$SHELL -c`
 * whose pid the bootstrap wrote to `PI_PTY_PID`. Measured on the real spawn
 * shape with SHELL=bash AND SHELL=zsh (2026-08-28): three frames, `script` →
 * shell → `sleep 30`, for both `sleep 30` and `echo first; sleep 30`. Neither
 * shell exec-optimises the tail command out from under `eval`.
 *
 * The shell is dropped by pid AND by `comm`, not by pid alone. A shell that DID
 * exec into the command keeps the recorded pid while becoming the command, and
 * a pid-only drop would erase the single frame that answers the question.
 */
const SHELL_COMMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
/** Enough to see a chain; not enough to bury the note under a fork bomb. */
const MAX_NAMED = 3;

/**
 * Name what is still alive in a command's process tree, leaf-first.
 *
 * PURE, exactly like `classify`, so the formatting is testable from fixtures
 * with no processes at all. Returns null when nothing but the scaffolding is
 * left — the caller must then say it could not tell rather than invent a name.
 */
export function describeLiveTree(
	tree: readonly ProcSnapshot[],
	opts: { rootPid: number; shellPid?: number },
): string | null {
	const byPid = new Map(tree.map((p) => [p.pid, p]));

	// Depth from the root, so "leaf-first" is a fact about the tree and not an
	// accident of the order `readTree` happened to pop its stack in.
	const depth = new Map<number, number>();
	const walk = (pid: number, d: number): void => {
		if (depth.has(pid)) return;
		depth.set(pid, d);
		for (const child of byPid.get(pid)?.children ?? []) walk(child, d + 1);
	};
	walk(opts.rootPid, 0);

	const live = tree.filter((p) => {
		if (p.pid === opts.rootPid) return false;
		if (p.pid === opts.shellPid && SHELL_COMMS.has(p.comm)) return false;
		return true;
	});
	if (live.length === 0) return null;

	live.sort((a, b) => (depth.get(b.pid) ?? 0) - (depth.get(a.pid) ?? 0) || a.pid - b.pid);
	const name = (p: ProcSnapshot) => {
		// `comm` is truncated to 15 bytes by the kernel, so it is the fallback and
		// never the first choice — but it is always there.
		const label = p.cmdline ? sanitizeCmdline(p.cmdline) : p.comm;
		return `${label === "" ? p.comm : label} (pid ${p.pid})`;
	};

	if (live.length === 1) {
		// Only safe to say with ONE survivor: with `a & b` both alive, "earlier
		// had finished" would contradict the list standing next to it.
		return `${name(live[0]!)} was still running; anything earlier in the command had already finished`;
	}
	const shown = live.slice(0, MAX_NAMED).map(name);
	const rest = live.length - shown.length;
	return `${live.length} processes were still running: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/**
 * Polls a command's process tree and reports transitions.
 *
 * One watch per exec: each call needs its own quiet clock and its own root.
 */
export class StdinWatch {
	private timer: NodeJS.Timeout | undefined;
	/**
	 * Set in the constructor BODY, not as a field initializer: initializers run
	 * before the constructor, so `opts.now` is not yet in scope and the clock
	 * would silently be the wall clock while every later reading used the
	 * injected one. A watch built with a fake clock then computes a quiet span
	 * of `fakeNow - Date.now()` — hugely negative — and never reports anything.
	 */
	private lastOutputMs: number;
	private current: BlockedVerdict = { kind: "working" };
	private lastNotifiedKind: BlockedVerdict["kind"] = "working";
	private lastNotifiedMs = 0;

	constructor(
		private readonly rootPid: number,
		private readonly reader: ProcReader,
		private readonly notify: (v: BlockedVerdict) => void,
		private readonly opts: {
			tickMs?: number;
			provenAfterMs?: number;
			quietAfterMs?: number;
			renotifyMs?: number;
			now?: () => number;
		} = {},
	) {
		this.lastOutputMs = this.now();
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Called from the raw byte sink: output means it is not blocked. */
	noteOutput(): void {
		this.lastOutputMs = this.now();
		if (this.current.kind !== "working") {
			this.current = { kind: "working" };
			// A resolved block is news — the note on screen must stop claiming the
			// command is stuck once bytes start flowing again.
			this.lastNotifiedKind = "working";
			this.notify(this.current);
		}
	}

	/** Evaluate once. Exposed so a test can drive it without a timer. */
	tick(): void {
		const quietMs = this.now() - this.lastOutputMs;
		const tree = readTree(this.rootPid, this.reader);
		const verdict = classify(tree, quietMs, process.arch, this.opts);
		this.current = verdict;

		if (verdict.kind === "working") return;
		const renotify = this.opts.renotifyMs ?? RENOTIFY_MS;
		const changed = verdict.kind !== this.lastNotifiedKind;
		if (changed || this.now() - this.lastNotifiedMs >= renotify) {
			this.lastNotifiedKind = verdict.kind;
			this.lastNotifiedMs = this.now();
			this.notify(verdict);
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
		// Never hold the process open for a diagnostic.
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	verdict(): BlockedVerdict {
		return this.current;
	}
}
