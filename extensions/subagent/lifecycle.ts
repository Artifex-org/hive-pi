// Pi JSON-mode lifecycle events are the only truthful progress signal for a
// child worker. Keep their UI mapping pure and separately tested: a worker may
// spend tens of seconds compiling extensions before it can complete a message.
// A cold pi child compiles extensions before its first model turn (measured
// 25–45s). Two minutes accommodates that while still surfacing a broken spawn;
// once active, ten minutes without any JSON lifecycle event is a genuine hang.
export const WORKER_STARTUP_SILENCE_MS = 2 * 60 * 1000;
export const WORKER_ACTIVITY_SILENCE_MS = 10 * 60 * 1000;

export function shouldStopForSilence(seenWorkerEvent: boolean, lastEventAtMs: number, nowMs: number): boolean {
	const limitMs = seenWorkerEvent ? WORKER_ACTIVITY_SILENCE_MS : WORKER_STARTUP_SILENCE_MS;
	return nowMs - lastEventAtMs >= limitMs;
}

export function describeLifecycleEvent(event: Record<string, unknown>): string | undefined {
	const type = typeof event.type === "string" ? event.type : "";
	switch (type) {
		case "session":
			return "worker session started";
		case "agent_start":
			return "agent started";
		case "turn_start":
			return "planning response";
		case "message_start":
			return "model responding";
		case "message_end":
			return "message complete";
		case "message_update": {
			const update = event.assistantMessageEvent;
			const updateType = update && typeof update === "object" && typeof (update as { type?: unknown }).type === "string"
				? (update as { type: string }).type
				: "";
			return updateType === "text_delta" ? "writing response" : "model updating";
		}
		case "tool_execution_start":
			return typeof event.toolName === "string" ? `running ${event.toolName}` : "running tool";
		case "tool_execution_update":
			return typeof event.toolName === "string" ? `running ${event.toolName}` : "running tool";
		case "tool_execution_end":
			return typeof event.toolName === "string" ? `finished ${event.toolName}` : "finished tool";
		case "agent_end":
			return "finalizing result";
		// pi retries a RETRYABLE provider error itself (429 and friends), with
		// exponential backoff and no other signal. Unmapped, those seconds read as
		// a frozen worker — and the caller is later told only that it "failed".
		case "auto_retry_start": {
			const attempt = typeof event.attempt === "number" ? event.attempt : 0;
			const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 0;
			const delayMs = typeof event.delayMs === "number" ? event.delayMs : 0;
			return `retrying (${attempt}/${maxAttempts}) in ${delayMs}ms`;
		}
		case "auto_retry_end":
			return event.success === true ? "retry succeeded" : "retries exhausted";
		default:
			return undefined;
	}
}

export function silenceError(seenWorkerEvent: boolean, elapsedMs: number): string {
	const seconds = Math.max(1, Math.floor(elapsedMs / 1000));
	return seenWorkerEvent
		? `Subagent became inactive for ${seconds}s and was stopped.`
		: `Subagent did not start within ${seconds}s and was stopped.`;
}
