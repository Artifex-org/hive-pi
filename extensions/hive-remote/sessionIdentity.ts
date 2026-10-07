import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { normalizeSessionTitle } from "./sessionTitleText.ts";
import { SESSION_IDENTITY_CHANNEL, SESSION_IDENTITY_INITIAL_CHANNEL, SESSION_PLAN_INTRO_CHANNEL, SESSION_MANUAL_TITLE_CHANNEL, type SessionIdentityUpdate } from "./sessionIdentityBus.ts";

export const SESSION_IDENTITY_ENTRY = "session-identity";
export interface SessionIdentity {
	title: string;
	description: string;
	provisional: boolean;
	revision: number;
	titlePinned?: boolean;
}

export function cleanDescription(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000);
}

/** Build a concise kickoff intro without another model call. */
export function provisionalIntro(prompt: string, title: string): string {
	// The title is the already-sanitized, bounded derivative of the true opening
	// input. Do not duplicate the raw prompt into durable metadata: it may include
	// paths, credentials, screenshots, or unrelated housekeeping.
	void prompt;
	return `Goal: ${title}. Approach: clarify the requested outcome, inspect the relevant code and tests, implement the smallest complete change, and verify it.`;
}

export function readIdentity(entries: readonly unknown[]): SessionIdentity | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: Partial<SessionIdentity> };
		if (entry?.type !== "custom" || entry.customType !== SESSION_IDENTITY_ENTRY) continue;
		const d = entry.data;
		if (typeof d?.title === "string" && typeof d.description === "string" && typeof d.revision === "number") return {
			title: d.title, description: d.description, provisional: d.provisional === true, revision: d.revision,
			titlePinned: d.titlePinned === true,
		};
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let identity: SessionIdentity | undefined;
	let manualTitle: string | undefined;
	let injectKickoff = false;
	const commit = (next: Omit<SessionIdentity, "revision">, source: SessionIdentityUpdate["source"], reason?: string) => {
		const requestedTitle = normalizeSessionTitle(next.title);
		const title = manualTitle ?? (identity?.titlePinned ? identity.title : requestedTitle);
		const description = cleanDescription(next.description);
		if (!requestedTitle || !title || !description) throw new Error("Session identity requires a title and description.");
		if (identity && identity.title === title && identity.description === description && identity.provisional === next.provisional && source === "description") return identity;
		identity = { ...next, title, description, titlePinned: manualTitle !== undefined || next.titlePinned, revision: (identity?.revision ?? 0) + 1 };
		pi.appendEntry(SESSION_IDENTITY_ENTRY, identity);
		pi.events.emit(SESSION_IDENTITY_CHANNEL, { ...identity, title: requestedTitle, source, reason, origin: "session-identity" } satisfies SessionIdentityUpdate);
		return identity;
	};
	pi.events.on(SESSION_IDENTITY_CHANNEL, (value: unknown) => {
		const event = value as SessionIdentityUpdate;
		if (event?.canonical) {
			identity = event.canonical;
			manualTitle = identity.titlePinned ? identity.title : undefined;
			pi.appendEntry(SESSION_IDENTITY_ENTRY, identity);
		}
		if (!event?.origin && event?.source === "pivot" && event.title && event.description && event.reason) {
			const result = commit({ title: event.title, description: event.description, provisional: false, titlePinned: identity?.titlePinned }, "pivot", event.reason);
			if (!result.titlePinned) pi.setSessionName(result.title);
		}
	});
	pi.on("session_start", (_event, ctx) => {
		try { identity = readIdentity(ctx.sessionManager.getBranch()); } catch { identity = undefined; }
		manualTitle = identity?.titlePinned ? identity.title : undefined;
		injectKickoff = true;
	});
	pi.on("session_info_changed", () => {
		const name = normalizeSessionTitle(pi.getSessionName() ?? "");
		// Agent writers commit canonical identity before naming. Any other change
		// is an operator /name gesture, which must stay pinned on reconnect.
		if (!name || name === identity?.title) return;
		manualTitle = name;
		if (identity) {
			identity = { ...identity, title: name, titlePinned: true };
			pi.appendEntry(SESSION_IDENTITY_ENTRY, identity);
		}
		pi.events.emit(SESSION_MANUAL_TITLE_CHANNEL, { title: name });
	});
	pi.on("session_compact", () => { injectKickoff = true; });
	pi.on("before_agent_start", () => {
		if (!injectKickoff) return;
		injectKickoff = false;
		return { message: {
			customType: "session-identity-context",
			content: identity
				? `Session identity (canonical): ${identity.title}\n${identity.description}${identity.provisional ? "\nRefine this provisional kickoff using session_context once the goal and approach are understood." : ""}\n\nAt kickoff, call session_context with a concise goal and approach paragraph even when no formal plan is needed. This does not create a plan or activate plan mode.`
				: "At kickoff, call session_context with a concise goal and approach paragraph, even when no formal plan is needed. Do not create a formal plan or activate plan mode unless the task warrants it.",
			display: false,
		},
		};
	});
	registerGuardedTool(pi, {
		capability: { writesExemptBecause: "stores the agent-authored session kickoff in Pi session metadata" },
		name: "session_context", exposure: "direct", label: "Set session context",
		promptSnippet: "At kickoff, define the goal and approach with session_context, even when no formal plan is needed.",
		description: "Author or update this session's canonical kickoff context as one concise paragraph covering goal and approach. Use it at kickoff even without formal planning; it does not create or activate a plan.",
		parameters: Type.Object({ goal: Type.String({ minLength: 1 }), approach: Type.String({ minLength: 1 }) }),
		async execute(_id, params: { goal: string; approach: string }) {
			const description = cleanDescription(`Goal: ${params.goal}. Approach: ${params.approach}`);
			if (!description) throw new Error("Provide a non-empty goal and approach.");
			const title = identity?.title ?? normalizeSessionTitle(pi.getSessionName() ?? "Session") ?? "Session";
			const result = commit({ title, description, provisional: false, titlePinned: identity?.titlePinned }, identity ? "description" : "initial");
			return { content: [{ type: "text" as const, text: `Session context saved: ${result.description}` }], details: result };
		},
	});
	pi.events.on(SESSION_PLAN_INTRO_CHANNEL, (payload: unknown) => {
		const description = (payload as { description?: unknown } | undefined)?.description;
		if (typeof description !== "string" || !description.trim()) return;
		const title = identity?.title ?? normalizeSessionTitle(pi.getSessionName() ?? "Session") ?? "Session";
		commit({ title, description, provisional: false, titlePinned: identity?.titlePinned }, identity ? "description" : "initial");
	});
	pi.events.on(SESSION_IDENTITY_INITIAL_CHANNEL, (payload: unknown) => {
		const p = payload as { title?: string; prompt?: string };
		if (identity || !p?.title || !p.prompt) return;
		commit({ title: p.title, description: provisionalIntro(p.prompt, p.title), provisional: true }, "initial");
	});
}
