import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FALLBACK_LABEL, FALLBACK_MODEL, FALLBACK_PROVIDER, isCybersecurityError } from "./policy.ts";

/** Recover only after Pi's own retry/compaction paths are finished. */
export default function cybersecurityFallback(pi: ExtensionAPI): void {
	let attempted = false;
	let generation = 0;
	let switching: { target: Model<Api>; superseding?: Model<Api> } | undefined;
	const reset = () => { attempted = false; switching = undefined; generation++; };
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("before_agent_start", reset);
	pi.on("input", () => { generation++; });
	pi.on("model_select", event => {
		if (switching && event.model !== switching.target) switching.superseding = event.model;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (attempted || event.outcome !== "error" || event.continue
			|| ctx.signal?.aborted || ctx.hasPendingMessages()) return;
		// The projected LLM context omits failed assistant messages. Read the
		// persisted branch instead so the terminal provider error is not lost.
		const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
		const failed = entry?.type === "message" ? entry.message : undefined;
		if (!failed || failed.role !== "assistant" || !isCybersecurityError(failed)) return;
		// A manual model switch has already taken over; do not overwrite it.
		// Virtual selections are also left to their own routing policy.
		if (ctx.model?.provider !== failed.provider || ctx.model.id !== failed.model) return;
		attempted = true;
		const gen = generation;
		const fallback = ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL);
		if (!fallback) {
			ctx.ui.notify(`Cybersecurity error: ${FALLBACK_LABEL} is not in the model registry; leaving the original error unchanged.`, "warning");
			return;
		}
		const operation: NonNullable<typeof switching> = { target: fallback };
		switching = operation;
		try {
			// setModel checks provider authentication. No credentials are read,
			// copied, or persisted here, and defaults for new sessions stay intact.
			if (!(await pi.setModel(fallback))) {
				ctx.ui.notify(`Cybersecurity error: no credentials for ${FALLBACK_LABEL}; leaving the original error unchanged.`, "warning");
				return;
			}
			if (switching !== operation) return;
			// Pi authenticates asynchronously before mutating the selection. A
			// manual selection may have landed during that await. Give it back
			// before returning; never continue over the operator's chosen model.
			if (operation.superseding) {
				do {
					operation.target = operation.superseding;
					if (ctx.model === operation.target) break;
					if (!(await pi.setModel(operation.target))) {
						ctx.ui.notify("Could not restore the manual model selection after fallback authentication; select the model again.", "warning");
						return;
					}
				} while (switching === operation && operation.superseding !== operation.target);
				return;
			}
		} catch (error) {
			ctx.ui.notify(`Cybersecurity fallback unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		} finally {
			if (switching === operation) switching = undefined;
		}
		if (gen !== generation || ctx.signal?.aborted || ctx.hasPendingMessages()
			|| ctx.model?.provider !== FALLBACK_PROVIDER || ctx.model.id !== FALLBACK_MODEL) return;
		ctx.ui.notify(`Cybersecurity-related provider error — switched to ${FALLBACK_LABEL} and continuing.`, "warning");
		// The failed assistant entry remains visible. A fresh context message makes
		// Pi's boundary continuation valid without replaying the original prompt
		// or mechanically re-executing completed tools. The continuation also
		// explicitly tells the model to preserve completed actions.
		return {
			entries: [...event.entries, {
				type: "custom_message" as const,
				customType: "cybersecurity-fallback",
				content: `The provider returned a cybersecurity-related error. Switched to ${FALLBACK_LABEL}. Continue the interrupted task from the current transcript and completed tool results; do not repeat completed actions.`,
				display: true,
				details: { provider: failed.provider, model: failed.model, fallback: FALLBACK_LABEL },
			}],
			continue: true,
		};
	});
}
