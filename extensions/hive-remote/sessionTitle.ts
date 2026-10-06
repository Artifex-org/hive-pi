/**
 * session_title — lets the agent keep its own session title current.
 *
 * pi titles a session ONCE, from its first prompt, and never again; that is
 * the name an operator reads the session by in the Hive agents workspace, so
 * it went on describing the opening question for hours after the work became
 * something else. Nothing let the agent fix that: the server's rename is an
 * operator gesture that PINS the title, and an agent overwriting an operator's
 * chosen name would be wrong. So this goes through pi's own session name — the
 * value hive-remote already reports on every conversation refresh — and the
 * server's pin keeps an operator rename in place regardless.
 *
 * The same file lives in hive's cmd/factory-exec/piext/hive-remote/ (the cloud
 * interactive copy); keep them alike.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { exposureFor } from "../loadout/policy.ts";
import { MAX_SESSION_TITLE, normalizeSessionTitle } from "./sessionTitleText.ts";

export function registerSessionTitleTool(pi: ExtensionAPI): void {
	registerGuardedTool(pi, {
		capability: { writesExemptBecause: "renames this session in pi's own metadata; writes no file" },
		name: "session_title",
		// Deferred (the direct-tool budget is full): Hive's hygiene nudges name it
		// exactly, and load_tools finds it by that name.
		exposure: exposureFor("session_title"),
		label: "Set session title",
		promptSnippet: "Keep this session's title current: retitle when the work changes shape, and by outcome when you finish",
		description:
			"Set this session's title — the one line an operator reads it by in the Hive agents workspace. " +
			"Call it when the work has changed shape so the first prompt no longer describes it, and once more when you finish, naming the outcome " +
			`(e.g. "Fixed runs-table sort drift — PR #8123"). Plain text, at most ${MAX_SESSION_TITLE} characters. ` +
			"An operator who renamed the session keeps their name; yours is then only local.",
		parameters: Type.Object({
			title: Type.String({ description: `The new title: what this session is doing or did, at most ${MAX_SESSION_TITLE} characters.` }),
		}),
		async execute(_id, params: { title: string }) {
			const title = normalizeSessionTitle(String(params.title ?? ""));
			if (!title) {
				return { content: [{ type: "text" as const, text: "No title given. Pass one plain-text line naming what this session is doing." }], isError: true, details: { title: "" } };
			}
			pi.setSessionName(title);
			return { content: [{ type: "text" as const, text: `Session titled "${title}".` }], details: { title } };
		},
	});
}
