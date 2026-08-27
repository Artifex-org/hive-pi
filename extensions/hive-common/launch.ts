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
 */
export function isUnattendedHiveLaunch(hiveLaunchId: string | undefined): boolean {
	return Boolean(hiveLaunchId);
}
