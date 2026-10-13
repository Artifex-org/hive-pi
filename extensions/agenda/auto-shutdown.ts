/**
 * Pure policy for closing a finished unattended session.
 *
 * This deliberately keys off the conductor's terminal stage, not merely an
 * achieved goal: verification and consolidation happen after the goal can
 * first become true. The caller is responsible for re-checking its live
 * session immediately before invoking the graceful shutdown API.
 */
export interface AutoShutdownInput {
	enabled: boolean;
	mode: string;
	unattendedHiveLaunch: boolean;
	/**
	 * A person has steered this session through Hive since it started
	 * (OPERATOR_INPUT_CHANNEL). Hive's own notices, other agents' steers and
	 * the launch prompt never set it.
	 */
	attended: boolean;
	conductorDone: boolean;
	asksQuestion: boolean;
}

/**
 * Automatic closure is opt-in and limited to RPC sessions or TUI sessions
 * launched unattended by Hive. One-shot modes are already responsible for their
 * own lifecycle. A question always wins over completion because it needs input.
 *
 * An ATTENDED session never closes itself. The opt-in exists because a launched
 * pane has nobody to quit it (HIV-1608) — but once a person has typed into the
 * session, somebody is there, and closing at `done` throws away what they say
 * next: measured on f2ead622 (2026-10-13), an operator steering a research run
 * typed "continue" twice, the session consolidated and closed four minutes after
 * the second, and the two messages sent after that sat unclaimed.
 *
 * The rule is "any person-sent message since the session started", sticky, not
 * "within the last N minutes". A window makes closure depend on how long the
 * agent took relative to the operator's last message — and the operator who
 * asked for a multi-hour run is exactly the one who comes back after the window
 * to ask about it. The cost of the other mistake is bounded: an attended session
 * left resident is ended by the person attending it (Hive's complete/kill), while
 * a session closed under its operator loses their next instruction outright.
 * Factory and teammate launches never receive a person-sent command, so they
 * keep closing at completion exactly as before.
 */
export function shouldAutoShutdown(input: AutoShutdownInput): boolean {
	return (
		input.enabled &&
		(input.mode === "rpc" || input.unattendedHiveLaunch) &&
		!input.attended &&
		input.conductorDone &&
		!input.asksQuestion
	);
}
