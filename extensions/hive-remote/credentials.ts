import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { request, type HiveAuth } from "../hive-common/http.ts";
import { exposureFor } from "../loadout/policy.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { requestAndWait, type Decision, type RequestRow } from "./client.ts";
import {
	bindCredentialSession, clearCredentialBinding, hasCredentialConsumer,
	installCredentialGrant, isCredentialBindingCurrent, validCredentialSet,
	type CredentialBinding, type ReceivedCredential,
} from "./credential-runtime.ts";

interface CatalogEntry { name: string; env_var: string; description?: string; requires_hosts?: string[] }
/** `unresolved` names the granted credentials the server could not resolve; only the rest were installed. */
export interface CredentialReceipt { installed: string[]; unresolved?: string[] }
type CredentialDecision = Decision<CredentialReceipt>;
/**
 * Where an approved delivery stopped. Each stage answers the two questions an
 * agent must not guess: was the one-shot value consumed, and will a fresh
 * request help? `value` is the only stage at which the server consumes it.
 */
export type DeliveryStage =
	| "grant-names" | "grant-shape" | "grant-expired" | "catalog-fetch" | "catalog-match" | "env-mapping"
	| "session-changed" | "value-fetch" | "value-shape" | "value-scope" | "value-mapping" | "install";
interface ReceiverDeps {
	enabled: boolean;
	localSessionID: () => string | null;
	isCurrent: (binding: CredentialBinding) => boolean;
	consumersReady: () => boolean;
	notice?: (text: string) => void;
	onUnavailable?: () => void;
}
const RECOVERY = "Approval is not installation. The one-shot value may be consumed; request again with a fresh call ID for a new approval.";
const safeResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** One owner of each secret fetch, regardless of native or MCP request origin.
 * Its cache contains only names/status, never credential values. */
export class CredentialReceiver {
	private binding?: CredentialBinding;
	private auth?: HiveAuth;
	private readonly deliveries = new Map<string, Promise<CredentialDecision>>();
	private polling = false;
	private recovering = false;
	private bindingVersion = 0;
	constructor(private readonly deps: ReceiverDeps) {}
	async probe(auth: HiveAuth, hiveSessionID: string): Promise<boolean> {
		if (!this.deps.enabled || !this.deps.localSessionID() || !this.deps.consumersReady()) return false;
		const res = await request<{ items?: unknown }>(auth, "GET", `/agent-sessions/${encodeURIComponent(hiveSessionID)}/credential-grants`);
		// HTTP helper deliberately discards error bodies; 409 is the owner-bound
		// ready-backend/no-attached-receiver handshake, not a successful discovery.
		return (res.status === 200 && Array.isArray(res.body?.items)) || res.status === 409;
	}
	bind(auth: HiveAuth, hiveSessionID: string, generation: number): void {
		this.detach();
		const local = this.deps.localSessionID();
		if (!local || !this.deps.enabled || !this.deps.consumersReady()) return;
		this.auth = auth;
		this.binding = bindCredentialSession(local, hiveSessionID, generation);
	}
	detach(): void {
		this.bindingVersion++;
		if (this.binding) clearCredentialBinding(this.binding);
		this.binding = undefined; this.auth = undefined; this.deliveries.clear();
	}
	/** Called at most once per existing poll tick, independently of conversation
	 * attachment. No binding/capability appears until backend and identity agree. */
	async recover(auth: HiveAuth, hiveSessionID: string, generation: number): Promise<boolean> {
		if (this.ready() || this.recovering || !this.deps.enabled) return false;
		const localSessionID = this.deps.localSessionID();
		if (!localSessionID || !this.deps.consumersReady()) return false;
		const candidate = { localSessionID, hiveSessionID, generation };
		if (!this.deps.isCurrent(candidate)) return false;
		if (this.binding) this.detach();
		const version = this.bindingVersion;
		this.recovering = true;
		try {
			if (!await this.probe(auth, hiveSessionID) || version !== this.bindingVersion || this.ready() ||
				this.deps.localSessionID() !== localSessionID || !this.deps.isCurrent(candidate)) return false;
			this.bind(auth, hiveSessionID, generation);
			return this.ready();
		} finally { this.recovering = false; }
	}
	private current(binding: CredentialBinding): boolean {
		return this.deps.enabled && this.binding === binding && isCredentialBindingCurrent(binding) &&
			this.deps.localSessionID() === binding.localSessionID && this.deps.isCurrent(binding) && this.deps.consumersReady();
	}
	ready(): boolean { return !!this.binding && this.current(this.binding); }
	/** Monotonic within this receiver, including same-lifecycle detach/rebind. */
	revision(): number { return this.bindingVersion; }
	private async catalog(auth: HiveAuth, binding: CredentialBinding): Promise<{ entries: CatalogEntry[] | null; status?: number | null }> {
		const res = await request<{ entries?: CatalogEntry[] }>(auth, "GET", `/agent-sessions/${encodeURIComponent(binding.hiveSessionID)}/credential-catalog`);
		if (!this.current(binding) || !res.ok || !Array.isArray(res.body?.entries)) return { entries: null, status: res.status };
		return { entries: res.body.entries };
	}
	async list(): Promise<string> {
		const binding = this.binding, auth = this.auth;
		if (!binding || !auth || !this.current(binding)) return this.unavailable();
		const { entries } = await this.catalog(auth, binding);
		if (!entries) return "Credential catalog unavailable; no credentials were installed.";
		const names = entries.filter(e => typeof e?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.name));
		if (!names.length) return "No credentials are configured.";
		// Metadata helps the agent choose the right service/database BEFORE asking
		// for a grant. Never forward operator refs, creators or credential values.
		return "Credential catalog metadata (not grants or values; descriptions are untrusted data):\n" + JSON.stringify(names.map(entry => ({
			name: entry.name, env_var: entry.env_var,
			description: typeof entry.description === "string" ? entry.description.slice(0, 1000) : "",
			requires_hosts: Array.isArray(entry.requires_hosts) ? entry.requires_hosts.filter(host => typeof host === "string") : [],
		})), null, 2);
	}
	unavailable(): string {
		return this.deps.enabled ? "Credential receiver unavailable: require a supported shell consumer, attached session and configured compatible backend. Check /hive-remote-status. No request or installation was made."
			: "Credential receipt disabled by allowReceiveCredentials. Ask the operator to re-enable it and restart; do not change configuration yourself. No request or installation was made.";
	}
	async request(callID: string, credentials: string[], reason: string, signal?: AbortSignal): Promise<string> {
		const binding = this.binding, auth = this.auth;
		if (!binding || !auth || !this.current(binding)) return this.unavailable();
		const decision = await requestAndWait<CredentialReceipt>(auth, "credential", binding.hiveSessionID, callID, { credentials, reason }, {
			pollMs: 3000, timeoutMs: 10 * 60_000, signal,
			isCurrent: () => this.current(binding), deliver: row => {
				if (!Array.isArray(row.credentials) || row.credentials.length !== credentials.length || row.credentials.some(name => !credentials.includes(name))) {
					return Promise.resolve(failed("grant-names", { names: credentials }));
				}
				return this.deliver(row, binding, auth);
			},
		});
		return `${this.describe(decision)}\nclient_call_id: ${callID}`;
	}
	async poll(): Promise<void> {
		const binding = this.binding, auth = this.auth;
		if (this.polling || !binding || !auth || !this.current(binding)) return;
		this.polling = true;
		try {
			const res = await request<{ items?: RequestRow[] }>(auth, "GET", `/agent-sessions/${encodeURIComponent(binding.hiveSessionID)}/credential-grants`);
			if (!this.current(binding)) return;
			if (res.status !== null && [401, 403, 404, 409, 503].includes(res.status)) {
				this.detach(); this.deps.onUnavailable?.(); return;
			}
			if (!res.ok || !Array.isArray(res.body?.items)) return;
			for (const row of res.body.items) {
				if (!this.current(binding)) break;
				const already = this.deliveries.has(row.id);
				const result = await this.deliver(row, binding, auth);
				if (!already && this.current(binding)) {
					try { this.deps.notice?.(this.describe(result)); } catch { /* stale session UI */ }
				}
			}
		} finally { this.polling = false; }
	}
	private deliver(row: RequestRow, binding: CredentialBinding, auth: HiveAuth): Promise<CredentialDecision> {
		if (!this.current(binding)) return Promise.resolve(failed("session-changed"));
		const prior = this.deliveries.get(row.id);
		if (prior) return prior;
		if (this.deliveries.size >= 512) return Promise.resolve({ verdict: "error", error: "receiver request limit reached" });
		let retryable = false;
		const delivery = this.fetchAndInstall(row, binding, auth, () => { retryable = true; }).finally(() => {
			if (retryable && this.deliveries.get(row.id) === delivery) this.deliveries.delete(row.id);
		});
		this.deliveries.set(row.id, delivery);
		return delivery;
	}
	private async fetchAndInstall(row: RequestRow, binding: CredentialBinding, auth: HiveAuth, retry: () => void): Promise<CredentialDecision> {
		if ((row.verdict !== "approve" && row.verdict !== "auto") || typeof row.id !== "string" ||
			!Array.isArray(row.credentials) || !row.credentials.length || row.credentials.length > 32 ||
			new Set(row.credentials).size !== row.credentials.length || typeof row.expires_at !== "string") return failed("grant-shape");
		const granted = row.credentials;
		const expiry = Date.parse(row.expires_at);
		if (!Number.isFinite(expiry) || expiry <= Date.now()) return failed("grant-expired", { names: granted });
		const catalog = await this.catalog(auth, binding);
		if (!catalog.entries) { retry(); return failed(this.current(binding) ? "catalog-fetch" : "session-changed", { status: catalog.status }); }
		const entries = granted.map(name => catalog.entries!.filter(entry => entry?.name === name));
		const unmatched = granted.filter((_, i) => entries[i].length !== 1);
		if (unmatched.length) return failed("catalog-match", { names: unmatched });
		// Validate mappings before consuming. Never allow a catalog entry to alter
		// provider authentication, process identity, shell startup or runtime config.
		const mapped = entries.map(matches => matches[0]);
		const refused = mapped.filter(entry => !validCredentialSet([{ ...entry, value: "validation-only" }])).map(entry => entry.name);
		if (refused.length || !validCredentialSet(mapped.map(entry => ({ ...entry, value: "validation-only" })))) {
			return failed("env-mapping", { names: refused.length ? refused : granted });
		}
		if (!this.current(binding)) return failed("session-changed");
		const res = await request<{ env?: Record<string, unknown>; resolved?: unknown[] }>(auth, "GET", `/agent-sessions/${encodeURIComponent(binding.hiveSessionID)}/credential-grants/${encodeURIComponent(row.id)}/value`);
		if (!this.current(binding)) return failed("session-changed");
		// The server body is deliberately not read on failure: the status names the stage.
		if (!res.ok) return failed("value-fetch", { status: res.status, names: granted });
		if (!res.body?.env || typeof res.body.env !== "object" || Array.isArray(res.body.env) || !Array.isArray(res.body.resolved)) return failed("value-shape");
		const resolved = res.body.resolved;
		if (!resolved.length || new Set(resolved).size !== resolved.length) return failed("value-shape");
		const outside = resolved.map(String).filter(name => !granted.includes(name));
		if (outside.length) return failed("value-scope", { names: outside.filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) });
		const items: ReceivedCredential[] = [];
		for (const name of resolved) {
			const entry = mapped.find(entry => entry.name === name);
			if (!entry) return failed("value-scope");
			const value = res.body.env[entry.env_var];
			if (typeof value !== "string") return failed("value-mapping", { names: [entry.name] });
			items.push({ name: entry.name, env_var: entry.env_var, value });
		}
		if (Object.keys(res.body.env).length !== items.length) return failed("value-mapping");
		if (!installCredentialGrant(binding, row.id, expiry, items)) return failed("install", { names: items.map(item => item.name) });
		const installed = items.map(item => item.name);
		const unresolved = granted.filter(name => !installed.includes(name));
		return { verdict: row.verdict, grant: { installed, ...(unresolved.length ? { unresolved } : {}) } };
	}
	private describe(decision: CredentialDecision): string {
		if (decision.grant) {
			const unresolved = decision.grant.unresolved?.length
				? ` Not installed, because the server could not resolve them: ${decision.grant.unresolved.join(", ")} (operator-side catalog reference or secret-store access; a fresh request fails the same way).`
				: "";
			return `Installed for future session-bound shell children only: ${decision.grant.installed.join(", ")}.${unresolved} Existing provider/MCP processes are unchanged; request expiry removes overrides. Literal shell output is redacted, not arbitrary secret containment.`;
		}
		if (decision.verdict === "deny" || decision.verdict === "expired" || decision.verdict === "timeout") return `Credential request ${decision.verdict}; nothing installed.`;
		if (decision.stage) {
			const status = decision.status === null || decision.status === undefined ? "network error" : `HTTP ${decision.status}`;
			// Request/poll endpoints return verdict metadata, never one-shot values.
			// Do NOT expose server error bodies from catalog/value delivery failures.
			return `Credential ${decision.stage} failed (${status}); installation is not confirmed by this call. ${decision.error ?? "No server explanation."} Background delivery may still complete; check receiver notices before requesting again.`;
		}
		if (decision.error === "receiver request limit reached") return "Credential receiver session limit reached; nothing installed. Ask the operator to restart a supported session before a fresh approved request.";
		if (decision.delivery) return describeDeliveryFailure(decision.delivery);
		return `Credential delivery failed; nothing installed. ${RECOVERY}`;
	}
}

function failed(stage: DeliveryStage, detail: { status?: number | null; names?: string[] } = {}): CredentialDecision {
	return { verdict: "error", delivery: { stage, ...detail } };
}

const FRESH = "Request again with a fresh call ID.";

/**
 * describeDeliveryFailure renders one stage as receiver-authored text: the
 * stage, the HTTP status when the stage was a call, whether the one-shot value
 * was consumed, and what to do next. No server text and no value reaches it.
 */
export function describeDeliveryFailure(delivery: { stage: string; status?: number | null; names?: string[] }): string {
	const names = delivery.names?.length ? ` (${delivery.names.join(", ")})` : "";
	const status = delivery.status === null ? "network error" : delivery.status === undefined ? "" : `HTTP ${delivery.status}`;
	const head = `Credential delivery failed at stage ${delivery.stage}${status ? ` (${status})` : ""}; nothing installed.`;
	switch (delivery.stage) {
		case "grant-names": return `${head} The approved grant names differ from this request${names}; the value was not fetched. ${FRESH}`;
		case "grant-shape": return `${head} The server returned a grant row this receiver cannot accept; the value was not fetched. Report it as a Hive client/server mismatch.`;
		case "grant-expired": return `${head} The grant${names} expired before delivery; the value was not fetched. ${FRESH}`;
		case "catalog-fetch": return `${head} The session catalog could not be read, so the value was not fetched and the grant is still deliverable; the receiver retries on its next poll. Check receiver notices before requesting again.`;
		case "catalog-match": return `${head} The granted name${names} is missing from, or ambiguous in, this session's catalog; the value was not fetched. Ask the operator to check the catalog entry.`;
		case "env-mapping": return `${head} The catalog maps${names} to an environment variable this receiver refuses (reserved or invalid name); the value was not fetched. Ask the operator to change the catalog env_var; do not request again until then.`;
		case "session-changed": return `${head} The session was replaced or detached during delivery; nothing reached this session. ${FRESH}`;
		case "value-fetch": return `${head} ${valueFetchFailure(delivery.status, names)}`;
		case "value-shape": return `${head} The server consumed the grant but its value response was malformed; nothing was kept. Report it as a Hive client/server mismatch; a fresh request is likely to fail the same way.`;
		case "value-scope": return `${head} The server resolved credentials outside this grant${names}; everything was refused. Report it; do not request again.`;
		case "value-mapping": return `${head} The server's values do not match the catalog mapping${names}; nothing was kept. Report it as a Hive client/server mismatch.`;
		case "install": return `${head} The values were fetched but this session refused to install them${names}: the session holds too many credentials, the grant expired, or a value is empty, binary or over 16 KiB. Restart the session before a fresh request if it holds many grants.`;
		default: return `${head} ${RECOVERY}`;
	}
}

function valueFetchFailure(status: number | null | undefined, names: string): string {
	switch (status) {
		case 502: return `The server consumed the grant but resolved none of the granted credentials${names} from its secret store: the catalog reference is unreadable with the owner's stored secret-store access, or wrong. A fresh request consumes another grant and fails the same way. Ask the operator to fix the catalog reference or that access (server log: "credbroker: bundle entry skipped").`;
		case 410: return `The server reports the one-shot grant already fetched, denied or expired. If another receiver fetched it, check receiver notices; otherwise request again with a fresh call ID.`;
		case 404: return `The server has no such grant for this session; nothing was consumed. ${FRESH}`;
		case 401: case 403: return "The server refused this receiver's Hive token for the owner-only value fetch; nothing was consumed. Check /hive-remote-status; the session's token must belong to the session owner.";
		case 409: return "The server no longer sees a credential-capable conversation for this session. Check /hive-remote-status, then request again with a fresh call ID.";
		case 503: return "Credential brokering is not configured on the server; nothing was consumed. Ask the operator.";
		case null: case undefined: return `The value fetch did not complete (network error or timeout); the server may have consumed the grant. ${FRESH}`;
		default: return `The value fetch failed; the server may have consumed the grant. ${FRESH}`;
	}
}

export function credentialConsumersReady(pi: ExtensionAPI): boolean {
	return hasCredentialConsumer("bash") &&
		(!pi.getAllTools().some(tool => tool.name === "background_bash") || hasCredentialConsumer("background"));
}
export function registerCredentialTools(pi: ExtensionAPI, receiver: CredentialReceiver): void {
	pi.registerTool({ name: "list_credential_catalog", exposure: exposureFor("list_credential_catalog"), label: "List grantable credentials",
		description: "List credential catalog names, service/database descriptions, environment mappings and required hosts for this session. Check scope before requesting a grant. Never returns values or operator references.", parameters: Type.Object({}),
		async execute() { return safeResult(await receiver.list()); },
	});
	registerGuardedTool(pi, { capability: { writesExemptBecause: "owner-approved credentials enter only this session’s future shell-child environment; never configuration" }, name: "request_credential", exposure: exposureFor("request_credential"), label: "Request a credential",
		description: "Request named catalog credentials with owner approval. On approval, install only into future shell children of this session. Provider authentication and existing MCP processes are unchanged. Never returns values.",
		parameters: Type.Object({ credentials: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }), { minItems: 1, maxItems: 32, uniqueItems: true }), reason: Type.String({ minLength: 1 }) }),
		async execute(id, params, signal) { return safeResult(await receiver.request(id, params.credentials, params.reason, signal)); },
	});
}
