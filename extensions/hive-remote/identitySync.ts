import type { RequestResult } from "../hive-common/http.ts";
import type { RemoteSessionIdentity } from "./client.ts";
import type { SessionIdentityUpdate } from "./sessionIdentityBus.ts";

export const IDENTITY_SYNC_ENTRY = "session-identity-sync";
type QueuedIdentity = { update: SessionIdentityUpdate; wireRevision?: number };
export type IdentitySyncState = { remoteRevision: number; queue: QueuedIdentity[]; conflicted?: boolean; manualTitle?: string };
type Transport = {
	read: () => Promise<RequestResult<RemoteSessionIdentity>>;
	rename?: (title: string) => Promise<RequestResult<void>>;
	put: (body: { revision: number; title?: string; description: string; provisional: boolean; source: SessionIdentityUpdate["source"]; reason?: string }) => Promise<RequestResult<RemoteSessionIdentity>>;
};

/** A persisted serial outbox: retries reuse the exact revision and payload. */
export class IdentitySync {
	private state: IdentitySyncState = { remoteRevision: 0, queue: [] };
	private transport?: Transport;
	private reconciled = false;
	private busy = false;
	private generation = 0;
	private attempts = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private blocked = false;
	constructor(private readonly deps: {
		persist: (state: IdentitySyncState) => void;
		apply: (identity: RemoteSessionIdentity) => void;
		notice: (message: string) => void;
	}) {}

	restore(entries: readonly unknown[]): void {
		this.detach();
		this.state = { remoteRevision: 0, queue: [] };
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { customType?: string; data?: IdentitySyncState };
			if (entry.customType !== IDENTITY_SYNC_ENTRY) continue;
			if (entry.data && Number.isSafeInteger(entry.data.remoteRevision) && entry.data.remoteRevision >= 0 && Array.isArray(entry.data.queue)) {
				this.state = structuredClone(entry.data);
			}
			break;
		}
	}

	update(update: SessionIdentityUpdate): void {
		if (update.origin !== "session-identity" || update.canonical) return;
		if (this.state.conflicted) { this.state.queue = []; this.state.conflicted = false; }
		const queue = this.state.queue;
		const last = queue.at(-1);
		// Coalesce only unsent paragraph edits. Never replace a sent request or pivot.
		if (last && last.wireRevision === undefined && last.update.source === "description" && update.source === "description") last.update = update;
		else queue.push({ update });
		this.blocked = false;
		this.attempts = 0;
		this.save();
		void this.run();
	}

	rename(title: string): void {
		this.state.manualTitle = title;
		this.attempts = 0;
		this.blocked = false;
		this.save();
		void this.run();
	}

	attach(supported: boolean, transport: Transport): void {
		if (!supported) { this.detach(); return; }
		if (this.transport) return; // cosmetic conversation refresh is not a reconnect
		this.transport = transport;
		this.reconciled = false;
		this.blocked = this.state.conflicted === true && this.state.manualTitle === undefined;
		this.attempts = 0;
		if (this.blocked) this.deps.notice("An unpublished identity conflicted with Hive; review canonical context and submit a new update to retry.");
		void this.run();
	}

	detach(): void {
		this.generation++;
		this.transport = undefined;
		this.reconciled = false;
		this.busy = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private save(): void { this.deps.persist(structuredClone(this.state)); }
	private valid(body?: RemoteSessionIdentity): body is RemoteSessionIdentity {
		return !!body && Number.isSafeInteger(body.identity_revision) && body.identity_revision >= 0 && typeof body.title === "string" &&
			(body.identity_revision === 0 || (typeof body.description === "string" && !body.description_locked));
	}
	private matches(head: QueuedIdentity, body: RemoteSessionIdentity): boolean {
		return head.wireRevision === body.identity_revision && head.update.description === body.description &&
			head.update.provisional === body.description_provisional &&
			(body.title_pinned === true || head.update.source === "description" || head.update.title === body.title);
	}
	private conflict(body: RemoteSessionIdentity): void {
		this.state.remoteRevision = body.identity_revision;
		this.state.conflicted = true;
		this.save();
		if (this.state.manualTitle === undefined) this.deps.apply(body);
		this.blocked = this.state.manualTitle === undefined;
		this.deps.notice("Session identity changed in Hive. Adopted its canonical title and introduction; review before submitting a new context or pivot.");
	}
	private retry(message: string, permanent = false, retryAfterMs = 0): void {
		this.deps.notice(message);
		if (permanent || this.attempts >= 5) {
			this.blocked = true;
			this.deps.notice(`${message} — sync paused; check connectivity/permissions and reconnect or update session context to retry.`);
			return;
		}
		const delay = Math.max(retryAfterMs, Math.min(30_000, 1_000 * 2 ** this.attempts++));
		this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
		this.timer.unref?.();
	}
	private async run(): Promise<void> {
		const transport = this.transport;
		if (!transport || this.busy || this.blocked || this.timer) return;
		const generation = this.generation;
		this.busy = true;
		try {
			if (!this.reconciled) {
				const result = await transport.read();
				if (generation !== this.generation) return;
				if (!result.ok || !this.valid(result.body)) {
					this.retry(`Could not read canonical session identity: ${result.error ?? (result.body?.description_locked ? "introduction locked" : `HTTP ${result.status ?? "unknown"}`)}`, result.permanent || result.authFailed, result.retryAfterMs ?? 0);
					return;
				}
				const body = result.body;
				const head = this.state.queue[0];
				if (head && this.matches(head, body)) this.state.queue.shift();
				else if (head && !this.state.conflicted && body.identity_revision !== this.state.remoteRevision) {
					this.conflict(body);
					if (this.state.manualTitle === undefined) return;
				}
				this.state.remoteRevision = body.identity_revision;
				this.reconciled = true;
				this.save();
				if (!this.state.queue.length && this.state.manualTitle === undefined && body.identity_revision > 0) this.deps.apply(body);
			}
			while (generation === this.generation && (this.state.manualTitle !== undefined || this.state.queue.length)) {
				if (this.state.manualTitle !== undefined) {
					const title = this.state.manualTitle;
					if (!transport.rename) { this.retry("Manual session name transport unavailable", true); return; }
					const result = await transport.rename(title);
					if (generation !== this.generation) return;
					if (!result.ok) {
						this.retry(`Could not pin manual session name: ${result.error ?? `HTTP ${result.status ?? "unknown"}`}`, result.permanent || result.authFailed, result.retryAfterMs ?? 0);
						return;
					}
					if (this.state.manualTitle === title) delete this.state.manualTitle;
					this.attempts = 0;
					this.save();
					if (this.state.manualTitle === undefined && !this.state.queue.length) {
						const canonical = await transport.read();
						if (generation !== this.generation) return;
						if (canonical.ok && this.valid(canonical.body)) {
							if (canonical.body.identity_revision > 0 && this.state.manualTitle === undefined && !this.state.queue.length) this.deps.apply(canonical.body);
						} else { this.reconciled = false; this.retry("Manual name pinned, but canonical identity could not be refreshed"); return; }
					}
					continue;
				}
				if (this.state.conflicted) return;
				const head = this.state.queue[0];
				const update = head.update;
				head.wireRevision ??= this.state.remoteRevision + 1;
				this.save(); // durable BEFORE send, including the replay revision
				const result = await transport.put({
					revision: head.wireRevision,
					...(update.source !== "description" ? { title: update.title } : {}),
					description: update.description, provisional: update.provisional, source: update.source,
					...(update.reason ? { reason: update.reason } : {}),
				});
				if (generation !== this.generation) return;
				if (result.status === 409 && this.valid(result.body)) {
					this.conflict(result.body);
					if (this.state.manualTitle !== undefined) continue;
					return;
				}
				if (!result.ok || !this.valid(result.body)) {
					this.retry(`Could not publish session identity: ${result.error ?? `HTTP ${result.status ?? "unknown"}`}`, result.permanent || result.authFailed, result.retryAfterMs ?? 0);
					return;
				}
				if (result.body.identity_revision !== head.wireRevision) {
					this.conflict(result.body);
					if (this.state.manualTitle !== undefined) continue;
					return;
				}
				this.state.remoteRevision = result.body.identity_revision;
				this.state.queue.shift();
				this.attempts = 0;
				this.save();
				this.deps.notice("");
				// A late response must not erase a newer authored paragraph.
				if (!this.state.queue.length && this.state.manualTitle === undefined) this.deps.apply(result.body);
			}
		} catch (error) {
			if (generation === this.generation) this.retry(`Session identity transport failed: ${String(error)}`);
		} finally {
			if (generation === this.generation) this.busy = false;
		}
	}
}
