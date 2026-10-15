/** Opt-in Claude Agent SDK transport. Pi remains the sole agent/tool executor. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream, createProvider, collapseSystemMessages,
	getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message, type Model,
	type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isolatedOptions, reasoningOptions, type AccessLease } from "./options.ts";
import { PiToolBridge } from "./tool-bridge.ts";
import { EventConverter, emptyUsage, SdkAssistantFailure } from "./events.ts";
import { fingerprint, seedHistory, userMessage, imageOrText, sdkToolCallId } from "./history.ts";
import { cancellable, hiveLease, LeaseManager, privateDirectory, processScope, removePrivateDirectory,
	validateExecutable, type LaunchConfig, type LeaseSource } from "./runtime.ts";

export const PROVIDER_ID = "claude-sdk";
export interface SdkQuery extends AsyncIterable<SDKMessage> { close(): void }
export type QueryFactory = (request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SdkQuery;
export interface Dependencies {
	query?: QueryFactory;
	lease?: LeaseSource;
	validateExecutable?: typeof validateExecutable;
	now?: () => number;
}
interface Parked {
	key: string; session?: string; model: string; prefix: Message[]; expected: Message[];
	queryOptions: { reasoning: ReturnType<typeof reasoningOptions>; maxTokens: number; toolChoice: "auto" | "none"; systemPrompt: string };
	lease: AccessLease; bridge: PiToolBridge; query: SdkQuery; iterator: AsyncIterator<SDKMessage>;
	controller: AbortController; dir: string; processes: ReturnType<typeof processScope>;
	observedIds: Set<string>; busy: boolean; timer?: ReturnType<typeof setTimeout>; releaseAbort?: () => void; closing?: Promise<void>;
}

export function claudeSdkModels(): Model<string>[] {
	// Metadata only; no native Anthropic stream/auth/prompt conversion is used.
	return getBuiltinModels("anthropic").map(model => ({ ...model, api: PROVIDER_ID, provider: PROVIDER_ID,
		baseUrl: "", headers: undefined, compat: undefined, promptCache: undefined,
		name: `${model.name} (Claude SDK)`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
}

export function createClaudeSdkRuntime(config: LaunchConfig, deps: Dependencies = {}): { provider: Provider; close: () => Promise<void> } {
	const now = deps.now ?? Date.now;
	const leases = new LeaseManager(deps.lease ?? hiveLease(config), now);
	const states = new Map<string, Parked>();
	const reservations = new Set<string>();
	const disposals = new Set<Promise<void>>();
	const runs = new Set<Promise<void>>();
	let cleanupError = false;
	let closing: Promise<void> | undefined;
	const ambiguous = new Set<string>();
	const shutdown = new AbortController();
	let closed = false;
	async function cleanupResources(resources: Pick<Parked, "controller" | "dir" | "processes"> & Partial<Pick<Parked, "bridge" | "query">>): Promise<void> {
		let failed = false;
		// Every resource gets its cleanup attempt, even when an earlier owner fails.
		for (const cleanup of [
			() => resources.controller.abort(),
			() => resources.bridge?.close(),
			() => resources.query?.close(),
			() => resources.processes.close(),
			() => resources.bridge?.config.instance.close(),
			() => removePrivateDirectory(resources.dir),
		]) {
			try { await cleanup(); } catch { failed = true; }
		}
		if (failed) {
			cleanupError = true;
			throw new Error("Claude SDK resource cleanup failed; operator cleanup required");
		}
	}
	function dispose(state: Parked): Promise<void> {
		// An idle handoff may already have executed in Pi. Losing the transport
		// cannot authorize replay of the original, result-free attempt.
		if (!state.busy && state.expected.length) ambiguous.add(fingerprint(state.prefix));
		if (state.closing) return state.closing;
		states.delete(state.key); clearTimeout(state.timer); state.releaseAbort?.();
		state.closing = cleanupResources(state);
		disposals.add(state.closing);
		void state.closing.then(() => disposals.delete(state.closing!), () => { disposals.delete(state.closing!); cleanupError = true; });
		return state.closing;
	}
	function stream(model: Model<string>, original: TranscriptContext, options: SimpleStreamOptions = {}) {
		const events = createAssistantMessageEventStream();
		const output: AssistantMessage = { role: "assistant", provider: PROVIDER_ID, api: PROVIDER_ID, model: model.id,
			content: [], usage: emptyUsage(), stopReason: "pending", timestamp: now(), thinkingLevel: options.reasoning ?? "off" };
		const run = (async () => {
			let state: Parked | undefined;
			let reservation: string | undefined;
			let sdkStarted = false;
			let attemptedPrefix: Message[] | undefined;
			const signal = AbortSignal.any([options.signal ?? new AbortController().signal, shutdown.signal]);
			let abortParked: (() => void) | undefined;
			try {
				signal.throwIfAborted();
				if (closed) throw new Error("Claude SDK runtime closed");
				if (cleanupError) throw new Error("Claude SDK private-state cleanup failed; operator cleanup required");
				if (model.provider !== PROVIDER_ID || !claudeSdkModels().some(m => m.id === model.id)) throw new Error("Unknown Claude SDK model");
				if (options.fetch || options.headers && Object.keys(options.headers).length ||
					options.apiKey && options.apiKey !== "hive-launch-admission") {
					throw new Error("Claude SDK has no injectable HTTP transport, response headers or API-key fallback; use structured SDK events");
				}
				if (options.env && Object.keys(options.env).length) throw new Error("Claude SDK child environment is launch-owned");
				if (options.deferred || options.samplingParams || options.temperature !== undefined) throw new Error("Unsupported Claude SDK request options");
				if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") {
					throw new Error("Unsupported Claude SDK tool choice; pinned Pi supports only auto or none");
				}
				const reasoning = reasoningOptions(getBuiltinModels("anthropic").find(m => m.id === model.id)!, options);
				const context = collapseSystemMessages(original);
				const queryOptions = { reasoning, maxTokens: options.maxTokens ?? model.maxTokens,
					toolChoice: options.toolChoice ?? "auto", systemPrompt: getCurrentSystemPrompt(context.messages) };
				const payload = { transport: PROVIDER_ID, capabilities: { structuredEvents: true, httpResponse: false, payloadMutation: false }, model: model.id, messages: context.messages,
					reasoning: options.reasoning, maxTokens: options.maxTokens, toolChoice: options.toolChoice };
				if (options.onPayload) {
					const inspected = structuredClone(payload);
					const replacement = await cancellable(Promise.resolve().then(() => options.onPayload!(inspected, model)), signal);
					if (!isDeepStrictEqual(replacement ?? inspected, payload)) throw new Error("Claude SDK payload mutation unsupported; Pi owns canonical history");
				}
				const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
				const contextHash = fingerprint(context.messages);
				if (ambiguous.has(contextHash)) throw new Error("Ambiguous previous SDK attempt; reconcile side effects before retrying");
				const key = options.sessionId ?? randomUUID();
				if (reservations.has(key)) throw new Error("Concurrent Claude SDK requests require isolated sessions");
				reservations.add(key);
				reservation = key;
				const lease = await leases.get(signal);
				const candidates = [...states.values()].filter(s => s.session === options.sessionId &&
					s.model === model.id && s.expected.length > 0 && isDeepStrictEqual(context.messages.slice(0, s.expected.length), s.expected));
				if (candidates.length > 1) throw new Error("Ambiguous SDK tool continuation");
				if (candidates[0]?.busy) throw new Error("SDK continuation already active");
				state = candidates[0];
				// Same named session but edited/compacted/forked transcript: discard SDK cache, never Pi history.
				for (const old of [...states.values()]) if (old !== state && options.sessionId && old.session === options.sessionId) await dispose(old);
				if (state) {
					if (state.busy) throw new Error("SDK continuation already active");
					const suffix = context.messages.slice(state.expected.length);
					let resultEnd = 0;
					while (suffix[resultEnd]?.role === "toolResult") resultEnd++;
					const results = suffix.slice(0, resultEnd);
					const calls = state.expected.at(-1);
					if (calls?.role !== "assistant") throw new Error("Invalid parked SDK state");
					const pending = calls.content.filter(block => block.type === "toolCall");
					if (results.length !== pending.length || results.some(result => result.role !== "toolResult") ||
						pending.some(call => results.filter(r => r.role === "toolResult" && r.toolCallId === call.id && r.toolName === call.name).length !== 1)) {
						throw new Error("Missing correlated Pi tool results; reconcile before continuing");
					}
					// Token rotation/account changes cannot carry the previous CLI state across the boundary.
					if (!isDeepStrictEqual(queryOptions, state.queryOptions) || resultEnd !== suffix.length || lease.credential !== state.lease.credential || lease.slot !== state.lease.slot || lease.access_token !== state.lease.access_token ||
						!isDeepStrictEqual(tools, state.bridge.toolNames.map(name => getCurrentTools(state!.prefix).find(t => t.name === name)))) {
						await dispose(state); state = undefined;
					} else {
						clearTimeout(state.timer); state.releaseAbort?.(); state.releaseAbort = undefined; state.busy = true;
						attemptedPrefix = structuredClone(context.messages);
						for (const result of results) if (result.role === "toolResult") state.bridge.complete(result);
						state.prefix = structuredClone(context.messages);
					}
				}
				if (!state) {
					const last = context.messages.at(-1);
					// Rebuilt tool continuations use native tool-result input, never a synthetic user prompt.
					let split = context.messages.length;
					let input: SDKUserMessage;
					if (last?.role === "user") { split--; input = userMessage(last); }
					else if (last?.role === "toolResult") {
						while (split > 0 && context.messages[split - 1].role === "toolResult") split--;
						input = { type: "user", message: { role: "user", content: context.messages.slice(split).flatMap(result =>
							result.role === "toolResult" ? [{ type: "tool_result" as const, tool_use_id: sdkToolCallId(result.toolCallId),
								is_error: result.isError, content: result.content.map(imageOrText) }] : []) },
							parent_tool_use_id: null, client_composed: true } as SDKUserMessage;
					} else throw new Error("Claude SDK request requires a user message or correlated tool results");
					const history = context.messages.slice(0, split);
					const controller = new AbortController();
					const dir = await privateDirectory(config.stateRoot);
					let bridge: PiToolBridge | undefined;
					let query: SdkQuery | undefined;
					const processes = processScope();
					try {
						bridge = new PiToolBridge(tools, controller.signal, 10_000);
						await (deps.validateExecutable ?? validateExecutable)(config, signal);
						const resume = await seedHistory(dir, history, randomUUID(), config.cwd, context.messages.slice(split));
						const sdkOptions = isolatedOptions({ executablePath: config.executable, cwd: config.cwd, privateRoot: dir, model: model.id,
							systemPrompt: queryOptions.systemPrompt, lease, now: now(), abortController: controller,
							bridge: bridge.config, toolNames: bridge.toolNames });
						sdkOptions.spawnClaudeCodeProcess = processes.spawn;
						sdkOptions.resume = resume;
						sdkOptions.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(queryOptions.maxTokens);
						Object.assign(sdkOptions, reasoning);
						async function* prompt(): AsyncGenerator<SDKUserMessage> {
							yield input;
							// Keep stdin open while MCP tools are parked. Resume-only queries need an explicit protocol trigger.
							await new Promise<void>(resolve => { if (controller.signal.aborted) resolve();
								else controller.signal.addEventListener("abort", () => resolve(), { once: true }); });
						}
						signal.throwIfAborted();
						attemptedPrefix = structuredClone(context.messages);
						sdkStarted = true;
						query = deps.query ? deps.query({ prompt: prompt(), options: sdkOptions }) :
							(await import("@anthropic-ai/claude-agent-sdk")).query({ prompt: prompt(), options: sdkOptions });
						state = { key: randomUUID(), session: options.sessionId, model: model.id, prefix: structuredClone(context.messages), expected: [],
							queryOptions: structuredClone(queryOptions), lease, bridge, query, iterator: query[Symbol.asyncIterator](), controller, dir, processes, observedIds: new Set(), busy: true };
						states.set(state.key, state);
					} catch (error) {
						await cleanupResources({ controller, dir, processes, bridge, query });
						throw error;
					}
				}
				const owned = state;
				abortParked = () => { owned.controller.abort(); if (!owned.busy) void dispose(owned); };
				signal.addEventListener("abort", abortParked, { once: true });
				state.releaseAbort = () => { if (abortParked) signal.removeEventListener("abort", abortParked); };
				if (signal.aborted) abortParked();
				events.push({ type: "start", partial: output });
				const converter = new EventConverter(output, events, model, state.bridge, state.observedIds);
				const expiry = setTimeout(() => state?.controller.abort(), Math.max(1, Date.parse(lease.expires_at) - now()));
				try {
					while (true) {
						const next = await cancellable(state.iterator.next(), AbortSignal.any([signal, state.controller.signal]));
						if (next.done) throw new Error("Claude SDK ended without result");
						if (options.onProviderStreamEvent) await cancellable(
							Promise.resolve().then(() => options.onProviderStreamEvent!(structuredClone(next.value), model)),
							AbortSignal.any([signal, state.controller.signal]));
						signal.throwIfAborted(); state.controller.signal.throwIfAborted();
						const action = converter.consume(next.value);
						if (action === "tools") {
							state.expected = [...structuredClone(context.messages), structuredClone(output)];
							state.busy = false;
							const parked = state;
							state.timer = setTimeout(() => { void dispose(parked); }, Math.min(5 * 60_000, Date.parse(lease.expires_at) - now()));
							state.timer.unref();
							events.push({ type: "done", reason: "toolUse", message: output }); break;
						}
						if (action === "done") {
							await dispose(state); state = undefined;
							events.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output }); break;
						}
					}
				} finally { clearTimeout(expiry); }
			} catch (error) {
				let cleanupFailed = cleanupError;
				if (attemptedPrefix) ambiguous.add(fingerprint(attemptedPrefix));
				if (state) {
					ambiguous.add(fingerprint(state.prefix));
					try { await dispose(state); } catch { cleanupFailed = true; }
				}
				output.stopReason = signal.aborted ? "aborted" : "error";
				if (error instanceof SdkAssistantFailure) output.diagnostics = [{
					type: "claude_sdk_assistant_failure", timestamp: now(),
					error: { message: "Claude SDK assistant failure", code: error.code },
					details: { retrySafe: false },
				}];
				// SDK classification does not promise nonexecution. Keep all post-start
				// failures generic/nonretryable; allowlisted codes are diagnostics only.
				output.errorMessage = cleanupFailed ? "Claude SDK failed to remove private state; operator cleanup required" : state || sdkStarted ? "Claude SDK interrupted or failed; reconcile any pending side effects before retrying" :
					(error instanceof Error ? error.message : "Claude SDK request failed");
				events.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				if (abortParked && (!state || state.busy)) signal.removeEventListener("abort", abortParked);
				if (reservation) reservations.delete(reservation);
				events.end();
			}
		})();
		runs.add(run);
		void run.then(() => runs.delete(run), () => { runs.delete(run); cleanupError = true; });
		return events;
	}
	const provider = createProvider({ id: PROVIDER_ID, name: "Claude SDK (Hive launch)", models: claudeSdkModels(),
		auth: { apiKey: { name: "Hive access-only launch admission",
			check: async () => closed ? undefined : { type: "api_key", source: "Hive launch (admission checked per request)" },
			resolve: async ({ signal }) => { await leases.get(signal); return { auth: { apiKey: "hive-launch-admission" }, source: "Hive launch" }; },
		} }, api: { stream, streamSimple: stream } });
	return { provider, close: () => {
		if (closing) return closing;
		closed = true;
		const remaining = [...states.values()];
		shutdown.abort(); leases.close();
		closing = (async () => {
			const settled = await Promise.allSettled([...remaining.map(dispose), ...disposals, ...runs]); ambiguous.clear();
			if (cleanupError || settled.some(result => result.status === "rejected")) throw new Error("Claude SDK private-state cleanup failed; operator cleanup required");
		})();
		return closing;
	} };
}
