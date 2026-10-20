/** Opt-in Claude Agent SDK transport. Pi remains the sole agent/tool executor. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream, createProvider, collapseSystemMessages,
	getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message, type Model,
	type Provider, type SimpleStreamOptions, type TranscriptContext, type TranscriptMessages } from "@earendil-works/pi-ai";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isolatedOptions, reasoningOptions, type AccessLease } from "./options.ts";
import { PiToolBridge } from "./tool-bridge.ts";
import type { PilotQueryBudget } from "./pilot-budget.ts";
import { EventConverter, emptyUsage, SdkAssistantFailure, SdkProtocolError, SdkProviderError, streamFailure, type FailureCode } from "./events.ts";
import { failureDiagnostic, SdkLeaseExpired, type Continuation, type FailureContext, type ParkedEndReason } from "./diagnostics.ts";
import { assertSettledHistory, fingerprint, seedHistory, transcript, userMessage, imageOrText, sdkToolCallId } from "./history.ts";
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
	/** Extension-owned across disposable SDK runtimes; contains hashes, not transcripts. */
	replayProtection?: Set<string>;
	/** Restrictive pilot policy; ordinary SDK requests have no pilot override. */
	pilot?: PilotQueryBudget;
}
interface Parked {
	key: string; session?: string; model: string; prefix: Message[]; expected: Message[];
	queryOptions: { reasoning: ReturnType<typeof reasoningOptions>; maxTokens: number; toolChoice: "auto" | "none"; systemPrompt: string };
	lease: AccessLease; bridge: PiToolBridge; query: SdkQuery; iterator: AsyncIterator<SDKMessage>;
	controller: AbortController; dir: string; processes: ReturnType<typeof processScope>;
	observedIds: Set<string>; busy: boolean; timer?: ReturnType<typeof setTimeout>; releaseAbort?: () => void; closing?: Promise<void>;
	/** When the model batch was handed to Pi; diagnostics only. */
	parkedAt?: number;
}
/** Parked queries whose disposal a later tool-result request is matched against, for diagnostics. */
const PARKED_END_LIMIT = 64;

/**
 * SDK failure codes the pre-effect retry may repeat once. Account, credential,
 * model and request-shape (`invalid_request`) failures are left out: they would
 * fail the same way a second time. The HIV-3906 refusals that a replay served
 * arrived as `unknown`.
 */
const PRE_EFFECT_RETRY_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>(["unknown", "unrecognized", "rate_limit", "overloaded", "server_error"]);

// Pi's own docs section as Pi renders it. Extensions that return a whole systemPrompt from
// before_agent_start flatten the sections into plain text, so match the rendered block.
const PI_DOCS_BLOCK = /\n*<docs>\nPi documentation \(read only when the user asks about pi itself[\s\S]*?\n<\/docs>/;

/**
 * Pi's system prompt without its own docs block (the pi README/docs/examples paths).
 * Anthropic bills a subscription request carrying that block as third-party usage
 * ("400 Third-party apps now draw from your extra usage"); everything else is sent verbatim.
 */
export function sdkSystemPrompt(messages: TranscriptMessages): string {
	return getCurrentSystemPrompt(messages).replace(PI_DOCS_BLOCK, "");
}

export function claudeSdkModels(): Model<string>[] {
	// Metadata only; no native Anthropic stream/auth/prompt conversion is used.
	return getBuiltinModels("anthropic").map(model => ({ ...model, api: PROVIDER_ID, provider: PROVIDER_ID,
		baseUrl: "", headers: undefined, compat: undefined, promptCache: undefined,
		name: `${model.name} (Claude SDK)`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
}

export function createClaudeSdkRuntime(config: LaunchConfig, deps: Dependencies = {}): { provider: Provider; close: () => Promise<void> } {
	const now = deps.now ?? Date.now;
	const leases = new LeaseManager(deps.lease ?? hiveLease(config, fetch, () => deps.pilot?.excludedAccounts ?? []), now);
	const states = new Map<string, Parked>();
	const reservations = new Set<string>();
	const disposals = new Set<Promise<void>>();
	const runs = new Set<Promise<void>>();
	let cleanupError = false;
	let closing: Promise<void> | undefined;
	const ambiguous = deps.replayProtection ?? new Set<string>();
	// Fingerprint of a disposed handoff's expected transcript -> why and when; diagnostics only.
	const parkedEnds = new Map<string, { reason: ParkedEndReason; parkedAt: number; endedAt: number }>();
	const shutdown = new AbortController();
	let closed = false;
	async function getLease(signal: AbortSignal): Promise<AccessLease> {
		deps.pilot?.assertRequestAllowed();
		const lease = await leases.get(signal);
		deps.pilot?.checkAccount({ credential: lease.credential, slot: lease.slot });
		return lease;
	}
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
			throw new SdkProviderError("Claude SDK resource cleanup failed; operator cleanup required");
		}
	}
	function dispose(state: Parked, reason?: ParkedEndReason): Promise<void> {
		// An idle handoff may already have executed in Pi. Losing the transport
		// cannot authorize replay of the original, result-free attempt.
		if (!state.busy && state.expected.length) {
			ambiguous.add(fingerprint(transcript(state.prefix)));
			if (reason && !state.closing) {
				if (parkedEnds.size >= PARKED_END_LIMIT) parkedEnds.delete(parkedEnds.keys().next().value!);
				parkedEnds.set(fingerprint(transcript(state.expected)), { reason, parkedAt: state.parkedAt ?? now(), endedAt: now() });
			}
		}
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
			let pilotRequest = false;
			let attemptedPrefix: Message[] | undefined;
			// Failure-diagnostic context; none of it changes control flow.
			let continuation: Continuation = "fresh_prompt";
			let parkedEnd: FailureContext["parkedEnd"];
			let scope: Parked["processes"] | undefined;
			let leaseExpired = false;
			const secrets = [config.token];
			const signal = AbortSignal.any([options.signal ?? new AbortController().signal, shutdown.signal]);
			let abortParked: (() => void) | undefined;
			try {
				signal.throwIfAborted();
				if (closed) throw new SdkProviderError("Claude SDK runtime closed");
				if (cleanupError) throw new SdkProviderError("Claude SDK private-state cleanup failed; operator cleanup required");
				if (model.provider !== PROVIDER_ID || !claudeSdkModels().some(m => m.id === model.id)) throw new SdkProviderError("Unknown Claude SDK model");
				if (options.fetch || options.headers && Object.keys(options.headers).length ||
					options.apiKey && options.apiKey !== "hive-launch-admission") {
					throw new SdkProviderError("Claude SDK has no injectable HTTP transport, response headers or API-key fallback; use structured SDK events");
				}
				if (options.env && Object.keys(options.env).length) throw new SdkProviderError("Claude SDK child environment is launch-owned");
				if (options.deferred || options.samplingParams || options.temperature !== undefined) throw new SdkProviderError("Unsupported Claude SDK request options");
				if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") {
					throw new SdkProviderError("Unsupported Claude SDK tool choice; pinned Pi supports only auto or none");
				}
				const reasoning = reasoningOptions(getBuiltinModels("anthropic").find(m => m.id === model.id)!, options);
				const context = collapseSystemMessages(original);
				const queryOptions = { reasoning, maxTokens: options.maxTokens ?? model.maxTokens,
					toolChoice: options.toolChoice ?? "auto", systemPrompt: sdkSystemPrompt(context.messages) };
				const payload = { transport: PROVIDER_ID, capabilities: { structuredEvents: true, httpResponse: false, payloadMutation: false }, model: model.id, messages: context.messages,
					reasoning: options.reasoning, maxTokens: options.maxTokens, toolChoice: options.toolChoice };
				if (options.onPayload) {
					const inspected = structuredClone(payload);
					const replacement = await cancellable(Promise.resolve().then(() => options.onPayload!(inspected, model)), signal);
					if (!isDeepStrictEqual(replacement ?? inspected, payload)) throw new SdkProviderError("Claude SDK payload mutation unsupported; Pi owns canonical history");
				}
				const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
				const contextHash = fingerprint(transcript(context.messages));
				if (context.messages.at(-1)?.role === "toolResult") continuation = "tool_results";
				if (ambiguous.has(contextHash)) throw new SdkProviderError("Ambiguous previous SDK attempt; reconcile side effects before retrying");
				const key = options.sessionId ?? randomUUID();
				if (reservations.has(key)) throw new SdkProviderError("Concurrent Claude SDK requests require isolated sessions");
				reservations.add(key);
				reservation = key;
				const candidates = [...states.values()].filter(s => s.session === options.sessionId &&
					s.model === model.id && s.expected.length > 0 && isDeepStrictEqual(transcript(context.messages.slice(0, s.expected.length)), transcript(s.expected)));
				if (candidates.length > 1) throw new SdkProviderError("Ambiguous SDK tool continuation");
				if (candidates[0]?.busy) throw new SdkProviderError("SDK continuation already active");
				state = candidates[0];
				if (state) { continuation = "parked"; scope = state.processes; }
				else if (continuation === "tool_results") {
					let handoff = context.messages.length;
					while (handoff > 0 && context.messages[handoff - 1].role === "toolResult") handoff--;
					const ended = parkedEnds.get(fingerprint(transcript(context.messages.slice(0, handoff))));
					continuation = ended ? `rebuilt_after_${ended.reason}` : "rebuilt";
					if (ended) parkedEnd = { parkedMs: ended.endedAt - ended.parkedAt, endedMsAgo: now() - ended.endedAt };
				}
				const suffix = state ? context.messages.slice(state.expected.length) : [];
				let resultEnd = 0;
				while (suffix[resultEnd]?.role === "toolResult") resultEnd++;
				const results = suffix.slice(0, resultEnd);
				if (state) {
					const calls = state.expected.at(-1);
					if (calls?.role !== "assistant") throw new SdkProviderError("Invalid parked SDK state");
					const pending = calls.content.filter(block => block.type === "toolCall");
					if (results.length !== pending.length || results.some(result => result.role !== "toolResult") ||
						pending.some(call => results.filter(r => r.role === "toolResult" && r.toolCallId === call.id && r.toolName === call.name).length !== 1)) {
						throw new SdkProviderError("Missing correlated Pi tool results; reconcile before continuing");
					}
				}
				assertSettledHistory(context.messages);
				if (!state && !["user", "toolResult"].includes(context.messages.at(-1)?.role ?? "")) {
					throw new SdkProviderError("Claude SDK request requires a user message or correlated tool results");
				}
				deps.pilot?.beginRequest(state !== undefined);
				pilotRequest = deps.pilot !== undefined;
				// Claim the parked state before admission yields. The losing request
				// rejects before assigning state; neither it nor the parking timer
				// may dispose this request's active continuation.
				if (state) {
					state.busy = true;
					clearTimeout(state.timer);
					state.releaseAbort?.(); state.releaseAbort = undefined;
				}
				const lease = await getLease(signal);
				secrets.push(lease.access_token);
				signal.throwIfAborted();
				// Same named session but edited/compacted/forked transcript: discard SDK cache, never Pi history.
				for (const old of [...states.values()]) if (old !== state && options.sessionId && old.session === options.sessionId) await dispose(old, "replaced");
				if (state) {
					// Token rotation/account changes cannot carry the previous CLI state across the boundary.
					if (!isDeepStrictEqual(queryOptions, state.queryOptions) || resultEnd !== suffix.length || lease.credential !== state.lease.credential || lease.slot !== state.lease.slot || lease.access_token !== state.lease.access_token ||
						!isDeepStrictEqual(tools, state.bridge.toolNames.map(name => getCurrentTools(state!.prefix).find(t => t.name === name)))) {
						await dispose(state); state = undefined; continuation = "rebuilt_options_changed";
					} else {
						attemptedPrefix = structuredClone(context.messages);
						for (const result of results) if (result.role === "toolResult") state.bridge.complete(result);
						state.prefix = structuredClone(context.messages);
					}
				}
				/** A fresh SDK query seeded from Pi's canonical history; this request's input is its only prompt. */
				const openQuery = async (): Promise<Parked> => {
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
					} else throw new SdkProviderError("Claude SDK request requires a user message or correlated tool results");
					const history = context.messages.slice(0, split);
					const controller = new AbortController();
					const dir = await privateDirectory(config.stateRoot);
					let bridge: PiToolBridge | undefined;
					let query: SdkQuery | undefined;
					const processes = processScope();
					scope = processes;
					try {
						bridge = new PiToolBridge(tools, controller.signal, 10_000);
						await (deps.validateExecutable ?? validateExecutable)(config, signal);
						const resume = await seedHistory(dir, history, randomUUID(), config.cwd, model, context.messages.slice(split));
						const sdkOptions = isolatedOptions({ executablePath: config.executable, cwd: config.cwd, privateRoot: dir, model: model.id,
							systemPrompt: queryOptions.systemPrompt, lease, now: now(), abortController: controller,
							bridge: bridge.config, toolNames: bridge.toolNames, egress: config.egress });
						sdkOptions.spawnClaudeCodeProcess = processes.spawn;
						sdkOptions.resume = resume;
						sdkOptions.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(deps.pilot ? Math.min(queryOptions.maxTokens, deps.pilot.maxOutputTokens) : queryOptions.maxTokens);
						Object.assign(sdkOptions, reasoning);
						async function* prompt(): AsyncGenerator<SDKUserMessage> {
							yield input;
							// Keep stdin open while MCP tools are parked. Resume-only queries need an explicit protocol trigger.
							await new Promise<void>(resolve => { if (controller.signal.aborted) resolve();
								else controller.signal.addEventListener("abort", () => resolve(), { once: true }); });
						}
						signal.throwIfAborted();
						attemptedPrefix = structuredClone(context.messages);
						if (deps.pilot) sdkOptions.maxTurns = deps.pilot.reserveQuery();
						sdkStarted = true;
						query = deps.query ? deps.query({ prompt: prompt(), options: sdkOptions }) :
							(await import("@anthropic-ai/claude-agent-sdk")).query({ prompt: prompt(), options: sdkOptions });
						const opened: Parked = { key: randomUUID(), session: options.sessionId, model: model.id, prefix: structuredClone(context.messages), expected: [],
							queryOptions: structuredClone(queryOptions), lease, bridge, query, iterator: query[Symbol.asyncIterator](), controller, dir, processes, observedIds: new Set(), busy: true };
						states.set(opened.key, opened);
						return opened;
					} catch (error) {
						await cleanupResources({ controller, dir, processes, bridge, query });
						throw error;
					}
				};
				// Only a query this request opened may be retried, never a reused parked continuation.
				const openedHere = !state;
				if (!state) state = await openQuery();
				events.push({ type: "start", partial: output });
				for (let attempt = 0; ; attempt++) {
					const owned: Parked = state;
					abortParked = () => { owned.controller.abort(); if (!owned.busy) void dispose(owned, "aborted"); };
					signal.addEventListener("abort", abortParked, { once: true });
					owned.releaseAbort = () => { if (abortParked) signal.removeEventListener("abort", abortParked); };
					if (signal.aborted) abortParked();
					const converter = new EventConverter(output, events, model, owned.bridge, owned.observedIds, [lease.access_token]);
					const expiry = setTimeout(() => { leaseExpired = true; owned.controller.abort(new SdkLeaseExpired()); }, Math.max(1, Date.parse(lease.expires_at) - now()));
					try {
						while (true) {
							const next = await cancellable(owned.iterator.next(), AbortSignal.any([signal, owned.controller.signal]));
							if (next.done) throw new SdkProtocolError("Claude SDK ended without result", "stream_ended");
							if (options.onProviderStreamEvent) await cancellable(
								Promise.resolve().then(() => options.onProviderStreamEvent!(structuredClone(next.value), model)),
								AbortSignal.any([signal, owned.controller.signal]));
							signal.throwIfAborted(); owned.controller.signal.throwIfAborted();
							if (next.value.type === "result") deps.pilot?.observeResult(next.value.num_turns, next.value.subtype === "success");
							let action: ReturnType<EventConverter["consume"]>;
							try { action = converter.consume(next.value); }
							catch (failure) { throw streamFailure(failure, next.value, secrets); }
							if (action === "tools") {
								// Reserve the result-free attempt at handoff, across session IDs,
								// before Pi can execute it or a replacement can pass admission.
								ambiguous.add(contextHash);
								owned.expected = [...structuredClone(context.messages), structuredClone(output)];
								owned.busy = false;
								owned.parkedAt = now();
								owned.timer = setTimeout(() => { void dispose(owned, "parked_expired"); }, Math.min(5 * 60_000, Date.parse(lease.expires_at) - now()));
								owned.timer.unref();
								events.push({ type: "done", reason: "toolUse", message: output }); break;
							}
							if (action === "done") {
								await dispose(owned); state = undefined;
								events.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output }); break;
							}
						}
					} catch (error) {
						// The one automatic retry (docs/claude-sdk-compatibility.md §Pre-effect
						// retry): a structured SDK API failure on a query this request opened
						// for a user prompt, before any content block or MCP call. Nothing was
						// proposed, so nothing can have run. The failed query is discarded, not
						// quarantined; a second failure takes the conservative path below.
						const retry = attempt === 0 && openedHere && !deps.pilot && error instanceof SdkAssistantFailure &&
							PRE_EFFECT_RETRY_CODES.has(error.code) && context.messages.at(-1)?.role === "user" &&
							output.content.length === 0 && owned.bridge.idle && !signal.aborted && !owned.controller.signal.aborted;
						if (!retry) throw error;
						output.diagnostics = [...output.diagnostics ?? [], failureDiagnostic(error, { phase: "post_start", continuation, parkedEnd, aborted: false,
							leaseExpired: false, cleanupFailed: false, evidence: await scope?.evidence(), secrets, retried: true }, now())];
						state = undefined;
						await dispose(owned);
						state = await openQuery();
						continue;
					} finally { clearTimeout(expiry); }
					break;
				}
			} catch (error) {
				// Whether the failure was an abort is read before the evidence wait below.
				const aborted = signal.aborted;
				// Snapshot the CLI's evidence before disposal signals it.
				const evidence = await scope?.evidence();
				const phase = state || sdkStarted ? "post_start" : "pre_start";
				let cleanupFailed = cleanupError;
				if (attemptedPrefix) ambiguous.add(fingerprint(transcript(attemptedPrefix)));
				if (state) {
					ambiguous.add(fingerprint(transcript(state.prefix)));
					try { await dispose(state); } catch { cleanupFailed = true; }
				}
				output.stopReason = signal.aborted ? "aborted" : "error";
				// SDK classification does not promise nonexecution. Keep all post-start
				// failures generic/nonretryable for Pi; the kind and cause are diagnostics only.
				output.diagnostics = [...output.diagnostics ?? [], failureDiagnostic(error, { phase, continuation, parkedEnd, aborted,
					leaseExpired, cleanupFailed, evidence, secrets }, now())];
				output.errorMessage = cleanupFailed ? "Claude SDK failed to remove private state; operator cleanup required" : state || sdkStarted ? "Claude SDK interrupted or failed; reconcile any pending side effects before retrying" :
					(error instanceof Error ? error.message : "Claude SDK request failed");
				events.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				if (pilotRequest) deps.pilot?.endRequest();
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
			resolve: async ({ signal }) => {
				// Pilot auth preflight must not issue credentials before stream correlation.
				// The real server admission check remains mandatory in getLease below.
				if (deps.pilot) deps.pilot.assertRequestAllowed(); else await getLease(signal);
				return { auth: { apiKey: "hive-launch-admission" }, source: "Hive launch" };
			},
		} }, api: { stream, streamSimple: stream } });
	return { provider, close: () => {
		if (closing) return closing;
		closed = true;
		const remaining = [...states.values()];
		shutdown.abort(); leases.close();
		closing = (async () => {
			const settled = await Promise.allSettled([...remaining.map(state => dispose(state)), ...disposals, ...runs]);
			if (cleanupError || settled.some(result => result.status === "rejected")) throw new Error("Claude SDK private-state cleanup failed; operator cleanup required");
		})();
		return closing;
	} };
}
