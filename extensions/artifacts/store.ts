/**
 * The artifact store — the file is the ground truth, the message is a pointer.
 *
 * ## The problem this exists to remove
 *
 * A subagent finds something large — a 900KB build log, a full stack dump, the
 * output of a slow query — and has exactly two bad options. It can paste the
 * thing into its answer, which floods the parent's context with text the parent
 * did not ask for and mostly will not read; or it can summarise, which is
 * lossy in the one direction that matters, because the detail a summary drops
 * is precisely the detail somebody would have wanted to grep. oh-my-pi's
 * `docs/blob-artifact-architecture.md` names the split: write the bytes to a
 * file, hand back a reference, let the reader decide whether to open it.
 *
 * ## The asymmetry that sets every constant below
 *
 * `background/jobs.ts` already states the economics for this house, and this
 * module is the same shape one level up. Text that is INJECTED into context is
 * the most expensive text there is per byte: the model did not ask for it and
 * cannot decline it. Text that is RETAINED on disk is nearly free, and text
 * that is PULLED back deliberately sits in between — the model paid a tool call
 * to ask for it, so it wanted it.
 *
 * So there are three numbers, not one, and they are orders of magnitude apart
 * exactly as `NOTIFY_TAIL_BYTES` (2KB volunteered) and `OUTPUT_CAP_BYTES`
 * (256KB retained) are:
 *
 *   PREVIEW_BYTES        2KB     what a spill VOLUNTEERS, unasked
 *   READ_BACK_CAP_BYTES  64KB    what one `artifact_read` returns by default
 *   MAX_ARTIFACT_BYTES   4MB     what one artifact RETAINS on disk
 *
 * ## Tail, not head — everywhere
 *
 * Every truncation in this file keeps the END. A failing build prints its error
 * last, a test runner prints its summary last, a traceback puts the exception
 * type on the final line. "The first 2KB of a 900KB log" is an expensive way to
 * say nothing. Where bytes are dropped it is stated in the text, never
 * silently: an artifact store whose losses are invisible is worse than no store,
 * because the reader believes they have the whole thing.
 *
 * ## Why ids are numeric and scanned rather than counted in memory
 *
 * The counter cannot live in a variable. A session is resumed, forked and
 * branched, and each of those either restarts the process or leaves a second
 * writer against the same directory; a remembered counter would restart at 1
 * and overwrite artifact 1 of the previous life. `nextId` therefore reads the
 * directory every time. That is a stat per spill, which is nothing next to the
 * write it precedes, and it means identity survives a restart for free.
 *
 * The accepted limitation: two processes spilling into one directory at the
 * same instant can scan the same maximum and both claim the next id. It is a
 * narrow window (scan and write are adjacent), the loser's bytes are the only
 * casualty, and the alternative — a lockfile — is a new failure mode with its
 * own stale-lock recovery story. Noted rather than engineered around.
 *
 * ## No process, no env, no pi
 *
 * This module touches the filesystem and nothing else. It reads no environment
 * variable and knows no session: `resolveArtifactDir` is a PURE function that
 * takes the inputs and returns the decision, so the resolution ORDER — the part
 * that makes child-process adoption work — is testable without a child process.
 * `index.ts` owns the impure half.
 *
 * Nothing mutable at module scope: pi builds a fresh jiti instance per
 * extension with `moduleCache: false`, so two importers get two module
 * instances and any cached counter here would silently fail to be shared.
 */

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The reference scheme. A ref is a POINTER, never a path — see `parseRef`. */
export const ARTIFACT_SCHEME = "artifact://";

/**
 * What a spill volunteers into the caller's text, unasked.
 *
 * Sized against `background/jobs.ts`'s `NOTIFY_TAIL_BYTES` (2KB) and for the
 * same reason: 2KB carries a stack trace or a test summary — the cases where
 * the reader should act immediately — and is small enough not to matter when it
 * is noise. Everything beyond it is one `artifact_read` away.
 */
export const PREVIEW_BYTES = 2 * 1024;

/**
 * What one `artifact_read` returns when the caller names no head or tail.
 *
 * 32x the preview, because this text was ASKED for: the model spent a tool call
 * on it, which is the signal that it wants the detail. Still bounded — an
 * unbounded read-back would hand the whole 4MB straight back into context and
 * defeat the point of having written it to a file at all.
 */
export const READ_BACK_CAP_BYTES = 64 * 1024;

/**
 * The largest single artifact that will be retained.
 *
 * 4MB is roughly a very verbose CI log, an order of magnitude above the 256KB
 * `background` keeps in memory — this one is on disk, so the budget is disk and
 * not heap. Above it the tail is kept and the head is dropped with a stated
 * count. A cap exists because a runaway producer (`yes`, a loop printing a
 * progress bar per byte) would otherwise fill the session directory, and the
 * failure mode of no cap is a full disk, which takes the whole workstation
 * down and not just this feature.
 */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/**
 * How many artifacts one session may hold.
 *
 * 256 at the 4MB ceiling is a 1GB worst case, which is a bounded and survivable
 * amount of disk for a session that genuinely produced that much. In practice a
 * session spills tens. The cap is not really about disk: it is about the store
 * staying READABLE — `artifact_list` at four hundred rows is not an index, it
 * is another haystack.
 *
 * When it is reached, `spill` still returns the preview and says the store is
 * full. It does NOT silently drop the ref, and it does not evict an older
 * artifact: something already handed out a reference to that id, and a store
 * that quietly invalidates references is worse than one that admits it is full.
 */
export const MAX_ARTIFACTS_PER_SESSION = 256;

/** The default `kind` when a caller does not supply a usable one. */
const DEFAULT_KIND = "log";

/** File names are `<id>.<kind>.log`; the kind is a slug, so bound it. */
const MAX_KIND_LENGTH = 32;

const ARTIFACT_FILE = /^(\d+)\.([a-z0-9_-]+)\.log$/;

export interface ArtifactRecord {
	id: number;
	kind: string;
	bytes: number;
	/** Epoch millis of last write, from the file's own mtime. */
	modifiedAtMs: number;
	file: string;
}

/**
 * The artifact directory for a session: its jsonl path with `.jsonl` stripped.
 *
 * Beside the session file rather than in a central store, because the session
 * file is what a fork copies, what a resume reopens and what an operator
 * deletes when they clean up. Co-locating means the artifacts share that whole
 * lifecycle without a single line of code arranging it — and it means a
 * human who finds `<timestamp>_<sessionId>.jsonl` finds
 * `<timestamp>_<sessionId>/` next to it and needs no explanation.
 */
export function artifactDirFor(sessionFile: string): string {
	return sessionFile.replace(/\.jsonl$/, "");
}

/**
 * Where a session's artifacts go, decided from the three possible sources.
 *
 * Pure on purpose. The ORDER is the interesting part and it is not obvious:
 *
 *   1. An INHERITED `PI_ARTIFACT_DIR`. A child pi launched by a parent that
 *      already has a store must write into that store — that is the entire
 *      point of exporting the variable, and a child that preferred its own
 *      session file would break the chain the variable exists to create. So an
 *      inherited value beats the child's own session, always.
 *   2. This session's own jsonl file.
 *   3. A per-process directory under the OS temp dir.
 *
 * Case 3 is not hypothetical: `SessionManager.getSessionFile()` returns
 * `undefined` whenever the session is not persisted, and the fake pi used by
 * this repo's tests does not implement the method at all. The fallback keeps
 * spilling working in both, at the cost of artifacts that do not survive the
 * session — which is stated in the README rather than discovered.
 *
 * The fallback is keyed on pid AND a per-instance token, never on pid alone.
 * Two reasons, and the first was measured one directory over: a sandboxed
 * session has its own PID namespace, so pid-keyed paths collide ACROSS live
 * sessions (HIV-1966, `devservices/pg.ts`); and pi rebuilds extensions on every
 * session replacement, so two sessions in ONE process would otherwise share a
 * store and silently append to each other's artifacts.
 */
export function resolveArtifactDir(input: {
	/** `PI_ARTIFACT_DIR` as INHERITED — never one this process exported itself. */
	envDir?: string;
	sessionFile?: string;
	tmpDir: string;
	pid: number;
	/** Distinguishes two sessions of one process; see the note above. */
	instanceToken?: string;
}): { dir: string; source: "env" | "session" | "fallback" } {
	const inherited = input.envDir?.trim();
	if (inherited) return { dir: inherited, source: "env" };
	const sessionFile = input.sessionFile?.trim();
	if (sessionFile) return { dir: artifactDirFor(sessionFile), source: "session" };
	const suffix = input.instanceToken ? `-${input.instanceToken}` : "";
	return { dir: join(input.tmpDir, `pi-artifacts-${input.pid}${suffix}`), source: "fallback" };
}

/** A token that makes one factory run's fallback store distinct. See above. */
export function newInstanceToken(): string {
	return randomUUID().slice(0, 8);
}

/**
 * Reduce a caller's `kind` to something safe to put in a file name.
 *
 * Not cosmetic. `writeArtifact` builds a path out of this string, so a kind
 * containing `/` or `..` would turn a store that declares itself write-free
 * outside its own directory into a general write primitive — and both tools in
 * `index.ts` declare `writesExemptBecause`, which that would make a lie.
 * Anything outside `[a-z0-9_-]` becomes `-`.
 */
export function sanitizeKind(kind: string): string {
	const slug = kind
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, MAX_KIND_LENGTH);
	return slug || DEFAULT_KIND;
}

/**
 * A ref to an id, or null.
 *
 * Accepts `artifact://7` and a bare `7`, because a model that has seen one form
 * will produce the other and refusing that teaches it nothing useful. It
 * accepts NOTHING else — no path, no `../`, no name. That is the property that
 * keeps `artifact_read` a reader of this session's own store rather than a
 * second `read` tool with no guard on it.
 */
export function parseRef(ref: string): number | null {
	const body = ref.trim().startsWith(ARTIFACT_SCHEME)
		? ref.trim().slice(ARTIFACT_SCHEME.length)
		: ref.trim();
	if (!/^\d+$/.test(body)) return null;
	const id = Number.parseInt(body, 10);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Render an id as the reference callers pass around. */
export function refFor(id: number): string {
	return `${ARTIFACT_SCHEME}${id}`;
}

/**
 * Every artifact in a directory, oldest id first.
 *
 * Files that do not match the naming convention are IGNORED rather than
 * reported as artifacts. The directory sits beside the session file and an
 * operator may well drop a note in it; treating a stray file as an artifact
 * would corrupt both the listing and the id counter.
 */
export function listArtifacts(dir: string): ArtifactRecord[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// A directory that does not exist yet holds no artifacts. This is the
		// normal state of a session that has not spilled, not an error.
		return [];
	}
	const records: ArtifactRecord[] = [];
	for (const name of names) {
		const match = ARTIFACT_FILE.exec(name);
		if (!match) continue;
		const file = join(dir, name);
		let bytes = 0;
		let modifiedAtMs = 0;
		try {
			const stats = statSync(file);
			if (!stats.isFile()) continue;
			bytes = stats.size;
			modifiedAtMs = stats.mtimeMs;
		} catch {
			continue;
		}
		records.push({ id: Number.parseInt(match[1], 10), kind: match[2], bytes, modifiedAtMs, file });
	}
	return records.sort((a, b) => a.id - b.id);
}

/**
 * The next id to write in this directory: one past the highest already there.
 *
 * Scanning rather than counting is what makes identity survive a restart, a
 * resume and a fork — see the header. Note it is `max + 1`, not `count + 1`: a
 * deleted artifact must not cause the next spill to re-use a reference somebody
 * is still holding.
 */
export function nextId(dir: string): number {
	let max = 0;
	for (const record of listArtifacts(dir)) {
		if (record.id > max) max = record.id;
	}
	return max + 1;
}

/**
 * Keep the last `maxBytes` of a string, reporting what that cost.
 *
 * The cut lands on a CHARACTER boundary, not a byte boundary. Slicing a UTF-8
 * buffer at an arbitrary offset can land mid-sequence, and `toString("utf8")`
 * then renders the orphaned continuation bytes as U+FFFD — so a German log, a
 * stack trace with a smart quote, or any emoji would open with a replacement
 * character. That is silent corruption in a module whose whole promise is that
 * truncation is honest and stated, so the first complete character wins back a
 * couple of bytes and the count stays exact.
 */
function keepTail(body: string, maxBytes: number): { text: string; dropped: number } {
	const buffer = Buffer.from(body, "utf8");
	if (buffer.byteLength <= maxBytes) return { text: body, dropped: 0 };
	let start = buffer.byteLength - maxBytes;
	// A UTF-8 continuation byte is 0b10xxxxxx; walk forward off the middle of a
	// sequence. At most three steps — the longest sequence is four bytes.
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
	const tail = buffer.subarray(start);
	return { text: tail.toString("utf8"), dropped: start };
}

/**
 * Write one artifact and return its reference.
 *
 * The body is capped at `MAX_ARTIFACT_BYTES` by keeping the tail, and when that
 * happens the file itself opens with a line saying how much was dropped. The
 * note goes in the FILE, not merely in a return value, because this file is the
 * ground truth and a reader who opens it months later must not be able to
 * mistake a truncated log for a complete one.
 */
export function writeArtifact(dir: string, id: number, kind: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const slug = sanitizeKind(kind);
	const { text, dropped } = keepTail(body, MAX_ARTIFACT_BYTES);
	const contents =
		dropped > 0
			? `[artifact truncated: ${dropped} bytes dropped from the head, tail kept]\n${text}`
			: text;
	writeFileSync(join(dir, `${id}.${slug}.log`), contents, "utf8");
	return refFor(id);
}

/**
 * Read one artifact back, whole. Null when there is no such id.
 *
 * Returns the entire file: bounding what reaches the model is the caller's
 * decision and `artifact_read` makes it. A store that truncated on read would
 * be a store with no way to get at the bytes it was built to keep.
 */
export function readArtifact(dir: string, ref: string): string | null {
	const id = parseRef(ref);
	if (id === null) return null;
	const record = listArtifacts(dir).find((entry) => entry.id === id);
	if (!record) return null;
	try {
		return readFileSync(record.file, "utf8");
	} catch {
		// Present in the listing a moment ago, unreadable now — a concurrent
		// delete, or a permission change. Null is the honest answer and the
		// caller already has a message for it.
		return null;
	}
}

export interface SpillResult {
	/** What the caller puts in its message. */
	text: string;
	/** The artifact reference, or null when nothing was written. */
	ref: string | null;
}

/**
 * The whole point of the module: keep small things inline, spill big ones.
 *
 * Under `previewBytes` the body is returned UNCHANGED and no file is written.
 * That matters more than it looks: most findings are small, and a store that
 * turned every two-line answer into `artifact://12` would force a second tool
 * call to read back what would have fitted in the first message — strictly
 * worse than not having a store.
 *
 * Over it, the bytes go to disk and the caller gets a header naming the ref and
 * the true size, then the TAIL. The header is first so a reader knows this is a
 * preview before reading it; the tail is last so the message still ENDS on the
 * error, which is where a failing build puts it.
 */
export function spill(
	body: string,
	opts: { dir: string; kind: string; previewBytes: number },
): SpillResult {
	const total = Buffer.byteLength(body, "utf8");
	if (total <= opts.previewBytes) return { text: body, ref: null };

	const preview = keepTail(body, opts.previewBytes);
	// Counted in BYTES, not in string length: `total` is a byte count and a
	// header mixing the two would understate the preview for any non-ASCII
	// body, which is the sort of quietly-wrong number this module promises not
	// to produce.
	const shown = Buffer.byteLength(preview.text, "utf8");
	const existing = listArtifacts(opts.dir);

	if (existing.length >= MAX_ARTIFACTS_PER_SESSION) {
		// Full: say so in the text. The alternative — dropping the ref quietly —
		// would leave the reader believing the preview is all there ever was.
		return {
			text: `[artifact store full: ${existing.length} artifacts this session, cap ${MAX_ARTIFACTS_PER_SESSION}. Showing the last ${shown} of ${total} bytes; ${preview.dropped} bytes were NOT retained]\n${preview.text}`,
			ref: null,
		};
	}

	const id = nextId(opts.dir);
	let ref: string;
	try {
		ref = writeArtifact(opts.dir, id, opts.kind, body);
	} catch (error) {
		// A failed write must not lose the preview as well as the artifact. The
		// reason is named so the operator can fix it (full disk, read-only mount)
		// instead of wondering why refs stopped appearing.
		const reason = error instanceof Error ? error.message : String(error);
		return {
			text: `[artifact write failed: ${reason}. Showing the last ${shown} of ${total} bytes; the rest is lost]\n${preview.text}`,
			ref: null,
		};
	}

	const retained = Math.min(total, MAX_ARTIFACT_BYTES);
	const truncated = retained < total ? `, artifact holds the last ${retained}` : "";
	return {
		text: `[${ref} · ${total} bytes${truncated} · showing the last ${shown}. Use artifact_read to see more]\n${preview.text}`,
		ref,
	};
}

export interface AdoptResult {
	/** Artifacts copied into the destination. */
	copied: number;
	/** Ids skipped because the destination already had one — never overwritten. */
	skipped: number;
	/** The id the destination's next spill will take. */
	nextId: number;
}

/**
 * Copy a store into a new session's directory, so a fork is not lossy.
 *
 * This is what makes branching work. pi copies custom session entries into a
 * fork, so the forked session's transcript still contains `artifact://7` — and
 * without this the reference would resolve against an empty directory and the
 * branch would silently be a session whose own history lies to it. Refs are
 * cheap to carry and impossible to reconstruct; the bytes have to come along.
 *
 * Ids are PRESERVED, not renumbered, because the refs already written into the
 * transcript name them. An id already present in the destination is SKIPPED
 * rather than overwritten: the destination's own artifact 3 has a reference
 * pointing at it too, and there is no ordering in which clobbering it is right.
 *
 * The counter needs no separate arrangement — `nextId` scans, so after the copy
 * it already continues from the highest id present, which is the maximum across
 * both stores. The returned `nextId` is that value, stated so a caller can log
 * it rather than infer it.
 */
export function adoptDir(fromDir: string, toDir: string): AdoptResult {
	if (!existsSync(fromDir)) return { copied: 0, skipped: 0, nextId: nextId(toDir) };
	mkdirSync(toDir, { recursive: true });

	let copied = 0;
	let skipped = 0;
	const present = new Set(listArtifacts(toDir).map((record) => record.id));

	for (const record of listArtifacts(fromDir)) {
		if (present.has(record.id)) {
			skipped++;
			continue;
		}
		cpSync(record.file, join(toDir, `${record.id}.${record.kind}.log`));
		present.add(record.id);
		copied++;
	}

	// Anything in the source that is not an artifact — a note an operator left,
	// a subdirectory some other tool put there — is carried across too, so the
	// fork gets the whole directory and not just the part this module
	// understands. Existing destination files are never overwritten, for the
	// same reason ids are not.
	for (const name of readdirSync(fromDir)) {
		if (ARTIFACT_FILE.test(name)) continue;
		const target = join(toDir, name);
		if (existsSync(target)) continue;
		cpSync(join(fromDir, name), target, { recursive: true });
	}

	return { copied, skipped, nextId: nextId(toDir) };
}

/**
 * Bound an artifact's text for a reader, tail-biased, saying what it cost.
 *
 * Shared by `artifact_read` so the "how much reaches the model" decision lives
 * here with the constants that motivate it, rather than in the wiring layer
 * where nobody would find it.
 */
export function boundForReader(body: string, maxBytes: number = READ_BACK_CAP_BYTES): string {
	const { text, dropped } = keepTail(body, maxBytes);
	if (dropped === 0) return text;
	return `[showing the last ${maxBytes} bytes; ${dropped} bytes dropped from the head. Use head/tail to page]\n${text}`;
}

/** Take the first `n` lines. */
export function headLines(body: string, n: number): string {
	return body.split("\n").slice(0, Math.max(0, n)).join("\n");
}

/** Take the last `n` lines. */
export function tailLines(body: string, n: number): string {
	const lines = body.split("\n");
	return lines.slice(Math.max(0, lines.length - Math.max(0, n))).join("\n");
}
