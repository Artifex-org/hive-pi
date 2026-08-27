/**
 * narrate — the reminder half of "say what you are doing".
 *
 * See ./narrate.ts for the measurements and the cache reasoning. In short: the
 * rule lives in AGENTS.md, and this pokes the model with a one-line version of
 * it at the moment it is being ignored — which is what Claude Code's output
 * styles do, and the reason they hold up over a long session where a static
 * system-prompt line does not.
 *
 * THE ONE MECHANICAL CONSTRAINT, inherited from every extension here: pi awaits
 * handlers serially, so a slow handler IS the agent loop. Both handlers below
 * are pure, synchronous and allocation-light; neither touches the network, the
 * filesystem, or a timer.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";
import {
	SILENT_TOOL_CALLS,
	createNarration,
	noteAssistantMessage,
	noteReminded,
	noteUserTurn,
	remindReason,
	reminderText,
	slowWaitText,
	type NarrationState,
} from "./narrate.ts";

interface NarrateConfig {
	enabled: boolean;
	/** Silent tool calls before the nudge. */
	threshold: number;
}

/**
 * Defaults ON, unlike hive-telemetry and hive-remote.
 *
 * Those two send data off the machine, so consent has to be an explicit act.
 * This one sends nothing anywhere: it appends about forty tokens to a request
 * the agent was already making, asking it to talk to the person already
 * watching. The cost of being wrong is a sentence nobody needed.
 */
function loadConfig(): NarrateConfig {
	const raw = readJSON<Partial<NarrateConfig>>(configPathFor("narrate")) ?? {};
	return {
		enabled: raw.enabled !== false,
		// Floor of 3: below that a normal read-grep-read burst trips it, and a
		// reminder that fires on competent work is one the model learns to skip.
		threshold: numberOr(raw.threshold, SILENT_TOOL_CALLS, 3, 100),
	};
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	// Read in the factory, so a disabled install registers NO handler at all —
	// which matters more here than anywhere else in this repo: pi skips the
	// `context` transform path entirely when nothing wants it, and registering a
	// no-op handler would turn that path on for a user who opted out.
	if (!cfg.enabled) return;

	const state: NarrationState = createNarration();

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; content?: unknown } | undefined;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;
		let hasText = false;
		let toolCalls = 0;
		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			const type = (block as { type?: string }).type;
			if (type === "toolCall") toolCalls += 1;
			// Whitespace is not narration. A model that emits an empty text block
			// alongside its tool calls would otherwise reset the streak forever.
			else if (type === "text" && String((block as { text?: unknown }).text ?? "").trim()) hasText = true;
		}
		noteAssistantMessage(state, hasText, toolCalls);
	});

	// A fresh instruction starts from silence — whatever the agent was doing
	// before, the streak that matters is the one in the answer it is about to
	// give.
	pi.on("input", () => noteUserTurn(state));

	// The reminder rides on a tool result the agent already ran — the same place
	// Claude Code puts its own. NOT on `context`: that path is banned here at
	// build level, and rightly, because subscribing switches on a transform pi
	// otherwise skips entirely, on every LLM call in every session.
	//
	// Appended to the END of the result's content, so the tool's actual output
	// is unchanged and a reader (or a parser) sees the reminder after it, not
	// spliced into it.
	pi.on("tool_result", (event) => {
		// Two triggers, one reminder. `remindReason` decides which complaint
		// applies; the streak wins when both do.
		const startedAt = state.silentBatchStartedAtMs;
		const reason = remindReason(state, cfg.threshold);
		if (!reason) return;
		const content = event.content;
		if (!Array.isArray(content)) return;
		const text =
			reason === "streak"
				? reminderText(state.silentToolCalls)
				: slowWaitText(Date.now() - (startedAt ?? Date.now()));
		noteReminded(state);
		return {
			content: [...content, { type: "text" as const, text }],
		};
	});

	pi.registerCommand("narrate-status", {
		description: "Show the narration nudge's current streak",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.ui.notify(
				[
					`enabled:   ${cfg.enabled}`,
					`threshold: ${cfg.threshold} silent tool calls`,
					`streak:    ${state.silentToolCalls}${state.reminded ? " (already reminded)" : ""}`,
				].join("\n"),
			);
		},
	});
}
