/**
 * explore — the pure half: the exploration record, its two transitions, and the
 * report they collapse to.
 *
 * THE PROBLEM. pi already has the tree primitives — `/tree` moves the leaf
 * around one session file and can attach a branch summary at the new position,
 * `/fork` starts a new file from an earlier user message, `/clone` duplicates the
 * current position. What none of them holds is the WHY. You branch off to check
 * whether the retry belongs in the client or the caller, spend twenty turns on
 * it, and come back with a session tree that records the shape of the detour and
 * nothing about its point. A week later the branch is unreadable, so it gets
 * re-explored.
 *
 * So the missing thing is not navigation. It is a stated purpose that outlives
 * the detour and a REPORT at the end of it — two lines you can read instead of a
 * transcript you will not.
 *
 * WHY THE REPORT IS ASSEMBLED, NOT WRITTEN. Everything `renderReport` prints is
 * either something the operator typed (the purpose, the conclusion) or something
 * a fold over the session already knows (the duration, the files changed, the
 * artifact refs). Nothing here calls a model. A side lane that costs a model call
 * every time you close it is a lane you stop closing — and pi's own branch
 * summary (`navigateTree({ summarize: true })`) is already the paid, model-backed
 * version for the people who want it. Two summarizers would be one too many.
 *
 * WHY WHOLE-SNAPSHOT PERSISTENCE, AND WHY NEWEST WINS. `pi.appendEntry("explore",
 * snapshot)` writes the entire log every time, the idiom `workflow/state.ts`,
 * `plan/state.ts` and `tasks/state.ts` all use: a custom entry is invisible to the
 * LLM, survives compaction, and is copied into a fork. Rehydration scans BACKWARDS
 * and stops at the first valid snapshot. That is safe here even though snapshots
 * are appended on different branches of the tree, and the invariant is worth
 * stating because it is the thing that would break: there is exactly one writer,
 * and it rehydrates over ALL entries before every write, so each snapshot already
 * subsumes every snapshot written before it — on any branch. Merging records by id
 * would be machinery guarding against a case that cannot arise.
 *
 * Nothing in this file touches pi, the clock or the filesystem. The wiring is in
 * ./index.ts.
 */

export const EXPLORE_ENTRY_TYPE = "explore";

/** Bumped only for a shape a previous reader could not have understood. */
const SCHEMA_VERSION = 1;

/**
 * A purpose is one sentence. The clamp is not cosmetic: this string is copied
 * into every fork of the session and reprinted on every `/explore` listing, so a
 * pasted stack trace as a "purpose" would be carried forever and would push the
 * listing off the screen. 200 characters is roughly two lines at a normal
 * terminal width — enough for "does the retry belong in the client or the
 * caller, and what does the 429 path do today", which is a real purpose.
 */
export const PURPOSE_MAX_CHARS = 200;

/**
 * A conclusion is allowed to be a paragraph — it is the thing the whole detour
 * produced — but it is stored under the same rule as the purpose, so it gets the
 * same treatment two orders of magnitude up. Anyone wanting more than 2k of
 * conclusion wants a file, and should say so in the conclusion.
 */
export const CONCLUSION_MAX_CHARS = 2_000;

/** How many changed files the report names before it says "and N more". */
export const FILES_SHOWN = 8;

const ELLIPSIS = "…";

export interface ExploreRecord {
	/** `e1`, `e2`, … — a counter in the log rather than a uuid, so the pure core
	 *  stays pure and a test can name the record it expects. */
	readonly id: string;
	readonly purpose: string;
	/**
	 * The session entry the exploration was opened at, when the session manager
	 * could name one. Null is a normal outcome, not an error: a session that is not
	 * persisted has no entry ids at all, and the record is still worth keeping —
	 * the purpose and the clock are the load-bearing parts.
	 */
	readonly entryId: string | null;
	readonly startedAtMs: number;
	readonly status: "open" | "closed";
	readonly endedAtMs?: number;
	readonly conclusion?: string;
	/** Files changed during the exploration, resolved once at close. */
	readonly files?: readonly string[];
	/** `artifact://<id>` refs seen during the exploration, resolved once at close. */
	readonly artifacts?: readonly string[];
}

export interface ExploreLog {
	readonly explorations: readonly ExploreRecord[];
	readonly nextId: number;
}

export function emptyLog(): ExploreLog {
	return { explorations: [], nextId: 1 };
}

/** The one open exploration, if there is one. */
export function openExploration(log: ExploreLog): ExploreRecord | null {
	return log.explorations.find((record) => record.status === "open") ?? null;
}

/**
 * Clamp to `max`, keeping the HEAD.
 *
 * The opposite of `btw/thread.ts:capSeed`, deliberately and for the same reason
 * that one keeps the tail: an excerpt is read for what just happened, a purpose
 * is read for what it starts with. Someone who writes 400 characters of purpose
 * put the point in the first sentence.
 */
export function clamp(text: string, max: number): { text: string; clamped: boolean } {
	const trimmed = text.trim();
	if (trimmed.length <= max) return { text: trimmed, clamped: false };
	return { text: `${trimmed.slice(0, Math.max(0, max - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`, clamped: true };
}

export type StartResult =
	| { ok: true; log: ExploreLog; record: ExploreRecord; clamped: boolean }
	/** Nested explorations are refused: see the comment on `start`. */
	| { ok: false; reason: "already-open"; open: ExploreRecord }
	| { ok: false; reason: "empty-purpose" };

/**
 * Open an exploration.
 *
 * ONE AT A TIME, and the refusal is the interesting decision. Nesting is
 * technically easy — the log is a list — but `/explore done` would then need to
 * name which one it closes, and the operator who is three levels deep is exactly
 * the one who cannot remember. pi's tree is already the nesting mechanism; this
 * is the label on the current detour. A second `/explore` therefore reports what
 * is already open (with its purpose, so the answer to "what was I doing" is in
 * the refusal itself) and changes nothing.
 *
 * Total, like `workflow/state.ts:applyOps`: it never throws, and a refusal is
 * returned as a value the caller has to render.
 */
export function start(
	log: ExploreLog,
	input: { purpose: string; entryId: string | null; nowMs: number },
): StartResult {
	const already = openExploration(log);
	if (already) return { ok: false, reason: "already-open", open: already };

	const { text: purpose, clamped } = clamp(input.purpose, PURPOSE_MAX_CHARS);
	// An exploration with no stated purpose is the thing this extension exists to
	// prevent, so it is refused rather than filled in with a placeholder.
	if (purpose === "") return { ok: false, reason: "empty-purpose" };

	const record: ExploreRecord = {
		id: `e${log.nextId}`,
		purpose,
		entryId: input.entryId,
		startedAtMs: input.nowMs,
		status: "open",
	};
	return {
		ok: true,
		log: { explorations: [...log.explorations, record], nextId: log.nextId + 1 },
		record,
		clamped,
	};
}

export type CloseResult =
	| { ok: true; log: ExploreLog; record: ExploreRecord; clamped: boolean }
	| { ok: false; reason: "nothing-open"; last: ExploreRecord | null };

/**
 * Close the open exploration.
 *
 * `nothing-open` covers both ways of getting it wrong — closing without ever
 * starting, and closing twice — and carries the most recently closed record so
 * the caller can say "the last one closed 4m ago" rather than just "no". The two
 * cases are not distinguished further because the operator's next move is the
 * same in both: `/explore <purpose>` if they meant to open one, nothing if they
 * fat-fingered a repeat.
 *
 * The conclusion is optional. A detour that ends in "no, that road is closed" is
 * a result, and demanding prose for it would train people to skip the close —
 * which loses the duration and the file list too.
 */
export function close(
	log: ExploreLog,
	input: { conclusion: string; nowMs: number; files?: readonly string[]; artifacts?: readonly string[] },
): CloseResult {
	const open = openExploration(log);
	if (!open) {
		const closed = log.explorations.filter((record) => record.status === "closed");
		return { ok: false, reason: "nothing-open", last: closed[closed.length - 1] ?? null };
	}

	const { text: conclusion, clamped } = clamp(input.conclusion, CONCLUSION_MAX_CHARS);
	const record: ExploreRecord = {
		...open,
		status: "closed",
		endedAtMs: input.nowMs,
		...(conclusion === "" ? {} : { conclusion }),
		...(input.files && input.files.length > 0 ? { files: [...input.files] } : {}),
		...(input.artifacts && input.artifacts.length > 0 ? { artifacts: [...input.artifacts] } : {}),
	};
	return {
		ok: true,
		log: {
			explorations: log.explorations.map((entry) => (entry.id === open.id ? record : entry)),
			nextId: log.nextId,
		},
		record,
		clamped,
	};
}

/* -------------------------------------------------------------------------- */
/* What the session already knows                                              */
/* -------------------------------------------------------------------------- */

/**
 * Tool calls whose argument names a file the agent CHANGED.
 *
 * `read` is excluded on purpose. An exploration reads a hundred files and changes
 * two; a report that listed the hundred would bury the two, and "we looked at
 * these" is not a finding. The count of reads is not reported either — it is
 * activity, not result.
 *
 * The argument name is `file_path ?? path` in that order, which is pi's own
 * precedence (`core/tools/edit.js:91`), not a guess: both spellings reach the
 * real tools, so a scan that knew only one would silently return nothing on half
 * the sessions.
 */
const MUTATING_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"]);

/**
 * The artifact reference format, frozen by the contract in
 * `extensions/artifacts/store.ts` (`artifact://<id>`, ids numeric).
 *
 * Matched with a local regex rather than by importing `parseRef`, because this
 * scan wants "every ref anywhere in a blob of text" and `parseRef` answers "is
 * this whole string a ref" — a different question. See the README.
 */
const ARTIFACT_REF = /artifact:\/\/(\d+)/g;

export interface TouchedFacts {
	/** Changed files, in first-touch order, deduped. */
	readonly files: string[];
	/** Artifact refs seen anywhere in the transcript after the start, deduped. */
	readonly artifacts: string[];
}

/**
 * Fold the session entries since `sinceMs` into the two lists the report prints.
 *
 * Defensive to the point of paranoia about shapes, and that is the design: this
 * is decoration on a record whose load-bearing fields are the purpose and the
 * clock. A session whose entries look nothing like the shape below yields two
 * empty lists and a report that simply omits those lines — never a report that
 * claims nothing was touched. The caller decides how to say that; see
 * `renderReport`.
 *
 * Entries with no timestamp are SKIPPED rather than included. An undated entry
 * included by default would drag the whole pre-exploration session into a report
 * about twenty minutes of it, and being over-inclusive here is the failure that
 * makes the line untrustworthy rather than merely thin.
 */
export function touchedSince(entries: readonly unknown[], sinceMs: number): TouchedFacts {
	const files: string[] = [];
	const artifacts: string[] = [];
	const seenFile = new Set<string>();
	const seenArtifact = new Set<string>();

	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) continue;
		const timestamp = message.timestamp;
		if (typeof timestamp !== "number" || timestamp < sinceMs) continue;

		for (const block of asArray(message.content)) {
			const record = asRecord(block);
			if (!record) continue;

			if (record.type === "toolCall" && typeof record.name === "string" && MUTATING_TOOLS.has(record.name)) {
				const args = asRecord(record.arguments);
				const path = text(args?.file_path) ?? text(args?.path);
				if (path && !seenFile.has(path)) {
					seenFile.add(path);
					files.push(path);
				}
			}

			const blockText = text(record.text);
			if (blockText) collectArtifacts(blockText, seenArtifact, artifacts);
		}
	}

	return { files, artifacts };
}

function collectArtifacts(haystack: string, seen: Set<string>, out: string[]): void {
	// A fresh lastIndex per call: a module-level /g regex reused across calls
	// resumes where it left off and silently skips the first match of the next one.
	ARTIFACT_REF.lastIndex = 0;
	for (;;) {
		const match = ARTIFACT_REF.exec(haystack);
		if (!match) break;
		const ref = `artifact://${match[1]}`;
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(ref);
	}
}

function messageOf(entry: unknown): Record<string, unknown> | null {
	const record = asRecord(entry);
	if (!record) return null;
	const inner = asRecord(record.message);
	if (inner && typeof inner.role === "string") return inner;
	return typeof record.role === "string" ? record : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Durations, coarse on purpose. "23m" is what anyone reads off a report; the
 * seconds are noise except for the very short detour, where "40s" is itself the
 * finding ("that was not an exploration, that was a typo").
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * What is printed when an exploration opens.
 *
 * The last two lines are the entire "nudge" half of this feature, and they name
 * pi's real commands verbatim because the operator is about to type one of them.
 * This extension does not run them — the reasoning is in the README, and it is a
 * decision rather than a limitation.
 */
export function renderStart(record: ExploreRecord, clamped: boolean): string[] {
	const lines = [
		`explore ${record.id}: ${record.purpose}`,
		// Two different absences, worded so they cannot be confused: no entry to
		// cite is about the session tree, and the caller adds a separate line when
		// the snapshot itself could not be written.
		record.entryId ? `  from entry ${record.entryId}` : "  (no entry to cite — this session has no ids yet)",
	];
	if (clamped) lines.push(`  purpose clamped to ${PURPOSE_MAX_CHARS} chars for the record`);
	lines.push(
		"",
		"  Branch where you want to: `/tree` (a branch in this session, summary optional)",
		"  or `/fork` (a new session file from an earlier message). This command holds",
		"  the purpose; it does not move you.",
		"  `/explore done [conclusion]` closes it and prints the report.",
	);
	return lines;
}

/**
 * The collapse. Purpose in, one small block out.
 *
 * The conclusion is printed LAST because it is the thing worth reading, and the
 * metadata above it is the thing worth skipping. The absent-conclusion case says
 * so explicitly rather than leaving a blank: a report that quietly omits the
 * conclusion reads, a month later, as one that had nothing to conclude — which
 * may be true, but the record should not decide that on the operator's behalf.
 */
export function renderReport(record: ExploreRecord, nowMs: number): string[] {
	const ended = record.endedAtMs ?? nowMs;
	const lines = [
		`explore ${record.id} · ${formatDuration(ended - record.startedAtMs)} · closed`,
		`  purpose:  ${record.purpose}`,
	];
	if (record.entryId) lines.push(`  from:     entry ${record.entryId}`);

	const files = record.files ?? [];
	if (files.length > 0) {
		const shown = files.slice(0, FILES_SHOWN);
		lines.push(`  changed:  ${shown.join(", ")}${files.length > shown.length ? ` (+${files.length - shown.length} more)` : ""}`);
	}
	const artifacts = record.artifacts ?? [];
	if (artifacts.length > 0) lines.push(`  artifacts: ${artifacts.join(", ")}`);

	lines.push("", record.conclusion ? record.conclusion : "(closed without a conclusion)");
	return lines;
}

/** `/explore` with no argument: what this session has explored. */
export function renderList(log: ExploreLog, nowMs: number): string[] {
	if (log.explorations.length === 0) {
		return [
			"explore: nothing explored in this session.",
			"  /explore <purpose>        state what you are going to go and find out",
			"  /explore done [what you found]  close it and print the report",
		];
	}
	const lines = [`explore: ${log.explorations.length} exploration${log.explorations.length === 1 ? "" : "s"} in this session.`];
	for (const record of log.explorations) {
		const ended = record.endedAtMs ?? nowMs;
		const age = formatDuration(ended - record.startedAtMs);
		const marker = record.status === "open" ? "open" : age;
		lines.push(`  ${record.id} [${marker}] ${record.purpose}`);
		// The conclusion is the point of the list — an exploration you cannot read
		// the answer of is a transcript again. One line each; the full text is in
		// the report the close already printed.
		if (record.conclusion) lines.push(`       → ${firstLine(record.conclusion)}`);
	}
	return lines;
}

function firstLine(value: string): string {
	const line = value.trim().split("\n")[0] ?? "";
	return line.length > 100 ? `${line.slice(0, 99)}${ELLIPSIS}` : line;
}

/* -------------------------------------------------------------------------- */
/* The command grammar                                                         */
/* -------------------------------------------------------------------------- */

export type ExploreCommand =
	| { kind: "list" }
	| { kind: "done"; conclusion: string }
	| { kind: "start"; purpose: string };

/**
 * Parse `/explore <args>`.
 *
 * `done` is a FIRST-TOKEN verb here, which is the opposite of
 * `btw/thread.ts:parseBtwCommand`'s whole-argument rule, and the divergence is
 * deliberate: btw's verbs take no argument, so `/btw end of file handling?` can
 * only be a question, while this grammar is specified as `/explore done
 * [conclusion]` — the rest of the line IS the conclusion. The cost is that
 * "done deciding whether to retry" cannot be a purpose; it can be written as
 * "decide whether to retry", and that is a better purpose anyway.
 */
export function parseExploreCommand(args: string): ExploreCommand {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "list" };

	const match = /^done\b(.*)$/is.exec(trimmed);
	if (match) return { kind: "done", conclusion: (match[1] ?? "").trim() };

	return { kind: "start", purpose: trimmed };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/** The persisted shape. Whole-snapshot, so one entry is the whole answer. */
export function toEntry(log: ExploreLog): Record<string, unknown> {
	return { kind: "explore", schemaVersion: SCHEMA_VERSION, log };
}

export function validateSnapshot(data: unknown): ExploreLog | null {
	const record = asRecord(data);
	if (!record || record.kind !== "explore") return null;
	// A newer writer's shape is not ours to guess at: an unknown version rehydrates
	// as "nothing explored" rather than as a half-understood log.
	if (record.schemaVersion !== SCHEMA_VERSION) return null;

	const log = asRecord(record.log);
	if (!log || !Array.isArray(log.explorations)) return null;

	const explorations = log.explorations
		.map((raw) => validateRecord(raw))
		.filter((entry): entry is ExploreRecord => entry !== null);

	// Repair rather than trust: a persisted `nextId` behind the live maximum would
	// hand the next exploration an id that already exists, and two records sharing
	// an id makes `close` ambiguous.
	const highest = explorations.reduce((max, entry) => {
		const numeric = Number(entry.id.replace(/^e/, ""));
		return Number.isSafeInteger(numeric) && numeric > max ? numeric : max;
	}, 0);
	const stored = typeof log.nextId === "number" && Number.isSafeInteger(log.nextId) ? log.nextId : 1;

	return { explorations, nextId: Math.max(stored, highest + 1) };
}

function validateRecord(raw: unknown): ExploreRecord | null {
	const record = asRecord(raw);
	if (!record) return null;
	const id = text(record.id);
	const purpose = text(record.purpose);
	if (!id || !purpose) return null;
	return {
		id,
		purpose,
		entryId: text(record.entryId),
		startedAtMs: typeof record.startedAtMs === "number" ? record.startedAtMs : 0,
		status: record.status === "closed" ? "closed" : "open",
		...(typeof record.endedAtMs === "number" ? { endedAtMs: record.endedAtMs } : {}),
		...(text(record.conclusion) ? { conclusion: record.conclusion as string } : {}),
		...(Array.isArray(record.files) ? { files: record.files.filter((f): f is string => typeof f === "string") } : {}),
		...(Array.isArray(record.artifacts)
			? { artifacts: record.artifacts.filter((a): a is string => typeof a === "string") }
			: {}),
	};
}

/**
 * Newest snapshot wins — see the file header for why that is safe across
 * branches. Scans backwards and stops at the first valid one, so the cost is
 * bounded by recency rather than by session length.
 */
export function rehydrate(entries: readonly unknown[]): ExploreLog {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== EXPLORE_ENTRY_TYPE) continue;
		const log = validateSnapshot(entry.data);
		if (log) return log;
	}
	return emptyLog();
}
