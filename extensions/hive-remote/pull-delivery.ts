import { redact, type RequestResult } from "../hive-common/http.ts";

/** Only the background owner's structured completion, bound to this session. */
export function backgroundPull(message: unknown, localSessionID: string | undefined): { url: string; source: string } | null {
	if (!message || typeof message !== "object") return null;
	const msg = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (msg.role !== "custom" || msg.customType !== "background" || !msg.details || typeof msg.details !== "object") return null;
	const d = msg.details as Record<string, unknown>;
	if (!localSessionID || d.sessionId !== localSessionID || d.status !== "done" || d.exitCode !== 0 ||
		typeof d.id !== "string" || !d.id || typeof d.executionId !== "string" || !d.executionId ||
		typeof d.pullURL !== "string" || !d.pullURL) return null;
	return { url: d.pullURL, source: `background:${d.id}:${d.executionId}` };
}

/** One attempt per execution; successful URLs also dedupe across executions. */
export function createPullReporter(deps: {
	binding: () => { key: string; submit: (url: string) => Promise<RequestResult> } | null;
	notice: (text: string) => void;
}) {
	const attempts = new Set<string>(), delivered = new Set<string>(), pending = new Set<string>();
	const waiting = new Map<string, { url: string; source: string }>();
	const reporter = {
		clear() { attempts.clear(); delivered.clear(); pending.clear(); waiting.clear(); },
		async flush(): Promise<void> {
			if (!deps.binding()) return;
			const reports = [...waiting.values()]; waiting.clear();
			await Promise.all(reports.map(({ url, source }) => reporter.report(url, source)));
		},
		async report(url: string, source: string): Promise<void> {
			const binding = deps.binding();
			if (!binding) { waiting.set(source, { url, source }); return; }
			if (attempts.has(source) || delivered.has(url) || pending.has(url)) return;
			attempts.add(source);
			pending.add(url);
			let result: RequestResult;
			try { result = await binding.submit(url); }
			catch (error) { result = { ok: false, status: null, authFailed: false, permanent: false, retryAfterMs: null, error: redact(error) }; }
			if (deps.binding()?.key !== binding.key) return;
			pending.delete(url);
			if (result.ok) { delivered.add(url); return; }
			deps.notice(`Hive could not link delivered PR ${url} (HTTP ${result.status ?? "unavailable"}): ${result.error ?? "association rejected"}. The PR exists, but its Delivery association was not recorded.`);
		},
	};
	return reporter;
}
