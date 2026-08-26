/**
 * hive-remote — the LOCAL journal: the same token stream, without the round trip.
 *
 * ## Why this exists
 *
 * A delta's job is to make the reply appear as it is written. Today every one of
 * them is an HTTP POST to Hive, and `deltaQueue` deliberately COALESCES them —
 * one request in flight per channel, later text accumulating behind it — because
 * HTTP gives no ordering across separate requests and thirty round trips per
 * burst is thirty round trips.
 *
 * That is the right trade for a browser on the other side of the internet. It is
 * the wrong one for the Hive desktop app, which is running on THIS MACHINE: the
 * text it renders was produced a few microseconds away and arrives via a server
 * that may be a continent away. So when a local sink is configured, every delta
 * is ALSO appended here, uncoalesced, in the order it was produced.
 *
 * ## What this is not
 *
 * Not a transcript, and not a replacement for one. The durable record is what
 * `postEvents` sends and what Hive stores; this carries only the ephemeral text
 * that a durable event later supersedes. Nothing here is authoritative, nothing
 * here is retried, and a reader that loses it has lost a frame of smoothness and
 * nothing else — the same trade `postDelta` already documents for the network.
 *
 * That is also why deltas are the only record kind. Events carry a client-minted
 * `seq` that is both ordering and idempotency key, and `rebase` can renumber
 * queued events after the fact; a journalled copy would then disagree with the
 * server about the numbering of the same event. Deltas have no seq and no
 * identity, so a local copy cannot contradict anything.
 *
 * ## Failure is silent, deliberately
 *
 * This runs on the agent loop's event handlers. Nothing it does may throw, and
 * nothing it does may block: a full disk or a vanished directory disables the
 * journal for the session and is never allowed to reach the caller. The session
 * carries on exactly as it would with no local sink at all.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/** Where to write. Set per launch by hive-agent, or by `hive desktop dev`. */
export const JOURNAL_DIR_ENV = "HIVE_LOCAL_JOURNAL";

/**
 * A session's journal is capped, and the cap is on BYTES WRITTEN rather than
 * file size.
 *
 * A long session can stream hundreds of megabytes of tokens, and this file is on
 * the operator's own disk with nothing rotating it. The reader tails from the
 * end, so the old bytes were never going to be read — but they would still be
 * occupying the disk. Past the cap the journal says so once and stops.
 */
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

export interface Journal {
	/** Append one delta. Returns immediately; never throws. */
	delta(text: string, channel?: "thinking"): void;
	/** Stop writing and release the handle. Safe to call twice. */
	close(): void;
}

/**
 * safeName keeps a session id from becoming a path.
 *
 * The id comes from the server and should be a UUID, but it is used here as a
 * FILENAME — and "should be" is not a check. Anything outside the plain
 * identifier set disables the journal rather than writing somewhere surprising.
 */
export function safeName(id: string): string | null {
	if (!id || id.length > 128) return null;
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function journalPath(dir: string, sessionID: string): string | null {
	const name = safeName(sessionID);
	return name ? join(dir, `${name}.ndjson`) : null;
}

/**
 * openJournal starts one session's journal, or returns null.
 *
 * Null for every "not configured" and every "could not": no sink in the
 * environment, an unusable session id, a directory that cannot be created. The
 * caller treats all of them the same way, because from the session's point of
 * view they are the same thing — no local reader is getting anything, and the
 * network path is unaffected.
 */
export function openJournal(
	sessionID: string,
	env: NodeJS.ProcessEnv = process.env,
): Journal | null {
	const dir = env[JOURNAL_DIR_ENV]?.trim();
	if (!dir) return null;
	const path = journalPath(dir, sessionID);
	if (!path) return null;

	let stream: WriteStream;
	try {
		// 0700 because everything written here is the operator's own conversation
		// text, and the directory is the only access control on it.
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		stream = createWriteStream(path, { flags: "a", mode: 0o600 });
	} catch {
		return null;
	}

	let written = 0;
	let live = true;
	// A stream error (disk full, directory removed under us) is emitted
	// asynchronously and is FATAL to an unhandled-error listener. Handling it is
	// what keeps a failed journal from taking the agent down with it.
	stream.on("error", () => {
		live = false;
	});

	function write(record: Record<string, unknown>): void {
		if (!live) return;
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch {
			// Unserializable text is not worth a thrown error on the agent loop.
			return;
		}
		if (written + line.length > JOURNAL_MAX_BYTES) {
			live = false;
			try {
				stream.write(`${JSON.stringify({ t: Date.now(), kind: "capped" })}\n`);
				stream.end();
			} catch {
				/* already gone */
			}
			return;
		}
		written += line.length;
		try {
			stream.write(line);
		} catch {
			live = false;
		}
	}

	return {
		delta(text: string, channel?: "thinking"): void {
			if (!text) return;
			// `channel` is omitted for ordinary text rather than written as
			// "text", mirroring the wire: a reader that predates the split treats
			// an unlabelled delta as the answer, which is the safe default —
			// filing answers behind a collapsed reasoning block is not.
			write(channel ? { t: Date.now(), kind: "delta", channel, text } : { t: Date.now(), kind: "delta", text });
		},
		close(): void {
			if (!live) return;
			live = false;
			try {
				stream.end();
			} catch {
				/* already gone */
			}
		},
	};
}
