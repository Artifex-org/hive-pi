/**
 * At most one automatic turn per settle, across extensions.
 *
 * The agenda driver and plan auto-continue both inject a follow-up turn from
 * `agent_settled`. Their mutual exclusion used to be `ctx.isIdle()`: pi set
 * `_isAgentRunActive` synchronously inside `sendMessage({triggerTurn:true})`,
 * so the second handler in the serial chain saw a busy session and stood down.
 *
 * pi 0.87 removed that signal. While `agent_settled` handlers run, a
 * triggerTurn message is pushed onto `_deferredSettledActions` and started only
 * after EVERY handler has returned (agent-session.js `_emitAgentSettled`), so
 * `isIdle()` stays true for the whole chain and `pendingMessageCount` does not
 * count deferred work. Both injectors passed their check and the session ran
 * two injected turns back to back, charging both caps.
 *
 * The claim travels on `pi.events`, a node EventEmitter: `emit` runs each
 * listener's synchronous part before returning, so a claim made by one handler
 * is visible to the next one in the same chain. It resets on `agent_start`,
 * which is where the claimed turn (or anything else) begins.
 *
 * Known gap, not closable from an extension: a prompt the operator types while
 * a slow handler (a gate) is running is deferred at the top of `prompt()`,
 * before the `input` event, so nothing can see it until the chain ends.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SETTLE_CLAIM_CHANNEL = "hive.settle.claim";

export interface SettleClaimEvent {
	/** Which injector took the settle — an enum-like name, never prose. */
	by: string;
}

export interface SettleClaims {
	/** The injector that already took this settle, or null. */
	claimedBy(): string | null;
	/** Announce that `by` has injected a turn for this settle. */
	claim(by: string): void;
}

export function trackSettleClaims(pi: ExtensionAPI): SettleClaims {
	let claimedBy: string | null = null;
	pi.events.on(SETTLE_CLAIM_CHANNEL, (data: unknown) => {
		const by = (data as Partial<SettleClaimEvent> | undefined)?.by;
		claimedBy = typeof by === "string" && by ? by : "unknown";
	});
	pi.on("agent_start", () => {
		claimedBy = null;
	});
	return {
		claimedBy: () => claimedBy,
		claim: (by) => pi.events.emit(SETTLE_CLAIM_CHANNEL, { by } satisfies SettleClaimEvent),
	};
}
