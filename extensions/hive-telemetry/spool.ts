/**
 * hive-telemetry — the offline spool.
 *
 * ONE FILE PER RUN, REWRITTEN IN PLACE. That is what bounds the spool: payloads
 * are cumulative, so the newest snapshot supersedes every earlier one and a
 * ten-hour session can never accumulate more than one file. An append-only
 * journal would have needed its own compaction story.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "./identity.ts";
import { postUsage } from "./transport.ts";
import type { AgentUsagePayload, ResolvedAuth } from "./types.ts";

const MAX_SPOOL_FILES = 500;
const MAX_SPOOL_BYTES = 8 * 1024 * 1024;
const SPOOL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DRAIN_PER_PASS = 50;
const DRAIN_GAP_MS = 250;
const CLAIM_STALE_MS = 10 * 60 * 1000;

function spoolFile(runId: string): string {
	return join(spoolDir(), `${runId}.json`);
}

/** Synchronous and ~1ms, so `session_shutdown` can guarantee durability before quitting. */
export function writeSpool(payload: AgentUsagePayload): void {
	try {
		mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
		const path = spoolFile(payload.client_run_id);
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		/* fail open: telemetry durability is never worth an error in the agent */
	}
}

export function clearSpool(runId: string): void {
	try {
		const path = spoolFile(runId);
		if (existsSync(path)) unlinkSync(path);
	} catch {
		/* best effort */
	}
}

interface SpoolEntry {
	path: string;
	mtimeMs: number;
	size: number;
}

function listSpool(): SpoolEntry[] {
	try {
		if (!existsSync(spoolDir())) return [];
		const out: SpoolEntry[] = [];
		for (const name of readdirSync(spoolDir())) {
			if (!name.endsWith(".json")) continue;
			const path = join(spoolDir(), name);
			try {
				const st = statSync(path);
				out.push({ path, mtimeMs: st.mtimeMs, size: st.size });
			} catch {
				/* vanished between readdir and stat — fine */
			}
		}
		out.sort((a, b) => a.mtimeMs - b.mtimeMs);
		return out;
	} catch {
		return [];
	}
}

export function spoolStats(): { files: number; bytes: number } {
	const entries = listSpool();
	return { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) };
}

/** Enforces the three bounds oldest-first, plus reclaims abandoned claims. */
export function pruneSpool(): void {
	try {
		const now = Date.now();
		// A claim whose owner died must not strand a payload forever.
		if (existsSync(spoolDir())) {
			for (const name of readdirSync(spoolDir())) {
				if (!name.includes(".claim-")) continue;
				const path = join(spoolDir(), name);
				try {
					if (now - statSync(path).mtimeMs > CLAIM_STALE_MS) {
						renameSync(path, path.slice(0, path.indexOf(".claim-")));
					}
				} catch {
					/* another process got there first */
				}
			}
		}

		let entries = listSpool();
		let bytes = entries.reduce((n, e) => n + e.size, 0);
		for (const entry of entries) {
			const tooOld = now - entry.mtimeMs > SPOOL_TTL_MS;
			const tooMany = entries.length > MAX_SPOOL_FILES;
			const tooBig = bytes > MAX_SPOOL_BYTES;
			if (!tooOld && !tooMany && !tooBig) break;
			try {
				unlinkSync(entry.path);
				bytes -= entry.size;
				entries = entries.filter((e) => e.path !== entry.path);
			} catch {
				/* best effort */
			}
		}
	} catch {
		/* best effort */
	}
}

export interface DrainResult {
	sent: number;
	failed: number;
	dropped: number;
}

/**
 * drainSpool replays spooled snapshots.
 *
 * Sequential with a gap, and it STOPS at the first network error or 5xx: if the
 * server is down, hammering it with 50 more requests helps nobody. It also stops
 * at the first 401 — retrying a revoked token on a loop looks like credential
 * stuffing in hive's audit trail, since authMiddleware bumps last_used_at on
 * every call.
 *
 * Concurrency between pi instances is handled by claim-by-rename: two processes
 * cannot both win a rename of the same path, so the loser simply skips.
 */
export async function drainSpool(auth: ResolvedAuth, excludeRunId: string | null): Promise<DrainResult> {
	const result: DrainResult = { sent: 0, failed: 0, dropped: 0 };
	pruneSpool();

	const entries = listSpool().slice(0, MAX_DRAIN_PER_PASS);
	for (const entry of entries) {
		if (excludeRunId && entry.path.endsWith(`${excludeRunId}.json`)) continue;

		const claim = `${entry.path}.claim-${process.pid}`;
		try {
			renameSync(entry.path, claim);
		} catch {
			continue; // another pi instance owns it
		}

		let payload: AgentUsagePayload;
		try {
			payload = JSON.parse(readFileSync(claim, "utf8")) as AgentUsagePayload;
		} catch {
			// Unparseable: it can never be sent, so drop it rather than keep
			// re-claiming it on every session start.
			try {
				unlinkSync(claim);
			} catch {
				/* best effort */
			}
			result.dropped++;
			continue;
		}

		const res = await postUsage(payload, auth);
		if (res.ok) {
			try {
				unlinkSync(claim);
			} catch {
				/* best effort */
			}
			result.sent++;
		} else if (res.permanent) {
			try {
				unlinkSync(claim);
			} catch {
				/* best effort */
			}
			result.dropped++;
		} else {
			// Put it back for a later attempt, then stop: the server is down or
			// the credential is bad, and neither improves within this pass.
			try {
				renameSync(claim, entry.path);
			} catch {
				/* best effort */
			}
			result.failed++;
			break;
		}

		await new Promise((resolve) => {
			const t = setTimeout(resolve, DRAIN_GAP_MS);
			t.unref?.();
		});
	}
	return result;
}
