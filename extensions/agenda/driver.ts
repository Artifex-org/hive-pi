/**
 * The driver — the only thing in this harness that injects a follow-up turn.
 *
 * Note the precise invariant: **one injector**, not "one `agent_settled`
 * owner". `hive-telemetry` legitimately subscribes to the same event and must
 * keep working; what must never happen is two things independently deciding to
 * re-enter the agent loop, because their caps then multiply instead of
 * composing and neither can see the other's spend.
 *
 * Structure of a settle:
 *
 *   1. cheap synchronous rejects (worker process, re-entrancy, headless mode)
 *   2. read EVERYTHING off `ctx` — it throws once the session is replaced
 *   3. the hand-back guard (hive-common/handback.ts) can veto before any work runs
 *   4. walk the policy chain in fixed order, running each policy that wants the
 *      settle, until one of them INJECTS
 *   5. re-check `generation` after every await; the session may be replaced
 *   6. every policy that ran reports its own metric; AT MOST ONE injects
 *
 * Step 4 continues past a policy that produced no injection, which is the point:
 * the gate applies on every settle in a gated repo, so stopping at the first
 * policy that merely *wants* the settle would starve everything behind it.
 *
 * `decide()` is cheap and synchronous by contract, so a settle where nothing
 * applies costs approximately nothing — which matters because pi awaits
 * extension handlers serially and this one now sits in front of
 * `hive-telemetry`'s flush.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENDA_INJECTION_CHANNEL, type AgendaInjectionEvent } from "../hive-common/channels.ts";
import { trackSettleClaims } from "../hive-common/settle-claim.ts";
import { walkChain } from "./chain.ts";
import { emptyLedger, record, count, type LedgerState } from "./ledger.ts";
import { ADVISE_LEDGER_ID } from "./conductor.ts";
import { ADVICE_GIVEN_ENTRY, registerDeliveryProgress } from "./delivery-progress.ts";
import { recapTranscript } from "./recap.ts";
import type { MetricOutcome, Policy } from "./policy.ts";
import { classifyHandback, type Handback, handbackClass } from "../hive-common/handback.ts";
import { confirmOwnWork, trackOwnWork } from "../hive-common/own-work.ts";
import { deriveSignals, emptySignals, type SessionSignals } from "./signals.ts";
import { type TurnFailure, turnFailureOf } from "./turn-outcome.ts";

/**
 * NO minimum-interval floor here, deliberately.
 *
 * The plan called for a 2s floor between injections. Building it revealed that
 * a floor which DROPS an injection is worse than none: the gate result would
 * never reach the model, so the loop stalls with the human seeing nothing —
 * and it would silently break the pinned behaviour that three consecutive
 * failures produce three injections, because a `exit 1` gate settles in
 * milliseconds. A floor has to DELAY, and delaying needs the timer that arrives
 * with `/loop`.
 *
 * The gate is self-limiting in the meantime: it spawns a real check, and it is
 * capped. Instant re-entry only becomes reachable with `/loop`, which is where
 * the floor belongs.
 */

export interface DriverOptions {
	policies: Policy[];
	/** Cheap milestone policies only; gates/judges stay at settle. */
	turnPolicies?: Policy[];
	/** True inside a spawned worker, where automatic re-entry is never wanted. */
	isWorker?: boolean;
}

export interface DriverHandle {
	/** Current ledger — read by `/agenda`. */
	ledger(): LedgerState;
	/** Wipe per-session state. Called on `session_start` and by `/agenda stop`. */
	reset(): void;
	/** Terminal state set by the hand-back guard, surfaced in `/agenda`. */
	blockedOnUser(): boolean;
	/**
	 * Run the policy chain NOW, outside a settle — the timer's entry point.
	 *
	 * Fire-and-forget: a timer has nowhere to await. It runs the identical chain
	 * as `agent_settled`, so the caps, the hand-back guard and the idle check all
	 * apply. No-ops when the session is busy or already inside the chain.
	 */
	pump(): void;
}

/**
 * Recent conversation as plain text, oldest first, for policies that grade what
 * happened. Capped from the END, because recency is what a judgment is about
 * and an unbounded excerpt would make every evaluation cost more than the turn
 * it is grading. The fold is recap.ts's, shared with the recap and the Claude
 * adapter; this wrapper only adds the defensive ctx read.
 */
function recentTranscript(ctx: ExtensionContext, maxChars = 16_000): string {
	try {
		return recapTranscript(ctx.sessionManager.getBranch() as readonly unknown[], maxChars);
	} catch {
		return "";
	}
}

/**
 * The newest turn's failure, if any. Wraps the pure `turnFailureOf` in the same
 * defensive read the other ctx helpers use.
 *
 * Fails CLOSED on an unreadable session — `undefined` here would mean "the turn
 * ran fine", and guessing that on a session we cannot read is how the loop got
 * to re-enter in the first place.
 */
function readTurnFailure(ctx: ExtensionContext): TurnFailure | undefined {
	try {
		return turnFailureOf(ctx.sessionManager.getBranch() as readonly unknown[]);
	} catch {
		return "error";
	}
}

/**
 * Session signals for policies, wrapped in the same defensive read the other
 * ctx helpers use. Fails EMPTY: a policy keyed on signals treats the empty
 * snapshot as "nothing to do", which is the safe direction for an unreadable
 * session — the opposite of the turn-failure helper, whose absence would mean
 * "go ahead and inject".
 */
function readSignals(ctx: ExtensionContext): SessionSignals {
	try {
		const entries = ctx.sessionManager.getEntries() as readonly unknown[];
		const branch = ctx.sessionManager.getBranch() as readonly unknown[];
		// Context pressure is a ctx read, not an entry derivation — so it happens
		// HERE, inside the driver's before-first-await block, and is handed to
		// `deriveSignals` as data. That keeps signals.ts pure and keeps policies
		// off `ctx`, which is the whole contract in policy.ts.
		return deriveSignals(entries, branch, ctx.getContextUsage());
	} catch {
		return emptySignals;
	}
}

/** Text of the most recent assistant turn, for the policies that read it. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
			const message = entry?.message;
			if (!message || message.role !== "assistant") continue;
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content
					.filter((part): part is { type: string; text: string } => {
						const p = part as { type?: string; text?: unknown };
						return p?.type === "text" && typeof p.text === "string";
					})
					.map((part) => part.text)
					.join("\n");
				return text.length > 0 ? text : undefined;
			}
			return undefined;
		}
	} catch {
		// Session replaced, or a shape we do not recognise. The guard fails OPEN:
		// a missing transcript must not block a legitimate gate injection.
	}
	return undefined;
}

export function installDriver(pi: ExtensionAPI, options: DriverOptions): DriverHandle {
	let ledger: LedgerState = emptyLedger;
	let inSettle = false;
	let generation = 0;
	let blockedOnUser = false;
	// The most recent ctx, kept so a TIMER has one to work through. It goes
	// stale on session replacement, which every read below is guarded against.
	let heldCtx: ExtensionContext | null = null;
	const settleClaims = trackSettleClaims(pi);
	const ownWork = trackOwnWork(pi);
	const rehydrateDeliveryProgress = registerDeliveryProgress(pi);

	// Registered UNCONDITIONALLY. The extension factory runs once at startup, so
	// a registration gated on state can never be un-gated by a later command —
	// that is the bug that shipped on 2026-08-05, where telemetry reported "on"
	// and recorded nothing for the rest of the session's life.
	pi.on("session_start", (_event, ctx) => {
		generation++;
		inSettle = false;
		blockedOnUser = false;
		heldCtx = ctx;
		// The gate's budget is per-session by design and pinned as such by
		// test/verification-loop.test.ts. Durable, non-resetting budgets arrive
		// with /goal, which needs persistence this policy deliberately does not.
		const entries = ctx.sessionManager.getEntries();
		rehydrateDeliveryProgress(entries);
		ledger = entries.some(entry =>
			(entry as { customType?: string }).customType === ADVICE_GIVEN_ENTRY)
			? record(emptyLedger, ADVISE_LEDGER_ID) : emptyLedger;
	});

	async function runChain(ctx: ExtensionContext, boundary: "settle" | "turn" | null = null, policies = options.policies): Promise<string | undefined> {
		if (options.isWorker) return;
		if (inSettle) return; // our own injected turn settling — never recurse

		// --- everything off ctx BEFORE the first await; ctx throws once stale ---
		let mode: ExtensionContext["mode"];
		let cwd: string;
		let assistantText: string | undefined;
		let transcript: string;
		let signals: SessionSignals;
		let turnFailure: TurnFailure | undefined;
		let handback: Handback;
		let setStatus: (text: string) => void;
		let isIdle: () => boolean;
		try {
			mode = ctx.mode;
			cwd = ctx.cwd;
			assistantText = lastAssistantText(ctx);
			transcript = recentTranscript(ctx);
			signals = readSignals(ctx);
			turnFailure = readTurnFailure(ctx);
			handback = confirmOwnWork(classifyHandback(ctx.sessionManager.getBranch() as readonly unknown[]), ownWork);
			setStatus = (text: string) => {
				try {
					ctx.ui.setStatus("agenda", text);
				} catch {
					/* session replaced — status is cosmetic, never fail the loop for it */
				}
			};
			// Must be read LIVE, not captured: whether a turn is already running
			// changes during our await. Fails CLOSED — an unreadable ctx means the
			// session is gone, and injecting into it is never right.
			isIdle = () => {
				try {
					// Before-settle is inside the active SDK run; only timer pumps need idle.
					return !ctx.signal?.aborted && (boundary || ctx.isIdle()) && !ctx.hasPendingMessages();
				} catch {
					return false;
				}
			};
		} catch {
			return; // ctx was already stale on entry
		}

		// Headless one-shot: the session is replaced immediately after settle, so
		// any ctx use across an await throws — and injecting an extra turn into a
		// scripted run is not wanted anyway.
		if (mode !== "tui" && mode !== "rpc") return;

		// Someone else already started a turn during this same settle chain.
		//
		// Two checks, because pi 0.87 changed what the first one can see.
		// `isIdle()` still stops us injecting into a streaming agent, where
		// `triggerTurn` silently degrades to a queued follow-up that lands
		// mid-turn. It no longer separates injectors: a triggerTurn sent from
		// `agent_settled` is DEFERRED until the whole chain returns, so the
		// session stays idle throughout. The settle claim (hive-common/
		// settle-claim.ts) is the mutual exclusion now.
		if (!isIdle() || settleClaims.claimedBy()) return;

		// The hand-back guard is a PRE-condition on automatic re-entry, not a
		// filter on the injection. Vetoing here means the policy's expensive work
		// never runs and nothing is charged to its budget — charging for an
		// injection the model never saw would spend a cap it had no chance to
		// satisfy. It also means the guard covers every policy for free.
		// A turn that did not RUN is not evidence — see turn-outcome.ts.
		//
		// This sits before the hand-back guard because it is the stronger claim:
		// the guard asks whether the assistant handed the turn to someone, while
		// this asks whether there was a turn at all. Both mean "do not re-enter",
		// and neither charges the ledger.
		//
		// `aborted` sets blockedOnUser: the human stopped this deliberately, and
		// `/agenda` should say so rather than look idle for no reason.
		if (turnFailure) {
			blockedOnUser = turnFailure === "aborted";
			return;
		}

		// A turn handed back — to a person (a plan up for approval, a pending
		// grant, a question, "ich warte auf deine Freigabe") or to the agent's own
		// running job — is not a stop to re-drive. Before this, only a trailing
		// `?` stood a policy down, and the goal judge re-drove an explicit
		// "waiting for your approval" seven times in one measured session.
		// Policies that legitimately act on a hand-back say so with
		// `proceedsDespite` (ask converts a prose decision into a card; the gate
		// and a user-armed loop still run while the agent waits on its own job).
		blockedOnUser = handback.kind === "human";
		const held = handbackClass(handback);
		const eligible = policies.filter(
			(policy) => held === "none" || (held !== "gate" && policy.proceedsDespite?.includes(held) === true),
		);
		if (eligible.length === 0) return;

		const gen = generation;
		const adviceBefore = count(ledger, ADVISE_LEDGER_ID);
		let injectionAccepted = false;
		const acceptInjection = () => {
			injectionAccepted = true;
			if (count(ledger, ADVISE_LEDGER_ID) > adviceBefore) pi.appendEntry(ADVICE_GIVEN_ENTRY, { given: true });
		};

		inSettle = true;
		try {
			// Walk the chain until something actually INJECTS, not until something
			// merely wants the settle.
			//
			// First-policy-wins is the obvious design and it is wrong: the gate
			// applies on every settle in any repo carrying a `.pi/harness.json`, so
			// it would starve every policy behind it — a goal would simply never be
			// judged in a gated repo. A policy that runs and has nothing to say
			// (gate green, budget already spent) must yield to the next one.
			//
			// "At most one injection per settle" is preserved: we stop at the first
			// injection. Every policy that ran still reports its own metric, so a
			// green gate followed by a goal evaluation records both.
			// The walk itself is harness-neutral (chain.ts) — the Claude adapter's
			// Stop hook runs the same one. What stays here is pi's half: the
			// generation and abort checks, the idle/claim check, the bus.
			const injection = await walkChain(
				eligible,
				{ cwd, lastAssistantText: assistantText, transcript, signals, signal: ctx.signal },
				{
					stillCurrent: () => gen === generation && !ctx.signal?.aborted,
					// Injecting while the user typed during a slow policy would cut
					// into their turn.
					mayInject: () => isIdle() && !settleClaims.claimedBy(),
					setStatus,
					// Publish on the in-process bus for hive-telemetry. Emitting with
					// no subscriber is a no-op, so this needs no import from that
					// extension and no load ordering against it. METRIC ONLY: a gate
					// command's output must never ride this channel, or the bus
					// becomes a path around payload.ts's allowlist.
					onMetric: (name, outcome, value) => emitMetric(pi, name, outcome, value),
					ledger: () => ledger,
					setLedger: (next) => { ledger = next; },
				},
			);
			if (!injection) return;

			if (boundary) {
				try {
					pi.events.emit(AGENDA_INJECTION_CHANNEL, { policy: injection.policy } satisfies AgendaInjectionEvent);
					// turn_end continues INSIDE the current run (turn_start, not
					// agent_start). Its advice must not hold a later settle hostage.
					if (boundary === "settle") settleClaims.claim("agenda");
					acceptInjection();
					return injection.text;
				} catch {
					return; // session went away mid-check
				}
			}
			try {
				pi.sendMessage(
					{ customType: "agenda", content: injection.text, display: true },
					{ deliverAs: "followUp", triggerTurn: true },
				);
				acceptInjection();
				pi.events.emit(AGENDA_INJECTION_CHANNEL, { policy: injection.policy } satisfies AgendaInjectionEvent);
				settleClaims.claim("agenda");
			} catch {
				/* session went away mid-check — nothing to inject into */
			}
			return; // one injection per settle
		} catch {
			/* a policy threw; never take the harness down with it */
		} finally {
			// A live user-message check can discard advice after policy work.
			// Keep other retry charges, but do not spend an undelivered reminder.
			if (gen === generation && !injectionAccepted && count(ledger, ADVISE_LEDGER_ID) > adviceBefore) {
				const iterations = { ...ledger.iterations };
				if (adviceBefore) iterations[ADVISE_LEDGER_ID] = adviceBefore;
				else delete iterations[ADVISE_LEDGER_ID];
				ledger = { ...ledger, iterations };
			}
			inSettle = false;
		}
	}

	// A commit's tool result is persisted before turn_end. Inject here so the
	// next model request sees advice, not after its final delivery report.
	pi.on("turn_end", async (event, ctx) => {
		if (!options.turnPolicies?.length || event.continue || event.outcome !== "completed") return;
		const injection = await runChain(ctx, "turn", options.turnPolicies);
		return injection ? {
			entries: [...event.entries, { type: "custom_message", customType: "agenda", content: injection, display: true }],
			continue: true,
		} : undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		heldCtx = ctx;
		if (event.outcome !== "completed") {
			blockedOnUser = event.outcome === "aborted";
			return;
		}
		if (event.continue) return; // another boundary handler already requested a turn
		const injection = await runChain(ctx, "settle");
		return injection ? {
			entries: [...event.entries, { type: "custom_message", customType: "agenda", content: injection, display: true }],
			continue: true,
		} : undefined;
	});
	pi.on("agent_settled", (_event, ctx) => {
		heldCtx = ctx; // final observation only; no policy work or continuation
	});

	return {
		ledger: () => ledger,
		pump: () => {
			const ctx = heldCtx;
			if (!ctx) return;
			// Fire-and-forget: a timer has nowhere to await, and an unhandled
			// rejection here would be an unexplained crash in a background tick.
			void runChain(ctx).catch(() => {});
		},
		reset: () => {
			// Stop/re-enable resets retry budgets, not the session-wide reminder.
			ledger = ledger.iterations[ADVISE_LEDGER_ID] ? record(emptyLedger, ADVISE_LEDGER_ID) : emptyLedger;
			blockedOnUser = false;
		},
		blockedOnUser: () => blockedOnUser,
	};
}

function emitMetric(pi: ExtensionAPI, name: string, outcome: MetricOutcome, value: number): void {
	try {
		pi.events.emit("hive.metric", { kind: "gate", name, outcome, value });
	} catch {
		/* the bus is best-effort; never fail a gate for it */
	}
}
