import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withTimeout, type HiveAuth } from "../hive-common/http.ts";
import { YouShouldKnowFindingsTransport, type CapturedFinding, type FindingsRequest } from "../hive-common/you-should-know-findings.ts";
import { YSK_FINDINGS_CHANNEL, YSK_POLICY_CHANNEL, YSK_POLICY_REQUEST_CHANNEL, YSK_RECEIPTS_CHANNEL, YSK_RECORDING_CHANNEL } from "../hive-common/you-should-know.ts";

export function findingsRequest(auth: HiveAuth): FindingsRequest {
	return async (method, path, body, signal) => withTimeout(20_000, async timeout => {
		const response = await fetch(auth.url + path, {
			method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const reader = response.body?.getReader();
		if (!reader) return { status: response.status, body: undefined };
		const chunks: Uint8Array[] = []; let size = 0;
		try {
			while (true) {
				const part = await reader.read(); if (part.done) break;
				size += part.value.byteLength;
				if (size > 4 * 1024 * 1024) throw new Error("oversized findings response");
				chunks.push(part.value);
			}
		} finally { await reader.cancel(); }
		const bytes = new Uint8Array(size); let at = 0;
		for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
		let parsed: unknown;
		try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* contract validator handles it */ }
		return { status: response.status, body: parsed };
	});
}

/** Only an existing consented remote attachment may carry durable findings.
 * All I/O is detached; retries stop after five attempts until a new capture,
 * explicit recording control or reconnect. Receipt reads never dispatch writes. */
export function createYouShouldKnowRemoteBridge(pi: ExtensionAPI, options: {
	allowed: () => boolean; request?: (auth: HiveAuth) => FindingsRequest;
}) {
	let transport: YouShouldKnowFindingsTransport | undefined;
	let controller: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let serverSessionId: string | undefined;
	let attempts = 0;
	let pendingControl: { recording: boolean; expected_revision: number; control_id: string; serverSessionId: string } | undefined;
	const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
	const schedule = (reset = false) => {
		if (reset) { cancelTimer(); attempts = 0; }
		if (timer || !transport || !options.allowed() || attempts >= 5) return;
		const current = transport;
		timer = setTimeout(() => {
			timer = undefined;
			if (current !== transport || !options.allowed()) return;
			attempts++;
			void (async () => {
				await current.discover();
				const command = pendingControl;
				if (command && command.serverSessionId === serverSessionId) {
					await current.setRecording(command.recording, command.expected_revision, command.control_id);
					if (current.state.capability && current.state.capability.recording_revision > command.expected_revision && pendingControl === command) pendingControl = undefined;
				}
				await current.upload();
			})().finally(() => { if (current === transport) schedule(); });
		}, attempts ? Math.min(30_000, 1_000 * 2 ** attempts) : 0);
		timer.unref?.();
	};
	pi.events.on(YSK_POLICY_REQUEST_CHANNEL, () => {
		const current = transport, sid = serverSessionId;
		if (!current || !sid || !options.allowed()) return;
		setTimeout(() => void current.discover().then(policy => {
			if (current === transport && options.allowed() && policy) pi.events.emit(YSK_POLICY_CHANNEL, { ...policy, serverSessionId: sid });
		}), 0);
	});
	pi.events.on(YSK_FINDINGS_CHANNEL, (data: unknown) => {
		if (!transport || !options.allowed() || !Array.isArray(data) || data.length > 200) return;
		transport.capture(data as CapturedFinding[]); schedule(true);
	});
	pi.events.on(YSK_RECORDING_CHANNEL, (data: unknown) => {
		if (!transport || !options.allowed() || !data || typeof data !== "object") return;
		const control = data as typeof pendingControl;
		if (!control || control.serverSessionId !== serverSessionId || typeof control.recording !== "boolean" || !Number.isSafeInteger(control.expected_revision) || control.expected_revision < 0 || typeof control.control_id !== "string") return;
		pendingControl = { ...control };
		// Off pauses uploads synchronously inside setRecording, before its await.
		const current = transport;
		void current.setRecording(control.recording, control.expected_revision, control.control_id).then(next => {
			if (current !== transport) return;
			if ((next || (current.state.capability?.recording_revision ?? -1) > control.expected_revision) && pendingControl?.control_id === control.control_id) pendingControl = undefined;
			schedule(true);
		});
	});
	return {
		attach(auth: HiveAuth, sessionId: string) {
			if (!options.allowed()) return;
			if (transport && serverSessionId === sessionId) { schedule(true); return; }
			this.detach(); serverSessionId = sessionId; controller = new AbortController();
			transport = new YouShouldKnowFindingsTransport({
				sessionId, request: (options.request ?? findingsRequest)(auth), signal: controller.signal, allowed: options.allowed,
				onPolicy: policy => pi.events.emit(YSK_POLICY_CHANNEL, { ...policy, serverSessionId: sessionId }),
				onReceipts: receipts => pi.events.emit(YSK_RECEIPTS_CHANNEL, { receipts, serverSessionId: sessionId }),
				onFailure: failure => pi.events.emit(YSK_RECEIPTS_CHANNEL, { failure, serverSessionId: sessionId }),
			});
			schedule(true);
		},
		applyRecording(recording: boolean, revision: number) {
			transport?.applyRemotePolicy({ version: 1, recording, recording_revision: revision });
		},
		detach() { cancelTimer(); controller?.abort(); controller = undefined; transport?.dispose(); transport = undefined; serverSessionId = undefined; pendingControl = undefined; attempts = 0; },
	};
}
