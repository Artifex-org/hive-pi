import type { HiveAuth, RequestResult } from "../hive-common/http.ts";
import { request } from "../hive-common/http.ts";

export interface ResourceRequest {
	id: string;
	session_id: string;
	client_call_id: string;
	resource: "postgres";
	action: "start" | "stop";
	database_name: string;
	/**
	 * Backend profile this start asked for. "template" seeds the database from
	 * the project's newest ready managed template; anything else (including the
	 * default "") starts bare, which is what every caller got before seeding
	 * existed.
	 */
	profile?: string;
	/**
	 * Presigned GET for that template's dump, minted by the server AT CLAIM
	 * TIME so it is as fresh as the fetch about to use it. Absent whenever the
	 * server could not resolve one — see template_seed_note — in which case the
	 * start proceeds bare.
	 */
	template_seed_url?: string;
	template_fingerprint?: string;
	template_seed_note?: string;
	requested_at: string;
	expires_at: string;
	state: "running";
	claimed_at: string;
}

export interface ResourceReport {
	generation: string;
	sequence: number;
	state: "starting" | "ready" | "stopping" | "ended" | "error";
	health: "unknown" | "healthy" | "unhealthy";
	database_name: string;
	host?: string;
	port?: number;
	connection_url?: string;
	process_id?: number;
	error?: string;
	ttl_seconds?: number;
}

export async function claimResourceRequests(
	auth: HiveAuth,
	sessionID: string,
): Promise<RequestResult<{ items: ResourceRequest[] }>> {
	return request<{ items: ResourceRequest[] }>(
		auth,
		"POST",
		`/agent-sessions/${encodeURIComponent(sessionID)}/resource-requests/claim`,
	);
}

export async function reportResource(
	auth: HiveAuth,
	sessionID: string,
	resource: string,
	body: ResourceReport,
): Promise<RequestResult<{ resource?: unknown }>> {
	return request<{ resource?: unknown }>(
		auth,
		"PUT",
		`/agent-sessions/${encodeURIComponent(sessionID)}/resources/${encodeURIComponent(resource)}`,
		body,
	);
}

export async function completeResourceRequest(
	auth: HiveAuth,
	sessionID: string,
	requestID: string,
	ok: boolean,
	error: string,
	durationMS: number,
): Promise<RequestResult> {
	return request(
		auth,
		"POST",
		`/agent-sessions/${encodeURIComponent(sessionID)}/resource-requests/${encodeURIComponent(requestID)}/complete`,
		{ ok, error, duration_ms: durationMS },
	);
}
