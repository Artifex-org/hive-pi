import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Private in-process signal from hive-remote for the exact user payload it is about to deliver. */
export const REMOTE_OPENING_INPUT_CHANNEL = "hive-remote:opening-input";
export const SESSION_IDENTITY_CHANNEL = "session-identity:canonical";
export const SESSION_IDENTITY_INITIAL_CHANNEL = "session-identity:initial";
export const SESSION_PLAN_INTRO_CHANNEL = "session-identity:plan-intro";
export const SESSION_MANUAL_TITLE_CHANNEL = "session-identity:manual-title";

export interface SessionIdentityUpdate {
	title: string;
	description: string;
	provisional: boolean;
	revision: number;
	titlePinned?: boolean;
	source: "initial" | "description" | "pivot";
	reason?: string;
	canonical?: import("./sessionIdentity.ts").SessionIdentity;
	origin?: "session-identity";
}

export function announceRemoteOpeningInput(pi: ExtensionAPI, text: string): void {
	pi.events.emit(REMOTE_OPENING_INPUT_CHANNEL, { text });
}
