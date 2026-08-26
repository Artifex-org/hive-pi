/**
 * pi provider surface for Cursor (HIV-2086).
 *
 * # The impedance mismatch, stated up front
 *
 * Cursor's `Run` is an AGENT api, not a completion api: it runs its own loop
 * server-side and expects the client to execute tools on request. pi also runs
 * an agent loop, with its own tools. Two loops cannot both drive.
 *
 * This provider resolves it by letting CURSOR'S loop drive and serving its tool
 * requests from pi's own tool implementations (see exec.ts). pi sees one
 * completion; Cursor sees a working client. A verified turn reads a file, edits
 * it and reports back.
 *
 * pi's EXTENSION tools (`factory_finish`, hive tools) are advertised to Cursor
 * as MCP definitions. A provider cannot execute pi's tools itself, so such a
 * call is handed back as a normal `toolCall` and pi runs it — but the Cursor
 * turn does NOT end. It parks with its stream open (session.ts), and when pi
 * calls this provider again with the result, we answer the waiting turn instead
 * of starting a new one.
 *
 * # The loop, and what it actually was
 *
 * Ending the turn on a tool call and rebuilding the next one from flattened
 * prose made composer-2.5 re-issue the same tool 25-33 times until the run
 * timed out. Three plausible causes were fixed along the way — the CALL missing
 * from the replayed history, the RESULT flattened as if the user had said it,
 * and corrupted argument decoding. All three were real defects. None was the
 * cause, and the loop survived all three.
 *
 * The cause was that Cursor never received a tool RESULT at all. Its own client
 * answers inline on the open stream and the turn continues; we tore the stream
 * down, so from the model's side the call it had just made was still
 * outstanding. Measured directly: hold the stream open, answer `mcpResult` after
 * a delay standing in for pi's execution, and the same prompt calls the tool
 * ONCE and ends cleanly.
 *
 * # History
 *
 * Flattening survives as the COLD-START path — a fresh session, a restarted
 * process, an expired suspension — where there is no live turn to resume. It is
 * lower fidelity (the server sees one long user message rather than structured
 * turns), which is precisely why resuming is preferred whenever possible.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import { createExecBridge } from "./exec.ts";
import { flattenConversation, messageText, trailingToolResult } from "./history.ts";
import type { PendingPiToolCall } from "./mcp.ts";
import { isCursorOwnModel } from "./models.ts";
import { claimSuspendedTurn } from "./session.ts";
import { runTurn, type RunEvents, type TurnUsage } from "./transport.ts";

function systemPromptOf(context: Context): string {
	const explicit = (context as { systemPrompt?: string }).systemPrompt;
	if (explicit?.trim()) return explicit;
	const fromMessages = (context.messages ?? []).find(
		(m) => (m as { role?: string }).role === "system",
	);
	return fromMessages ? messageText(fromMessages) : "You are a helpful assistant.";
}

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Stream one Cursor turn as pi assistant-message events.
 *
 * Cost stays zero throughout, and that is a fact rather than an omission: these
 * tokens are covered by a flat-rate subscription. What bounds a Cursor run is
 * the account's remaining allowance (see usage.ts), not a dollar figure — so
 * reporting an invented per-token price would make every consumer that ranks on
 * cost treat subscription work as though it spent metered credit.
 */
export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};

		const applyUsage = (usage: TurnUsage | null) => {
			if (!usage) return;
			output.usage.input = usage.input;
			output.usage.output = usage.output;
			output.usage.cacheRead = usage.cacheRead;
			output.usage.cacheWrite = usage.cacheWrite;
			output.usage.totalTokens =
				usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		};

		const fail = (message: string) => {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = message;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		};

		// THE BILLING BOUNDARY IS ENFORCED HERE, not only in the catalogue.
		//
		// Filtering `toPiModels` hides the third-party passthroughs from the model
		// picker, and that is NOT sufficient: pi accepts an unrecognised id for a
		// registered provider, warns "Using custom model id", and calls this
		// function anyway. Measured — `--model cursor/claude-opus-5-thinking-high`
		// completed a real turn against the metered pool while reporting cost 0.
		//
		// So the refusal lives at the point where a request would actually leave.
		if (!isCursorOwnModel(model.id)) {
			return fail(
				`Refusing to run ${model.id} through Cursor: only Cursor's own models ` +
					`(composer-*, cursor-grok-*) are covered by the flat-rate subscription. ` +
					`Third-party models are billed against a separate pool at the provider's ` +
					`API price, which this integration reports as zero cost and would hide.`,
			);
		}

		const accessToken = options?.apiKey;
		if (!accessToken) {
			return fail("No Cursor credential. Run /login cursor.");
		}

		stream.push({ type: "start", partial: output });

		// Content blocks are opened lazily: a turn that produces only thinking, or
		// only text, should not emit an empty block of the other kind.
		let textIndex = -1;
		let thinkingIndex = -1;
		// Set when Cursor calls one of pi's tools. It makes this MESSAGE terminate
		// with "toolUse" instead of "stop", which is what tells pi to execute the
		// call and come back. The Cursor turn itself does not end -- it parks with
		// its stream open, waiting for the result (see session.ts).
		let pendingPiCall: PendingPiToolCall | null = null;

		const openText = () => {
			if (textIndex >= 0) return;
			output.content.push({ type: "text", text: "" });
			textIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
		};
		const openThinking = () => {
			if (thinkingIndex >= 0) return;
			output.content.push({ type: "thinking", thinking: "" } as never);
			thinkingIndex = output.content.length - 1;
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		};


		const events: RunEvents = {
			onPiToolCall(call) {
				pendingPiCall = call;
			},
			onThinking(delta) {
				openThinking();
				const block = output.content[thinkingIndex] as { thinking: string };
				block.thinking += delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta,
					partial: output,
				});
			},
			onText(delta) {
				openText();
				const block = output.content[textIndex] as { text: string };
				block.text += delta;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
			},
			onDone(usage: TurnUsage | null, error: string | null) {
				// A pi tool call is the turn's RESULT, not an interruption of it.
				// Emitted as a normal toolCall block so pi executes it exactly as
				// it would any other provider's, then re-invokes this provider
				// with the result appended.
				if (pendingPiCall) {
					const call = pendingPiCall as PendingPiToolCall;
					if (thinkingIndex >= 0) {
						stream.push({
							type: "thinking_end",
							contentIndex: thinkingIndex,
							content: (output.content[thinkingIndex] as { thinking: string }).thinking,
							partial: output,
						});
					}
					if (textIndex >= 0) {
						stream.push({
							type: "text_end",
							contentIndex: textIndex,
							content: (output.content[textIndex] as { text: string }).text,
							partial: output,
						});
					}
					const toolCall = {
						type: "toolCall" as const,
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					};
					output.content.push(toolCall);
					const contentIndex = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					applyUsage(usage);
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					return stream.end();
				}

				if (thinkingIndex >= 0) {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: (output.content[thinkingIndex] as { thinking: string }).thinking,
						partial: output,
					});
				}
				if (textIndex >= 0) {
					stream.push({
						type: "text_end",
						contentIndex: textIndex,
						content: (output.content[textIndex] as { text: string }).text,
						partial: output,
					});
				}
				if (error) return fail(error);

				applyUsage(usage);
				// A stream that ends clean but produced nothing is a FAILURE, not an
				// empty answer: it is what a stalled turn looks like from here, and
				// reporting it as success would record a model that never spoke as a
				// model that had nothing to say.
				if (textIndex < 0) {
					return fail("Cursor returned no text (the turn ended without producing content)");
				}
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			},
		};

		// IS PI HANDING BACK A TOOL RESULT WE ARE STILL HOLDING A TURN OPEN FOR?
		//
		// When Cursor calls one of pi's tools this provider ends the assistant
		// MESSAGE but parks the Cursor turn with its stream alive. pi executes the
		// tool and calls us straight back with the result — so the right move is
		// not to start a new turn at all, but to answer the one already waiting.
		//
		// This is what stops the re-call loop. MEASURED: rebuilt as a new turn with
		// the call replayed as prose, composer-2.5 re-issued the same tool 25-33
		// times until the run timed out; answered on the parked stream it calls
		// once and finishes.
		const handback = trailingToolResult(context.messages ?? []);
		const parked = handback ? claimSuspendedTurn(handback.callId, model.id) : null;
		if (parked && handback) {
			return void (await parked.resume(
				events,
				{ text: handback.text, isError: handback.isError },
				options?.signal,
			));
		}

		// No parked turn: a fresh conversation, a restarted process, or a
		// suspension that expired. Start over, carrying what history we have as
		// text — lower fidelity than a live stream, and the reason resuming is
		// preferred wherever it is possible.
		//
		// The bridge is built here rather than at the top because a resumed turn
		// already has the one it started with. Null means pi's tools could not be
		// resolved from wherever this extension is vendored; the turn still runs,
		// as a text generator.
		const bridge = await createExecBridge(process.cwd());
		const flattened = flattenConversation(context.messages ?? []);
		await runTurn({
			accessToken,
			modelId: model.id,
			systemPrompt: systemPromptOf(context),
			userText: flattened,
			workspacePath: process.cwd(),
			signal: options?.signal,
			// Turns Cursor from a text generator into something that can actually
			// read and change a repository, by running its tool requests through
			// pi's own tool implementations (HIV-2095).
			bridge: bridge ?? undefined,
			// pi's own tools, advertised to Cursor so an extension tool —
			// factory_finish above all — is reachable at all.
			piTools: context.tools as never,
			events,
		});
	})();

	return stream;
}
