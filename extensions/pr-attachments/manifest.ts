/**
 * The screenshot ledger and the `pr-attachments.json` manifest (HIV-3240).
 *
 * ## The file contract — read this before writing the Go consumer
 *
 * After every `browser_screenshot`, the browser extension writes a manifest
 * file named `pr-attachments.json` whose body is a JSON ARRAY, oldest first, of
 *
 *     { "path": string, "label": string, "url": string, "taken_at": string }
 *
 *   - `path`     absolute path to the PNG on this sandbox's disk, e.g.
 *                `/tmp/pi-browser-4131/shot-1725291600000.png`.
 *   - `label`    the free-text label the agent passed (`before` / `after` by
 *                convention); the empty string when none was given.
 *   - `url`      the page URL the shot was taken against (NOT the uploaded
 *                GitHub asset URL — that does not exist until `gh … --attach`
 *                runs and is the consumer's to capture).
 *   - `taken_at` ISO-8601 UTC timestamp, e.g. `2026-09-02T16:40:29.011Z`.
 *
 * WHERE the file lives, in priority order:
 *   1. `$HIVE_PR_ATTACHMENTS_DIR/pr-attachments.json` when that env var is set —
 *      this is the funnel's contract: the hive-side Go reader sets the var to a
 *      directory it controls and reads the manifest back from it.
 *   2. otherwise next to the screenshots, at
 *      `<os.tmpdir()>/pi-browser-<pid>/pr-attachments.json`.
 *
 * The array is REWRITTEN in full on every screenshot (append-then-write), so a
 * consumer that reads it at any time sees every shot taken so far. It is never
 * truncated within a session. A malformed or absent file is equivalent to an
 * empty array — the manifest is best-effort telemetry, never a hard dependency.
 *
 * ## Why disk is the source of truth, not module state
 *
 * Two independent consumers need this ledger: `extensions/browser` writes it,
 * `extensions/pr-attachments` reads it to build the PR nudge. Pi loads
 * extension entrypoints with ISOLATED module caches (see
 * `flows/register.ts`'s header), so a shared module variable would give each
 * entrypoint its OWN copy and the reader would always see zero shots. The
 * on-disk manifest is the one place both can meet.
 *
 * It is also what makes the record survive `session_compact`: compaction
 * summarises the conversation, and while the process — and therefore any
 * closure state — happens to outlive it today, the ledger does not depend on
 * that. Every read re-derives from disk, and if the manifest file itself is
 * lost, `reDeriveFromDisk` reconstructs a labelless ledger from the `shot-*.png`
 * files that are still there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ScreenshotRecord {
	/** Absolute path to the PNG on this sandbox's disk. */
	path: string;
	/** Free-text label; `before`/`after` by convention, `""` when none. */
	label: string;
	/** The page URL the shot was taken against. */
	url: string;
	/** ISO-8601 UTC timestamp. */
	taken_at: string;
}

export const MANIFEST_FILENAME = "pr-attachments.json";

/** The per-process screenshot directory, matching extensions/browser. */
export function screenshotDir(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
	return path.join(os.tmpdir(), `pi-browser-${pid}`);
}

/**
 * The directory the manifest is written to: `$HIVE_PR_ATTACHMENTS_DIR` when
 * set (the funnel's contract), else the per-process screenshot directory.
 */
export function manifestDir(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
	const configured = env.HIVE_PR_ATTACHMENTS_DIR?.trim();
	return configured ? configured : screenshotDir(env, pid);
}

export function manifestPath(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
	return path.join(manifestDir(env, pid), MANIFEST_FILENAME);
}

function isRecord(value: unknown): value is ScreenshotRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.path === "string" &&
		typeof r.label === "string" &&
		typeof r.url === "string" &&
		typeof r.taken_at === "string"
	);
}

/** Read and parse the manifest. A missing or malformed file is an empty array. */
export function readManifest(file: string): ScreenshotRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
	} catch {
		return [];
	}
}

/**
 * Reconstruct a labelless ledger from the `shot-*.png` files on disk.
 *
 * The fallback for a lost manifest: the timestamp is recovered from the
 * `shot-<ms>.png` name, the label and url are unknown (empty), and records are
 * returned oldest first. Used only when the manifest file itself is gone.
 */
export function reDeriveFromDisk(dir: string): ScreenshotRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: ScreenshotRecord[] = [];
	for (const name of names) {
		const matched = /^shot-(\d+)\.png$/.exec(name);
		if (!matched) continue;
		const ms = Number(matched[1]);
		records.push({
			path: path.join(dir, name),
			label: "",
			url: "",
			taken_at: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
		});
	}
	records.sort((a, b) => a.taken_at.localeCompare(b.taken_at));
	return records;
}

/**
 * The screenshot ledger, backed by the on-disk manifest.
 *
 * Constructed over an env so two entrypoints (and two tests) resolve the same
 * file. No in-memory cache: every `all()` re-reads disk, which is what makes it
 * correct across extension isolation and compaction. The files are tiny.
 */
export class ScreenshotLedger {
	private readonly file: string;
	private readonly dir: string;

	constructor(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid) {
		this.file = manifestPath(env, pid);
		this.dir = manifestDir(env, pid);
	}

	/** Append one screenshot and rewrite the manifest. Returns the record. */
	record(entry: { path: string; label: string; url: string; taken_at?: string }): ScreenshotRecord {
		const rec: ScreenshotRecord = {
			path: entry.path,
			label: entry.label,
			url: entry.url,
			taken_at: entry.taken_at ?? new Date().toISOString(),
		};
		const all = readManifest(this.file);
		all.push(rec);
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(this.file, `${JSON.stringify(all, null, 2)}\n`);
		return rec;
	}

	/**
	 * Every screenshot taken this session, oldest first. Reads the manifest; if
	 * it is missing, re-derives a labelless ledger from the screenshot dir.
	 */
	all(): ScreenshotRecord[] {
		const fromManifest = readManifest(this.file);
		if (fromManifest.length > 0) return fromManifest;
		return reDeriveFromDisk(this.dir);
	}
}
