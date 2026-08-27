/**
 * The artifact store's rules.
 *
 * Everything here pins a DECISION rather than an implementation: which way a
 * truncation faces, whether a reference can name a path, what happens at the
 * caps, and whether a fork keeps its history's references resolvable. The
 * extension's wiring — where the directory comes from, what the tools answer —
 * is `artifacts-extension.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	ARTIFACT_SCHEME,
	MAX_ARTIFACTS_PER_SESSION,
	MAX_ARTIFACT_BYTES,
	PREVIEW_BYTES,
	adoptDir,
	artifactDirFor,
	boundForReader,
	listArtifacts,
	nextId,
	parseRef,
	readArtifact,
	resolveArtifactDir,
	sanitizeKind,
	spill,
	writeArtifact,
} from "../extensions/artifacts/store.ts";

const created: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hive-pi-artifacts-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("where a store lives", () => {
	// The directory has to be derivable from the session file by anyone — a
	// human looking at ~/.pi/agent/sessions, a forked session, another
	// extension. If this were a hash or a uuid, none of them could find it.
	it("is the session jsonl path with .jsonl stripped", () => {
		expect(artifactDirFor("/s/2026-08-16T09-00-00_abc123.jsonl")).toBe("/s/2026-08-16T09-00-00_abc123");
	});

	it("leaves a path that is not a jsonl alone rather than mangling it", () => {
		expect(artifactDirFor("/s/session")).toBe("/s/session");
	});
});

describe("resolution order", () => {
	// THE decision that makes child adoption work. A child pi that preferred its
	// own session file would write its findings into a directory the parent
	// never reads, which is precisely the loss the whole extension exists to
	// prevent — so an inherited env var beats everything.
	it("prefers an inherited PI_ARTIFACT_DIR over this session's own file", () => {
		const resolved = resolveArtifactDir({
			envDir: "/parent/store",
			sessionFile: "/child/2026_x.jsonl",
			tmpDir: "/tmp",
			pid: 9,
		});
		expect(resolved).toEqual({ dir: "/parent/store", source: "env" });
	});

	it("uses the session file when nothing was inherited", () => {
		const resolved = resolveArtifactDir({ sessionFile: "/s/2026_x.jsonl", tmpDir: "/tmp", pid: 9 });
		expect(resolved).toEqual({ dir: "/s/2026_x", source: "session" });
	});

	// Not hypothetical: getSessionFile() returns undefined for an unpersisted
	// session, and the fake pi does not implement it at all. Without a fallback
	// every spill in those sessions would throw instead of degrading.
	it("falls back to a per-process tmpdir when there is no session file", () => {
		const resolved = resolveArtifactDir({ tmpDir: "/tmp", pid: 4242 });
		expect(resolved).toEqual({ dir: "/tmp/pi-artifacts-4242", source: "fallback" });
	});

	it("ignores a blank env var rather than treating it as a directory named ''", () => {
		// An exported-but-empty variable is the shape a shell produces by
		// accident; resolving it to "" would put artifacts in the process cwd.
		expect(resolveArtifactDir({ envDir: "  ", sessionFile: "/s/a.jsonl", tmpDir: "/tmp", pid: 1 }).source).toBe(
			"session",
		);
	});
});

describe("references are pointers, never paths", () => {
	it("accepts both the scheme and a bare id, because a model will produce both", () => {
		expect(parseRef(`${ARTIFACT_SCHEME}7`)).toBe(7);
		expect(parseRef("7")).toBe(7);
		expect(parseRef("  artifact://12  ")).toBe(12);
	});

	// This is the security property, not a formatting nicety. If a ref could
	// carry a path, `artifact_read` would be an unguarded file reader wearing
	// the capability declaration of a store reader.
	it("rejects anything that could address a file", () => {
		for (const bad of ["../secrets", "artifact://../../etc/passwd", "/etc/passwd", "7.log", "0", "-1", "1.5", ""]) {
			expect(parseRef(bad), bad).toBeNull();
		}
	});
});

describe("kinds cannot escape the store", () => {
	// `writeArtifact` builds a filename out of `kind`. Both tools declare
	// `writesExemptBecause`; a kind that could contain a slash would make that
	// declaration false, which is worse than having no declaration.
	it("neutralises path traversal in a kind", () => {
		const dir = scratch();
		writeArtifact(dir, 1, "../../etc/pwn", "body");
		expect(existsSync(join(dir, "1.etc-pwn.log"))).toBe(true);
		expect(readdirSync(dir)).toEqual(["1.etc-pwn.log"]);
	});

	it("falls back to a usable kind when nothing survives sanitising", () => {
		expect(sanitizeKind("///")).toBe("log");
		expect(sanitizeKind("Build Log")).toBe("build-log");
	});
});

describe("spill — the inline/artifact decision", () => {
	// Most findings are small. A store that spilled everything would force a
	// second tool call to read back what would have fitted in the first
	// message, which is strictly worse than having no store.
	it("returns a small body unchanged and writes nothing", () => {
		const dir = scratch();
		const result = spill("short finding", { dir, kind: "note", previewBytes: PREVIEW_BYTES });
		expect(result).toEqual({ text: "short finding", ref: null });
		expect(existsSync(dir) && readdirSync(dir).length).toBe(0);
	});

	it("spills a large body and hands back a reference to all of it", () => {
		const dir = scratch();
		const body = `${"x".repeat(5_000)}THE-ERROR`;
		const result = spill(body, { dir, kind: "build", previewBytes: 64 });
		expect(result.ref).toBe("artifact://1");
		expect(readArtifact(dir, result.ref!)).toBe(body);
	});

	// Tail, not head — the rule that runs through the whole module. A failing
	// build prints its error last; a head preview would reliably show the one
	// part nobody wants.
	it("previews the TAIL, so the message ends on the error", () => {
		const dir = scratch();
		const result = spill(`${"x".repeat(5_000)}THE-ERROR`, { dir, kind: "build", previewBytes: 64 });
		expect(result.text.endsWith("THE-ERROR")).toBe(true);
		expect(result.text).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".repeat(2));
	});

	// The preview is a pointer plus a taste. If it did not say how much is
	// missing, a reader would have no way to tell a complete small answer from
	// the last 2KB of a 900KB one.
	it("states the reference and the true size in the preview header", () => {
		const dir = scratch();
		const body = "y".repeat(9_000);
		const result = spill(body, { dir, kind: "log", previewBytes: 100 });
		expect(result.text.split("\n")[0]).toContain("artifact://1");
		expect(result.text.split("\n")[0]).toContain("9000 bytes");
		expect(result.text.split("\n")[0]).toContain("artifact_read");
	});

	it("keeps counting up across spills rather than overwriting artifact 1", () => {
		const dir = scratch();
		const first = spill("a".repeat(500), { dir, kind: "one", previewBytes: 10 });
		const second = spill("b".repeat(500), { dir, kind: "two", previewBytes: 10 });
		expect([first.ref, second.ref]).toEqual(["artifact://1", "artifact://2"]);
		expect(readArtifact(dir, "artifact://1")).toBe("a".repeat(500));
	});
});

describe("the caps, and admitting when they bite", () => {
	// A full disk takes the whole workstation down, not just this feature, so
	// the ceiling is real. What it must never do is lie about it.
	it("truncates a huge artifact to its tail and says so IN THE FILE", () => {
		const dir = scratch();
		const body = `${"z".repeat(MAX_ARTIFACT_BYTES)}FINAL-LINE`;
		writeArtifact(dir, 1, "huge", body);
		const stored = readArtifact(dir, "artifact://1")!;
		expect(stored.startsWith("[artifact truncated:")).toBe(true);
		expect(stored.endsWith("FINAL-LINE")).toBe(true);
		expect(stored).toContain("10 bytes dropped from the head");
	});

	// Silent loss is the one failure the store exists to prevent, so a full
	// store still returns the preview AND names the cap. It also must not evict:
	// something is already holding a reference to artifact 1.
	it("refuses to spill past the per-session cap without hiding it", () => {
		const dir = scratch();
		mkdirSync(dir, { recursive: true });
		for (let id = 1; id <= MAX_ARTIFACTS_PER_SESSION; id++) {
			writeFileSync(join(dir, `${id}.log.log`), "old");
		}
		const result = spill("q".repeat(5_000), { dir, kind: "new", previewBytes: 50 });
		expect(result.ref).toBeNull();
		expect(result.text).toContain("artifact store full");
		expect(result.text).toContain(`cap ${MAX_ARTIFACTS_PER_SESSION}`);
		expect(readArtifact(dir, "artifact://1")).toBe("old");
	});

	// A read-only mount or a full disk must cost the artifact, not the finding.
	// Provoked with a FILE standing where the store's parent directory should
	// be (ENOTDIR) — deterministic and unprivileged, unlike writing somewhere
	// the OS refuses, which behaves differently under a sandbox.
	it("keeps the preview when the write itself fails, and names the reason", () => {
		const blocker = join(scratch(), "not-a-directory");
		writeFileSync(blocker, "in the way");
		const result = spill("q".repeat(5_000), {
			dir: join(blocker, "store"),
			kind: "log",
			previewBytes: 50,
		});
		expect(result.ref).toBeNull();
		expect(result.text).toContain("artifact write failed");
		expect(result.text.endsWith("q".repeat(50))).toBe(true);
	});
});

describe("ids survive a restart", () => {
	// The counter cannot live in memory: a resume restarts the process, and a
	// remembered counter would restart at 1 and overwrite artifact 1 of the
	// previous life. Scanning is what buys durable identity.
	it("continues from the highest id already on disk", () => {
		const dir = scratch();
		writeArtifact(dir, 1, "a", "one");
		writeArtifact(dir, 9, "b", "nine");
		expect(nextId(dir)).toBe(10);
	});

	// max+1, not count+1: a deleted artifact must not make the next spill
	// re-use a reference somebody is still holding in their transcript.
	it("does not re-use the id of a deleted artifact", () => {
		const dir = scratch();
		writeArtifact(dir, 1, "a", "one");
		writeArtifact(dir, 2, "b", "two");
		rmSync(join(dir, "1.a.log"));
		expect(nextId(dir)).toBe(3);
	});

	it("starts at 1 in a directory that does not exist yet", () => {
		expect(nextId(join(scratch(), "not-created"))).toBe(1);
	});

	// The directory sits beside the session file, where an operator may well
	// drop a note. Counting a stray file as an artifact would corrupt both the
	// listing and the counter.
	it("ignores files that are not artifacts", () => {
		const dir = scratch();
		writeFileSync(join(dir, "notes.md"), "human note");
		writeFileSync(join(dir, "99.jsonl"), "not ours");
		writeArtifact(dir, 1, "a", "one");
		expect(listArtifacts(dir).map((r) => r.id)).toEqual([1]);
		expect(nextId(dir)).toBe(2);
	});
});

describe("reading back", () => {
	it("round-trips exactly, newlines and all", () => {
		const dir = scratch();
		const body = "line one\n\n  indented\ntrailing\n";
		writeArtifact(dir, 3, "out", body);
		expect(readArtifact(dir, "artifact://3")).toBe(body);
		expect(readArtifact(dir, "3")).toBe(body);
	});

	it("returns null for an id this store does not have, rather than throwing", () => {
		expect(readArtifact(scratch(), "artifact://42")).toBeNull();
	});

	it("returns null for a ref that is really a path", () => {
		const dir = scratch();
		writeFileSync(join(dir, "secret.txt"), "classified");
		expect(readArtifact(dir, "../secret.txt")).toBeNull();
		expect(readArtifact(dir, "/etc/hostname")).toBeNull();
	});

	// An unbounded read-back would put the whole 4MB into context and defeat the
	// point of writing it to a file at all. Bounded, tail-first, and stated.
	it("bounds what reaches a reader, keeping the tail and reporting the loss", () => {
		const bounded = boundForReader(`${"a".repeat(1_000)}END`, 20);
		expect(bounded.endsWith("END")).toBe(true);
		expect(bounded).toContain("983 bytes dropped from the head");
	});

	it("leaves a short body untouched — no header on text that lost nothing", () => {
		expect(boundForReader("small", 1_000)).toBe("small");
	});
});

describe("adoptDir — what makes a fork non-lossy", () => {
	// pi copies custom entries into a fork, so the forked transcript still says
	// `artifact://7`. Without the bytes the branch is a session whose own
	// history lies to it.
	it("copies a store so the fork's inherited references still resolve", () => {
		const from = scratch();
		const to = scratch();
		writeArtifact(from, 1, "build", "first");
		writeArtifact(from, 7, "test", "seventh");

		const result = adoptDir(from, to);

		expect(result.copied).toBe(2);
		expect(readArtifact(to, "artifact://7")).toBe("seventh");
	});

	// Ids are preserved, not renumbered, precisely because the transcript names
	// them; and the counter then continues from the maximum copied id for free,
	// because nextId scans.
	it("preserves ids and leaves the counter continuing past the highest one", () => {
		const from = scratch();
		const to = scratch();
		writeArtifact(from, 1, "a", "one");
		writeArtifact(from, 7, "b", "seven");

		expect(adoptDir(from, to).nextId).toBe(8);
		expect(nextId(to)).toBe(8);
	});

	// The destination's own artifact 3 has a reference pointing at it too. There
	// is no ordering in which clobbering it is the right answer.
	it("never overwrites an id the destination already has", () => {
		const from = scratch();
		const to = scratch();
		writeArtifact(from, 1, "a", "from-source");
		writeArtifact(to, 1, "a", "destination-original");

		const result = adoptDir(from, to);

		expect(result).toMatchObject({ copied: 0, skipped: 1 });
		expect(readArtifact(to, "artifact://1")).toBe("destination-original");
	});

	it("carries non-artifact files across too, so the fork gets the whole directory", () => {
		const from = scratch();
		const to = scratch();
		writeFileSync(join(from, "notes.md"), "operator note");
		adoptDir(from, to);
		expect(readFileSync(join(to, "notes.md"), "utf8")).toBe("operator note");
	});

	// A fork of a session that never spilled is the common case; it must be a
	// no-op, not an ENOENT.
	it("is a no-op when the source store was never created", () => {
		const to = scratch();
		expect(adoptDir(join(scratch(), "never-existed"), to)).toEqual({ copied: 0, skipped: 0, nextId: 1 });
	});
});
