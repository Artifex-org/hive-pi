export type FindingWire = {
	id: string; kind: "caveat" | "blocker" | "action" | "decision";
	classification: "context" | "friction" | "incident" | "defect" | "improvement";
	text: string; quote: string; source_id: string; source_type: "assistant" | "tool";
	provenance: "assistant_reported" | "observed"; context?: string; expected?: string; impact?: string;
};
export type CapturedFinding = { finding: FindingWire; recording: boolean; revision: number; serverSessionId: string };
export type FindingReceipt = { id: string; deliveries: { destination: "papercut" | "board" | "linear"; state: "queued" | "delivered" | "linked" | "failed" | "blocked" | "uncertain" | "disabled"; url?: string; error?: string }[] };
export type FindingsResponse = { status: number; body: unknown };
export type FindingsRequest = (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<FindingsResponse>;
export type RecordingPolicy = { version: 1; recording: boolean; recording_revision: number };
export type YskFindingsOptions = {
	sessionId: string; request: FindingsRequest; allowed: () => boolean;
	onPolicy?: (policy: RecordingPolicy) => void;
	onReceipts?: (receipts: FindingReceipt[]) => void;
	onFailure?: (error: string) => void;
	signal?: AbortSignal; generation?: () => number;
};
const validRevision = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function line(v: unknown, min: number, max: number): v is string {
	if (typeof v !== "string" || v.length > max * 2 || [...v.trim()].length < min || [...v].length > max) return false;
	return [...v].every(c => { const n = c.codePointAt(0)!; return n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff) && n !== 0x2028 && n !== 0x2029; });
}
export function validFinding(v: unknown): v is FindingWire {
	if (!object(v)) return false;
	return line(v.id, 1, 128) && line(v.text, 1, 1000) && line(v.quote, 8, 400) && line(v.source_id, 1, 128) &&
		["caveat", "blocker", "action", "decision"].includes(String(v.kind)) &&
		["context", "friction", "incident", "defect", "improvement"].includes(String(v.classification)) &&
		((v.source_type === "assistant" && v.provenance === "assistant_reported") || (v.source_type === "tool" && v.provenance === "observed")) &&
		(v.context === undefined || line(v.context, 0, 1000)) && (v.expected === undefined || line(v.expected, 0, 500)) && (v.impact === undefined || line(v.impact, 0, 500));
}
function policy(v: unknown): RecordingPolicy | undefined {
	return object(v) && v.version === 1 && typeof v.recording === "boolean" && validRevision(v.recording_revision) ? { version: 1, recording: v.recording, recording_revision: v.recording_revision } : undefined;
}
function receipts(v: unknown): FindingReceipt[] | undefined {
	if (!Array.isArray(v) || v.length > 200) return;
	const out: FindingReceipt[] = [];
	for (const f of v) {
		if (!object(f) || !line(f.id, 1, 128) || !Array.isArray(f.deliveries) || f.deliveries.length > 3) return;
		const deliveries: FindingReceipt["deliveries"] = [];
		const destinations = new Set<string>();
		for (const d of f.deliveries) {
			if (!object(d) || !["papercut", "board", "linear"].includes(String(d.destination)) || destinations.has(String(d.destination)) ||
				!["queued", "delivered", "linked", "failed", "blocked", "uncertain", "disabled"].includes(String(d.state)) ||
				(d.url !== undefined && !line(d.url, 0, 4096)) || (d.error !== undefined && !line(d.error, 0, 1000))) return;
			destinations.add(String(d.destination));
			deliveries.push({ destination: d.destination as FindingReceipt["deliveries"][number]["destination"], state: d.state as FindingReceipt["deliveries"][number]["state"], ...(d.url ? { url: d.url as string } : {}), ...(d.error ? { error: d.error as string } : {}) });
		}
		out.push({ id: f.id, deliveries });
	}
	return out;
}
function wire(f: FindingWire): FindingWire {
	const { id, kind, classification, text, quote, source_id, source_type, provenance, context, expected, impact } = f;
	return { id, kind, classification, text, quote, source_id, source_type, provenance, ...(context === undefined ? {} : { context }), ...(expected === undefined ? {} : { expected }), ...(impact === undefined ? {} : { impact }) };
}

/** No policy mutation during uploads. Source revisions are immutable and never
 * restamped after reconnect; server receipts are the only delivery evidence. */
export class YouShouldKnowFindingsTransport {
	readonly sessionId: string;
	private capability?: RecordingPolicy;
	private unsupported = false;
	private disposed = false;
	private pendingStop: { id: string; revision: number } | undefined;
	private latestLocalControl?: string;
	private requestChain: Promise<unknown> = Promise.resolve();
	private readonly generation: number;
	private uploadInFlight?: Promise<void>;
	private discoverInFlight?: Promise<RecordingPolicy | undefined>;
	private readonly records = new Map<string, CapturedFinding>();
	private readonly receiptMap = new Map<string, FindingReceipt>();
	private readonly failures = new Map<string, string>();
	constructor(private readonly opts: YskFindingsOptions) { this.sessionId = opts.sessionId; this.generation = opts.generation?.() ?? 0; }
	get state() { return { capability: this.capability, unsupported: this.unsupported, receipts: [...this.receiptMap.values()], failures: [...this.failures.entries()] }; }
	private live() { return !this.disposed && !this.opts.signal?.aborted && this.opts.allowed() && (this.opts.generation?.() ?? 0) === this.generation; }
	private report(message: string) { if (this.live()) { this.failures.set("last", message); this.opts.onFailure?.(message); } }
	private async send(method: string, suffix: string, body?: unknown): Promise<FindingsResponse | undefined> {
		const task = this.requestChain.then(() => this.doSend(method, suffix, body));
		this.requestChain = task.then(() => undefined, () => undefined);
		return task;
	}
	private async doSend(method: string, suffix: string, body?: unknown): Promise<FindingsResponse | undefined> {
		if (!this.live() || (method === "POST" && this.pendingStop)) return;
		try {
			const r = await this.opts.request(method, `/api/v1/agent-sessions/${encodeURIComponent(this.sessionId)}/you-should-know/findings${suffix}`, body, this.opts.signal);
			return this.live() ? r : undefined;
		} catch { this.report("Findings transport unavailable"); return; }
	}
	private acceptPolicy(next: RecordingPolicy, force = false) {
		if (this.capability && next.recording_revision < this.capability.recording_revision) return;
		if (this.capability && next.recording_revision === this.capability.recording_revision && next.recording !== this.capability.recording) { this.report("Conflicting recording policy response"); return; }
		const changed = JSON.stringify(next) !== JSON.stringify(this.capability);
		this.capability = next;
		// History lives in the caller's durable ledger, not this upload queue.
		for (const [id, record] of this.records) if (record.revision < next.recording_revision) this.records.delete(id);
		if (changed || force) this.opts.onPolicy?.(next);
	}
	private acceptReceipts(next: FindingReceipt[]) {
		const changed: FindingReceipt[] = [];
		for (const receipt of next) {
			if (JSON.stringify(this.receiptMap.get(receipt.id)) !== JSON.stringify(receipt)) changed.push(receipt);
			this.receiptMap.set(receipt.id, receipt);
			// Retain queued bodies for authenticated POST-driven dispatch retries.
			if (!receipt.deliveries.some(d => d.state === "queued")) this.records.delete(receipt.id);
		}
		if (changed.length) this.opts.onReceipts?.(changed);
	}
	async discover(): Promise<RecordingPolicy | undefined> {
		if (this.unsupported || !this.live()) return;
		if (this.discoverInFlight) return this.discoverInFlight;
		const task = this.doDiscover(); this.discoverInFlight = task;
		try { return await task; } finally { this.discoverInFlight = undefined; }
	}
	private async doDiscover(): Promise<RecordingPolicy | undefined> {
		const r = await this.send("GET", ""); if (!r) return;
		if (r.status === 404) { this.unsupported = true; return; }
		if (r.status < 200 || r.status >= 300) { this.report(`Findings capability request failed (${r.status})`); return; }
		const next = policy(r.body), found = object(r.body) ? receipts(r.body.findings) : undefined;
		if (!next || !found) { this.unsupported = true; this.report("Findings server lacks the recording contract"); return; }
		if (!this.capability || next.recording_revision >= this.capability.recording_revision) { this.acceptPolicy(next); this.acceptReceipts(found); }
		return this.capability;
	}
	capture(records: CapturedFinding[]): void {
		for (const x of records) {
			if (!x.recording || x.serverSessionId !== this.sessionId || !validRevision(x.revision) || !validFinding(x.finding)) continue;
			const receipt = this.receiptMap.get(x.finding.id);
			if (receipt && !receipt.deliveries.some(d => d.state === "queued")) continue;
			const copy = { finding: wire(x.finding), recording: true, revision: x.revision, serverSessionId: x.serverSessionId };
			const previous = this.records.get(copy.finding.id);
			if (previous && JSON.stringify(previous) !== JSON.stringify(copy)) { this.report("Finding identity conflicts with prior evidence"); continue; }
			if (!previous && this.records.size >= 200) { this.report("Local finding budget reached"); break; }
			this.records.set(copy.finding.id, copy);
		}
	}
	async upload(): Promise<void> {
		if (this.uploadInFlight) return this.uploadInFlight;
		const task = this.doUpload(); this.uploadInFlight = task;
		try { await task; } finally { this.uploadInFlight = undefined; }
	}
	private async doUpload(): Promise<void> {
		if (!this.capability && !await this.discover()) return;
		if (!this.live() || this.pendingStop || !this.capability?.recording) return;
		const groups = new Map<number, CapturedFinding[]>();
		for (const x of this.records.values()) { const group = groups.get(x.revision) ?? []; group.push(x); groups.set(x.revision, group); }
		for (const [revision, batch] of groups) {
			// Old captures stay local; enabling recording is never a backfill request.
			if (revision !== this.capability.recording_revision) continue;
			for (let i = 0; i < batch.length;) {
				if (!this.live() || this.pendingStop || !this.capability.recording || revision !== this.capability.recording_revision) return;
				const part: CapturedFinding[] = [];
				const payload = () => ({ version: 1, recording: true, recording_revision: revision, findings: part.map(x => x.finding) });
				while (i < batch.length && part.length < 20) {
					part.push(batch[i]);
					if (new TextEncoder().encode(JSON.stringify(payload())).length > 60_000) { part.pop(); break; }
					i++;
				}
				if (!part.length) { this.report("Finding exceeds upload byte budget"); return; }
				const r = await this.send("POST", "", payload());
				if (!r) return;
				if (r.status < 200 || r.status >= 300) { this.report(`Findings upload failed (${r.status})`); return; }
				const next = policy(r.body), found = object(r.body) ? receipts(r.body.findings) : undefined;
				if (!next || !found) { this.report("Invalid findings receipt"); return; }
				if (next.recording_revision >= this.capability.recording_revision) { this.acceptPolicy(next); this.acceptReceipts(found); }
			}
		}
	}
	async setRecording(recording: boolean, expectedRevision: number, controlId: string): Promise<RecordingPolicy | undefined> {
		if (!validRevision(expectedRevision) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(controlId) || !this.live()) return;
		this.latestLocalControl = controlId;
		if (!recording) this.pendingStop = { id: controlId, revision: expectedRevision };
		if (!this.capability && !await this.discover()) return;
		const r = await this.send("PUT", "/recording", { version: 1, recording, expected_revision: expectedRevision, control_id: controlId }); if (!r) return;
		const next = policy(r.body);
		if (r.status === 409) { if (next) { this.acceptPolicy(next, true); if (this.latestLocalControl === controlId) this.pendingStop = undefined; } this.report("Recording policy conflict; latest server control applies"); return; }
		if (r.status < 200 || r.status >= 300 || !next) { this.report(`Recording policy update failed (${r.status})`); return; }
		this.acceptPolicy(next, true);
		if (this.latestLocalControl === controlId) this.pendingStop = undefined;
		return this.capability;
	}
	applyRemotePolicy(next: RecordingPolicy): void {
		const valid = policy(next);
		if (valid && this.live() && (!this.capability || valid.recording_revision >= this.capability.recording_revision)) {
			this.acceptPolicy(valid);
			// Only a strictly newer explicit server command supersedes a local stop.
			if (this.pendingStop && valid.recording_revision > this.pendingStop.revision) this.pendingStop = undefined;
		}
	}
	dispose(): void { this.disposed = true; this.records.clear(); }
}
