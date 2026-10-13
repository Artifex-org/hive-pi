/**
 * True when this pi was started by Hive as a managed launch, which means the
 * terminal is unattended: the operator watches and steers through Hive, not by
 * sitting in the tmux pane.
 *
 * `HIVE_LAUNCH_ID` is set only by the workstation launcher, and is the narrowest
 * of the launch variables — `HIVE_URL`/`HIVE_TOKEN` leak in from any developer
 * shell with Hive configured, so keying on those would suppress the modal in a
 * human's own interactive pi. Measured on the live fleet: Hive-launched pi
 * carries six `HIVE_*` variables, a developer's own pi carries exactly the two.
 *
 * This says the PANE is unattended, not that nobody is steering. A person can
 * drive a launched session from the Hive browser, and that is a fact about the
 * conversation, known only once their first message arrives — see
 * OPERATOR_INPUT_CHANNEL and agenda/attendance.ts, which keep such a session
 * from closing itself at completion.
 */
export function isUnattendedHiveLaunch(hiveLaunchId: string | undefined): boolean {
	return Boolean(hiveLaunchId);
}
