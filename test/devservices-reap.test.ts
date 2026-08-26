/**
 * devservices reaping (HIV-1980).
 *
 * This code DELETES DATABASES, so the assertions that earn their keep are the
 * refusals: it must not touch a live session's cluster, must not delete a
 * directory whose server it could not stop (the removal would free no inodes
 * anyway — open fds pin them), and must do nothing at all inside a sandbox,
 * where /proc is namespace-local and every liveness answer would be a guess.
 */

import { describe, expect, it, vi } from "vitest";

import devservicesExtension, { SWEEP_DELAY_MS } from "../extensions/devservices/index.ts";
import { createFakePi } from "./fake-pi.ts";

import {
	DIR_PREFIX,
	HEARTBEAT_FILE,
	MAX_SWEEP_DIRS,
	STALE_AFTER_MS,
	dataDirIn,
	isAbandoned,
	reapOnce,
	stopPostmaster,
	type ReapDeps,
} from "../extensions/devservices/reap.ts";

const NOW = 1_800_000_000_000;
const TMP = "/tmp/claude";

interface World {
	/** dir name -> heartbeat value ("" = file exists but unparseable, null = absent) */
	heartbeats: Record<string, number | string | null>;
	/** dir name -> mtime ms */
	mtimes: Record<string, number>;
	/** Entries of a NESTED tmp root, e.g. what a sandbox's TMPDIR=/tmp/claude holds. */
	nested?: Record<string, string[]>;
	/** dataDir -> host pid of a live postmaster */
	servers: Record<string, number>;
	sandboxed?: boolean;
	/** pids that ignore SIGQUIT */
	unkillable?: number[];
}

function deps(world: World): { deps: ReapDeps; removed: string[]; signalled: number[] } {
	const removed: string[] = [];
	const signalled: number[] = [];
	const servers = { ...world.servers };
	return {
		removed,
		signalled,
		deps: {
			now: () => NOW,
			listDir: (dir) => {
				if (dir === TMP) return [...Object.keys(world.mtimes), ...Object.keys(world.nested ?? {})];
				const entries = world.nested?.[dir.split("/").pop() ?? ""];
				if (!entries) throw new Error("ENOTDIR");
				return entries;
			},
			isDir: (target) => Boolean(world.nested?.[target.split("/").pop() ?? ""]),
			mtimeMs: (target) => {
				const name = target.split("/").pop() ?? "";
				return world.mtimes[name] ?? null;
			},
			readText: (file) => {
				const parts = file.split("/");
				if (parts.pop() !== HEARTBEAT_FILE) return null;
				const beat = world.heartbeats[parts.pop() ?? ""];
				if (beat === undefined || beat === null) return null;
				return String(beat);
			},
			findPostmaster: (dataDir) => servers[dataDir] ?? null,
			kill: (pid) => {
				signalled.push(pid);
				if (world.unkillable?.includes(pid)) return;
				for (const [dir, p] of Object.entries(servers)) if (p === pid) delete servers[dir];
			},
			removeTree: (target) => {
				removed.push(target.split("/").pop() ?? "");
			},
			wait: async () => undefined,
			sandboxed: () => Boolean(world.sandboxed),
		},
	};
}

const stale = NOW - STALE_AFTER_MS - 1;
const recent = NOW - 1_000;

describe("isAbandoned", () => {
	const d = (w: World) => deps(w).deps;

	it("trusts a fresh heartbeat over an old directory", () => {
		// The steady state for a long-lived session: the directory was created
		// days ago and is very much in use.
		const world: World = { heartbeats: { a: recent }, mtimes: { a: stale }, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/a`)).toBe(false);
	});

	it("calls a stale heartbeat abandoned", () => {
		const world: World = { heartbeats: { a: stale }, mtimes: { a: recent }, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/a`)).toBe(true);
	});

	it("does NOT treat a missing heartbeat as abandoned when the dir is recent", () => {
		// Two real cases this protects: a peer part-way through initdb, and — on
		// the first deploy of this code — every already-running session, because a
		// live pi keeps the extension it loaded and never starts a heartbeat.
		const world: World = { heartbeats: {}, mtimes: { a: recent }, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/a`)).toBe(false);
	});

	it("falls back to mtime for the pre-heartbeat litter that started this", () => {
		// `/tmp/claude/pi-devservices-2` from 2026-08-10: no heartbeat, ancient.
		const world: World = { heartbeats: {}, mtimes: { a: stale }, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/a`)).toBe(true);
	});

	it("ignores an unparseable heartbeat rather than believing it", () => {
		const world: World = { heartbeats: { a: "garbage" }, mtimes: { a: recent }, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/a`)).toBe(false);
	});

	it("keeps a directory it cannot stat — absence of evidence is not evidence", () => {
		const world: World = { heartbeats: {}, mtimes: {}, servers: {} };
		expect(isAbandoned(d(world), `${TMP}/gone`)).toBe(false);
	});
});

describe("stopPostmaster", () => {
	it("succeeds when there is no server at all", async () => {
		const { deps: d, signalled } = deps({ heartbeats: {}, mtimes: {}, servers: {} });
		expect(await stopPostmaster(d, `${TMP}/a/pg`)).toBe(true);
		expect(signalled).toEqual([]);
	});

	it("signals the pid found in /proc, not one read from postmaster.pid", async () => {
		// The whole reason this module exists. A sandboxed session's
		// postmaster.pid records a pid from ITS namespace — measured: 10054 while
		// the real host pid was 2857879 — so signalling that number would hit an
		// unrelated host process.
		const { deps: d, signalled } = deps({ heartbeats: {}, mtimes: {}, servers: { [`${TMP}/a/pg`]: 2857879 } });
		expect(await stopPostmaster(d, `${TMP}/a/pg`)).toBe(true);
		expect(signalled).toEqual([2857879]);
	});

	it("reports failure when the server outlives the signal", async () => {
		const { deps: d } = deps({
			heartbeats: {},
			mtimes: {},
			servers: { [`${TMP}/a/pg`]: 99 },
			unkillable: [99],
		});
		expect(await stopPostmaster(d, `${TMP}/a/pg`)).toBe(false);
	});
});

describe("reapOnce", () => {
	it("collects abandoned litter", async () => {
		const world: World = {
			heartbeats: {},
			mtimes: { [`${DIR_PREFIX}2`]: stale, [`${DIR_PREFIX}52`]: stale },
			servers: {},
		};
		const { deps: d, removed } = deps(world);
		const out = await reapOnce(d, TMP, null);
		expect(removed.sort()).toEqual([`${DIR_PREFIX}2`, `${DIR_PREFIX}52`]);
		expect(out.reaped).toHaveLength(2);
	});

	it("never collects the session's OWN cluster, however it looks", async () => {
		const own = `${DIR_PREFIX}9-abcd1234`;
		const world: World = { heartbeats: {}, mtimes: { [own]: stale }, servers: {} };
		const { deps: d, removed } = deps(world);
		const out = await reapOnce(d, TMP, `${TMP}/${own}`);
		expect(removed).toEqual([]);
		expect(out.verdicts[own]).toBe("own");
	});

	it("leaves a live peer alone", async () => {
		const live = `${DIR_PREFIX}2-7b7a51b2`;
		const world: World = { heartbeats: { [live]: recent }, mtimes: { [live]: stale }, servers: {} };
		const { deps: d, removed } = deps(world);
		const out = await reapOnce(d, TMP, null);
		expect(removed).toEqual([]);
		expect(out.verdicts[live]).toBe("fresh");
	});

	it("will NOT kill a running server that never had a heartbeat (HIV-1980)", async () => {
		// The rollout hazard, measured at the moment of the first deploy: every
		// already-running session has a cluster with no heartbeat (a live pi keeps
		// the extension it loaded), and two of them were ALREADY past the
		// staleness threshold on directory mtime. Without this guard the first
		// sweep SIGQUITs two working databases.
		const dir = `${DIR_PREFIX}2-7b7a51b2`;
		const world: World = {
			heartbeats: {}, // never reported
			mtimes: { [dir]: stale },
			servers: { [dataDirIn(`${TMP}/${dir}`)]: 2857879 },
		};
		const { deps: d, removed, signalled } = deps(world);
		const out = await reapOnce(d, TMP, null);
		expect(out.verdicts[dir]).toBe("unknown-owner");
		expect(signalled).toEqual([]);
		expect(removed).toEqual([]);
	});

	it("DOES reap a live server whose heartbeat went stale — a real orphan", async () => {
		// The ambiguity is only about absence. Once a session has reported even
		// once, silence since is evidence, and this must still collect.
		const dir = `${DIR_PREFIX}9-abcd`;
		const world: World = {
			heartbeats: { [dir]: stale },
			mtimes: { [dir]: stale },
			servers: { [dataDirIn(`${TMP}/${dir}`)]: 777 },
		};
		const { deps: d, removed, signalled } = deps(world);
		await reapOnce(d, TMP, null);
		expect(signalled).toEqual([777]);
		expect(removed).toEqual([dir]);
	});

	it("still reaps heartbeat-less litter when NO server is running", async () => {
		// The 2026-08-10 directories: no heartbeat, ancient, no postmaster. The
		// guard above must not spare these — they are the whole reason for this.
		const world: World = {
			heartbeats: {},
			mtimes: { [`${DIR_PREFIX}2`]: stale, [`${DIR_PREFIX}52`]: stale },
			servers: {},
		};
		const { deps: d, removed } = deps(world);
		await reapOnce(d, TMP, null);
		expect(removed.sort()).toEqual([`${DIR_PREFIX}2`, `${DIR_PREFIX}52`]);
	});

	it("stops the server BEFORE removing — and refuses to remove if it could not", async () => {
		// Unlinking files a live postgres holds open frees no inodes: the fds pin
		// them. A removal that "succeeded" there would reclaim nothing while
		// reporting success — failing silently at its only job.
		const dir = `${DIR_PREFIX}7-deadbeef`;
		const world: World = {
			// A stale heartbeat, not a missing one: with a live server, "never
			// reported" is ambiguous and now keeps the directory (see
			// "unknown-owner"). This test is about a REAL orphan reaching the stop.
			heartbeats: { [dir]: stale },
			mtimes: { [dir]: stale },
			servers: { [dataDirIn(`${TMP}/${dir}`)]: 4242 },
			unkillable: [4242],
		};
		const { deps: d, removed } = deps(world);
		const out = await reapOnce(d, TMP, null);
		expect(removed).toEqual([]);
		expect(out.verdicts[dir]).toBe("server-would-not-stop");
	});

	it("stops a stoppable server and then removes", async () => {
		const dir = `${DIR_PREFIX}7-deadbeef`;
		const world: World = {
			heartbeats: { [dir]: stale }, // reported once, then went silent
			mtimes: { [dir]: stale },
			servers: { [dataDirIn(`${TMP}/${dir}`)]: 4242 },
		};
		const { deps: d, removed, signalled } = deps(world);
		await reapOnce(d, TMP, null);
		expect(signalled).toEqual([4242]);
		expect(removed).toEqual([dir]);
	});

	it("does NOTHING inside a sandbox", async () => {
		// /proc is namespace-local there, so a sandboxed sweeper cannot see a host
		// postmaster and would delete live clusters it is blind to.
		const world: World = {
			heartbeats: {},
			mtimes: { [`${DIR_PREFIX}2`]: stale },
			servers: {},
			sandboxed: true,
		};
		const { deps: d, removed } = deps(world);
		const out = await reapOnce(d, TMP, null);
		expect(out.skipped).toBe("sandboxed");
		expect(removed).toEqual([]);
	});

	it("finds litter one level down, under a SANDBOX's own TMPDIR (HIV-1980)", async () => {
		// The defect the first version shipped with, and the reason this test
		// exists. Clusters are created under the CREATING session's TMPDIR, and a
		// sandboxed session runs with TMPDIR=/tmp/claude — so every leaked
		// directory sits one level below the host's os.tmpdir(). The sweeper
		// looked only in /tmp, found nothing, and reported success while 244k
		// files sat one directory away. No injected-tmp unit test could see it;
		// running the deployed code on the real machine did.
		const world: World = {
			heartbeats: {},
			mtimes: {},
			nested: { claude: [`${DIR_PREFIX}2`, `${DIR_PREFIX}52`, "unrelated"] },
			servers: {},
		};
		// The nested entries need ages; they are looked up by basename.
		world.mtimes = {};
		const { deps: base, removed } = deps(world);
		const d: ReapDeps = { ...base, mtimeMs: () => stale };
		const out = await reapOnce(d, TMP, null);
		expect(removed.sort()).toEqual([`${DIR_PREFIX}2`, `${DIR_PREFIX}52`]);
		expect(out.reaped).toHaveLength(2);
	});

	it("does not descend past one level, and ignores unreadable neighbours", async () => {
		const world: World = {
			heartbeats: {},
			mtimes: {},
			nested: { claude: ["deeper"], other: [] },
			servers: {},
		};
		const { deps: base, removed } = deps(world);
		const d: ReapDeps = { ...base, mtimeMs: () => stale };
		await reapOnce(d, TMP, null);
		expect(removed).toEqual([]);
	});

	it("ignores directories that are not ours", async () => {
		const world: World = { heartbeats: {}, mtimes: { "some-other-thing": stale }, servers: {} };
		const { deps: d, removed } = deps(world);
		await reapOnce(d, TMP, null);
		expect(removed).toEqual([]);
	});

	it("bounds one pass so a sweep never becomes the workload", async () => {
		const mtimes: Record<string, number> = {};
		for (let i = 0; i < MAX_SWEEP_DIRS + 20; i++) mtimes[`${DIR_PREFIX}${i}`] = stale;
		const { deps: d, removed } = deps({ heartbeats: {}, mtimes, servers: {} });
		await reapOnce(d, TMP, null);
		expect(removed).toHaveLength(MAX_SWEEP_DIRS);
	});

	it("survives a directory that throws mid-pass", async () => {
		const world: World = {
			heartbeats: {},
			mtimes: { [`${DIR_PREFIX}bad`]: stale, [`${DIR_PREFIX}good`]: stale },
			servers: {},
		};
		const { deps: base, removed } = deps(world);
		const d: ReapDeps = {
			...base,
			removeTree: (target) => {
				if (target.endsWith("bad")) throw new Error("EACCES");
				base.removeTree(target);
			},
		};
		await reapOnce(d, TMP, null);
		expect(removed).toEqual([`${DIR_PREFIX}good`]);
	});

	it("returns quietly when the tmp directory cannot be listed", async () => {
		const { deps: base } = deps({ heartbeats: {}, mtimes: {}, servers: {} });
		const d: ReapDeps = {
			...base,
			listDir: () => {
				throw new Error("ENOENT");
			},
		};
		await expect(reapOnce(d, TMP, null)).resolves.toMatchObject({ reaped: [] });
	});
});

describe("the wiring", () => {
	/**
	 * The half no unit test covered, and the half that decides whether any of
	 * this ever runs. Precedent: `kernel-session.test.ts` has "the EXTENSION
	 * reaps on session_shutdown — the wiring, not just the method", written
	 * after the same class of gap.
	 */
	it("registers a session_start handler that schedules a sweep", async () => {
		vi.useFakeTimers();
		try {
			const pi = createFakePi();
			devservicesExtension(pi.api);

			expect(pi.handlers.has("session_start"), "no session_start handler registered").toBe(true);

			await pi.emit({ type: "session_start" });
			// The handler must RETURN immediately — pi awaits handlers serially, so
			// a sweep done inline would be the agent loop.
			expect(vi.getTimerCount()).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("schedules the sweep soon enough that a short session still runs it", () => {
		// A headless `pi -p` finishes in a few seconds, and the timer is unref'd,
		// so a long delay means the process exits first and the sweep never
		// happens. Measured at 20s: a real session ran to completion and collected
		// nothing. This bound is what keeps the feature observable AND effective.
		expect(SWEEP_DELAY_MS).toBeLessThanOrEqual(5_000);
	});
});
