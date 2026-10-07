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

interface CatalogEntry { name: string; env_var: string }
export interface CredentialReceipt { installed: string[] }
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
	private readonly deliveries = new Map<string, Promise<Decision<CredentialReceipt>>>();
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
	private async catalog(auth: HiveAuth, binding: CredentialBinding): Promise<CatalogEntry[] | null> {
		const res = await request<{ entries?: CatalogEntry[] }>(auth, "GET", `/agent-sessions/${encodeURIComponent(binding.hiveSessionID)}/credential-catalog`);
		if (!this.current(binding) || !res.ok || !Array.isArray(res.body?.entries)) return null;
		return res.body.entries;
	}
	async list(): Promise<string> {
		const binding = this.binding, auth = this.auth;
		if (!binding || !auth || !this.current(binding)) return this.unavailable();
		const entries = await this.catalog(auth, binding);
		if (!entries) return "Credential catalog unavailable; no credentials were installed.";
		const names = entries.filter(e => typeof e?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.name));
		return names.length ? `Grantable credentials (names only): ${names.map(e => e.name).join(", ")}` : "No credentials are configured.";
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
					return Promise.resolve({ verdict: "error", error: "grant names do not match the request" });
				}
				return this.deliver(row, binding, auth);
			},
		});
		return this.describe(decision);
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
	private deliver(row: RequestRow, binding: CredentialBinding, auth: HiveAuth): Promise<Decision<CredentialReceipt>> {
		if (!this.current(binding)) return Promise.resolve({ verdict: "error", error: "session changed" });
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
	private async fetchAndInstall(row: RequestRow, binding: CredentialBinding, auth: HiveAuth, retry: () => void): Promise<Decision<CredentialReceipt>> {
		const failure = (): Decision<CredentialReceipt> => ({ verdict: "error", error: RECOVERY });
		if ((row.verdict !== "approve" && row.verdict !== "auto") || typeof row.id !== "string" ||
			!Array.isArray(row.credentials) || !row.credentials.length || row.credentials.length > 32 ||
			new Set(row.credentials).size !== row.credentials.length || typeof row.expires_at !== "string") return failure();
		const expiry = Date.parse(row.expires_at);
		if (!Number.isFinite(expiry) || expiry <= Date.now()) return failure();
		const catalog = await this.catalog(auth, binding);
		if (!catalog) { retry(); return failure(); }
		const entries = row.credentials.map(name => catalog.filter(entry => entry?.name === name));
		if (entries.some(matches => matches.length !== 1)) return failure();
		// Validate mappings before consuming. Never allow a catalog entry to alter
		// provider authentication, process identity, shell startup or runtime config.
		const mapped = entries.map(matches => matches[0]);
		if (!validCredentialSet(mapped.map(entry => ({ ...entry, value: "validation-only" })))) return failure();
		if (!this.current(binding)) return failure();
		const res = await request<{ env?: Record<string, unknown>; resolved?: unknown[] }>(auth, "GET", `/agent-sessions/${encodeURIComponent(binding.hiveSessionID)}/credential-grants/${encodeURIComponent(row.id)}/value`);
		if (!this.current(binding) || !res.ok || !res.body?.env || typeof res.body.env !== "object" || Array.isArray(res.body.env) || !Array.isArray(res.body.resolved)) return failure();
		const resolved = res.body.resolved;
		if (!resolved.length || new Set(resolved).size !== resolved.length || resolved.some(name => !row.credentials!.includes(String(name)))) return failure();
		const items: ReceivedCredential[] = [];
		for (const name of resolved) {
			const entry = mapped.find(entry => entry.name === name);
			if (!entry) return failure();
			const value = res.body.env[entry.env_var];
			if (typeof value !== "string") return failure();
			items.push({ name: entry.name, env_var: entry.env_var, value });
		}
		if (Object.keys(res.body.env).length !== items.length || !installCredentialGrant(binding, row.id, expiry, items)) return failure();
		return { verdict: row.verdict, grant: { installed: items.map(item => item.name) } };
	}
	private describe(decision: Decision<CredentialReceipt>): string {
		if (decision.grant) return `Installed for future session-bound shell children only: ${decision.grant.installed.join(", ")}. Existing provider/MCP processes are unchanged; request expiry removes overrides. Literal shell output is redacted, not arbitrary secret containment.`;
		if (decision.verdict === "deny" || decision.verdict === "expired" || decision.verdict === "timeout") return `Credential request ${decision.verdict}; nothing installed.`;
		if (decision.error === "receiver request limit reached") return "Credential receiver session limit reached; nothing installed. Ask the operator to restart a supported session before a fresh approved request.";
		return `Credential delivery failed; nothing installed. ${RECOVERY}`;
	}
}

export function credentialConsumersReady(pi: ExtensionAPI): boolean {
	return hasCredentialConsumer("bash") &&
		(!pi.getAllTools().some(tool => tool.name === "background_bash") || hasCredentialConsumer("background"));
}
export function registerCredentialTools(pi: ExtensionAPI, receiver: CredentialReceiver): void {
	pi.registerTool({ name: "list_credential_catalog", exposure: exposureFor("list_credential_catalog"), label: "List grantable credentials",
		description: "List credential catalog names for this session. Never returns values.", parameters: Type.Object({}),
		async execute() { return safeResult(await receiver.list()); },
	});
	registerGuardedTool(pi, { capability: { writesExemptBecause: "owner-approved credentials enter only this session’s future shell-child environment; never configuration" }, name: "request_credential", exposure: exposureFor("request_credential"), label: "Request a credential",
		description: "Request named catalog credentials with owner approval. On approval, install only into future shell children of this session. Provider authentication and existing MCP processes are unchanged. Never returns values.",
		parameters: Type.Object({ credentials: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }), { minItems: 1, maxItems: 32, uniqueItems: true }), reason: Type.String({ minLength: 1 }) }),
		async execute(id, params, signal) { return safeResult(await receiver.request(id, params.credentials, params.reason, signal)); },
	});
}
