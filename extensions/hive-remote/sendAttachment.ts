import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HiveAuth } from "../hive-common/http.ts";
import { screenshotCaption, uploadOutputAttachment } from "../hive-common/output-attachment.ts";
import { ScreenshotLedger } from "../pr-attachments/manifest.ts";
import { exposureFor } from "../loadout/policy.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";

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
		description: "Upload a local file (maximum 5 MiB) to this session's Hive chat as an assistant attachment; it lands in the chat and its Media section. Use for screenshots, recordings, reports or other files the operator should see. A browser_screenshot taken WITH a label is already posted automatically — do not send it again. This is separate from attaching files to a GitHub PR.",
		parameters: Type.Object({
			path: Type.String({ description: "Local file path beneath this session's working directory or this session's browser screenshot directory." }),
			caption: Type.Optional(Type.String({ description: "Short caption shown with the uploaded file." })),
		}),
		async execute(_id, params: { path: string; caption?: string }, _signal, _onUpdate, ctx) {
			const auth = deps.getAuth();
			const sessionID = deps.getSessionID();
			const generation = deps.getGeneration();
			if (!auth || !sessionID) return result("This session is not attached to the Hive agents workspace yet.", true);
			const ledger = new ScreenshotLedger(process.env, ctx.sessionManager.getSessionId());
			const uploaded = await uploadOutputAttachment(auth, sessionID, resolve(ctx.cwd, params.path), [ctx.cwd, ledger.shotDir]);
			if (!uploaded.ok) return result(uploaded.message, true);
			if (!deps.isUploadTargetCurrent(sessionID, generation)) return result("Attachment uploaded to the original Hive session but was not published here because the session changed or remote reporting was turned off.", true);
			const caption = params.caption?.trim() || `Attached ${uploaded.name}`;
			deps.onUploaded(sessionID, caption, [uploaded.id]);
			return result(`Uploaded ${uploaded.name} to the Hive chat: ${caption}`);
		},
	});
}

/**
 * Post a labelled browser_screenshot to the Hive chat without the model asking.
 *
 * A label (`before`/`after`, or any other) is the agent declaring the shot is
 * evidence — the same signal the PR funnel attaches by — so the operator gets
 * it in the chat and its Media section as it is taken. Unlabelled shots are the
 * agent looking at its own work and stay private to it. Only this session's
 * screenshot directory is admissible: the path comes from a tool result, and a
 * result is not a request to read the working tree.
 *
 * Returns a failure message for the caller to surface, or null when the shot
 * was published or deliberately skipped.
 */
export async function publishLabelledScreenshot(deps: SendAttachmentDeps, piSessionID: string, toolResult: unknown): Promise<string | null> {
	const details = (toolResult as { details?: { path?: unknown; label?: unknown; url?: unknown } } | null)?.details;
	const label = typeof details?.label === "string" ? details.label.trim() : "";
	if (!label || typeof details?.path !== "string") return null;
	const auth = deps.getAuth();
	const sessionID = deps.getSessionID();
	const generation = deps.getGeneration();
	if (!auth || !sessionID) return null;
	const ledger = new ScreenshotLedger(process.env, piSessionID);
	const uploaded = await uploadOutputAttachment(auth, sessionID, details.path, [ledger.shotDir]);
	if (!uploaded.ok) return `Could not post the ${label} screenshot to the chat: ${uploaded.message}`;
	if (!deps.isUploadTargetCurrent(sessionID, generation)) return null;
	deps.onUploaded(sessionID, screenshotCaption(label, typeof details.url === "string" ? details.url : ""), [uploaded.id]);
	return null;
}

function result(message: string, isError = false) {
	return { content: [{ type: "text" as const, text: message }], details: {}, ...(isError ? { isError: true } : {}) };
}
