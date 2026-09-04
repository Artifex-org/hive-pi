/**
 * narrate — nudge the agent to say what it is doing, when it has gone quiet.
 *
 * WHY A REMINDER AND NOT JUST A PROMPT LINE.
 *
 * `workstation/.pi/agent/AGENTS.md` already asks for a line of prose before each
 * batch of tool calls. A static instruction at position zero competes with
 * seventy other lines and decays across a long session, which is measurable:
 * across 7 days of workstation sessions, pi averaged 18.6 tool calls per prose
 * message. Claude Code, measured the same way over 32 sessions and 20,383
 * tool-calling messages, averages 3.4 — and its docs say why it can: an output
 * style is not only added to the system prompt, it "triggers reminders for
 * Claude to adhere to the output style instructions DURING the conversation".
 *
 * So this is the reminder half. The instruction lives in AGENTS.md; this pokes
 * the model with a short version of it at the moment it is being ignored.
 *
 * WHERE IT RIDES, AND WHY NOT `context`.
 *
 * The obvious implementation appends a message in a `context` handler. This repo
 * forbids that, at build level (test/no-forbidden-events.test.ts), and the ban is
 * right in a way the obvious implementation does not address: pi skips the
 * transform path ENTIRELY when nothing subscribes, so registering a handler
 * switches on work pi would otherwise bypass — on every LLM call, in every
 * session, whether or not this extension ever has anything to say. Reasoning
 * about how little the appended text costs answers the wrong question.
 *
 * So the reminder rides on a TOOL RESULT instead, which is also how Claude Code
 * delivers its own: `tool_result` fires after a tool the agent already ran, the
 * content is already being sent, and the text becomes part of history rather
 * than being re-synthesised per request — so once written it is stable, and the
 * prompt cache keeps working.
 *
 * It fires ONCE per silent streak. A streak ends when the agent speaks, which
 * re-arms it; an agent that narrates normally never sees it at all.
 *
 * Everything here is pure and synchronous. It is called from a pi event handler,
 * and pi awaits handlers serially: a slow handler IS the agent loop.
 */

export interface NarrationState {
	/** Tool calls since the agent last said anything in prose. */
	silentToolCalls: number;
	/** Whether this streak has already been reminded. Re-armed when it speaks. */
	reminded: boolean;
	/**
	 * When the current SILENT batch of tool calls was dispatched, or null.
	 *
	 * This is what makes the second trigger possible without a single new event
	 * subscription. pi gives `tool_result` no duration and no start time, and
	 * `tool_execution_start`/`_end` would be two more handlers on a hooks budget
	 * this house keeps deliberately small — but `message_end` already tells us
	 * when the batch was dispatched and `tool_result` already tells us when one
	 * came back, and both are already subscribed. The difference is the wait.
	 */
	silentBatchStartedAtMs: number | null;
}

/**
 * Why a reminder is being sent, or null for none.
 *
 * Two triggers, because they are two different failures with the same remedy:
 * a long SILENT STRETCH (many calls, nobody told), and a long SILENT WAIT (one
 * call, nothing on screen for half a minute). The second is the one the human
 * experiences as "it has hung".
 */
export type RemindReason = "streak" | "slow-wait";

/**
 * How many silent tool calls before the nudge.
 *
 * Five, matching the ceiling AGENTS.md states ("never go more than ~5 tool calls
 * without saying something") — a reminder that fired at a different number than
 * the rule it points at would be teaching two rules.
 *
 * Not lower: a three-call read-grep-read burst to answer one question is normal,
 * competent work and does not need an announcement. The failure mode this exists
 * for is the twenty-call silent stretch.
 */
export const SILENT_TOOL_CALLS = 5;

/**
 * What the reminder says.
 *
 * Written as an observation plus an instruction, not as an accusation: "you have
 * run N tool calls" is checkable, and a model told something checkable about its
 * own behaviour acts on it more reliably than one told to be better.
 *
 * It restates the RULE, briefly, rather than pointing at AGENTS.md — the whole
 * premise is that the far-away instruction is the thing being missed. Which is
 * also why the wording tracks AGENTS.md's "Say what you are doing" section
 * verbatim in spirit: a reminder that asked for something different from the
 * rule it stands in for would be teaching two rules, the same trap
 * `SILENT_TOOL_CALLS` avoids on the numeric side.
 *
 * "What you are doing and why" was the old wording, and the `why` was doing real
 * damage: measured over 39,816 preambles, the median ran to 202 characters —
 * longer than the median END-OF-TURN report on the same fleet. A preamble is a
 * label for someone glancing at a pane, so it asks for what and where only.
 */
export function reminderText(silentToolCalls: number): string {
	return (
		`<system-reminder>You have run ${silentToolCalls} tool calls without saying anything. ` +
		`Someone is watching this session and cannot tell working from stuck. ` +
		`Before the next batch, write ONE short line naming what you are doing and where — or what you just found. ` +
		`Under ~80 characters, no reasoning, no list of the calls. A label, not a report. Then carry on.</system-reminder>`
	);
}

/**
 * How long a silent tool batch may run before the wait itself is the problem.
 *
 * Twenty seconds. Below that a slow read or a quick `git status` would trip it,
 * and a reminder that fires on ordinary work is one the model learns to skip —
 * the same reasoning that keeps `SILENT_TOOL_CALLS` at five rather than three.
 * Above it, the person watching has been looking at a tool call with no
 * explanation for long enough to wonder whether the session is stuck, which is
 * precisely the complaint this exists to answer.
 */
export const SLOW_WAIT_MS = 20_000;

export function createNarration(): NarrationState {
	return { silentToolCalls: 0, reminded: false, silentBatchStartedAtMs: null };
}

/**
 * Fold one completed assistant message.
 *
 * PROSE RESETS THE STREAK, including prose that accompanies tool calls — a
 * message carrying both is exactly the behaviour being asked for, and counting
 * its calls as silent would nag the agent that just complied.
 *
 * Reasoning does NOT reset it. A trace is visible in Hive's pane and nowhere
 * else: not in a terminal, not to a teammate reading a shared session. It is
 * also the model thinking, not the model reporting, and the two are different
 * things to someone trying to find out what happened.
 */
export function noteAssistantMessage(
	state: NarrationState,
	hasText: boolean,
	toolCalls: number,
	nowMs: number = Date.now(),
): void {
	if (hasText) {
		state.silentToolCalls = 0;
		state.reminded = false;
		// A batch the agent DID introduce is not a silent wait, however long it
		// runs. Waiting is fine; waiting with no explanation on screen is not,
		// and this message already gave the explanation.
		state.silentBatchStartedAtMs = null;
		return;
	}
	state.silentToolCalls += Math.max(0, toolCalls);
	// Only a batch that actually dispatched tools starts a wait clock. A silent
	// message with no tool calls ends the turn; there is nothing to wait for.
	state.silentBatchStartedAtMs = toolCalls > 0 ? nowMs : null;
}

/** A new user turn clears the streak: whatever went before, the agent is about
 *  to answer a fresh instruction and starts from silence. */
export function noteUserTurn(state: NarrationState): void {
	state.silentToolCalls = 0;
	state.reminded = false;
	state.silentBatchStartedAtMs = null;
}

/**
 * Which reminder this request should carry, if any.
 *
 * The streak is checked first. When both apply, the streak is the larger
 * complaint — a long silent stretch that also happens to be slow is still
 * mainly a silent stretch — and only one reminder is sent either way.
 */
export function remindReason(
	state: NarrationState,
	threshold = SILENT_TOOL_CALLS,
	nowMs: number = Date.now(),
	slowWaitMs: number = SLOW_WAIT_MS,
): RemindReason | null {
	if (state.reminded) return null;
	if (state.silentToolCalls >= threshold) return "streak";
	if (state.silentBatchStartedAtMs !== null && nowMs - state.silentBatchStartedAtMs >= slowWaitMs) {
		return "slow-wait";
	}
	return null;
}

/** Whether this request should carry the nudge. Kept for the streak-only path. */
export function shouldRemind(state: NarrationState, threshold = SILENT_TOOL_CALLS): boolean {
	return !state.reminded && state.silentToolCalls >= threshold;
}

/** Record that the nudge went out. Only prose re-arms it. */
export function noteReminded(state: NarrationState): void {
	state.reminded = true;
	// The wait has been reported; do not report the same one again as the rest
	// of the batch's results come back.
	state.silentBatchStartedAtMs = null;
}

/**
 * What the slow-wait reminder says.
 *
 * Deliberately NOT the streak text. The streak reminder asks for a status line
 * about work already done; this one is about a wait in progress, and it is the
 * only place the harness can teach the habit the whole feature is named for:
 * say what you are about to wait on, BEFORE you wait on it.
 *
 * It names the backgrounding escape hatch too, because for a genuinely long job
 * the better answer is not a better sentence — it is not blocking the session
 * at all.
 */
export function slowWaitText(waitedMs: number): string {
	const seconds = Math.max(1, Math.round(waitedMs / 1000));
	return (
		`<system-reminder>That tool call has been running for ${seconds}s with nothing on screen explaining it. ` +
		`Someone watching cannot tell a slow command from a hung one. ` +
		`Before starting anything you expect to be slow, write ONE short line naming what you are running and ` +
		`what you will do while it runs. If it is genuinely long, start it with background_bash — or subagent ` +
		`with background:true — and carry on instead of waiting.</system-reminder>`
	);
}
