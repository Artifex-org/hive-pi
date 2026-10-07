/** Explicit session identity pivot; ordinary completion is not a rename. */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { exposureFor } from "../loadout/policy.ts";
import { MAX_SESSION_TITLE, normalizeSessionTitle } from "./sessionTitleText.ts";
import { SESSION_IDENTITY_CHANNEL, type SessionIdentityUpdate } from "./sessionIdentityBus.ts";

export function registerSessionTitleTool(pi: ExtensionAPI): void {
	registerGuardedTool(pi, {
		capability: { writesExemptBecause: "records an explicitly requested session identity pivot in Pi metadata" },
		name: "session_title", exposure: exposureFor("session_title"), label: "Pivot session identity",
		promptSnippet: "Use session_title only for an explicit task pivot; provide a new title, goal/approach description, and reason.",
		description: `Explicitly pivot the session's identity when the task fundamentally changes. Requires title (at most ${MAX_SESSION_TITLE} characters), goal/approach description, and reason. Do not call merely to report completion.`,
		parameters: Type.Object({
			title: Type.String({ description: "New session title." }),
			description: Type.String({ minLength: 1, description: "Canonical goal and approach paragraph." }),
			reason: Type.String({ minLength: 1, description: "Why the session's task has pivoted." }),
		}),
		async execute(_id, params: { title: string; description: string; reason: string }) {
			const title = normalizeSessionTitle(params.title);
			const description = params.description.trim();
			const reason = params.reason.trim();
			if (!title || !description || !reason) throw new Error("A pivot requires title, description, and reason.");
			pi.events.emit(SESSION_IDENTITY_CHANNEL, { title, description, reason, source: "pivot", provisional: false, revision: 0 } satisfies SessionIdentityUpdate);
			return { content: [{ type: "text" as const, text: `Session pivot recorded: ${title}` }], details: { title, description, reason } };
		},
	});
}
