import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HIVE_SESSION_CHANNEL, type HiveSessionEvent } from "./channels.ts";
import { type ResolvedAuth, resolveAuth } from "./identity.ts";
import { request } from "./http.ts";

export interface HiveSessionBinding {
	auth: ResolvedAuth;
	sessionID: string;
}

/**
 * Resolve one extension's own authenticated Hive session without sharing
 * hive-remote closure state. Pi loads extensions through separate jiti module
 * caches, so the process event bus carries only the opaque client run id.
 */
export class SessionPublisher {
	private clientRunID = process.env.PI_HIVE_RUN_ID?.trim() ?? "";
	private resolvedRunID = "";
	private sessionID = "";
	private auth: ResolvedAuth | null = null;
	private readonly unsubscribe: () => void;

	constructor(pi: ExtensionAPI) {
		this.unsubscribe = pi.events.on(HIVE_SESSION_CHANNEL, (data: unknown) => {
			const id = (data as HiveSessionEvent | undefined)?.clientRunID;
			if (typeof id !== "string" || !id || id === this.clientRunID) return;
			this.clientRunID = id;
			this.resolvedRunID = "";
			this.sessionID = "";
			this.auth = null;
		});
	}

	async binding(): Promise<HiveSessionBinding | null> {
		if (!this.clientRunID) this.clientRunID = process.env.PI_HIVE_RUN_ID?.trim() ?? "";
		if (!this.clientRunID) return null;
		if (this.auth && this.sessionID && this.resolvedRunID === this.clientRunID) {
			return { auth: this.auth, sessionID: this.sessionID };
		}
		const auth = resolveAuth();
		if (!auth) return null;
		const result = await request<{ id?: string }>(
			auth,
			"GET",
			`/agent-sessions/by-run/${encodeURIComponent(this.clientRunID)}`,
		);
		if (!result.ok || !result.body?.id) return null;
		this.auth = auth;
		this.sessionID = result.body.id;
		this.resolvedRunID = this.clientRunID;
		return { auth, sessionID: this.sessionID };
	}

	dispose(): void {
		this.unsubscribe();
		this.auth = null;
		this.sessionID = "";
		this.resolvedRunID = "";
	}
}
