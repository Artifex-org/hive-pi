/**
 * The one-writer-per-worktree rule: mechanism, scope, and predicate.
 *
 * The lock is a file rather than a module-level Set because a Set has two
 * holes: it is per-process, and — measured, not assumed — it is per-EXTENSION,
 * because pi builds a fresh jiti per extension entry with `moduleCache:false`.
 * Two extensions importing the same module get separate instances, so a shared
 * Set silently forks and each half believes it is the only writer.
 *
 * The scope and the predicate are tested here alongside it because agreeing on
 * the mechanism is not enough: two callers that lock different KEYS for one
 * checkout, or disagree about which roles are writers at all, exclude each
 * other exactly as poorly as two separate Sets do.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireWriterLock,
	isStale,
	isWriterCapable,
	lockPathFor,
	noWriterLock,
	STALE_LOCK_MS,
	writerScopeFor,
} from "../extensions/harness/writer.ts";

const realHome = process.env.HOME;

beforeEach(() => {
	process.env.HOME = mkdtempSync(join(tmpdir(), "hive-pi-lockhome-"));
});
afterEach(() => {
	process.env.HOME = realHome;
});

const payload = { pid: 1234, runId: "run-1", nodeId: "node-a" };

describe("acquireWriterLock", () => {
	it("grants the lock when nothing holds it", () => {
		const lock = acquireWriterLock("/repo/wt", payload);
		expect(lock.acquired).toBe(true);
		lock.release();
	});

	it("REFUSES a second holder for the same worktree", () => {
		const first = acquireWriterLock("/repo/wt", payload);
		const second = acquireWriterLock("/repo/wt", { ...payload, nodeId: "node-b" });

		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(false);
		first.release();
	});

	it("names who holds it, so a stuck run is diagnosable rather than merely blocked", () => {
		const first = acquireWriterLock("/repo/wt", payload);
		const second = acquireWriterLock("/repo/wt", { ...payload, nodeId: "node-b" });

		expect(second.heldBy?.runId).toBe("run-1");
		expect(second.heldBy?.nodeId).toBe("node-a");
		first.release();
	});

	it("allows concurrent writers in DIFFERENT worktrees", () => {
		const a = acquireWriterLock("/repo/wt-a", payload);
		const b = acquireWriterLock("/repo/wt-b", payload);
		expect(a.acquired && b.acquired).toBe(true);
		a.release();
		b.release();
	});

	it("frees the worktree on release", () => {
		const first = acquireWriterLock("/repo/wt", payload);
		first.release();
		const second = acquireWriterLock("/repo/wt", payload);
		expect(second.acquired).toBe(true);
		second.release();
	});

	it("release is idempotent", () => {
		const lock = acquireWriterLock("/repo/wt", payload);
		lock.release();
		expect(() => lock.release()).not.toThrow();
	});

	it("writes the holder's identity to disk", () => {
		const lock = acquireWriterLock("/repo/wt", payload);
		const written = JSON.parse(readFileSync(lockPathFor("/repo/wt"), "utf8"));
		expect(written).toMatchObject({ pid: 1234, runId: "run-1", nodeId: "node-a" });
		expect(typeof written.at).toBe("number");
		lock.release();
	});
});

describe("stale locks", () => {
	it("reclaims one left by a process that died", () => {
		const now = 1_700_000_000_000;
		acquireWriterLock("/repo/wt", payload, now);

		const later = now + STALE_LOCK_MS + 1;
		const reclaimed = acquireWriterLock("/repo/wt", { ...payload, runId: "run-2" }, later);
		expect(reclaimed.acquired).toBe(true);
		reclaimed.release();
	});

	it("does NOT reclaim one that is merely a bit old", () => {
		const now = 1_700_000_000_000;
		const first = acquireWriterLock("/repo/wt", payload, now);
		const soon = now + STALE_LOCK_MS - 1;
		expect(acquireWriterLock("/repo/wt", payload, soon).acquired).toBe(false);
		first.release();
	});

	it("treats an unparseable lock file as debris", () => {
		const path = lockPathFor("/repo/wt");
		mkdirSync(join(process.env.HOME as string, ".pi", "agent", "agenda", "locks"), { recursive: true });
		writeFileSync(path, "not json at all");

		expect(isStale(null, Date.now())).toBe(true);
		const lock = acquireWriterLock("/repo/wt", payload);
		expect(lock.acquired).toBe(true);
		lock.release();
	});
});

describe("isStale", () => {
	const now = 1_700_000_000_000;

	it("is false for a fresh lock", () => {
		expect(isStale({ ...payload, at: now }, now)).toBe(false);
	});
	it("is true at exactly the timeout", () => {
		expect(isStale({ ...payload, at: now - STALE_LOCK_MS }, now)).toBe(true);
	});
	it("is true for a missing payload", () => {
		expect(isStale(null, now)).toBe(true);
	});
});

describe("lockPathFor", () => {
	it("gives different worktrees different files", () => {
		expect(lockPathFor("/a")).not.toBe(lockPathFor("/b"));
	});
	it("is stable for the same worktree", () => {
		expect(lockPathFor("/a")).toBe(lockPathFor("/a"));
	});
	it("produces a filesystem-safe name from an awkward path", () => {
		const path = lockPathFor("/repo/feature/some thing:weird");
		expect(existsSync(join(path, ".."))).toBe(false); // no traversal
		expect(path.endsWith(".lock")).toBe(true);
	});
});

describe("writerScopeFor", () => {
	// The defect this pins: agenda locked the raw `cwd` while subagent walked up
	// to the git root. Two callers in one checkout then hashed different keys and
	// excluded nothing, even though both used the same lock file mechanism.
	it("resolves a subdirectory to the enclosing worktree", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-scope-"));
		mkdirSync(join(root, ".git"));
		const nested = join(root, "web", "src");
		mkdirSync(nested, { recursive: true });

		expect(writerScopeFor(nested)).toBe(writerScopeFor(root));
	});

	it("treats a gwq worktree — where .git is a FILE — as a worktree", () => {
		// A directory-only test would walk straight past every worktree we use.
		const root = mkdtempSync(join(tmpdir(), "hive-pi-scope-wt-"));
		writeFileSync(join(root, ".git"), "gitdir: /repos/hive-pi.git/worktrees/feature\n");
		const nested = join(root, "extensions");
		mkdirSync(nested);

		expect(writerScopeFor(nested)).toBe(writerScopeFor(root));
	});

	it("resolves symlinked checkouts to one key", () => {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-scope-link-"));
		const real = join(base, "real");
		mkdirSync(real);
		mkdirSync(join(real, ".git"));
		const link = join(base, "link");
		symlinkSync(real, link);

		expect(writerScopeFor(link)).toBe(writerScopeFor(real));
	});

	it("keeps separate checkouts separate", () => {
		const base = mkdtempSync(join(tmpdir(), "hive-pi-scope-two-"));
		for (const name of ["a", "b"]) mkdirSync(join(base, name, ".git"), { recursive: true });

		expect(writerScopeFor(join(base, "a"))).not.toBe(writerScopeFor(join(base, "b")));
	});
});

describe("isWriterCapable", () => {
	it("treats an absent tool list as writer-capable", () => {
		// Absent means the role inherits pi's full default set, writers included.
		// Reading it as harmless would run the MOST capable roles unlocked.
		expect(isWriterCapable(undefined)).toBe(true);
		expect(isWriterCapable([])).toBe(true);
	});

	it("is false for a read-only role", () => {
		expect(isWriterCapable(["read", "grep", "find", "ls"])).toBe(false);
	});

	it.each(["write", "edit", "bash"])("is true for a role holding %s", (tool) => {
		expect(isWriterCapable(["read", tool])).toBe(true);
	});

	it("ignores case and surrounding space, as a hand-written frontmatter list has", () => {
		expect(isWriterCapable([" Bash ", "read"])).toBe(true);
	});
});

describe("one writer per worktree, across callers", () => {
	// The whole point of the consolidation: the subagent tool and an agenda
	// worker must exclude each other. Before HIV-1132 they could not — different
	// mechanisms (Set vs file) AND different keys (git root vs raw cwd).
	it("refuses a second writer that names the worktree by a subdirectory", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-xcaller-"));
		mkdirSync(join(root, ".git"));
		const nested = join(root, "web");
		mkdirSync(nested);

		const agenda = acquireWriterLock(root, { pid: 1, runId: "run-1", nodeId: "node-a" });
		expect(agenda.acquired).toBe(true);

		const subagent = acquireWriterLock(nested, { pid: 2, runId: "run-2", nodeId: "node-b" });
		expect(subagent.acquired).toBe(false);
		expect(subagent.heldBy?.runId).toBe("run-1");

		agenda.release();
		expect(acquireWriterLock(nested, { pid: 3, runId: "run-3", nodeId: "node-c" }).acquired).toBe(true);
	});
});

describe("re-entrancy for descendants", () => {
	// A writer that spawns a writer in the SAME worktree is not two writers: the
	// parent is blocked awaiting the child. Refusing it would break a real
	// pattern — an agenda worker delegating through the subagent tool, which is
	// reachable because workers are not spawned with `--no-extensions`.
	const holderPayload = { pid: 1, runId: "run-1", nodeId: "node-a" };
	const childPayload = { pid: 2, runId: "run-2", nodeId: "node-b" };

	it("admits a child carrying the holder's token", () => {
		const held = acquireWriterLock("/repo/wt", holderPayload);
		expect(held.childEnv.PI_HOUSE_WRITER_LOCK).toBeTruthy();

		const child = acquireWriterLock("/repo/wt", childPayload, Date.now(), held.childEnv);
		expect(child.acquired).toBe(true);
		held.release();
	});

	it("still refuses an unrelated process with no token", () => {
		const held = acquireWriterLock("/repo/wt", holderPayload);
		expect(acquireWriterLock("/repo/wt", childPayload, Date.now(), {}).acquired).toBe(false);
		held.release();
	});

	it("refuses a WRONG token — the env var is not a skeleton key", () => {
		const held = acquireWriterLock("/repo/wt", holderPayload);
		const forged = { PI_HOUSE_WRITER_LOCK: "not-the-token" };
		expect(acquireWriterLock("/repo/wt", childPayload, Date.now(), forged).acquired).toBe(false);
		held.release();
	});

	it("does not let one worktree's token open another's lock", () => {
		const a = acquireWriterLock("/repo/wt-a", holderPayload);
		const b = acquireWriterLock("/repo/wt-b", holderPayload);
		// A descendant of A reaching into B is an ordinary contender there.
		expect(acquireWriterLock("/repo/wt-b", childPayload, Date.now(), a.childEnv).acquired).toBe(false);
		a.release();
		b.release();
	});

	it("an inner frame's release does NOT free the worktree", () => {
		// The outermost holder owns the lock's lifetime. If an inner release freed
		// it, the worktree would open up while the outer writer was still running —
		// worse than the deadlock re-entrancy avoids.
		const held = acquireWriterLock("/repo/wt", holderPayload);
		const child = acquireWriterLock("/repo/wt", childPayload, Date.now(), held.childEnv);

		child.release();

		expect(acquireWriterLock("/repo/wt", { pid: 3, runId: "run-3", nodeId: "node-c" }).acquired).toBe(false);
		held.release();
		expect(acquireWriterLock("/repo/wt", { pid: 3, runId: "run-3", nodeId: "node-c" }).acquired).toBe(true);
	});

	it("passes the SAME token further down, so depth is not capped at two", () => {
		const held = acquireWriterLock("/repo/wt", holderPayload);
		const child = acquireWriterLock("/repo/wt", childPayload, Date.now(), held.childEnv);
		const grandchild = acquireWriterLock("/repo/wt", { pid: 3, runId: "run-3", nodeId: "node-c" }, Date.now(), child.childEnv);

		expect(grandchild.acquired).toBe(true);
		held.release();
	});

	it("gives a read-only role a lock that holds and frees nothing", () => {
		const none = noWriterLock();
		expect(none.acquired).toBe(true);
		expect(none.childEnv).toEqual({});
		expect(() => none.release()).not.toThrow();
	});
});
