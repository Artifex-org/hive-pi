/**
 * The bidirectional Run stream (HIV-2086).
 *
 * Cursor's agent loop executes SERVER-side, but its context and tools live on
 * the client, so `Run` is a genuine two-way stream rather than a request with a
 * response. Three client obligations, all discovered by watching a turn stall:
 *
 *  1. **requestContext** — before the turn starts at all, the server asks the
 *     client to describe its workspace. Unanswered, the stream emits heartbeats
 *     forever and no text. This was the single blocker between a well-formed
 *     request and a working turn.
 *  2. **blobs** — the system prompt is addressed by sha256 and held client-side;
 *     the server fetches it mid-stream (`getBlobArgs`) and pushes conversation
 *     state back (`setBlobArgs`).
 *  3. **heartbeats** — the client sends `clientHeartbeat` periodically.
 *
 * The request half therefore stays OPEN for the whole turn; calling end() after
 * the initial frame deadlocks it.
 *
 * It stays open across pi's tool execution too. When Cursor calls one of pi's
 * tools the turn SUSPENDS rather than ending: the socket, heartbeat and blob
 * store are parked (see session.ts), pi runs the tool, and the result is
 * answered inline on this same stream. That is how Cursor's own client behaves,
 * and MEASURED it is the difference between the model calling a tool once and
 * calling it 25-33 times until the run times out.
 */

import * as http2 from "node:http2";
import type * as net from "node:net";

import { proxyUrl, tunnelSocket } from "./proxy.ts";
import { createHash, randomUUID } from "node:crypto";

import {
	toolDefinitions,
	toPiToolCall,
	type PendingPiToolCall,
	type PiToolDecl,
} from "./mcp.ts";
import {
	capabilityRule,
	execKind,
	handleExec,
	projectLayout,
	refusalFor,
	type ExecBridge,
} from "./exec.ts";
import {
	createFrameDecoder,
	encodeFrame,
	extractError,
	formatError,
	isEndStream,
	type ConnectFrame,
} from "./protocol.ts";
import { discardSuspendedTurn, suspendTurn, type PiToolResult } from "./session.ts";
import { apiUrl, cursorHeaders, isHeartbeatOnly, piToolsEnabled, streamIdleMs, turnStallMs } from "./config.ts";
export {
	DEFAULT_CLIENT_VERSION,
	clientVersion,
	cursorHeaders,
	isHeartbeatOnly,
	streamIdleMs,
	turnStallMs,
} from "./config.ts";

/**
 * Cursor's endpoint.
 *
 * Overridable ONLY so the transport's socket path can be exercised against a
 * local server. That path is where both serious defects in this extension have
 * lived — the tool-call loop and the heartbeat-masked stall — and neither was
 * reachable by a test while this was a hardcoded constant. Nothing in
 * production sets it.
 */
const RUN_PATH = "/agent.v1.AgentService/Run";
const HEARTBEAT_MS = 5_000;

/**
 * How long the stream may produce NOTHING before the turn is failed.
 *
 * A heartbeat keeps the connection willing; it does not prove the turn is
 * progressing. Without this a stalled stream hangs forever, and the caller
 * cannot tell it from a slow model — there is no error, no output, and no end.
 *
 * MEASURED, and the reason this exists: a factory eval case spent real tokens
 * (32c billed, so the request certainly reached Cursor) and then produced not
 * one event for thirty minutes, until an unrelated inactivity watchdog killed
 * the whole task and destroyed its artifacts. Every local turn had completed in
 * seconds, so nothing had ever waited long enough to notice.
 *
 * Generous, because a long tool-using turn legitimately goes quiet: the model
 * thinks, and Cursor's own client tolerates that. What it must not tolerate is
 * silence without end. Overridable for an operator who hits a real ceiling.
 */

/**
 * How long the stream may produce no PROGRESS before the turn is failed.
 *
 * The budget above is not enough on its own, and the incident it names is the
 * proof. `streamIdleMs` measures SILENCE, and it is reset by every frame the
 * server sends — including the server's own heartbeat. A stream that heartbeats
 * while producing nothing therefore resets it forever, which is exactly the
 * shape of the 30-minute hang: the connection was never idle, the TURN was.
 * Measured again 2026-08-19 on a cursor eval case that sat 40 minutes past its
 * context pack with a 180s idle budget armed and never fired.
 *
 * So this one is reset only by a frame that carries something — a token, a tool
 * call, a blob request. A heartbeat does not count, which is the entire point.
 *
 * Much longer than the silence budget on purpose. Silence means the socket is
 * probably dead; a heartbeat without content means the model is thinking, and a
 * reasoning model at high effort legitimately thinks for minutes. This must
 * bound the pathological case without truncating the slow-but-working one, so
 * it is set well past any think time observed and stays overridable.
 */

/**
 * True when a frame carries a heartbeat and nothing else.
 *
 * Shared with the trace filter below so there is ONE definition of "this frame
 * says nothing": a second, drifting copy is how the progress timer would
 * quietly start counting heartbeats as work again.
 */

/**
 * The client version Cursor requires.
 *
 * MEASURED: this header is not enforced on `GetUsableModels` but IS on `Run`.
 * The check is on presence and the `cli-` prefix, NOT on being current — a
 * seven-month-old value was accepted, while the same string without the prefix
 * was refused. So this is a pin we can hold, not a treadmill.
 *
 * It stays overridable because that leniency is server-side policy which can
 * tighten without notice, and when it does the operator needs a way out that is
 * not "wait for a release".
 */

/**
 * Whether pi's own tools are advertised to Cursor.
 *
 * ON by default since the tool-result path was fixed. It stays switchable
 * because tool definitions are not free -- MEASURED at ~7k tokens of the
 * context window for a modest set -- so a text-only workload (review, advice,
 * planning) can decline to pay for tools it will never call.
 */

/** Headers every Cursor call carries. */

/**
 * Frame-level tracing, off unless `CURSOR_DEBUG=1`.
 *
 * Worth carrying permanently: every hard bug on this transport so far — the
 * unanswered requestContext, the missing tool result, the schema the server
 * accepted and ignored — presented as a turn that simply stopped, with no error
 * anywhere. A stalled bidirectional stream cannot be diagnosed from its output.
 */
const debugEnabled = () => process.env.CURSOR_DEBUG === "1";
function trace(message: string): void {
	if (debugEnabled()) process.stderr.write(`[cursor] ${message}\n`);
}

export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface RunEvents {
	onText(delta: string): void;
	onThinking(delta: string): void;
	/**
	 * One bridged tool call, already labelled. Optional because a caller that
	 * only wants the text should not have to care -- but a caller that shows
	 * progress needs it, since a Cursor turn can spend minutes in tool calls
	 * emitting no text at all, which is indistinguishable from a hang.
	 */
	onToolCall?(label: string): void;
	/** Terminal. Exactly one of usage/error is meaningful. */
	onDone(usage: TurnUsage | null, error: string | null): void;
	/**
	 * Cursor asked for one of PI's tools. Terminal for this pi MESSAGE but not
	 * for the Cursor turn: the stream is parked, pi executes the tool, and the
	 * result is fed back into the same turn. This is the only way an extension
	 * tool — `factory_finish` above all — ever runs.
	 */
	onPiToolCall?(call: PendingPiToolCall): void;
}

export interface RunOptions {
	accessToken: string;
	modelId: string;
	systemPrompt: string;
	userText: string;
	workspacePath: string;
	signal?: AbortSignal;
	events: RunEvents;
	/**
	 * The tool bridge. Absent means the model runs as a pure text generator and
	 * every tool request is refused -- which is a legitimate mode (advice,
	 * review, planning) and was the only mode before HIV-2095.
	 */
	bridge?: ExecBridge;
	/**
	 * pi's own tool declarations, advertised to Cursor as MCP tools. Calling one
	 * suspends the turn and hands it to pi to execute — see mcp.ts.
	 */
	piTools?: PiToolDecl[];
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");

const num = (v: unknown): number => {
	// Cursor sends 64-bit counters as JSON STRINGS ("11118"), per protobuf-JSON.
	// Number() on a string is right; on undefined it is NaN, which would poison
	// every downstream total silently.
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
	return Number.isFinite(n) ? n : 0;
};

/**
 * How an interaction query is refused.
 *
 * The server can ask the CLIENT to do things pi's provider surface has no way to
 * do -- put a question to the user, run a web search. Ignoring the ask is the
 * one thing that must not happen: an unanswered query stalls the turn exactly
 * the way the unanswered requestContext did, and a stall is indistinguishable
 * from a hang. Each refusal carries a reason, so the model re-plans instead of
 * waiting.
 *
 * The nesting differs per query type -- askQuestion wraps its oneof in an extra
 * `result` -- which is why this is a table rather than one generic shape.
 */
const QUERY_REFUSALS: Record<string, (reason: string) => Record<string, unknown>> = {
	askQuestionInteractionQuery: (reason) => ({
		askQuestionInteractionResponse: { result: { rejected: { reason } } },
	}),
	webSearchRequestQuery: (reason) => ({ webSearchRequestResponse: { rejected: { reason } } }),
	switchModeRequestQuery: (reason) => ({ switchModeRequestResponse: { rejected: { reason } } }),
	exaSearchRequestQuery: (reason) => ({ exaSearchRequestResponse: { rejected: { reason } } }),
	exaFetchRequestQuery: (reason) => ({ exaFetchRequestResponse: { rejected: { reason } } }),
};

/**
 * Run one turn.
 *
 * Resolves when the turn ENDS, or when it SUSPENDS to let pi execute one of its
 * own tools -- from pi's side both mean "this assistant message is complete".
 * Never rejects: a transport failure arrives through `onDone` as an error
 * string, because a provider that throws loses whatever text the model had
 * already produced.
 */
export async function runTurn(opts: RunOptions): Promise<void> {
	const systemBytes = Buffer.from(
		JSON.stringify({ role: "system", content: opts.systemPrompt }),
		"utf8",
	);
	const systemId = b64(createHash("sha256").update(systemBytes).digest());
	const blobs = new Map<string, Buffer>([[systemId, systemBytes]]);

	const tunnel = proxyUrl() ? await tunnelSocket(new URL(apiUrl()), new URL(proxyUrl())) : null;
	// Through the sandbox's proxy when there is one, directly otherwise. See
	// proxy.ts: node:http2 has no proxy support, and a sandboxed namespace has no
	// DNS, so the direct call fails as EAI_AGAIN and reads as a canceled stream.
	const api = apiUrl();
	const proxy = proxyUrl();
	const client = proxy
		? http2.connect(api, {
				createConnection: () => tunnel as unknown as net.Socket,
			})
		: http2.connect(api);
	let heartbeat: NodeJS.Timeout | null = null;
	// Reset by every frame the server sends. A turn that goes silent past the
	// budget is failed rather than left hanging — see streamIdleMs.
	let idle: NodeJS.Timeout | null = null;
	// Reset only by a frame that CARRIES something. A heartbeat resets `idle`
	// but not this, so a stream that stays warm while producing nothing is
	// bounded — see turnStallMs.
	let stall: NodeJS.Timeout | null = null;

	// `closed` is about the SOCKET; `segmentDone` is about the pi assistant
	// message currently being built. They part company while suspended: the
	// message is finished, the socket very much is not.
	let closed = false;
	let segmentDone = false;
	let settleSegment: (() => void) | null = null;
	const nextSegment = () =>
		new Promise<void>((resolve) => {
			segmentDone = false;
			settleSegment = resolve;
		});
	const first = nextSegment();

	// Re-pointed on resume. Text the model produces AFTER a tool call belongs to
	// the assistant message pi is building now, not the one that already ended --
	// pushing it into the old sink would emit deltas onto a closed stream.
	let events = opts.events;

	// Cursor's exec envelope for each tool call pi still owes a result for. Keyed
	// by tool-call id, the only id that survives the round trip through pi.
	const awaiting = new Map<string, { id: number; execId: string }>();
	// Calls Cursor made while the turn was already suspended. pi executes one
	// tool per provider round-trip, so the rest wait rather than being dropped.
	const queued: PendingPiToolCall[] = [];

	const teardown = () => {
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		if (idle) clearTimeout(idle);
		if (stall) clearTimeout(stall);
		try {
			req.close();
			client.close();
		} catch {
			// The turn's outcome is already decided; a teardown failure must not
			// replace a good answer with an exception.
		}
	};

	const settle = () => {
		if (segmentDone) return;
		segmentDone = true;
		const resolve = settleSegment;
		settleSegment = null;
		resolve?.();
	};

	/** Terminal for the whole turn: the stream goes down with it. */
	const finish = (usage: TurnUsage | null, error: string | null) => {
		trace(`-- finish(error=${error ?? "none"}) closed=${closed} segmentDone=${segmentDone}`);
		if (closed && segmentDone) return;
		const wasSuspended = segmentDone && !closed;
		teardown();
		if (wasSuspended) {
			// Nobody is listening: pi already has its assistant message and is off
			// running a tool. Drop the parked entry so the next call starts a fresh
			// turn instead of resuming a dead socket.
			for (const callId of awaiting.keys()) {
				discardSuspendedTurn(callId, error ?? "the Cursor stream ended while suspended");
			}
			return;
		}
		if (segmentDone) return;
		events.onDone(usage, error);
		settle();
	};

	const send = (value: unknown) => {
		if (closed) return;
		try {
			req.write(encodeFrame(value));
		} catch {
			// A write failure surfaces through the stream's own error event.
		}
	};

	/**
	 * Answer a tool call inline, exactly where Cursor expects a result.
	 *
	 * This is the whole point of suspending rather than tearing down. MEASURED:
	 * with the call replayed as prose in a fresh turn, composer-2.5 re-issued it
	 * 25-33 times until the run timed out; answered here it calls once.
	 *
	 * A failure travels as `success` with `isError`, not as the `error` variant:
	 * the tool DID run and its complaint is the useful part, whereas the error
	 * variant reads as the tool being unreachable.
	 */
	const sendToolResult = (callId: string, result: PiToolResult) => {
		const envelope = awaiting.get(callId);
		awaiting.delete(callId);
		if (!envelope) {
			trace(`>> mcpResult DROPPED: no envelope for ${callId}`);
			return;
		}
		trace(`>> mcpResult ${callId} isError=${result.isError} len=${result.text.length}`);
		send({
			execClientMessage: {
				id: envelope.id,
				execId: envelope.execId,
				mcpResult: {
					success: {
						content: [
							{
								text: {
									// An empty result is indistinguishable from the tool never
									// having run, which is what makes a model call it again.
									text: result.text || (result.isError ? "(failed, no detail)" : "(no output)"),
								},
							},
						],
						isError: result.isError,
					},
				},
			},
		});
	};

	/** Park the turn while pi executes one of its own tools. */
	const suspendFor = (call: PendingPiToolCall) => {
		trace(`-- suspending for ${call.name} (${call.id})`);
		suspendTurn({
			callId: call.id,
			modelId: opts.modelId,
			resume: (nextEvents, result, signal) => {
				trace(`-- resuming ${call.id} (socket ${closed ? "CLOSED" : "open"})`);
				events = nextEvents;
				// The resuming call has its own signal; the one this turn started
				// with belongs to a pi message that has already ended.
				signal?.addEventListener("abort", () => finish(null, "aborted"), { once: true });
				// Back to holding the process open: there is a turn in flight again.
				heartbeat?.ref?.();
				client.ref?.();
				touch();
				const segment = nextSegment();
				if (closed) {
					// Parked across a socket death. Report it rather than hang: pi is
					// awaiting this promise and has no other way to learn.
					events.onDone(null, "the Cursor stream closed while a tool was running");
					settle();
					return segment;
				}
				sendToolResult(call.id, result);
				// Cursor asked for more than one tool before we could answer the
				// first. Hand the next one straight back rather than losing it.
				const next = queued.shift();
				if (next) suspendFor(next);
				return segment;
			},
			abort: (reason) => {
				if (closed) return;
				// Refuse the outstanding calls before going, so the server side is not
				// left waiting on a client that has gone away.
				for (const callId of [...awaiting.keys()]) {
					sendToolResult(callId, { text: `the client gave up: ${reason}`, isError: true });
				}
				teardown();
			},
		});
		// A PARKED TURN MUST NOT KEEP THE PROCESS ALIVE.
		//
		// The heartbeat interval and the http2 session are both ref'd handles, so
		// while suspended they are enough on their own to stop Node exiting. pi's
		// loop can legitimately end here -- `factory_finish` is exactly that: a
		// tool whose execution terminates the run, with no further provider call --
		// and the process would then sit idle holding a socket until the suspension
		// expired, minutes after its work was done, with the exit hook unable to
		// fire because nothing was exiting.
		//
		// Unref'd, a finished loop drains and exits, and the exit hook aborts what
		// is still parked. Re-ref'd on resume, when there is a turn in flight again.
		heartbeat?.unref?.();
		stall?.unref?.();
		client.unref?.();
		// The stream is legitimately silent while pi executes the tool, and pi's
		// own execution can be slow. Silence is the SUSPENSION's business now
		// (session.ts owns that budget), so the idle timer stands down and is
		// re-armed on resume.
		if (idle) clearTimeout(idle);
		idle = null;
		const sink = events;
		sink.onPiToolCall?.(call);
		// The assistant message is complete as far as pi is concerned; the socket
		// stays up underneath it.
		sink.onDone(null, null);
		settle();
	};

	client.on("error", (e) => finish(null, `Cursor connection failed: ${e.message}`));

	const req = client.request({
		":method": "POST",
		":path": RUN_PATH,
		"content-type": "application/connect+json",
		"connect-protocol-version": "1",
		te: "trailers",
		...cursorHeaders(opts.accessToken),
		"x-request-id": randomUUID(),
	});

	opts.signal?.addEventListener("abort", () => finish(null, "aborted"), { once: true });

	const handle = (frame: ConnectFrame) => {
		const msg = frame.message as Record<string, any>;
		// A heartbeat keeps the socket warm and must NOT count as work.
		if (!isHeartbeatOnly(msg)) progress();
		if (debugEnabled()) {
			const top = Object.keys(msg).join(",");
			const detail =
				msg.execServerMessage
					? Object.keys(msg.execServerMessage).join("/")
					: msg.interactionUpdate
						? Object.keys(msg.interactionUpdate).join("/")
						: "";
			if (!isHeartbeatOnly(msg)) trace(`<< ${top} ${detail}`);
		}

		if (isEndStream(frame)) {
			const err = extractError(msg);
			return finish(null, err ? formatError(err) : null);
		}

		// (1) workspace description — the turn does not begin without it
		const exec = msg.execServerMessage;
		if (exec?.requestContextArgs) {
			return send({
				execClientMessage: {
					id: exec.id ?? 0,
					execId: exec.execId ?? "",
					requestContextResult: {
						success: {
							requestContext: {
								// One global rule describing what the bridge can actually do.
								// Without it the model discovers the unsupported calls by
								// trying them mid-task and getting a rejection.
								rules: opts.bridge
									? [
											{
												fullPath: ".cursor/rules/pi-bridge.mdc",
												content: capabilityRule(),
												type: { global: {} },
												source: 0,
											},
										]
									: [],
								env: {
									osVersion: process.platform,
									workspacePaths: [opts.workspacePath],
									shell: process.env.SHELL || "/bin/sh",
									sandboxEnabled: false,
									timeZone: "UTC",
									projectFolder: opts.workspacePath,
								},
								repositoryInfo: [],
								// pi's OWN tools, as MCP definitions. Cursor's native tools
								// are absent on purpose: the server offers those itself and
								// the bridge serves them locally, so declaring them here
								// would give the model two routes to one capability with
								// different semantics.
								tools: piToolsEnabled() ? toolDefinitions(opts.piTools) : [],
								gitRepos: [],
								// The workspace tree. An empty layout leaves Cursor's
								// server-side view blank, which is a plausible reason for a
								// model to report a file it was told about as "not found" —
								// though that specific attribution is NOT established, see
								// the note in exec.ts.
								projectLayouts: [projectLayout(opts.workspacePath)],
								mcpInstructions: [],
								fileContents: {},
								customSubagents: [],
							},
						},
					},
				},
			});
		}

		// A call to one of PI's tools. We cannot execute it here -- a provider gets
		// declarations, never bodies -- so the turn SUSPENDS: pi runs the tool and
		// the result comes back down this same still-open stream.
		if (exec?.mcpArgs) {
			const call = toPiToolCall(exec.mcpArgs);
			if (call && events.onPiToolCall) {
				awaiting.set(call.id, { id: exec.id ?? 0, execId: exec.execId ?? "" });
				// Already suspended: queue rather than suspend twice on one socket.
				if (segmentDone) {
					queued.push(call);
					return;
				}
				return suspendFor(call);
			}
			// No handler — refuse rather than hang, and say which tool, since a
			// silently dropped tool call reads to the model as the tool doing
			// nothing.
			return send({
				execClientMessage: {
					id: exec.id ?? 0,
					execId: exec.execId ?? "",
					mcpResult: {
						error: {
							error: `${call?.name ?? "tool"} is not available in this session`,
						},
					},
				},
			});
		}

		if (exec) {
			// Every other tool request goes to the bridge, which runs it through
			// pi's own tool implementations (HIV-2095).
			//
			// Deliberately not awaited inside the frame handler: that handler is
			// synchronous and shared with the heartbeat path, so awaiting a tool
			// here would block the decoder for the whole of a shell command and
			// starve the keep-alive the same stream depends on.
			void (async () => {
				const outcome = opts.bridge ? await handleExec(opts.bridge, exec, opts.signal) : null;
				if (outcome) {
					events.onToolCall?.(outcome.label);
					// A streamed request answers with several frames, terminal one last.
					for (const frame of outcome.precedingMessages ?? []) {
						send({ execClientMessage: frame });
					}
					return send({ execClientMessage: outcome.message });
				}
				// Unimplemented, or running without a bridge. Refuse EXPLICITLY, and
				// in the RESULT TYPE THE REQUEST ASKED FOR — silence stalls the turn
				// exactly the way the missing requestContext handler did, and so does
				// a refusal of the wrong type, which the server never matches to the
				// request it is waiting on.
				const kind = execKind(exec);
				events.onToolCall?.(`${kind} (unsupported)`);
				send({
					execClientMessage: {
						id: exec.id ?? 0,
						execId: exec.execId ?? "",
						...refusalFor(
							exec,
							`${kind} is not supported by this bridge; use read/write/ls/grep/shell`,
						),
					},
				});
			})();
			return;
		}

		// (2) blob exchange
		const kv = msg.kvServerMessage;
		if (kv?.getBlobArgs) {
			const data = blobs.get(kv.getBlobArgs.blobId);
			return send({
				kvClientMessage: {
					id: kv.id ?? 0,
					getBlobResult: data ? { blobData: b64(data) } : {},
				},
			});
		}
		if (kv?.setBlobArgs) {
			blobs.set(kv.setBlobArgs.blobId, Buffer.from(kv.setBlobArgs.blobData ?? "", "base64"));
			return send({ kvClientMessage: { id: kv.id ?? 0, setBlobResult: {} } });
		}

		// (3) things the server asks the CLIENT to do that this provider cannot.
		// Refused explicitly -- see QUERY_REFUSALS.
		const query = msg.interactionQuery;
		if (query) {
			const kind = Object.keys(query).find((k) => k.endsWith("Query"));
			const build = kind ? QUERY_REFUSALS[kind] : undefined;
			return send({
				interactionResponse: {
					id: query.id ?? 0,
					...(build?.(
						`${kind} is not available through pi's Cursor provider; continue without it`,
					) ?? {}),
				},
			});
		}

		// The server's own snapshot of the conversation, pushed after every step.
		// Deliberately unused: this provider keeps the STREAM alive across a tool
		// call rather than rebuilding the conversation from a checkpoint, so there
		// is nothing here it needs. Named rather than silently dropped because an
		// unhandled top-level case is exactly what hid the requestContext blocker.
		if (msg.conversationCheckpointUpdate) return;

		const update = msg.interactionUpdate;
		if (!update) return;

		if (update.textDelta?.text) events.onText(update.textDelta.text);
		if (update.thinkingDelta?.text) events.onThinking(update.thinkingDelta.text);

		if (update.turnEnded) {
			const t = update.turnEnded;
			finish(
				{
					input: num(t.inputTokens),
					output: num(t.outputTokens),
					cacheRead: num(t.cacheReadTokens),
					cacheWrite: num(t.cacheWriteTokens),
					reasoning: num(t.reasoningTokens),
				},
				null,
			);
		}
	};

	// Any frame at all counts as progress — a token, a tool request, a blob
	// fetch, even the server's own heartbeat. The timer is about SILENCE, not
	// about how fast the model is answering.
	const touch = () => {
		if (closed) return;
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => {
			finish(
				null,
				`Cursor sent nothing for ${Math.round(streamIdleMs() / 1000)}s; treating the turn as stalled`,
			);
		}, streamIdleMs());
		idle.unref?.();
	};

	// Progress, as distinct from liveness. Only a frame that carries something
	// resets this, so a heartbeating stream that produces nothing still ends —
	// the failure `touch` alone cannot catch, because a heartbeat resets it.
	const progress = () => {
		if (closed) return;
		if (stall) clearTimeout(stall);
		stall = setTimeout(() => {
			finish(
				null,
				`Cursor produced nothing for ${Math.round(turnStallMs() / 60_000)}m ` +
					`(the connection stayed alive); treating the turn as stalled`,
			);
		}, turnStallMs());
		stall.unref?.();
	};

	const decode = createFrameDecoder();
	req.on("data", (chunk: Buffer) => {
		touch();
		for (const frame of decode(chunk)) handle(frame);
	});
	// A transport end without turnEnded is a truncated turn, not a clean one.
	req.on("end", () => finish(null, "Cursor stream ended before the turn completed"));
	req.on("error", (e) => finish(null, `Cursor stream error: ${e.message}`));

	send({
		runRequest: {
			conversationState: { rootPromptMessagesJson: [systemId], turns: [] },
			action: {
				userMessageAction: {
					userMessage: { text: opts.userText, messageId: randomUUID(), mode: 0 },
				},
			},
			modelDetails: {
				modelId: opts.modelId,
				displayModelId: opts.modelId,
				displayName: opts.modelId,
			},
			conversationId: randomUUID(),
		},
	});
	// (3) keep-alive. NOT req.end() — the request half must stay open, and it
	// stays open across a suspension too: that is what lets pi's tool result
	// arrive on the turn that asked for it.
	heartbeat = setInterval(() => send({ clientHeartbeat: {} }), HEARTBEAT_MS);
	// Both armed from the moment the request leaves: a turn that never produces
	// a FIRST frame is the exact case that hung a factory eval for 30 minutes,
	// and one that produces only heartbeats is the case that hung another for 40
	// with the silence budget armed and never firing.
	touch();
	progress();

	return first;
}
