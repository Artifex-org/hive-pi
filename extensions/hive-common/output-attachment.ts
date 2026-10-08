/**
 * hive-common — one file upload to a session's private Hive chat attachments
 * (`POST /agent-sessions/{id}/output-attachments`).
 *
 * Shared by pi's send_attachment / labelled-screenshot auto-post and the Claude
 * adapter's browser_screenshot, so it imports nothing from pi: erasable TS and
 * node only.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type HiveAuth, withTimeout } from "./http.ts";

export const MAX_OUTPUT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_LABEL = 80;

export type UploadOutcome = { ok: true; id: string; name: string } | { ok: false; message: string };

/**
 * `Screenshot · before · http://127.0.0.1:5173/orders` — query and fragment
 * dropped, as the surface publisher does. The label is model text: whitespace
 * and control characters collapse to single spaces, so a caption stays one
 * line (the Claude driver reads it off the result's last line).
 */
export function screenshotCaption(label: string, url: string): string {
	const flat = label.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
	const shortLabel = flat.length > MAX_CAPTION_LABEL ? `${flat.slice(0, MAX_CAPTION_LABEL - 1)}…` : flat;
	let page = "";
	try {
		const parsed = new URL(url);
		page = `${parsed.origin}${parsed.pathname}`;
	} catch {
		page = "";
	}
	return page ? `Screenshot · ${shortLabel} · ${page}` : `Screenshot · ${shortLabel}`;
}

/**
 * `dir` when it is a real directory owned by this user, else null. Admits the
 * session's screenshot directory as an upload root: its path is predictable in
 * a shared tmpdir, so another local user could pre-create it as a symlink to a
 * directory of their choosing and widen what an upload may read.
 */
export async function ownedDirectory(dir: string): Promise<string | null> {
	try {
		const info = await lstat(dir);
		if (info.isSymbolicLink() || !info.isDirectory()) return null;
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
		return dir;
	} catch {
		return null;
	}
}

/**
 * Upload one file to the session's private output attachments. `requested` is
 * absolute; its real path must sit beneath one of `roots`. Reads are bounded
 * and refuse FIFOs, symlink leaves and anything but a non-empty regular file.
 */
export async function uploadOutputAttachment(auth: HiveAuth, sessionID: string, requested: string, roots: string[]): Promise<UploadOutcome> {
	let path: string;
	let bytes: Buffer;
	let handle;
	try {
		path = await realpath(requested);
		const realRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter((root) => root !== null);
		if (!realRoots.some((root) => beneath(path, root))) return { ok: false, message: "File must be beneath this session's working directory or its browser screenshot directory." };
		// O_NONBLOCK prevents opening a FIFO from hanging; descriptor stat is authoritative.
		handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = await handle.stat();
		if (!info.isFile()) return { ok: false, message: "send_attachment requires a regular file." };
		if (info.size <= 0) return { ok: false, message: "Cannot upload an empty file." };
		if (info.size > MAX_OUTPUT_ATTACHMENT_BYTES) return { ok: false, message: `File exceeds the 5 MiB upload limit (${info.size} bytes).` };
		const bounded = Buffer.allocUnsafe(MAX_OUTPUT_ATTACHMENT_BYTES + 1);
		let total = 0;
		while (total < bounded.length) {
			const { bytesRead } = await handle.read(bounded, total, bounded.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > MAX_OUTPUT_ATTACHMENT_BYTES) return { ok: false, message: "File grew beyond the 5 MiB upload limit while being read." };
		bytes = bounded.subarray(0, total);
	} catch {
		return { ok: false, message: "Could not access or read the requested file." };
	} finally {
		await handle?.close().catch(() => undefined);
	}
	if (bytes.length === 0) return { ok: false, message: "Cannot upload an empty file." };
	const name = basename(path);
	const form = new FormData();
	form.append("file", new Blob([Uint8Array.from(bytes)]), name);
	try {
		const response = await withTimeout(15_000, (signal) => fetch(
			`${auth.url}/api/v1/agent-sessions/${encodeURIComponent(sessionID)}/output-attachments`,
			{ method: "POST", headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" }, body: form, signal },
		));
		if (!response.ok) return { ok: false, message: response.status === 401 || response.status === 403
			? "Hive rejected the session credentials; re-authenticate and retry."
			: `Hive rejected the attachment upload (HTTP ${response.status}).` };
		const body = await response.json() as { attachment?: { id?: unknown } };
		const id = body?.attachment?.id;
		if (typeof id !== "string" || !id) return { ok: false, message: "Hive accepted the upload but returned no attachment id." };
		return { ok: true, id, name };
	} catch (error) {
		return { ok: false, message: error instanceof Error && error.name === "AbortError"
			? "Attachment upload timed out. Retry when Hive is reachable."
			: "Attachment upload failed. Check Hive connectivity and retry." };
	}
}

function beneath(file: string, directory: string): boolean {
	const rel = relative(directory, file);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
