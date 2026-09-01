import type { HiveAuth, RequestResult } from "../hive-common/http.ts";
import { request } from "../hive-common/http.ts";

export interface ResourceRequest {
	id: string;
	session_id: string;
	client_call_id: string;
	resource: "postgres";
	action: "start" | "stop";
	database_name: string;
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
