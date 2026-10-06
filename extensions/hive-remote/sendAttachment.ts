import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HiveAuth } from "../hive-common/http.ts";
import { withTimeout } from "../hive-common/http.ts";
import { ScreenshotLedger } from "../pr-attachments/manifest.ts";
import { exposureFor } from "../loadout/policy.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

export const MAX_OUTPUT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface SendAttachmentDeps {
	getAuth(): HiveAuth | null;
	getSessionID(): string | null;
	getGeneration(): number;
	isUploadTargetCurrent(sessionID: string, generation: number): boolean;
	onUploaded(sessionID: string, caption: string, attachmentIDs: string[]): void;
}

/** Register the session-scoped native file upload tool. */
export function registerSendAttachmentTool(pi: ExtensionAPI, deps: SendAttachmentDeps): void {
	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "uploads the user-requested file to this session's Hive transcript" },
		name: "send_attachment",
		exposure: exposureFor("send_attachment"),
		label: "Send attachment to Hive chat",
		promptSnippet: "Upload a local file to the Hive chat transcript",
		description: "Upload a local file (maximum 5 MiB) to this session's Hive chat as an assistant attachment. Use for before/after screenshots or other files the operator should see. This is separate from attaching files to a GitHub PR.",
		parameters: Type.Object({
			path: Type.String({ description: "Local file path beneath this session's working directory or this session's browser screenshot directory." }),
			caption: Type.Optional(Type.String({ description: "Short caption shown with the uploaded file." })),
		}),
		async execute(_id, params: { path: string; caption?: string }, _signal, _onUpdate, ctx) {
			const auth = deps.getAuth();
			const sessionID = deps.getSessionID();
			const generation = deps.getGeneration();
			if (!auth || !sessionID) return result("This session is not attached to the Hive agents workspace yet.", true);
			const cwd = ctx.cwd;
			const ledger = new ScreenshotLedger(process.env, ctx.sessionManager.getSessionId());
			let path: string;
			let bytes: Buffer;
			let handle;
			try {
				const requested = resolve(cwd, params.path);
				path = await realpath(requested);
				const [realCwd, realShotDir] = await Promise.all([realpath(cwd), realpath(ledger.shotDir).catch(() => resolve(ledger.shotDir))]);
				if (!beneath(path, realCwd) && !beneath(path, realShotDir)) return result("File must be beneath this session's working directory or its browser screenshot directory.", true);
				// O_NONBLOCK prevents opening a FIFO from hanging; descriptor stat is authoritative.
				handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const info = await handle.stat();
				if (!info.isFile()) return result("send_attachment requires a regular file.", true);
				if (info.size <= 0) return result("Cannot upload an empty file.", true);
				if (info.size > MAX_OUTPUT_ATTACHMENT_BYTES) return result(`File exceeds the 5 MiB upload limit (${info.size} bytes).`, true);
				const bounded = Buffer.allocUnsafe(MAX_OUTPUT_ATTACHMENT_BYTES + 1);
				let total = 0;
				while (total < bounded.length) {
					const { bytesRead } = await handle.read(bounded, total, bounded.length - total, total);
					if (bytesRead === 0) break;
					total += bytesRead;
				}
				if (total > MAX_OUTPUT_ATTACHMENT_BYTES) return result("File grew beyond the 5 MiB upload limit while being read.", true);
				bytes = bounded.subarray(0, total);
			} catch {
				return result("Could not access or read the requested file.", true);
			} finally {
				await handle?.close().catch(() => undefined);
			}
			if (bytes.length === 0) return result("Cannot upload an empty file.", true);
			const name = basename(path);
			const form = new FormData();
			form.append("file", new Blob([Uint8Array.from(bytes)]), name);
			try {
				const response = await withTimeout(15_000, (signal) => fetch(
					`${auth.url}/api/v1/agent-sessions/${encodeURIComponent(sessionID)}/output-attachments`,
					{ method: "POST", headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" }, body: form, signal },
				));
				if (!response.ok) return result(response.status === 401 || response.status === 403
					? "Hive rejected the session credentials; re-authenticate and retry."
					: `Hive rejected the attachment upload (HTTP ${response.status}).`, true);
				const body = await response.json() as { attachment?: { id?: unknown } };
				const id = body?.attachment?.id;
				if (typeof id !== "string" || !id) return result("Hive accepted the upload but returned no attachment id.", true);
				if (!deps.isUploadTargetCurrent(sessionID, generation)) return result("Attachment uploaded to the original Hive session but was not published here because the session changed or remote reporting was turned off.", true);
				const caption = params.caption?.trim() || `Attached ${name}`;
				deps.onUploaded(sessionID, caption, [id]);
				return result(`Uploaded ${name} to the Hive chat: ${caption}`);
			} catch (error) {
				return result(error instanceof Error && error.name === "AbortError"
					? "Attachment upload timed out. Retry when Hive is reachable."
					: "Attachment upload failed. Check Hive connectivity and retry.", true);
			}
		},
	});
}

function beneath(file: string, directory: string): boolean {
	const rel = relative(directory, file);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function result(message: string, isError = false) {
	return { content: [{ type: "text" as const, text: message }], details: {}, ...(isError ? { isError: true } : {}) };
}
