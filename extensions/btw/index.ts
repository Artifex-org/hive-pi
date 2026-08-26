/**
 * btw — the pi wiring for the side-question lane. The reasoning lives in
 * ./thread.ts; this file is `/btw`, the in-memory thread, and the two seams that
 * make it testable.
 *
 * WHAT THE CHILD IS. Not a pi session — one `modelRegistry.complete()` call per
 * turn, the same mechanism `advisor` uses, with `tools` left undefined. That is
 * what "tool-less" is implemented as: not a permission list the child could talk
 * its way past, but an absent field. There is no child process, no session file,
 * no `PI_AGENDA_WORKER` to set, and nothing to clean up if the user walks away.
 *
 * WHERE IT RENDERS. `ctx.ui.notify` — the transcript, not an overlay. HIV-1218 is
 * currently consolidating six competing widget-band keys into one; a seventh
 * added this week would be work against that, and the answer to a question you
 * just typed does not need a panel. The README records this as deferred.
 *
 * WHAT IT PERSISTS. Exactly one thing, and only when asked: `/btw done` sends a
 * single custom message with `deliverAs: "nextTurn"`. Everything else — the
 * questions, the answers, the excerpt — lives in the `thread` variable below and
 * is gone when the process is. `appendEntry` is deliberately NOT used anywhere in
 * this file: it writes the session JSONL, which is the one thing the design says
 * a side lane must not do.
 *
 * THE MECHANICAL CONSTRAINT, as everywhere here: pi awaits handlers serially. The
 * only slow thing in this file is the completion, and it runs inside a COMMAND
 * handler — user-initiated, with the user already waiting for it. The two event
 * handlers registered here are an assignment and a boolean.
 */

import { randomUUID } from "node:crypto";

import { buildSessionContext, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";
import {
	assistantText,
	buildSideSystemPrompt,
	capSeed,
	createThread,
	describeThread,
	handoffContent,
	parseBtwCommand,
	recordExchange,
	SEED_MAX_CHARS,
	SUMMARY_REQUEST,
	threadMessages,
	userMessage,
	type BtwThread,
} from "./thread.ts";

/** An answer is a paragraph or two. Generous, but it must end. */
const ANSWER_MAX_TOKENS = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface BtwConfig {
	enabled: boolean;
	/** Hard wall for one side turn. */
	timeoutMs: number;
	/** Excerpt budget. Defaults to the agenda driver's number — see thread.ts. */
	maxSeedChars: number;
}

/**
 * Opt-out (`raw.enabled !== false`), default ON.
 *
 * The opt-in convention is for anything that sends data off the machine or
 * changes a posture. This does neither until you type `/btw`, and until then it
 * costs one registered command and one null variable — so defaulting it off would
 * only mean the feature is missing on the day someone first reaches for it.
 */
export function loadBtwConfig(): BtwConfig {
	const raw = readJSON<Partial<BtwConfig>>(configPathFor("btw")) ?? {};
	return {
		enabled: raw.enabled !== false,
		timeoutMs: numberOr(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 5_000, 600_000),
		maxSeedChars: numberOr(raw.maxSeedChars, SEED_MAX_CHARS, 1_000, 200_000),
	};
}

/** One tool-less turn's request. `tools` is absent by construction, not by flag. */
export interface SideRequest {
	system: string;
	messages: Message[];
	sessionId: string;
}

/**
 * The two things a test cannot get from `createFakePi()`: its ctx carries
 * `modelRegistry: {}` and a session manager with no tree. Injecting them is the
 * `wireSkillScope` precedent — the real implementations are the defaults, so
 * production never sees a seam, and the command's actual behaviour (does the
 * child get the stripped prompt, do follow-ups carry the prior turns, does the
 * handoff land) is testable without a provider.
 */
export interface BtwDeps {
	complete(ctx: ExtensionContext, request: SideRequest, timeoutMs: number): Promise<AssistantMessage>;
	seed(ctx: ExtensionContext, maxChars: number): { text: string; capped: boolean };
}

/**
 * The excerpt, from `buildSessionContext` — pi's own compaction- and
 * branch-aware resolution of what the model currently sees. Walking `getBranch()`
 * by hand (as agenda's `recentTranscript` does, for its own reasons) would
 * re-include entries a compaction has already replaced with a summary.
 *
 * Defensive read throughout: `ctx` throws once the session is replaced, and a
 * failure here should cost the excerpt, not the question. An empty seed still
 * produces a usable child — one that knows the project from the inherited system
 * prompt and says it cannot see the conversation.
 */
function defaultSeed(ctx: ExtensionContext, maxChars: number): { text: string; capped: boolean } {
	try {
		const manager = ctx.sessionManager;
		const context = buildSessionContext(manager.getEntries(), manager.getLeafId());
		return capSeed(serializeConversation(convertToLlm(context.messages)), maxChars);
	} catch {
		return { text: "", capped: false };
	}
}

async function defaultComplete(
	ctx: ExtensionContext,
	request: SideRequest,
	timeoutMs: number,
): Promise<AssistantMessage> {
	// Read off ctx BEFORE the first await: it goes stale the moment the session is
	// replaced, and this call is the long one (advisor/index.ts, agenda/goal.ts).
	const registry = ctx.modelRegistry;
	const model = ctx.model;
	if (!model) throw new Error("no model is selected — pick one with /model, then ask again");

	// The SAME model as the main session, deliberately. advisor escalates a class
	// because its value is an independent read; this lane's value is a cheap
	// answer from context already in hand, and escalating would make the detour
	// cost more than the work it interrupts.
	return await registry.complete(
		model,
		// No `tools` field. THE hard constraint of this feature, and it is enforced
		// by this line's absence rather than by anything the child is told.
		{ systemPrompt: request.system, messages: request.messages },
		{
			maxTokens: ANSWER_MAX_TOKENS,
			// Cache retention left at the provider default, UNLIKE advisor's
			// "none". advisor is one shot and never reuses its prefix; this thread
			// resends a frozen system prompt (inherited prompt + excerpt, often
			// 16k+ chars) on every follow-up, so the cached prefix is most of what
			// makes a second question cheap.
			sessionId: request.sessionId,
			signal: AbortSignal.timeout(timeoutMs),
		},
	);
}

export default function (pi: ExtensionAPI): void {
	const cfg = loadBtwConfig();
	wireBtw(pi, cfg, { complete: defaultComplete, seed: defaultSeed });
}

export function wireBtw(pi: ExtensionAPI, cfg: BtwConfig, deps: BtwDeps): void {
	if (!cfg.enabled) return;

	// Workers get no side lane. A delegated subagent is already a side
	// conversation someone else opened; letting it open its own would spend the
	// parent's budget on a question nobody asked and that nobody will ever read —
	// there is no human at a worker's transcript to notify. Inlined rather than
	// imported from brief/detect.ts, matching term-title.ts:178 and
	// session-context.ts:71; brief's own workers also carry PI_AGENDA_WORKER
	// (brief/run.ts:179), so the one check covers both.
	if (process.env.PI_AGENDA_WORKER === "1") return;

	/** The whole feature's state. In memory, one at a time, never persisted. */
	let thread: BtwThread | null = null;

	// A thread seeded from one conversation is a lie in the next. Resume, fork and
	// `/new` all arrive here, and each of them replaces the excerpt the child was
	// answering from.
	pi.on("session_start", () => {
		thread = null;
	});

	const open = (ctx: ExtensionContext): BtwThread => {
		const { text, capped } = deps.seed(ctx, cfg.maxSeedChars);
		return createThread(
			buildSideSystemPrompt(ctx.getSystemPrompt(), text, capped),
			text.length,
			randomUUID(),
			Date.now(),
		);
	};

	/**
	 * One side turn. Returns the answer text; throws with a usable message.
	 *
	 * `record` is false for the handoff, and that is not an optimisation: the
	 * summary request is a message to the child ABOUT the conversation, not a
	 * question the user asked in it. Recording it would put "Stop answering and
	 * write the handoff…" into the folded message's list of what was asked, and
	 * would replay it as history if a failed handoff is retried.
	 */
	const turn = async (
		ctx: ExtensionContext,
		current: BtwThread,
		question: string,
		record = true,
	): Promise<string> => {
		const pending = userMessage(question, Date.now());
		// `ui` is read off ctx BEFORE the await, for the same reason
		// `defaultComplete` reads the registry there: ctx throws on every property
		// access once the session is replaced, and this await is the 120s one. The
		// `finally` below is the dangerous half — a throw from a `finally` REPLACES
		// whatever was in flight, so a session replaced mid-completion would turn a
		// finished, paid-for answer into an escaped exception and leave the status
		// line stuck at "btw: thinking…" with nothing able to clear it.
		const ui = ctx.ui;
		ui.setStatus("btw", "btw: thinking…");
		try {
			const answer = await deps.complete(
				ctx,
				{ system: current.system, messages: threadMessages(current, pending), sessionId: current.sessionId },
				cfg.timeoutMs,
			);
			const text = assistantText(answer);
			// Recorded only on a usable answer. A failed turn that stayed in the
			// thread would be resent as history on every follow-up, so one provider
			// hiccup would poison the rest of the conversation.
			if (!text) throw new Error("the side thread returned an empty answer");
			if (record) recordExchange(current, pending, answer);
			return text;
		} finally {
			ui.setStatus("btw", undefined);
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a side question that does not enter the main conversation (`/btw <question>`, `/btw done`, `/btw end`)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const command = parseBtwCommand(args);

			if (command.kind === "status") {
				ctx.ui.notify(describeThread(thread, Date.now()).join("\n"));
				return;
			}

			if (command.kind === "end") {
				ctx.ui.notify(thread ? "btw: side thread discarded." : "btw: no side thread open.");
				thread = null;
				return;
			}

			if (command.kind === "handoff") {
				if (!thread) {
					ctx.ui.notify("btw: no side thread to fold in. `/btw <question>` opens one.");
					return;
				}
				const current = thread;
				let summary: string;
				try {
					summary = await turn(ctx, current, SUMMARY_REQUEST, false);
				} catch (error) {
					// The thread is KEPT on a failed handoff. Losing an exchange
					// because the summary call timed out would be the worst possible
					// moment to drop it — it is the moment the user decided it was
					// worth keeping.
					ctx.ui.notify(`btw: could not produce a handoff (${message(error)}). The thread is still open.`, "error");
					return;
				}
				// The one write into the main conversation. `nextTurn` rather than
				// `triggerTurn: true`: folding a finding in is not a reason to make
				// the agent act on it — the user is mid-task and will say what to do
				// with it. It reaches the model with their next message.
				pi.sendMessage(
					{
						customType: "btw",
						content: handoffContent(current, summary),
						display: true,
						details: { exchanges: current.exchanges.length, seed_chars: current.seedChars },
					},
					{ deliverAs: "nextTurn" },
				);
				thread = null;
				ctx.ui.notify(`btw: folded in — the main thread sees it with your next message.\n\n${summary}`);
				return;
			}

			const current = thread ?? open(ctx);
			let answer: string;
			try {
				answer = await turn(ctx, current, command.question);
			} catch (error) {
				// A first question that fails leaves NO thread behind: `thread` is
				// only assigned below, so a failed open cannot strand an empty one
				// that later follow-ups would silently attach to.
				ctx.ui.notify(`btw: ${message(error)}`, "error");
				return;
			}
			thread = current;
			ctx.ui.notify(`${answer}\n\n(btw · ${current.exchanges.length} exchange${current.exchanges.length === 1 ? "" : "s"} · /btw done to fold in · /btw end to discard)`);
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
