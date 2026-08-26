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
	conductorDone: boolean;
	asksQuestion: boolean;
}

/**
 * Automatic closure is opt-in and limited to RPC sessions or TUI sessions
 * launched unattended by Hive. One-shot modes are already responsible for their
 * own lifecycle. A question always wins over completion because it needs input.
 */
export function shouldAutoShutdown(input: AutoShutdownInput): boolean {
	return (
		input.enabled &&
		(input.mode === "rpc" || input.unattendedHiveLaunch) &&
		input.conductorDone &&
		!input.asksQuestion
	);
}
