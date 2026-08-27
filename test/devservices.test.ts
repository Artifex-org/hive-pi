import { describe, expect, it } from "vitest";
import {
	BASE_DIR_ENV,
	baseDirCandidates,
	databaseUrl,
	dataDirFor,
	freePort,
	newInstanceToken,
	pgPaths,
	resolveBaseDir,
	serverArgs,
	startFailureHint,
	sweepRoots,
} from "../extensions/devservices/pg.ts";

// The devservices extension's pure core (HIV-1636). The real
// initdb/server/psql round trip is the gated integration test in
// devservices-integration.test.ts.

describe("serverArgs", () => {
	it("runs TCP-only — srt's seccomp blocks socket(AF_UNIX)", () => {
		const args = serverArgs(15432);
		expect(args).toContain("unix_socket_directories=");
		expect(args).toContain("listen_addresses=127.0.0.1");
		expect(args).toContain("port=15432");
	});

	it("turns durability off — the database is disposable by contract", () => {
		expect(serverArgs(1).join(" ")).toContain("fsync=off");
	});

	it("keeps parallel-query segments off /dev/shm — a small tmpfs in the sandbox", () => {
		// posix DSM dies resizing under a concurrent full-suite load (57P03
		// cascade, papercut 2026-08-20); mmap lands in the /tmp data dir.
		expect(serverArgs(1).join(" ")).toContain("dynamic_shared_memory_type=mmap");
	});

	it("checkpoints every 30s — TRUNCATE garbage is only unlinked at a checkpoint (HIV-2407)", () => {
		// TRUNCATE reassigns the relfilenode of the table and every index/toast
		// relation; the old file goes to zero bytes and is unlinked at the NEXT
		// checkpoint. A suite that resets between tests therefore piles up one
		// zero-byte file per relation per reset, bounded only by checkpoint
		// cadence — and /tmp is tmpfs with a fixed, GLOBAL inode budget shared
		// with every other process on the machine.
		//
		// Measured 2026-08-24: one data dir at 805,122 inodes, 99.3% of the
		// files zero bytes, /tmp at 81% of its 1,048,576 inodes while `df -h`
		// read 7%. Identical 95s workload: 11,312 files at the 5-minute default
		// against 1,157 with this setting, the first climbing monotonically and
		// the second sawtoothing.
		//
		// Pinned as a VALUE, not just presence: the bound is the cadence, so a
		// well-meaning bump back toward the default silently restores the leak.
		expect(serverArgs(1).join(" ")).toContain("checkpoint_timeout=30s");
	});
});

describe("pgPaths", () => {
	it("defaults under ~/.hive/tools and honours the override", () => {
		expect(pgPaths({}, "/home/x").root).toBe("/home/x/.hive/tools/postgres");
		expect(pgPaths({ PI_DEVSERVICES_PG: "/opt/pg" }, "/home/x").bin).toBe("/opt/pg/bin");
	});
});

describe("databaseUrl", () => {
	it("builds a loopback URL for the trust-auth dev user", () => {
		expect(databaseUrl(15432, "app")).toBe("postgresql://dev@127.0.0.1:15432/app");
	});
});

describe("dataDirFor (HIV-1966)", () => {
	it("does NOT collide for the same pid — the sandbox reuses low pids", () => {
		// The measured bug: a sandboxed session has its own PID namespace, so pi
		// was pid 2 in several live sessions at once while /tmp stayed shared.
		// Two sessions then shared a data directory and the second died on
		// `FATAL: pre-existing shared memory block ... is still in use`.
		const a = dataDirFor("aaaaaaaa", "/tmp", 2);
		const b = dataDirFor("bbbbbbbb", "/tmp", 2);
		expect(a).not.toBe(b);
		expect(a).toBe("/tmp/pi-devservices-2-aaaaaaaa/pg");
	});

	it("keeps the pid in the name so a directory is still traceable to a process", () => {
		expect(dataDirFor("tok", "/tmp", 4242)).toContain("pi-devservices-4242-");
	});

	it("mints a distinct token per call", () => {
		const tokens = new Set(Array.from({ length: 20 }, () => newInstanceToken()));
		expect(tokens.size).toBe(20);
		for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("startFailureHint", () => {
	it("names the recovery for the shared-memory collision", () => {
		// The papercut was not only the collision: the tool reported the raw FATAL
		// and stopped, so three sessions abandoned the task instead of recovering.
		const hint = startFailureHint("FATAL:  pre-existing shared memory block (key 5432001) is still in use");
		expect(hint).toContain("pg_ctl");
		expect(hint).toContain("-m immediate stop");
	});

	it("distinguishes a port race from a broken install", () => {
		expect(startFailureHint("could not bind IPv4 address")).toContain("Retry");
		expect(startFailureHint("error while loading shared libraries: libxml2.so.2")).toContain(
			"install-devservices-postgres",
		);
	});

	it("stays silent on an error it cannot classify — a wrong hint is worse than none", () => {
		expect(startFailureHint("something nobody has seen before")).toBeNull();
	});
});

describe("freePort", () => {
	it("returns a bindable ephemeral port", async () => {
		const port = await freePort();
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThan(65536);
	});
});

describe("base dir resolution (HIV-2407)", () => {
	// The failure being prevented: /tmp is tmpfs with a FIXED, GLOBAL inode
	// budget, so a DB suite's relation-file churn exhausts it and every other
	// process on the box starts failing with ENOSPC — including the coding
	// agent's own tooling, which writes each command's output under /tmp.

	it("prefers ~/.pi over tmpfs — disk has no fixed inode budget", () => {
		const [first] = baseDirCandidates({}, "/home/dev", "/tmp");
		expect(first).toBe("/home/dev/.pi/devservices");
	});

	it("always keeps tmp as the last resort", () => {
		expect(baseDirCandidates({}, "/home/dev", "/tmp").at(-1)).toBe("/tmp");
	});

	it("lets an operator override the base", () => {
		const cands = baseDirCandidates({ [BASE_DIR_ENV]: "/mnt/fast" }, "/home/dev", "/tmp");
		expect(cands[0]).toBe("/mnt/fast");
		expect(cands.at(-1)).toBe("/tmp");
	});

	it("ignores a blank override rather than creating an empty-string path", () => {
		expect(baseDirCandidates({ [BASE_DIR_ENV]: "   " }, "/home/dev", "/tmp")[0]).toBe("/home/dev/.pi/devservices");
	});

	it("does not list tmp twice when it IS the preferred base", () => {
		expect(baseDirCandidates({ [BASE_DIR_ENV]: "/tmp" }, "/home/dev", "/tmp")).toEqual(["/tmp"]);
	});

	it("FALLS BACK when the preferred base is not writable", () => {
		// The whole reason the probe exists: srt is allow-only for writes, and a
		// node whose policy omits ~/.pi must keep working, not lose its database.
		const tried: string[] = [];
		const dir = resolveBaseDir(
			["/home/dev/.pi/devservices", "/tmp"],
			(d) => {
				tried.push(d);
				if (d !== "/tmp") throw Object.assign(new Error("EROFS"), { code: "EROFS" });
			},
			() => {},
			() => false,
		);
		expect(dir).toBe("/tmp");
		expect(tried).toEqual(["/home/dev/.pi/devservices", "/tmp"]);
	});

	it("uses the preferred base when it can be created", () => {
		const dir = resolveBaseDir(["/home/dev/.pi/devservices", "/tmp"], () => {}, () => {}, () => false);
		expect(dir).toBe("/home/dev/.pi/devservices");
	});

	it("disables CoW only on a directory it actually created", () => {
		// chattr +C only takes effect on an EMPTY directory, so running it on a
		// base that already holds clusters would be a silent no-op we'd trust.
		const cowed: string[] = [];
		resolveBaseDir(["/base"], () => {}, (d) => cowed.push(d), () => true);
		expect(cowed).toEqual([]);
		resolveBaseDir(["/base"], () => {}, (d) => cowed.push(d), () => false);
		expect(cowed).toEqual(["/base"]);
	});

	it("never throws out to the caller — a dev DB is not worth a hard failure", () => {
		const dir = resolveBaseDir(
			["/a", "/b"],
			() => {
				throw new Error("nope");
			},
			() => {},
			() => false,
		);
		expect(dir).toBe("/b");
	});
});

describe("sweepRoots (HIV-2407)", () => {
	it("still sweeps tmp after the move — live sessions keep the OLD module", () => {
		// pi loads this extension at session start and holds it for the session's
		// life, so sessions already running when this ships keep creating
		// clusters under os.tmpdir() for hours. Dropping that root strands them.
		expect(sweepRoots("/home/dev/.pi/devservices", "/tmp")).toEqual(["/home/dev/.pi/devservices", "/tmp"]);
	});

	it("does not sweep the same root twice", () => {
		expect(sweepRoots("/tmp", "/tmp")).toEqual(["/tmp"]);
	});
});
